// Verify the browser half without a live DSH page:
//   1. the Inspect provider manifest passes the real schema validator
//   2. pageCall() produces valid JS that really invokes the page helper
//   3. guest lookup correlates data-sidebar-right-tab -> webview in a stub DOM
//
// Run with ELECTRON_RUN_AS_NODE=1 so Electron's asar support can read app.asar.
const vm = require('node:vm')
const fs = require('node:fs')

const ASAR_TOOLS = 'D:/App/DeepSeekHarness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
const CLIENT = 'D:/VibeCoding/Deepseek/dsh/plugins/dsh-agent-browser/client.js'

/** Minimal fake DOM sufficient for the driver's lookup logic. */
function makeFakeDom({ sessionId, tabs }) {
  // Each tab: { tabId, guest } where guest is null for an unmounted tab.
  const wrappers = tabs.map((tab) => {
    const wrapper = {
      dataset: { sidebarRightTab: tab.tabId },
      closest(selector) {
        if (selector === '[data-sidebar-right-session]') return sessionRoot
        return null
      },
      querySelector(selector) {
        if (selector.includes('webview') && tab.guest) return tab.guest
        return null
      },
    }
    return wrapper
  })
  const sessionRoot = {
    dataset: { sidebarRightSession: sessionId },
    querySelectorAll(selector) {
      if (selector === '[data-sidebar-right-tab]') return wrappers
      return []
    },
  }
  const document = {
    querySelector(selector) {
      if (selector.includes('data-sidebar-right-session')) return sessionRoot
      return null
    },
    querySelectorAll(selector) {
      if (selector === '[data-sidebar-right-tab]') return wrappers
      return []
    },
  }
  return { document, sessionRoot }
}

async function main() {
  const tools = await import('file:///' + ASAR_TOOLS.replace(/\\/g, '/'))
  const { assertSupportedJsonSchema } = tools

  // --- Load the browser half through a stub module loader -------------------
  let captured
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          captured = registration
        },
      },
    },
    console,
    setTimeout,
    clearTimeout,
    Map,
    Set,
    Array,
    Object,
    JSON,
    String,
    Number,
    Boolean,
    Error,
    Promise,
    CSS: { escape: (value) => value },
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
  }
  sandbox.globalThis = sandbox
  const source = fs.readFileSync(CLIENT, 'utf8')
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })

  if (!captured || captured.id !== 'dsh-agent-browser') {
    console.error('FAIL: the bundle did not register id "dsh-agent-browser"')
    process.exit(1)
  }
  console.log('ok   bundle registered id:', captured.id)

  /** Stub the shell-provided seed modules the bundle imports. */
  const stubRequire = (spec) => {
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
          create: () => ({ actions: {}, getSnapshot: () => decl.init(), subscribe: () => () => {} }),
        }),
      }
    }
    throw new Error(`unexpected require("${spec}")`)
  }

  const exports = captured.factory(stubRequire)
  for (const key of ['apply', 'inject']) {
    if (exports[key] === undefined) {
      console.error(`FAIL: client bundle does not export ${key}`)
      process.exit(1)
    }
  }
  console.log('ok   client exports:', Object.keys(exports).join(', '))
  console.log('ok   client inject:', JSON.stringify(exports.inject))

  // --- Provider manifest against the real validator -------------------------
  const sidebarRight = {
    openTabs: { getSnapshot: () => [] },
    openTab: () => {},
  }
  // The viewport controller has its own suite (viewport-check.cjs); the provider
  // tests pass a stub so they stay focused on the agent-facing methods.
  const viewportStub = {
    apply: () => undefined,
    applyAll: () => undefined,
    describe: async (sessionId, tabId) => ({ tabId, preset: 'auto' }),
    select: async (sessionId, input) => ({ preset: input.preset }),
    frameOf: () => undefined,
    forget: () => {},
  }
  const provider = exports.buildProvider({ sidebarRight, get: () => undefined }, viewportStub)
  if (provider.manifest.id !== 'AgentBrowser') {
    console.error('FAIL: provider id is', provider.manifest.id)
    process.exit(1)
  }
  let failures = 0
  for (const method of provider.manifest.methods) {
    try {
      assertSupportedJsonSchema(method.inputSchema)
      assertSupportedJsonSchema(method.outputSchema)
      console.log(`ok   manifest ${provider.manifest.id}.${method.name}`)
    } catch (error) {
      console.error(`FAIL manifest ${method.name}: ${error.message}`)
      failures++
    }
  }

  // --- pageCall source generation ------------------------------------------
  // Reach the internal helper indirectly: drive a fake guest and inspect the
  // code the driver hands to executeJavaScript.
  const executed = []
  const fakeGuest = {
    executeJavaScript(code) {
      executed.push(code)
      return Promise.resolve({ url: 'https://example.test/', title: 'Example', readyState: 'complete' })
    },
    isLoading: () => false,
    getURL: () => 'https://example.test/',
    getTitle: () => 'Example',
  }

  const dom = makeFakeDom({
    sessionId: 'session-1',
    tabs: [
      { tabId: 'tab-a', guest: fakeGuest },
      { tabId: 'tab-b', guest: null },
    ],
  })
  sandbox.document = dom.document

  const ctx = {
    sidebarRight: {
      openTabs: {
        getSnapshot: () => [
          { sessionId: 'session-1', tabId: 'tab-a', kind: 'browser', contentId: 'a' },
          { sessionId: 'session-1', tabId: 'tab-b', kind: 'browser', contentId: 'b' },
          { sessionId: 'session-1', tabId: 'tab-x', kind: 'terminal', contentId: 'x' },
        ],
      },
      openTab: () => {},
    },
  }
  const live = exports.buildProvider(ctx, viewportStub)

  const tabs = await live.query('listTabs', {}, { sessionId: 'session-1' })
  const browserTabs = tabs.tabs.map((tab) => tab.tabId)
  if (browserTabs.join(',') !== 'tab-a,tab-b') {
    console.error('FAIL: listTabs should report only browser tabs, got', browserTabs.join(','))
    failures++
  } else {
    console.log('ok   listTabs filters to kind=browser:', browserTabs.join(', '))
  }
  const mounted = tabs.tabs.find((tab) => tab.tabId === 'tab-a')
  const unmounted = tabs.tabs.find((tab) => tab.tabId === 'tab-b')
  if (mounted?.mounted !== true || unmounted?.mounted !== false) {
    console.error('FAIL: mounted flags wrong', JSON.stringify(tabs.tabs))
    failures++
  } else {
    console.log('ok   mounted flag distinguishes DOM presence')
  }

  // Exactly one mounted tab -> tabId may be omitted.
  const read = await live.query('read', { mode: 'text' }, { sessionId: 'session-1' })
  if (read.tabId !== 'tab-a') {
    console.error('FAIL: implicit tabId should pick the single mounted tab, got', read.tabId)
    failures++
  } else {
    console.log('ok   implicit tabId resolves the single mounted tab')
  }

  // The generated source must be valid JS and must actually call the helper.
  const code = executed[executed.length - 1]
  try {
    new vm.Script(code)
    console.log('ok   generated page source parses as JavaScript')
  } catch (error) {
    console.error('FAIL: generated page source does not parse:', error.message)
    failures++
  }
  if (!/return \(pageReadText\)\(/.test(code)) {
    console.error('FAIL: generated source does not invoke the requested helper')
    failures++
  } else {
    console.log('ok   generated source invokes the requested helper')
  }
  // The IIFE must contain the sibling helper pageResolve for the act helpers.
  if (!/function pageResolve/.test(code)) {
    console.error('FAIL: generated source omits pageResolve, so act helpers would fail')
    failures++
  } else {
    console.log('ok   generated source carries the sibling helpers')
  }

  // Naming a tab that exists but is not mounted must fail with guidance.
  try {
    await live.query('read', { tabId: 'tab-b' }, { sessionId: 'session-1' })
    console.error('FAIL: reading an unmounted tab should throw')
    failures++
  } catch (error) {
    console.log('ok   unmounted tab rejected:', error.message.slice(0, 70) + '…')
  }

  // A Session with no Agent identity must be refused, not guessed.
  try {
    await live.query('listTabs', {}, {})
    console.error('FAIL: a Session-less query should throw')
    failures++
  } catch (error) {
    console.log('ok   Session-less query rejected:', error.message.slice(0, 60) + '…')
  }

  console.log(failures === 0 ? '\nALL CLIENT CHECKS PASSED' : `\n${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('ERROR', error)
  process.exit(1)
})
