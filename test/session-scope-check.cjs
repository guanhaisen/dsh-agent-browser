// Verify that opening a browser tab is addressed to the CALLING Session.
//
// The bug this guards was found live and is invisible from a single-Conversation
// test: `sidebarRight.openTab` is the ON-SCREEN entry, resolving its Session from
// `sidebarRight.mounted` and ignoring who asked. With two Conversations each
// driving their own project's dev server, a tool call from the Conversation that
// was NOT on screen created its tab inside the other Conversation's Sidebar.
// That Conversation's Agent then found the tab in its own inventory and drove a
// page belonging to the other project, while the calling Agent polled its own
// inventory, never saw the tab, and reported the misleading "has not mounted yet".
//
// So the assertions here are about SCOPING, not about tab creation succeeding:
// the Session-addressed entry must receive the caller's Session, and a tab that
// lands in another Conversation must be reported as exactly that.
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

/** A stubbed Electron webview guest with the surface the driver touches. */
function makeGuest(url) {
  return {
    tagName: 'WEBVIEW',
    style: { cssText: '' },
    dataset: { sidebarBrowserFrame: 'webview' },
    isConnected: true,
    isLoading: () => false,
    getURL: () => url,
    getTitle: () => 'Example',
    loadURL: async () => {},
    executeJavaScript: async () => ({ url, title: 'Example', readyState: 'complete' }),
  }
}

/** A tab body wrapper: how the driver maps a tabId to its guest. */
function makeWrapper(tabId, guest, root) {
  return {
    dataset: { sidebarRightTab: tabId },
    querySelector: (selector) => (selector.includes('webview') ? guest : null),
    closest: (selector) => (selector === '[data-sidebar-right-session]' ? root : null),
  }
}

/** A Session's Sidebar root, as the builtin tags it. */
function makeRoot(sessionId) {
  const root = {
    dataset: { sidebarRightSession: sessionId },
    wrappers: [],
    querySelectorAll: (selector) => (selector === '[data-sidebar-right-tab]' ? root.wrappers : []),
  }
  return root
}

/**
 * A two-Conversation world: real Sidebar roots, and the open-tab inventory the
 * builtin publishes. `addTab` is how a stub open is made to look like a real one.
 */
function makeWorld() {
  const roots = new Map()
  const openTabs = []
  const ensureRoot = (sessionId) => {
    if (!roots.has(sessionId)) roots.set(sessionId, makeRoot(sessionId))
    return roots.get(sessionId)
  }
  const addTab = (sessionId, tabId, url) => {
    const root = ensureRoot(sessionId)
    const guest = makeGuest(url)
    root.wrappers.push(makeWrapper(tabId, guest, root))
    openTabs.push({ sessionId, tabId, kind: 'browser', contentId: url })
    return guest
  }
  return { roots, openTabs, addTab, ensureRoot }
}

/**
 * Load the browser half with stub modules and a DOM that follows `world`.
 * @param world - from {@link makeWorld}.
 * @returns the bundle's exports.
 */
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
  return captured.factory((spec) => {
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
          create: () => ({
            actions: {},
            getSnapshot: () => decl.init(),
            subscribe: () => () => {},
            store: { getSnapshot: () => decl.init() },
            clearPersisted: () => {},
          }),
        }),
      }
    }
    throw new Error(`unexpected require("${spec}")`)
  })
}

/** A viewport stub: these checks never exercise sizing. */
const viewportStub = {
  apply: () => undefined,
  applyAll: () => undefined,
  describe: async (sessionId, tabId) => ({ tabId, preset: 'auto' }),
  select: async (sessionId, tabId) => ({ tabId, preset: 'auto' }),
  frameOf: () => undefined,
  forget: () => {},
}

const CALLER = 's-caller'
const OTHER = 's-other'

async function main() {
  // ---------------------------------------------------------------------
  // The fix: a new tab is opened through the Session-addressed entry.
  // ---------------------------------------------------------------------
  {
    const world = makeWorld()
    const bundle = loadBundle(world)
    const calls = []
    const sidebarRight = {
      openTabs: { getSnapshot: () => world.openTabs },
      // The on-screen Conversation is the OTHER one — the whole point.
      mounted: { getSnapshot: () => OTHER },
      openTab: () => { calls.push({ entry: 'openTab' }) },
      openTabIn: (sessionId, kind, options) => {
        calls.push({ entry: 'openTabIn', sessionId, kind, options })
        world.addTab(sessionId, 'tab-new', options?.params?.url)
      },
    }
    const provider = bundle.buildProvider({ sidebarRight, get: () => undefined }, viewportStub)
    const result = await provider.query(
      'navigate',
      { url: 'http://localhost:5173/' },
      { sessionId: CALLER },
    )

    check(
      'a new tab is opened through the Session-addressed entry',
      calls.length === 1 && calls[0].entry === 'openTabIn',
      calls,
    )
    check(
      'the tab is opened in the CALLING Session, not the on-screen one',
      calls[0]?.sessionId === CALLER && calls[0]?.sessionId !== OTHER,
      calls[0],
    )
    check('the open names the browser tab type', calls[0]?.kind === 'browser', calls[0])
    check(
      'the requested url reaches the open call',
      calls[0]?.options?.params?.url === 'http://localhost:5173/',
      calls[0]?.options,
    )
    check(
      'the on-screen entry is not used when the Session-addressed one exists',
      calls.every((call) => call.entry !== 'openTab'),
      calls,
    )
    check(
      'the created tab is returned to the caller',
      result?.tabId === 'tab-new' && result?.url === 'http://localhost:5173/',
      result,
    )
    check(
      'no tab was created in the other Conversation',
      world.openTabs.every((tab) => tab.sessionId === CALLER),
      world.openTabs,
    )
  }

  // ---------------------------------------------------------------------
  // The leak itself: a tab that lands in another Conversation must be named as
  // such. Before the fix this surfaced as "has not mounted yet", which pointed
  // the caller at the wrong thing entirely.
  // ---------------------------------------------------------------------
  {
    const world = makeWorld()
    const bundle = loadBundle(world)
    const sidebarRight = {
      openTabs: { getSnapshot: () => world.openTabs },
      mounted: { getSnapshot: () => OTHER },
      openTab: () => {},
      // Deliberately ignores the Session it was handed: the pre-fix behaviour.
      openTabIn: (_sessionId, _kind, options) => {
        world.addTab(OTHER, 'tab-stray', options?.params?.url)
      },
    }
    const provider = bundle.buildProvider({ sidebarRight, get: () => undefined }, viewportStub)
    let error
    try {
      await provider.query('navigate', { url: 'http://localhost:5173/' }, { sessionId: CALLER })
    } catch (thrown) {
      error = thrown
    }
    check('a cross-Conversation open fails instead of silently succeeding', error !== undefined)
    check(
      'the failure names the other Conversation',
      /another Conversation/.test(String(error?.message)) && /s-other/.test(String(error?.message)),
      String(error?.message),
    )
    check(
      'the failure does not claim the tab merely has not mounted',
      !/has not mounted/.test(String(error?.message)),
      String(error?.message),
    )
  }

  // ---------------------------------------------------------------------
  // Legacy shells: with no Session-addressed entry, the on-screen one is only
  // safe when the on-screen Session IS the caller. Otherwise refusing is better
  // than writing into a Conversation that did not ask.
  // ---------------------------------------------------------------------
  {
    const world = makeWorld()
    const bundle = loadBundle(world)
    const calls = []
    const sidebarRight = {
      openTabs: { getSnapshot: () => world.openTabs },
      mounted: { getSnapshot: () => OTHER },
      openTab: (kind, options) => {
        calls.push({ kind, options })
        world.addTab(OTHER, 'tab-legacy', options?.params?.url)
      },
    }
    const provider = bundle.buildProvider({ sidebarRight, get: () => undefined }, viewportStub)
    let error
    try {
      await provider.query('navigate', { url: 'http://localhost:5173/' }, { sessionId: CALLER })
    } catch (thrown) {
      error = thrown
    }
    check('without the Session-addressed entry, a mismatch is refused', error !== undefined)
    check(
      'the refusal explains the tab would land elsewhere',
      /another Conversation/.test(String(error?.message)),
      String(error?.message),
    )
    check('the on-screen entry is not called on a mismatch', calls.length === 0, calls)
  }

  // The same legacy shell IS safe when the caller is the on-screen Session.
  {
    const world = makeWorld()
    const bundle = loadBundle(world)
    const calls = []
    const sidebarRight = {
      openTabs: { getSnapshot: () => world.openTabs },
      mounted: { getSnapshot: () => CALLER },
      openTab: (kind, options) => {
        calls.push({ kind, options })
        world.addTab(CALLER, 'tab-legacy', options?.params?.url)
      },
    }
    const provider = bundle.buildProvider({ sidebarRight, get: () => undefined }, viewportStub)
    const result = await provider.query(
      'navigate',
      { url: 'http://localhost:5173/' },
      { sessionId: CALLER },
    )
    check('a matching legacy shell still opens a tab', calls.length === 1, calls)
    check('the legacy open returns the created tab', result?.tabId === 'tab-legacy', result)
  }

  console.log(failures === 0 ? '\nALL SESSION SCOPE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('session scope check crashed:', error)
  process.exit(1)
})
