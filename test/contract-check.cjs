// Verify that every tool's REAL result shape survives the two things the tool
// registry does to a successful result, in order:
//
//   1. a lossless-JSON detach (own keys holding `undefined` reject the value), and
//   2. output-schema validation against the tool's declared schema.
//
// Both stages are driven by the application's own code, so this cannot drift from
// the installed build. It exists because a green schema-check proved nothing:
// `browser_viewport` read omitted a required `tabId`, and both screenshot
// fallbacks emitted `base64: undefined`, so a documented read call and every
// graceful screenshot degradation threw `ToolOutputError` at runtime.
//
// Run with ELECTRON_RUN_AS_NODE=1 so Electron's asar support can read app.asar.
const { asarToolsPath, asarValuesPath, pluginFile, fileUrl } = require('./paths.cjs')

const ASAR_TOOLS = asarToolsPath()
const PLUGIN = pluginFile('index.js')
const CLIENT = pluginFile('client.js')

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log('ok  ', label)
  else {
    console.error('FAIL', label, detail === undefined ? '' : JSON.stringify(detail))
    failures++
  }
}

/**
 * Load the registry's own lossless-JSON validator.
 *
 * `snapshotJsonValue` is the exact function `createSuccessResult` runs before
 * output-schema validation: it returns `undefined` for any value JSON would not
 * round-trip, including an own key holding `undefined`. Importing it from the
 * packaged install keeps this check honest instead of approximating the rule.
 * @returns the validator, or undefined when it cannot be located.
 */
async function loadLosslessJsonValidator() {
  try {
    const module = await import(fileUrl(asarValuesPath()))
    return typeof module.snapshotJsonValue === 'function' ? module.snapshotJsonValue : undefined
  } catch {
    return undefined
  }
}

/**
 * Register every Host tool definition by running the plugin's apply().
 *
 * `services` supplies what the tool bodies reach for through `ctx.get`: the
 * inspect registry their calls go through, and the attachment store. Filling
 * those in is what lets this suite drive the Host's REAL execute path — including
 * the screenshot degradation branches — instead of restating their output shape
 * by hand, which would keep passing after the code drifted.
 * @param services - `{ cordisInspect, attachments }`.
 * @returns the registered definitions.
 */
async function captureTools(services = {}) {
  const registered = []
  const fakeTools = {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
    guard() {
      return () => {}
    },
  }
  const values = { ...services }
  const fakeCtx = {
    get: (key) => values[key],
    inject: (_deps, callback) => callback({ tools: fakeTools, effect: (fn) => fn() }),
  }
  const plugin = await import(fileUrl(PLUGIN))
  // enableEval so `browser_eval` is registered too and gets the same treatment.
  plugin.apply(fakeCtx, { enableEval: true })
  return registered
}

/**
 * Load the browser half and return its provider, wired to a fake DOM.
 *
 * The provider uses the REAL driver and the REAL viewport controller, which is
 * the point: the result shapes under test are the ones production produces, not
 * ones a stub was told to produce.
 */
function loadProvider({ dom, openTabs, sidebarRightExtra = {} }) {
  const vm = require('node:vm')
  const fs = require('node:fs')

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
    Math,
    Date,
    Error,
    Promise,
    Symbol,
    CSS: { escape: (value) => value },
    atob: (value) => Buffer.from(value, 'base64').toString('binary'),
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
        if (match) return dom.roots.find((root) => root.dataset.sidebarRightSession === match[1]) ?? null
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

  const requireStub = (spec) => {
    if (spec === 'react') {
      return { useState: () => [undefined, () => {}], useSyncExternalStore: () => undefined, Fragment: 'fragment' }
    }
    if (spec === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null }
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return {}
    if (spec === '@deepseek-ai/dsh-client-store') {
      // A functional stand-in for the real store engine: the controller's
      // `select()` really writes through `actions`, so empty actions would make
      // this suite unable to exercise the write path at all. Snapshot identity
      // is stable between mutations, as the real store guarantees.
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
  }
  const exports = captured.factory(requireStub)
  const sidebarRight = {
    openTabs: { getSnapshot: () => openTabs },
    openTab: () => {},
    ...sidebarRightExtra,
  }
  const store = exports.__viewport.viewportStore.create()
  const controller = new exports.__viewport.ViewportController(store)
  return { provider: exports.buildProvider({ sidebarRight, get: () => undefined }, controller), exports, store, controller }
}

/** A fake element with the surface the driver and controller touch. */
function makeElement(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    style: { cssText: '' },
    dataset: {},
    children: [],
    parentElement: null,
    clientWidth: 800,
    clientHeight: 700,
    isConnected: true,
    getBoundingClientRect: () => ({ width: el.clientWidth, height: el.clientHeight }),
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    appendChild(child) {
      child.parentElement = el
      el.children.push(child)
      return child
    },
    isLoading: () => false,
    getURL: () => 'https://example.test/',
    getTitle: () => 'Example',
    loadURL: async () => {},
    executeJavaScript: async () => ({ url: 'https://example.test/', title: 'Example', readyState: 'complete' }),
  }
  return el
}

/**
 * Install a canned page-result on a stubbed guest, while keeping the viewport
 * probe honest.
 *
 * The real guest answers `executeJavaScript` by running the code, so its
 * `window.innerWidth` follows its own element box. A stub that returns one fixed
 * object for every call would make `pageWidth` silently undefined — the very
 * fact this suite exists to check. So the probe is answered from the declared
 * element width, exactly as the real carrier behaves, and everything else gets
 * the canned payload.
 * @param guest - the stubbed webview element.
 * @param value - what a page helper should return.
 */
function setPageResult(guest, value) {
  guest.executeJavaScript = async (code) => {
    if (typeof code === 'string' && code.includes('window.innerWidth')) return readViewportProbe(guest)
    return value
  }
}

/**
 * What a guest reports for `window.innerWidth`/`innerHeight`: its own box, which
 * is what makes a sized element a sized viewport.
 * @param guest - the stubbed webview element.
 * @returns `{ w, h }`.
 */
function readViewportProbe(guest) {
  const declaredWidth = /width:(\d+)px/.exec(guest.style.cssText ?? '')
  const declaredHeight = /height:(\d+)px/.exec(guest.style.cssText ?? '')
  return {
    w: declaredWidth ? Number(declaredWidth[1]) : guest.clientWidth,
    h: declaredHeight ? Number(declaredHeight[1]) : guest.clientHeight,
  }
}

/**
 * Build a sidebar DOM with one browser tab.
 * @param options - carrier ('webview' or 'iframe'), whether it is mounted.
 */
function makeDom({ sessionId = 's1', tabId = 'tab1', carrier = 'webview', mounted = true } = {}) {
  const guest = makeElement(carrier === 'webview' ? 'webview' : 'iframe')
  guest.dataset.sidebarBrowserFrame = carrier
  setPageResult(guest, {
    url: 'https://example.test/',
    title: 'Example',
    readyState: 'complete',
    body: { innerText: 'Hello' },
    documentElement: { outerHTML: '<html/>' },
  })

  const container = makeElement('div')
  if (mounted) container.appendChild(guest)

  const wrapper = makeElement('div')
  wrapper.dataset.sidebarRightTab = tabId
  wrapper.appendChild(container)
  wrapper.closest = (selector) => (selector === '[data-sidebar-right-session]' ? sessionRoot : null)
  wrapper.querySelector = (selector) => {
    if (selector.includes('webview')) return carrier === 'webview' ? guest : null
    if (selector.includes('iframe')) return carrier === 'iframe' ? guest : null
    return null
  }

  const sessionRoot = makeElement('div')
  sessionRoot.dataset.sidebarRightSession = sessionId
  sessionRoot.appendChild(wrapper)
  sessionRoot.querySelectorAll = (selector) =>
    selector === '[data-sidebar-right-tab]' ? [wrapper] : []

  return { guest, container, wrapper, sessionRoot, roots: mounted ? [sessionRoot] : [] }
}

async function main() {
  const tools = await import(fileUrl(ASAR_TOOLS))
  const { validateJsonSchemaValue } = tools
  const snapshot = await loadLosslessJsonValidator()
  check(
    'the registry lossless-JSON validator was located',
    typeof snapshot === 'function',
    'snapshotJsonValue unavailable — this suite cannot judge anything without it',
  )
  if (typeof snapshot !== 'function') {
    console.error('\nCANNOT CONTINUE without the real lossless-JSON walker')
    process.exit(1)
  }

  const registered = await captureTools()
  const byName = Object.fromEntries(registered.map((definition) => [definition.name, definition]))
  console.log('\nregistered tools:', registered.map((d) => d.name).join(', '))

  /**
   * Run one result through both registry stages.
   * @returns a list of human-readable failures (empty when accepted).
   */
  const registryVerdict = (name, value) => {
    const problems = []
    // Stage 1: the lossless-JSON detach.
    let detached
    try {
      detached = snapshot(value)
    } catch (error) {
      problems.push(`lossless-JSON walk threw: ${error.message}`)
      return problems
    }
    if (detached === undefined) {
      problems.push('rejected by the lossless-JSON walk (an own key holds undefined, or a value is not JSON)')
      return problems
    }
    // Stage 2: the declared output schema.
    const definition = byName[name]
    const violations = validateJsonSchemaValue(definition.output.schema, detached, 'value')
    problems.push(...violations.map((violation) => `schema: ${violation}`))
    return problems
  }

  const assertAccepted = (label, name, value) => {
    const problems = registryVerdict(name, value)
    check(label, problems.length === 0, problems)
  }

  // ---------------------------------------------------------------------
  // browser_tabs — including both carriers and an unmounted tab.
  // ---------------------------------------------------------------------
  {
    const dom = makeDom({})
    const { provider } = loadProvider({
      dom,
      openTabs: [
        { sessionId: 's1', tabId: 'tab1', kind: 'browser', contentId: 'c' },
        { sessionId: 's1', tabId: 'tab2', kind: 'browser', contentId: 'd' },
      ],
      sidebarRightExtra: { commandTarget: () => ({ sessionId: 's1', tabId: 'tab1' }) },
    })
    const result = await provider.query('listTabs', {}, { sessionId: 's1' })
    assertAccepted('browser_tabs result passes both registry stages', 'browser_tabs', result)
    const mounted = result.tabs.find((tab) => tab.tabId === 'tab1')
    const absent = result.tabs.find((tab) => tab.tabId === 'tab2')
    check('browser_tabs reports the carrier of a mounted tab', mounted?.carrier === 'webview', mounted)
    check('browser_tabs omits carrier for an unmounted tab', absent?.carrier === undefined, absent)
    check(
      'browser_tabs marks the app-reported active tab active',
      mounted?.active === true && absent?.active === false,
      result.tabs,
    )
  }

  // `commandTarget` is not a contract this plugin can assume, so a missing or
  // throwing implementation must degrade the listing rather than fail it.
  for (const [label, sidebarRightExtra] of [
    ['absent', {}],
    [
      'throwing',
      {
        commandTarget: () => {
          throw new Error('no on-screen surface')
        },
      },
    ],
  ]) {
    const dom = makeDom({})
    const { provider } = loadProvider({
      dom,
      openTabs: [{ sessionId: 's1', tabId: 'tab1', kind: 'browser', contentId: 'c' }],
      sidebarRightExtra,
    })
    let result
    try {
      result = await provider.query('listTabs', {}, { sessionId: 's1' })
    } catch (error) {
      check(`browser_tabs survives a ${label} commandTarget`, false, error.message)
      continue
    }
    assertAccepted(`browser_tabs with a ${label} commandTarget passes both registry stages`, 'browser_tabs', result)
    check(
      `a ${label} commandTarget degrades active to the mounted tab`,
      result.tabs[0]?.active === true && result.tabs[0]?.mounted === true,
      result.tabs,
    )
  }

  // ---------------------------------------------------------------------
  // browser_viewport — BOTH the explicit and the omitted-tabId read. This is
  // the regression guard for the read path that threw ToolOutputError.
  // ---------------------------------------------------------------------
  {
    const dom = makeDom({})
    const { provider } = loadProvider({
      dom,
      openTabs: [{ sessionId: 's1', tabId: 'tab1', kind: 'browser', contentId: 'c' }],
    })
    const named = await provider.query('getViewport', { tabId: 'tab1' }, { sessionId: 's1' })
    assertAccepted('getViewport {tabId} result passes both registry stages', 'browser_viewport', named)
    check('getViewport {tabId} reports the tab', named.tabId === 'tab1', named)

    const implicit = await provider.query('getViewport', {}, { sessionId: 's1' })
    assertAccepted('getViewport {} (tabId omitted) result passes both registry stages', 'browser_viewport', implicit)
    check(
      'getViewport {} resolves the only mounted tab instead of omitting tabId',
      implicit.tabId === 'tab1',
      implicit,
    )

    // A named tab that does not exist must be refused, not answered as empty.
    try {
      await provider.query('getViewport', { tabId: 'nope' }, { sessionId: 's1' })
      check('getViewport with an unknown tabId is refused', false, 'it returned a result instead')
    } catch (error) {
      check(
        'getViewport with an unknown tabId is refused',
        /no browser tab "nope"/.test(error.message),
        error.message,
      )
    }

    const set = await provider.query('setViewport', { preset: 'phone' }, { sessionId: 's1' })
    assertAccepted('setViewport {} result passes both registry stages', 'browser_viewport', set)
    check('setViewport resolves the only tab', set.tabId === 'tab1', set)
  }

  // ---------------------------------------------------------------------
  // browser_read — all three modes, with hidden elements present and the cap
  // not reached.
  // ---------------------------------------------------------------------
  {
    const dom = makeDom({})
    const { provider } = loadProvider({
      dom,
      openTabs: [{ sessionId: 's1', tabId: 'tab1', kind: 'browser', contentId: 'c' }],
    })
    dom.guest.executeJavaScript = async () => ({
      url: 'https://example.test/',
      title: 'Example',
      text: 'Hello',
      html: '<html/>',
      elements: [{ ref: 'e1', tag: 'button', type: '', text: 'Go', name: '', value: '', disabled: false }],
      // The page helper reports the cap, which this result shape must carry.
      truncated: false,
    })
    for (const mode of ['text', 'html', 'elements']) {
      const result = await provider.query('read', { mode }, { sessionId: 's1' })
      assertAccepted(`browser_read ${mode} result passes both registry stages`, 'browser_read', result)
    }
  }

  // ---------------------------------------------------------------------
  // browser_act, browser_navigate, browser_eval.
  // ---------------------------------------------------------------------
  {
    const dom = makeDom({})
    const { provider } = loadProvider({
      dom,
      openTabs: [{ sessionId: 's1', tabId: 'tab1', kind: 'browser', contentId: 'c' }],
    })
    dom.guest.executeJavaScript = async () => ({ ok: true, tag: 'button', text: 'Go', url: 'https://example.test/', title: 'Example', readyState: 'complete' })
    const acted = await provider.query('act', { action: 'click', ref: 'e1' }, { sessionId: 's1' })
    assertAccepted('browser_act result passes both registry stages', 'browser_act', acted)

    const navigated = await provider.query('navigate', { tabId: 'tab1', url: 'https://example.test/' }, { sessionId: 's1' })
    assertAccepted('browser_navigate result passes both registry stages', 'browser_navigate', navigated)

    dom.guest.executeJavaScript = async () => ({ value: 2, kind: 'number', url: 'https://example.test/', title: 'Example', readyState: 'complete' })
    const evaluated = await provider.query('eval', { code: '1+1' }, { sessionId: 's1' })
    assertAccepted('browser_eval result passes both registry stages', 'browser_eval', evaluated)

    // A statement body must run rather than being refused as a syntax error.
    dom.guest.executeJavaScript = async () => ({ value: 3, kind: 'number', url: 'https://example.test/', title: 'Example', readyState: 'complete' })
    const statements = await provider.query('eval', { code: 'const a = 1; a + 2' }, { sessionId: 's1' })
    assertAccepted('browser_eval with statements passes both registry stages', 'browser_eval', statements)
  }

  // ---------------------------------------------------------------------
  // browser_screenshot — the success shape, then the Host's REAL degradation
  // branches driven through the registered tool body. The degradations are the
  // regression guard: they used to carry `base64: undefined`, which the
  // lossless-JSON stage rejects outright, so "degrade gracefully" threw instead.
  // ---------------------------------------------------------------------
  {
    const dom = makeDom({})
    const { provider } = loadProvider({
      dom,
      openTabs: [{ sessionId: 's1', tabId: 'tab1', kind: 'browser', contentId: 'c' }],
    })
    dom.guest.capturePage = async () => ({
      getSize: () => ({ width: 10, height: 10 }),
      resize: () => ({ getSize: () => ({ width: 10, height: 10 }), toDataURL: () => 'data:image/png;base64,AAAA' }),
      toDataURL: () => 'data:image/png;base64,AAAA',
    })
    const shot = await provider.query('screenshot', {}, { sessionId: 's1' })
    // Spread the real result rather than hand-listing fields: rebuilding it here
    // is what let a required field drift out of the check unnoticed.
    assertAccepted('browser_screenshot success result passes both registry stages', 'browser_screenshot', {
      ...shot,
      image: [{ type: 'image', attachment: 'sha256:x' }],
    })
    check('screenshot returns PNG bytes and dimensions', shot.base64 === 'AAAA' && shot.width === 10, shot)

    // A preset applied by the capture itself: the model should not have to move
    // the viewport and screenshot in two calls, and the answer must report the
    // size it actually used so a wrong-size capture is visible.
    const sized = await provider.query('screenshot', { preset: 'desktop' }, { sessionId: 's1' })
    assertAccepted('browser_screenshot with a preset passes both registry stages', 'browser_screenshot', sized)
    check(
      'screenshot with a preset reports the size it captured at',
      sized.preset === 'desktop' && sized.pageWidth === 1280 && sized.scale !== undefined,
      sized,
    )
    check(
      'screenshot with a preset really resized the guest',
      dom.guest.style.cssText.includes('width:1280px'),
      dom.guest.style.cssText,
    )

    // The mobile case this guidance exists for.
    const mobile = await provider.query('screenshot', { preset: 'phone' }, { sessionId: 's1' })
    check(
      'screenshot with preset phone captures at a real phone width',
      mobile.preset === 'phone' && mobile.pageWidth === 390,
      mobile,
    )

    // An unknown preset must be refused rather than silently ignored, so a typo
    // cannot produce a capture at an unintended size.
    try {
      await provider.query('screenshot', { preset: 'smrtphone' }, { sessionId: 's1' })
      check('screenshot refuses an unknown preset', false, 'it returned a result instead')
    } catch (error) {
      check('screenshot refuses an unknown preset', /unknown viewport preset/.test(error.message), error.message)
    }

    /** Drive the Host's screenshot body with the given attachment store. */
    /**
     * Drive the Host's screenshot body with the given attachment store.
     * @param attachments - the store, or undefined for the no-store branch.
     * @param base64 - what the driver reported capturing.
     * @param extra - extra driver-reported fields, e.g. the viewport report.
     */
    const runScreenshot = async (attachments, base64, extra = {}) => {
      const definitions = await captureTools({
        // The provider call is answered locally: this check is about the Host's
        // result shaping, and the driver has its own suites.
        cordisInspect: {
          query: async () => ({
            tabId: 'tab1',
            url: 'https://example.test/',
            title: 'Example',
            width: 10,
            height: 10,
            mediaType: 'image/png',
            // The real driver always reports this, from describe(): a successful
            // capture is only reachable when the load did NOT fail.
            failed: false,
            base64,
            ...extra,
          }),
        },
        attachments,
      })
      const definition = definitions.find((entry) => entry.name === 'browser_screenshot')
      return await definition.execute({}, { agent: { id: 'a' }, signal: undefined })
    }

    // Branch 1: no attachment store mounted. The captured bytes are dropped and
    // the result explains why, rather than failing.
    const noStore = await runScreenshot(undefined, 'AAAA')
    assertAccepted(
      'browser_screenshot without an attachment store passes both registry stages',
      'browser_screenshot',
      noStore,
    )
    check(
      'browser_screenshot without a store still returns the tab identity',
      noStore.tabId === 'tab1' && typeof noStore.note === 'string',
      noStore,
    )

    // Branch 2: the store refuses the image (the oversized-screenshot case).
    const refusing = {
      saveImage: async () => {
        throw new Error('Image exceeds the configured byte limit.')
      },
    }
    const refused = await runScreenshot(refusing, 'AAAA')
    assertAccepted(
      'browser_screenshot after a refused save passes both registry stages',
      'browser_screenshot',
      refused,
    )
    check(
      'browser_screenshot after a refused save reports the reason',
      /could not be delivered as an image/.test(refused.note ?? ''),
      refused,
    )

    // And the success branch, through the same body, must still produce an image
    // block rather than a note — and must carry the viewport report through, so
    // the model can see which size was actually captured. The Host used to
    // rebuild this object field by field, which silently dropped those facts.
    const saving = { saveImage: async () => 'sha256:x' }
    const saved = await runScreenshot(saving, 'AAAA', {
      tabId: 'tab1',
      url: 'https://example.test/',
      title: 'Example',
      width: 10,
      height: 10,
      mediaType: 'image/png',
      preset: 'phone',
      pageWidth: 390,
      pageHeight: 844,
      scale: 0.62,
    })
    check(
      'browser_screenshot with a store returns an image block',
      Array.isArray(saved.image) && saved.image[0]?.type === 'image',
      saved,
    )
    check('browser_screenshot with a store emits no note', saved.note === undefined, saved)
    check(
      'browser_screenshot success result keeps the viewport it captured at',
      saved.preset === 'phone' && saved.pageWidth === 390 && saved.scale === 0.62,
      saved,
    )
    check(
      'browser_screenshot success result carries no base64 or undefined',
      saved.base64 === undefined && Object.values(saved).every((value) => value !== undefined),
      saved,
    )
  }

  // ---------------------------------------------------------------------
  // Web profile: an iframe carrier is mounted but not drivable, and the tools
  // must say THAT rather than claiming the tab is unmounted.
  // ---------------------------------------------------------------------
  {
    const dom = makeDom({ carrier: 'iframe' })
    const { provider } = loadProvider({
      dom,
      openTabs: [{ sessionId: 's1', tabId: 'tab1', kind: 'browser', contentId: 'c' }],
    })
    const listed = await provider.query('listTabs', {}, { sessionId: 's1' })
    assertAccepted('browser_tabs reports an iframe carrier', 'browser_tabs', listed)
    check(
      'an iframe tab is reported as mounted, not missing',
      listed.tabs[0]?.mounted === true && listed.tabs[0]?.carrier === 'iframe',
      listed.tabs,
    )
    for (const [method, input, what] of [
      ['read', { mode: 'text' }, 'read'],
      ['act', { action: 'click', selector: '#x' }, 'interact'],
      ['screenshot', {}, 'capture'],
      ['eval', { code: '1' }, 'script'],
    ]) {
      try {
        await provider.query(method, input, { sessionId: 's1' })
        check(`${method} on a Web-profile iframe is refused`, false, 'it returned a result instead')
      } catch (error) {
        check(
          `${method} on a Web-profile iframe names the Web profile`,
          /Web profile/.test(error.message) && /iframe/.test(error.message),
          error.message,
        )
        void what
      }
    }
  }

  // ---------------------------------------------------------------------
  // The elements cap: hidden matches must not be reported as truncation, while
  // genuinely exceeding the cap must be.
  // ---------------------------------------------------------------------
  {
    const vm = require('node:vm')
    const fs = require('node:fs')
    const source = fs.readFileSync(CLIENT, 'utf8')
    // Lift pageReadElements out of the bundle and run it against a DOM stub, so
    // the flag's real computation is what gets judged.
    const start = source.indexOf('function pageReadElements(')
    let depth = 0
    let end = -1
    for (let i = source.indexOf('{', start); i < source.length; i++) {
      if (source[i] === '{') depth++
      else if (source[i] === '}') {
        depth--
        if (depth === 0) {
          end = i + 1
          break
        }
      }
    }
    const pageReadElementsSrc = source.slice(start, end)

    const makeEl = (props = {}) => ({
      tagName: (props.tag ?? 'button').toUpperCase(),
      isConnected: true,
      value: '',
      innerText: props.text ?? 'x',
      textContent: props.text ?? 'x',
      disabled: false,
      labels: [],
      attributes: {},
      getAttribute: () => null,
      getClientRects: () => (props.hidden ? [] : [{}]),
      querySelector: () => null,
    })

    const run = (elements, max) => {
      const sandbox = {
        document: { querySelectorAll: () => elements, title: 'T' },
        location: { href: 'https://x/' },
        getComputedStyle: (el) => ({ visibility: 'visible', display: 'block', opacity: el.hiddenFlag ? '0' : '1' }),
        Map,
        Array,
        Object,
        JSON,
        String,
        Number,
      }
      sandbox.window = sandbox
      vm.createContext(sandbox)
      return vm.runInContext(`(() => { ${pageReadElementsSrc}\nreturn pageReadElements(${max}) })()`, sandbox)
    }

    const hiddenOne = makeEl({ hidden: true })
    hiddenOne.hiddenFlag = true
    const withHidden = run([makeEl({ text: 'Go' }), hiddenOne], 300)
    check(
      'hidden matches are not reported as truncation',
      withHidden.truncated === false,
      withHidden,
    )

    const many = Array.from({ length: 5 }, (_, index) => makeEl({ text: 'b' + index }))
    const capped = run(many, 3)
    check('hitting the element cap reports truncation', capped.truncated === true, capped)
    check('the cap bounds the returned elements', capped.elements.length === 3, capped.elements.length)
  }

  // ---------------------------------------------------------------------
  // The Host's transport-error mapping. The registry's real diagnostics must be
  // recognized as "not reachable", while a cancellation and a schema
  // disagreement must NOT be — dressing either as a Session problem would send
  // the model looking for a fix that cannot exist.
  // ---------------------------------------------------------------------
  {
    /** Drive browser_tabs with a registry that fails using `message`. */
    const withFailure = async (message) => {
      const definitions = await captureTools({
        cordisInspect: {
          query: async () => {
            throw new Error(message)
          },
        },
      })
      const definition = definitions.find((entry) => entry.name === 'browser_tabs')
      try {
        await definition.execute({}, { agent: { id: 'a' }, signal: undefined })
        return { threw: false }
      } catch (error) {
        return { threw: true, message: error.message }
      }
    }

    const unreachable = [
      'AgentBrowser.listTabs: Client Cordis inspect provider "AgentBrowser" is not registered',
      'AgentBrowser.read: Client inspect query AgentBrowser.read has no connected Harness page. Open or reconnect the Harness page, then retry.',
      'AgentBrowser.read: Client inspect query AgentBrowser.read timed out after 10000ms. Open or reconnect the Harness page, then retry.',
      'AgentBrowser.read: Client inspect provider "AgentBrowser" has no method "read"',
    ]
    for (const message of unreachable) {
      const outcome = await withFailure(message)
      check(
        `the Host maps a reachability failure to guidance: ${message.slice(0, 46)}…`,
        outcome.threw && /not reachable from this Session/.test(outcome.message),
        outcome.message,
      )
    }

    const passedThrough = [
      'AgentBrowser.read: Client inspect query AgentBrowser.read was cancelled',
      'Client Cordis inspect read rejected input: "value.tabId" is required',
    ]
    for (const message of passedThrough) {
      const outcome = await withFailure(message)
      check(
        `the Host passes through a non-reachability failure: ${message.slice(0, 46)}…`,
        outcome.threw && !/not reachable from this Session/.test(outcome.message) && outcome.message.includes(message),
        outcome.message,
      )
    }

    // A provider that ANSWERED with a failure is neither unreachable nor the
    // Session's fault, and reporting it as either buries the only real diagnosis.
    // Measured live: every screenshot failure was explained as "the browser is not
    // reachable; use a Desktop Session" while `browser_read` worked against the
    // same tab on that same Desktop Session — the browser was fine and the
    // provider's own reason (a capture timeout, and separately an Electron
    // GUEST_VIEW_MANAGER_CALL UnknownVizError) was what mattered. Note the shape:
    // the provider answer is WRAPPED in the channel's `timed out after …`, so a
    // classifier that tests for "timed out" first swallows the diagnosis.
    const answered = [
      'AgentBrowser.screenshot: Client inspect query AgentBrowser.screenshot timed out after 60000ms. Client failure: provider-error: the screenshot did not answer within 13s.',
      "AgentBrowser.screenshot: Client inspect query AgentBrowser.screenshot timed out after 60000ms. Client failure: provider-error: Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: UnknownVizError.",
    ]
    for (const message of answered) {
      const outcome = await withFailure(message)
      check(
        `the Host surfaces a provider failure instead of blaming reachability: ${message.slice(-40)}…`,
        outcome.threw &&
          !/not reachable from this Session/.test(outcome.message) &&
          !/Use a Desktop Session/.test(outcome.message) &&
          outcome.message.includes('Client failure:'),
        outcome.message,
      )
    }
  }

  console.log(failures === 0 ? '\nALL CONTRACT CHECKS PASSED' : `\n${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('ERROR', error)
  process.exit(1)
})
