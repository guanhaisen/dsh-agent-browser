// Verify the in-app browser survives the failure modes reported from live use,
// and that it tells the truth while doing so.
//
// Every assertion here corresponds to something an agent hit while doing real
// page-layout verification in a desktop Session, and each one is written so that
// reintroducing the original defect makes it fail:
//
//   1. A stalled page produced a fixed 60 s stall per call, because the guest
//      calls were awaited bare and the only bound left was the Inspect channel's
//      own timeout. The plugin's budget must bound them instead.
//   2. `preset: "phone"` reported `pageWidth: 1280` — the layout was still the
//      previous one when it was measured, and a request was reported as an
//      observation.
//   3. A viewport read returned `preset: "desktop"` beside
//      `custom: {width: 320, height: 700}`; two contradictory sizes in one answer.
//   4. `browser_tabs` reported `http://localhost:3000/` while `browser_read`
//      reported `chrome-error://chromewebdata/`, because Electron's view of the
//      URL overrode the page's. A failed load looked healthy.
//   5. A failed load still captured, so a blank image was returned as success.
//   6. There was no way to reload a sick tab, and no way to close the tabs that
//      accumulated while retrying.
//
// Pure Node: the browser half is loaded through a stub module loader, so this
// needs no packaged install and runs in the default suite.
const vm = require('node:vm')
const fs = require('node:fs')
const { join } = require('node:path')

const CLIENT = join(__dirname, '..', 'client.js')

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log('ok  ', label)
  else {
    console.error('FAIL', label, detail === undefined ? '' : JSON.stringify(detail))
    failures++
  }
}

/** A promise that never settles, standing in for a stalled renderer. */
const never = () => new Promise(() => {})

/**
 * A stubbed Electron webview guest.
 *
 * The viewport probe is answered from the element's OWN applied styles, which is
 * what the real carrier does — its box IS the page's viewport. Layout is modelled
 * as lagging that write by `reflowDelay` probes, because that lag is the actual
 * defect being guarded: a size that was requested but had not been laid out yet.
 * `reflowDelay: Infinity` is a page that never reflows at all.
 */
function makeGuest(options = {}) {
  const state = {
    url: options.url ?? 'https://example.test/',
    title: options.title ?? 'Example',
    width: options.width ?? 800,
    height: options.height ?? 600,
    loading: options.loading ?? false,
    urls: [],
    reloads: [],
  }
  // The styles the page has actually laid out, which trail the element's own.
  // The empty string means no width/height have been laid out yet, so the page
  // reports its natural size — the state a fresh guest is in.
  let visibleCss = ''
  let lagTarget = ''
  let lagLeft = 0
  const guest = {
    tagName: 'WEBVIEW',
    style: { cssText: '' },
    dataset: { sidebarBrowserFrame: 'webview' },
    isConnected: true,
    state,
    isLoading: () => state.loading,
    getURL: () => state.url,
    getTitle: () => state.title,
    loadURL: async (url) => {
      state.url = url
      state.urls.push(url)
    },
    reload: () => {
      state.reloads.push({ ignoreCache: false })
    },
    reloadIgnoringCache: () => {
      state.reloads.push({ ignoreCache: true })
    },
    executeJavaScript: async (code) => {
      if (options.executeJavaScript) return await options.executeJavaScript(code, guest)
      if (typeof code === 'string' && code.includes('window.innerWidth')) {
        const css = guest.style.cssText || ''
        if (css !== visibleCss) {
          const delay = options.reflowDelay ?? 0
          if (lagTarget !== css) {
            lagTarget = css
            lagLeft = delay
          }
          if (lagLeft > 0) lagLeft -= 1
          else visibleCss = css
        }
        // Report from what has LAID OUT, never from what was just written. With
        // nothing laid out the regexes miss and the natural size is reported,
        // which is exactly the stale reading the defect produced.
        const source = visibleCss
        const w = /width:(\d+)px/.exec(source)
        const h = /height:(\d+)px/.exec(source)
        return { w: w ? Number(w[1]) : state.width, h: h ? Number(h[1]) : state.height }
      }
      if (typeof code === 'string' && code.includes('location.href')) {
        return { url: state.url, title: state.title, readyState: 'complete' }
      }
      return {
        url: state.url,
        title: state.title,
        readyState: 'complete',
        body: { innerText: 'Hello' },
        documentElement: { outerHTML: '<html/>' },
        elements: [],
        truncated: false,
      }
    },
  }
  if (options.capturePage) guest.capturePage = options.capturePage
  // The controller sizes the guest's own PARENT container, so the guest needs
  // one: `apply` reads its client box to compute the display scale.
  const container = {
    style: {},
    clientWidth: options.containerWidth ?? 800,
    clientHeight: options.containerHeight ?? 700,
    getBoundingClientRect: () => ({
      width: options.containerWidth ?? 800,
      height: options.containerHeight ?? 700,
    }),
  }
  guest.parentElement = container
  return guest
}

/** One Session's Sidebar root, carrying its browser tabs. */
function makeRoot(sessionId, entries) {
  const root = {
    dataset: { sidebarRightSession: sessionId },
    wrappers: [],
    querySelectorAll: (selector) => (selector === '[data-sidebar-right-tab]' ? root.wrappers : []),
  }
  for (const entry of entries) {
    root.wrappers.push({
      dataset: { sidebarRightTab: entry.tabId },
      querySelector: (selector) => (selector.includes('webview') ? entry.guest : null),
      closest: (selector) => (selector === '[data-sidebar-right-session]' ? root : null),
    })
  }
  return root
}

/** A world of Sessions, tabs and guests, plus a recording Sidebar service. */
function makeWorld(tabs) {
  const roots = new Map()
  const openTabs = []
  for (const tab of tabs) {
    const guest = tab.guest ?? makeGuest(tab)
    if (!roots.has(tab.sessionId)) roots.set(tab.sessionId, makeRoot(tab.sessionId, []))
    roots.get(tab.sessionId).wrappers.push({
      dataset: { sidebarRightTab: tab.tabId },
      querySelector: (selector) => (selector.includes('webview') ? guest : null),
      closest: (selector) => (selector === '[data-sidebar-right-session]' ? roots.get(tab.sessionId) : null),
    })
    openTabs.push({ sessionId: tab.sessionId, tabId: tab.tabId, kind: 'browser', contentId: 'c', guest })
  }
  const calls = { openTabIn: [], closeIn: [], openTab: [], close: [] }
  const sidebarRight = {
    openTabs: { getSnapshot: () => openTabs },
    mounted: { getSnapshot: () => tabs[0]?.sessionId },
    openTabIn: (sessionId, kind, options) => calls.openTabIn.push({ sessionId, kind, options }),
    closeIn: (sessionId, tabId) => {
      calls.closeIn.push({ sessionId, tabId })
      // Model the Sidebar actually removing it, which is what makes the close
      // confirmation meaningful rather than a restatement of the call.
      const index = openTabs.findIndex((entry) => entry.sessionId === sessionId && entry.tabId === tabId)
      if (index >= 0) openTabs.splice(index, 1)
    },
    openTab: (...args) => calls.openTab.push(args),
    close: (...args) => calls.close.push(args),
  }
  return { roots, openTabs, sidebarRight, calls, guestOf: (tabId) => openTabs.find((t) => t.tabId === tabId)?.guest }
}

/** Load the browser half against a world. */
function loadBundle(world) {
  let captured
  const sandbox = {
    window: { __ModuleLoader__: { load(registration) { captured = registration } } },
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    Map,
    Set,
    WeakMap,
    Array,
    Object,
    JSON,
    String,
    Number,
    Boolean,
    Error,
    Promise,
    Symbol,
    Math,
    Date,
    CSS: { escape: (value) => value },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    localStorage: {
      store: new Map(),
      getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
      setItem(key, value) { this.store.set(key, String(value)) },
      removeItem(key) { this.store.delete(key) },
    },
    document: {
      querySelector: (selector) => {
        const match = /^\[data-sidebar-right-session="([^"]*)"\]$/.exec(selector)
        if (match) return world.roots.get(match[1]) ?? null
        return null
      },
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, dataset: {}, appendChild() {}, setAttribute() {} }),
    },
  }
  sandbox.globalThis = sandbox
  sandbox.window.document = sandbox.document
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), sandbox, { filename: 'client.js' })

  if (!captured) throw new Error('bundle did not register with __ModuleLoader__')
  const exports = captured.factory((spec) => {
    if (spec === 'react') {
      return {
        useState: () => [undefined, () => {}],
        useSyncExternalStore: () => undefined,
        Fragment: 'fragment',
      }
    }
    if (spec === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return {}
    if (spec === '@deepseek-ai/dsh-client-store') {
      return {
        defineStore: (decl) => ({
          spec: decl,
          create: () => {
            let state = decl.init()
            const actions = {}
            for (const key of Object.keys(decl.actions)) {
              actions[key] = (...params) => {
                const draft = JSON.parse(JSON.stringify(state))
                decl.actions[key](draft, ...params)
                state = draft
              }
            }
            return {
              actions,
              getSnapshot: () => state,
              subscribe: () => () => {},
              store: { getSnapshot: () => state },
              clearPersisted: () => {},
            }
          },
        }),
      }
    }
    throw new Error(`unexpected require("${spec}")`)
  })
  const store = exports.__viewport.viewportStore.create()
  const controller = new exports.__viewport.ViewportController(store)
  return {
    exports,
    store,
    controller,
    budgets: exports.__viewport.budgets,
    provider: exports.buildProvider({ sidebarRight: world.sidebarRight, get: () => undefined }, controller),
  }
}

const SESSION = 's1'

/**
 * Fail loudly if the suite itself hangs.
 *
 * This matters more here than in a normal suite. The defects being guarded are
 * calls that NEVER settle, and a check that awaits one does not merely fail — it
 * leaves the process with no pending work, so Node exits 0 and the run looks
 * green. Without this watchdog, removing the very bound under test turns these
 * checks into silent passes.
 */
const WATCHDOG_MS = 30_000
const watchdog = setTimeout(() => {
  console.error(
    `FAIL the suite did not finish within ${WATCHDOG_MS / 1000}s: a call hung instead of failing, ` +
      'which is the defect these checks exist to catch',
  )
  process.exit(1)
}, WATCHDOG_MS)

async function main() {
  // ---------------------------------------------------------------------
  // 1. A stalled page is bounded by the plugin's budget, not by the channel.
  // ---------------------------------------------------------------------
  {
    const world = makeWorld([
      { sessionId: SESSION, tabId: 'tab1', guest: makeGuest({ executeJavaScript: () => never() }) },
    ])
    const bundle = loadBundle(world)
    // Shrink the budget so the assertion costs milliseconds, not 6 seconds. The
    // bound being TESTED is that a budget exists at all and is enforced.
    bundle.budgets.call = 120
    bundle.budgets.identity = 120

    const started = Date.now()
    let error
    try {
      await bundle.provider.query('read', { mode: 'text' }, { sessionId: SESSION })
    } catch (thrown) {
      error = thrown
    }
    const elapsed = Date.now() - started
    check('a stalled page script fails instead of hanging', error !== undefined, String(error))
    check(
      'the failure is bounded by the plugin budget, not the channel timeout',
      elapsed < 2000 && elapsed >= 100,
      { elapsed },
    )
    check(
      'the failure says the page did not answer and suggests a way out',
      /did not answer/i.test(String(error?.message)) && /reload/.test(String(error?.message)),
      String(error?.message),
    )
  }

  // The same bound must cover a capture and a navigation, which are the two
  // calls the report saw stall for a full minute each.
  {
    const world = makeWorld([
      {
        sessionId: SESSION,
        tabId: 'tab1',
        guest: makeGuest({ capturePage: () => never() }),
      },
    ])
    const bundle = loadBundle(world)
    bundle.budgets.screenshot = 150
    bundle.budgets.identity = 150
    const started = Date.now()
    let error
    try {
      await bundle.provider.query('screenshot', {}, { sessionId: SESSION })
    } catch (thrown) {
      error = thrown
    }
    check('a stalled capture fails instead of hanging', error !== undefined, String(error))
    check('the stalled capture is bounded', Date.now() - started < 2000, { elapsed: Date.now() - started })
  }

  {
    const world = makeWorld([
      { sessionId: SESSION, tabId: 'tab1', guest: makeGuest({}) },
    ])
    // A navigation into a server that accepts the connection and never answers.
    world.guestOf('tab1').loadURL = () => never()
    const bundle = loadBundle(world)
    bundle.budgets.call = 150
    bundle.budgets.identity = 150
    const started = Date.now()
    let error
    try {
      await bundle.provider.query('navigate', { tabId: 'tab1', url: 'http://localhost:9/' }, { sessionId: SESSION })
    } catch (thrown) {
      error = thrown
    }
    check('a stalled navigation fails instead of hanging', error !== undefined, String(error))
    check('the stalled navigation is bounded', Date.now() - started < 2000, { elapsed: Date.now() - started })
  }

  // ---------------------------------------------------------------------
  // 2. A viewport change is confirmed, never assumed.
  // ---------------------------------------------------------------------
  {
    // The page's layout trails the element's style write by two probes, which is
    // what made a phone request report the previous (1280px) layout. The
    // confirmation loop must wait it out.
    const world = makeWorld([
      {
        sessionId: SESSION,
        tabId: 'tab1',
        guest: makeGuest({ width: 1280, height: 800, reflowDelay: 2 }),
      },
    ])
    const bundle = loadBundle(world)
    // Shrink only the confirmation bound; keep the call budget realistic, since
    // the confirmation allowance is deliberately capped below it. Setting the
    // two equal would leave zero allowance and the check would pass for the
    // wrong reason.
    bundle.budgets.call = 6000
    bundle.budgets.confirm = 1500
    bundle.budgets.confirmReserve = 500
    bundle.budgets.identity = 500
    const result = await bundle.provider.query('setViewport', { preset: 'phone' }, { sessionId: SESSION })
    check('a settled viewport change is reported as confirmed', result.confirmed === true, result)
    check(
      'the reported size is the one the page settled at, not the stale one',
      result.pageWidth === 390,
      result,
    )
  }

  {
    // The page never reflows — the live defect reported `pageWidth: 1280` for a
    // phone request and presented it as though the change had applied.
    const world = makeWorld([
      { sessionId: SESSION, tabId: 'tab1', guest: makeGuest({ width: 1280, reflowDelay: Number.POSITIVE_INFINITY }) },
    ])
    const bundle = loadBundle(world)
    bundle.budgets.call = 6000
    bundle.budgets.confirm = 200
    bundle.budgets.confirmReserve = 100
    bundle.budgets.identity = 200
    const result = await bundle.provider.query('setViewport', { preset: 'phone' }, { sessionId: SESSION })
    check('an unconfirmed viewport change is reported as NOT confirmed', result.confirmed === false, result)
    check(
      'an unconfirmed change reports the size actually measured',
      result.pageWidth === 1280 && result.preset === 'phone',
      result,
    )
  }

  // `auto` has no target width, so there is nothing to confirm and the field
  // must not appear at all rather than being reported as a false claim.
  {
    const world = makeWorld([{ sessionId: SESSION, tabId: 'tab1', guest: makeGuest({}) }])
    const bundle = loadBundle(world)
    bundle.budgets.identity = 200
    const result = await bundle.provider.query('setViewport', { preset: 'auto' }, { sessionId: SESSION })
    check('auto reports no confirmation either way', result.confirmed === undefined, result)
  }

  // ---------------------------------------------------------------------
  // 3. `custom` is reported only for the custom preset.
  // ---------------------------------------------------------------------
  {
    const world = makeWorld([{ sessionId: SESSION, tabId: 'tab1', guest: makeGuest({ width: 1280 }) }])
    const bundle = loadBundle(world)
    bundle.budgets.identity = 500
    // Prime the stored custom size, which is what used to leak into every read.
    bundle.store.actions.setCustom({ width: 320, height: 700 })
    const read = await bundle.provider.query(
      'getViewport',
      { tabId: 'tab1' },
      { sessionId: SESSION },
    )
    check(
      'a non-custom viewport read carries no contradictory custom size',
      read.custom === undefined,
      read,
    )
    check('the read still reports its preset', read.preset !== undefined, read)

    const custom = await bundle.provider.query(
      'setViewport',
      { preset: 'custom', width: 320, height: 700 },
      { sessionId: SESSION },
    )
    check('the custom preset does report its size', custom.custom?.width === 320, custom)
    // A custom request must be confirmed against the size that was APPLIED, not
    // against a fallback: the per-tab selection stores only the preset, so
    // resolving the target without the stored size silently confirms `custom`
    // against the phone fallback.
    check(
      'a custom viewport is confirmed against its own size, not a fallback',
      custom.confirmed === true && custom.pageWidth === 320 && custom.pageHeight === 700,
      custom,
    )
  }

  // ---------------------------------------------------------------------
  // 4. A failed load is reported as failed, and the page's URL wins.
  // ---------------------------------------------------------------------
  {
    // This is the exact disagreement from the report: the page sits on the error
    // page while Electron still reports the requested address.
    const guest = makeGuest({ url: 'chrome-error://chromewebdata/', title: 'localhost:3000' })
    guest.getURL = () => 'http://localhost:3000/'
    guest.getTitle = () => 'localhost:3000'
    const world = makeWorld([{ sessionId: SESSION, tabId: 'tab1', guest }])
    const bundle = loadBundle(world)
    bundle.budgets.identity = 500

    const listed = await bundle.provider.query('listTabs', {}, { sessionId: SESSION })
    const tab = listed.tabs[0]
    check('a failed load is reported as failed', tab.failed === true, tab)
    check(
      'the reported url is the error page, not the address that was requested',
      tab.url === 'chrome-error://chromewebdata/',
      tab,
    )
    check(
      'a failed load is not reported as merely loading or unmounted',
      tab.loading === false && tab.mounted === true,
      tab,
    )
    check('a readable page is not reported as unverified', tab.unverified === false, tab)

    const read = await bundle.provider.query('read', { mode: 'text' }, { sessionId: SESSION })
    check('browser_read also reports the failure', read.failed === true, read)
  }

  // When the page cannot be asked at all, the identity is an inference and says so.
  {
    const guest = makeGuest({ executeJavaScript: () => never() })
    const world = makeWorld([{ sessionId: SESSION, tabId: 'tab1', guest }])
    const bundle = loadBundle(world)
    bundle.budgets.call = 150
    bundle.budgets.identity = 150
    let listed
    try {
      listed = await bundle.provider.query('listTabs', {}, { sessionId: SESSION })
    } catch (error) {
      listed = undefined
      check('listing a tab whose page cannot be asked still answers', false, String(error))
    }
    if (listed) {
      check('an unreadable page is marked unverified', listed.tabs[0].unverified === true, listed.tabs[0])
    }
  }

  // ---------------------------------------------------------------------
  // 5. A screenshot never returns the error page as a successful capture.
  // ---------------------------------------------------------------------
  {
    const guest = makeGuest({
      url: 'chrome-error://chromewebdata/',
      // Even though a capture WOULD succeed, it would capture the error page.
      capturePage: async () => ({
        getSize: () => ({ width: 10, height: 10 }),
        resize() { return this },
        toDataURL: () => 'data:image/png;base64,AAAA',
      }),
    })
    const world = makeWorld([{ sessionId: SESSION, tabId: 'tab1', guest }])
    const bundle = loadBundle(world)
    bundle.budgets.identity = 500
    bundle.budgets.screenshot = 2000
    let error
    try {
      await bundle.provider.query('screenshot', {}, { sessionId: SESSION })
    } catch (thrown) {
      error = thrown
    }
    check('a failed page is refused rather than captured', error !== undefined, String(error))
    check(
      'the refusal explains it would have captured the error page',
      /failed page load/.test(String(error?.message)) && /error page/.test(String(error?.message)),
      String(error?.message),
    )
  }

  // A healthy page must still capture normally, at the confirmed size.
  {
    const world = makeWorld([
      { sessionId: SESSION, tabId: 'tab1', guest: makeGuest({ width: 1280, height: 800 }) },
    ])
    const bundle = loadBundle(world)
    bundle.budgets.identity = 500
    bundle.budgets.identityCeiling = 1000
    bundle.budgets.screenshot = 4000
    bundle.budgets.confirm = 1000
    world.guestOf('tab1').capturePage = async () => ({
      getSize: () => ({ width: 10, height: 10 }),
      resize() { return this },
      toDataURL: () => 'data:image/png;base64,AAAA',
    })
    const shot = await bundle.provider.query('screenshot', { preset: 'desktop' }, { sessionId: SESSION })
    check('a healthy page still captures', shot.base64 === 'AAAA', shot)
    check('the capture reports its confirmed size', shot.confirmed === true, shot)
    check('the capture reports the size the page laid out at', shot.pageWidth === 1280, shot)
  }

  // A WEDGED renderer must not yield a blank image reported as success. This is
  // the report's actual harm: with the server down the page cannot be scripted,
  // so `failed` cannot even be evaluated — Electron keeps reporting the address
  // that was REQUESTED — and a check on `failed` alone never fires.
  {
    const guest = makeGuest({ executeJavaScript: () => never() })
    guest.capturePage = async () => ({
      getSize: () => ({ width: 10, height: 10 }),
      resize() { return this },
      toDataURL: () => 'data:image/png;base64,AAAA',
    })
    guest.getURL = () => 'http://localhost:3000/'
    const world = makeWorld([{ sessionId: SESSION, tabId: 'tab1', guest }])
    const bundle = loadBundle(world)
    bundle.budgets.identity = 120
    bundle.budgets.identityCeiling = 200
    bundle.budgets.screenshot = 3000
    let error
    try {
      await bundle.provider.query('screenshot', {}, { sessionId: SESSION })
    } catch (thrown) {
      error = thrown
    }
    check('a page that cannot be inspected is not captured as a blank image', error !== undefined, String(error))
    check(
      'the refusal explains the page did not answer',
      /did not answer/.test(String(error?.message)) && /blank/.test(String(error?.message)),
      String(error?.message),
    )
  }

  // The refusal must not defeat the larger screenshot budget: a page that answers
  // slowly — the heavy-page case that budget exists for — still captures,
  // because the identity probe is given more patience inside a capture. The page
  // is modelled as ONE call that settles late, which is what a busy renderer
  // actually does (the pending call resolves once it frees up).
  {
    const guest = makeGuest({
      executeJavaScript: async (code) => {
        if (typeof code === 'string' && code.includes('window.innerWidth')) {
          return { w: 1280, h: 800 }
        }
        if (typeof code === 'string' && code.includes('location.href')) {
          // Slower than the shared identity budget, well inside the ceiling.
          await new Promise((resolve) => setTimeout(resolve, 150))
          return { url: 'https://example.test/', title: 'Example', readyState: 'complete' }
        }
        return { url: 'https://example.test/', title: 'Example', readyState: 'complete' }
      },
    })
    guest.capturePage = async () => ({
      getSize: () => ({ width: 10, height: 10 }),
      resize() { return this },
      toDataURL: () => 'data:image/png;base64,AAAA',
    })
    const world = makeWorld([{ sessionId: SESSION, tabId: 'tab1', guest }])
    const bundle = loadBundle(world)
    bundle.budgets.identity = 60
    bundle.budgets.identityCeiling = 2000
    bundle.budgets.screenshot = 6000
    let shot
    let error
    try {
      shot = await bundle.provider.query('screenshot', {}, { sessionId: SESSION })
    } catch (thrown) {
      error = thrown
    }
    check(
      'a briefly busy page is still captured rather than refused',
      shot?.base64 === 'AAAA',
      error ? String(error.message) : shot,
    )
  }

  // A Session full of stalled tabs must not make the listing cost one full probe
  // per tab: the whole listing shares one deadline.
  {
    const world = makeWorld([
      { sessionId: SESSION, tabId: 'tab1', guest: makeGuest({ executeJavaScript: () => never() }) },
      { sessionId: SESSION, tabId: 'tab2', guest: makeGuest({ executeJavaScript: () => never() }) },
      { sessionId: SESSION, tabId: 'tab3', guest: makeGuest({ executeJavaScript: () => never() }) },
      { sessionId: SESSION, tabId: 'tab4', guest: makeGuest({ executeJavaScript: () => never() }) },
    ])
    const bundle = loadBundle(world)
    bundle.budgets.call = 400
    bundle.budgets.identity = 400
    const started = Date.now()
    const listed = await bundle.provider.query('listTabs', {}, { sessionId: SESSION })
    const elapsed = Date.now() - started
    check('a listing of stalled tabs still answers', listed.tabs.length === 4, listed.tabs.length)
    check(
      'the listing is bounded by ONE deadline, not one per tab',
      elapsed < 1500,
      { elapsed, perTabBudget: 400, tabs: 4 },
    )
    check(
      'every stalled tab is reported unverified',
      listed.tabs.every((tab) => tab.unverified === true),
      listed.tabs,
    )
  }

  // ---------------------------------------------------------------------
  // 6. Recovery: reload (with and without the cache) and close.
  // ---------------------------------------------------------------------
  {
    const world = makeWorld([{ sessionId: SESSION, tabId: 'tab1', guest: makeGuest({}) }])
    const bundle = loadBundle(world)
    bundle.budgets.call = 500
    bundle.budgets.identity = 200
    await bundle.provider.query('act', { action: 'reload', ignoreCache: true }, { sessionId: SESSION })
    check(
      'reload with ignoreCache bypasses the cache',
      world.guestOf('tab1').state.reloads.some((entry) => entry.ignoreCache === true),
      world.guestOf('tab1').state.reloads,
    )

    // A carrier without the bypass must still reload, and must not claim it
    // bypassed anything.
    const plainGuest = makeGuest({})
    delete plainGuest.reloadIgnoringCache
    const plainWorld = makeWorld([{ sessionId: SESSION, tabId: 'tab1', guest: plainGuest }])
    const plainBundle = loadBundle(plainWorld)
    plainBundle.budgets.call = 500
    plainBundle.budgets.identity = 200
    const plain = await plainBundle.provider.query(
      'act',
      { action: 'reload', ignoreCache: true },
      { sessionId: SESSION },
    )
    check('a carrier without a cache bypass still reloads', plainGuest.state.reloads.length === 1, plainGuest.state.reloads)
    check('and does not claim the cache was bypassed', plain.ignoreCache === false, plain)
    check('and says so', typeof plain.note === 'string', plain)
  }

  {
    const world = makeWorld([{ sessionId: SESSION, tabId: 'tab1', guest: makeGuest({}) }])
    const bundle = loadBundle(world)
    bundle.budgets.call = 500
    const closed = await bundle.provider.query('closeTab', { tabId: 'tab1' }, { sessionId: SESSION })
    check('closing a tab reports success', closed.closed === true && closed.tabId === 'tab1', closed)
    check(
      'closing is addressed to the calling Session',
      world.calls.closeIn.length === 1 && world.calls.closeIn[0].sessionId === SESSION,
      world.calls.closeIn,
    )
    check(
      'the on-screen close is not used when a Session-addressed one exists',
      world.calls.close.length === 0,
      world.calls.close,
    )
    check('the tab is gone afterwards', world.openTabs.length === 0, world.openTabs)
  }

  // A close that the Sidebar silently ignores must not be reported as success.
  {
    const world = makeWorld([{ sessionId: SESSION, tabId: 'tab1', guest: makeGuest({}) }])
    // The pre-fix hazard: the entry exists but does nothing for this Session.
    world.sidebarRight.closeIn = () => {}
    const bundle = loadBundle(world)
    bundle.budgets.call = 200
    let error
    try {
      await bundle.provider.query('closeTab', { tabId: 'tab1' }, { sessionId: SESSION })
    } catch (thrown) {
      error = thrown
    }
    check('a close the Sidebar ignored is not reported as success', error !== undefined, String(error))
    check(
      'the failure explains the tab is still open',
      /still open/.test(String(error?.message)),
      String(error?.message),
    )
  }

  // Closing a tab that is not there must say so rather than silently succeeding.
  {
    const world = makeWorld([{ sessionId: SESSION, tabId: 'tab1', guest: makeGuest({}) }])
    const bundle = loadBundle(world)
    bundle.budgets.call = 200
    let error
    try {
      await bundle.provider.query('closeTab', { tabId: 'nope' }, { sessionId: SESSION })
    } catch (thrown) {
      error = thrown
    }
    check('closing an unknown tab fails', error !== undefined, String(error))
    check(
      'and names it as unknown',
      /no browser tab/.test(String(error?.message)),
      String(error?.message),
    )
  }

  // ---------------------------------------------------------------------
  // The provider must advertise every method the Host can call.
  // ---------------------------------------------------------------------
  {
    const world = makeWorld([{ sessionId: SESSION, tabId: 'tab1', guest: makeGuest({}) }])
    const bundle = loadBundle(world)
    const names = bundle.provider.manifest.methods.map((method) => method.name)
    check('the manifest declares closeTab', names.includes('closeTab'), names)
    const act = bundle.provider.manifest.methods.find((method) => method.name === 'act')
    check(
      'the act action enum includes reload',
      act?.inputSchema.properties.action.enum.includes('reload'),
      act?.inputSchema.properties.action.enum,
    )
    check(
      'the act schema accepts ignoreCache',
      Object.hasOwn(act?.inputSchema.properties ?? {}, 'ignoreCache'),
      Object.keys(act?.inputSchema.properties ?? {}),
    )
  }

  clearTimeout(watchdog)
  console.log(failures === 0 ? '\nALL RESILIENCE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  clearTimeout(watchdog)
  console.error('resilience check crashed:', error)
  process.exit(1)
})
