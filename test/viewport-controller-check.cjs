// Drive ViewportController against a fake DOM, to prove the sizing actually
// lands on the guest element and its container.
//
// This is the part unit tests of the pure math cannot reach: which element gets
// which inline style, what happens when the guest is missing, and that auto mode
// removes the styles it previously set.
const vm = require('node:vm')
const fs = require('node:fs')
const { join } = require('node:path')

const CLIENT = join(__dirname, '..', 'client.js')

/** A stand-in element with just the surface the controller touches. */
function makeElement(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    style: { cssText: '' },
    dataset: {},
    children: [],
    parentElement: null,
    clientWidth: 0,
    clientHeight: 0,
    getBoundingClientRect: () => ({ width: el.clientWidth, height: el.clientHeight }),
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    appendChild(child) {
      child.parentElement = el
      el.children.push(child)
      return child
    },
    // Mirrors the real thing: the page's innerWidth follows the element's box,
    // so a fixed-width guest reports that width back to describe().
    executeJavaScript: async () => {
      const declared = /width:(\d+)px/.exec(el.style.cssText)
      const width = declared ? Number(declared[1]) : el.clientWidth
      return { w: width, h: 800 }
    },
  }
  return el
}

/** Build a fake sidebar DOM holding one browser tab. */
function makeDom({ sessionId = 's1', tabId = 'tab1', containerWidth = 800, containerHeight = 700, mounted = true } = {}) {
  const guest = makeElement('webview')
  guest.dataset.sidebarBrowserFrame = 'webview'
  // In auto mode the guest fills its container, so its own width tracks it.
  guest.clientWidth = containerWidth

  const container = makeElement('div')
  container.clientWidth = containerWidth
  container.clientHeight = containerHeight
  if (mounted) container.appendChild(guest)

  const tabWrapper = makeElement('div')
  tabWrapper.dataset.sidebarRightTab = tabId
  tabWrapper.appendChild(container)

  const sessionRoot = makeElement('div')
  sessionRoot.dataset.sidebarRightSession = sessionId
  sessionRoot.appendChild(tabWrapper)

  const roots = mounted ? [sessionRoot] : []
  return { guest, container, tabWrapper, sessionRoot, roots }
}

function loadBundle(dom) {
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
    ResizeObserver: class {
      constructor(callback) {
        this.callback = callback
      }
      observe() {}
      disconnect() {}
    },
    localStorage: {
      store: new Map(),
      getItem(key) {
        return this.store.has(key) ? this.store.get(key) : null
      },
      setItem(key, value) {
        this.store.set(key, String(value))
      },
      removeItem(key) {
        this.store.delete(key)
      },
    },
    document: {
      querySelector(selector) {
        const match = /^\[data-sidebar-right-session="([^"]*)"\]$/.exec(selector)
        if (match) return dom.roots.find((root) => root.dataset.sidebarRightSession === match[1]) ?? null
        return null
      },
      querySelectorAll: () => [],
      createElement: (tag) => makeElement(tag),
    },
  }
  sandbox.document.querySelector = (selector) => {
    const match = /^\[data-sidebar-right-session="([^"]*)"\]$/.exec(selector)
    if (match) return dom.roots.find((root) => root.dataset.sidebarRightSession === match[1]) ?? null
    return null
  }
  // The controller walks [data-sidebar-right-tab] under the session root.
  for (const root of dom.roots) {
    root.querySelectorAll = (selector) =>
      selector === '[data-sidebar-right-tab]' ? root.children.filter((c) => c.dataset.sidebarRightTab !== undefined) : []
    for (const wrapper of root.children) {
      wrapper.querySelector = (selector) =>
        selector === 'webview[data-sidebar-browser-frame="webview"]'
          ? (wrapper.children[0]?.children[0] ?? null)
          : null
    }
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), sandbox, { filename: 'client.js' })

  const requireStub = (spec) => {
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
          }),
        }),
      }
    }
    throw new Error(`unexpected require("${spec}")`)
  }
  return captured.factory(requireStub)
}

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log('ok  ', label)
  else {
    console.error('FAIL', label, detail === undefined ? '' : JSON.stringify(detail))
    failures++
  }
}

const { ViewportController } = loadBundle(makeDom()).__viewport

/** Build a controller over a fresh DOM with a controllable store. */
function harness({ containerWidth = 800, preset = 'auto', custom, mounted = true } = {}) {
  const dom = makeDom({ containerWidth, mounted })
  const bundle = loadBundle(dom)
  const state = { byTab: { tab1: { preset } }, custom: custom ?? { width: 390, height: 844 }, lastPreset: 'auto' }
  const store = {
    getSnapshot: () => state,
    subscribe: () => () => {},
    actions: {
      set(tabId, next) {
        state.byTab[tabId] = { preset: next }
      },
      setCustom(size) {
        state.custom = size
      },
    },
  }
  return { dom, state, controller: new bundle.__viewport.ViewportController(store) }
}

// --- auto mode -------------------------------------------------------------
{
  const { dom, controller } = harness({ preset: 'auto', containerWidth: 800 })
  const frame = controller.apply('s1', 'tab1')
  check('auto reports scale 1', frame.scale === 1, frame)
  check('auto leaves the guest unstyled', dom.guest.style.cssText === '', dom.guest.style.cssText)
  check('auto clears container clipping', dom.container.style.overflow === '', dom.container.style.overflow)
  check('auto reports the column width as the viewport', frame.viewportWidth === 800, frame)
}

// --- phone in a wide column ------------------------------------------------
{
  const { dom, controller } = harness({ preset: 'phone', containerWidth: 800 })
  const frame = controller.apply('s1', 'tab1')
  check('phone sets a true 390px element width', dom.guest.style.cssText.includes('width:390px'), dom.guest.style.cssText)
  check('phone does not shrink when the column is wider', frame.scale === 1, frame)
  check('phone clips the container', dom.container.style.overflow === 'hidden', dom.container.style.overflow)
  check('phone reports 390 as the viewport width', frame.viewportWidth === 390, frame)
}

// --- desktop in a narrow column (the headline case) ------------------------
{
  // 1280×800 into a 640×700 column: scale 0.5, so the drawn page is 640×400.
  const { dom, controller } = harness({ preset: 'desktop', containerWidth: 640, containerHeight: 700 })
  const frame = controller.apply('s1', 'tab1')
  check('desktop still renders at a true 1280px width', dom.guest.style.cssText.includes('width:1280px'), dom.guest.style.cssText)
  check('desktop scales down to fit the column', Math.abs(frame.scale - 0.5) < 1e-9, frame)
  check(
    'desktop scales by the computed factor',
    dom.guest.style.cssText.includes('scale(0.5)'),
    dom.guest.style.cssText,
  )
  check('desktop anchors the transform at the top left', dom.guest.style.cssText.includes('transform-origin:top left'), dom.guest.style.cssText)
  // The element box IS the page's viewport, so its height must be the true
  // target height. Scaling it up to fill the column would stretch the viewport
  // (a "1280×800" preset laying out 1571px tall) and break `100vh`; this
  // assertion pins that down.
  check('desktop keeps the true target height', dom.guest.style.cssText.includes('height:800px'), dom.guest.style.cssText)
  check('desktop never stretches the viewport to fill the column', !dom.guest.style.cssText.includes('height:1600px'), dom.guest.style.cssText)
  check('desktop stops the guest from flexing', dom.guest.style.cssText.includes('flex:none'), dom.guest.style.cssText)
  check('desktop reports the target width, not the scaled one', frame.viewportWidth === 1280, frame)

  // Centring: 640-wide column, 640-wide drawn page -> no horizontal offset.
  // 700-tall column, 400-tall drawn page -> 150px of top offset.
  check('desktop centres horizontally when the scaled page fills the width', frame.offsetX === 0, frame)
  check('desktop centres vertically when the scaled page fits', frame.offsetY === 150, frame)
  check('desktop reports vertical centring', frame.verticallyCentered === true, frame)
  check(
    'the translate precedes the scale so offsets stay unscaled',
    /transform:translate\(0\.00px, 150\.00px\) scale\(0\.5\)/.test(dom.guest.style.cssText),
    dom.guest.style.cssText,
  )
}

// --- a tall preset in a short column is top-anchored, not clipped -----------
{
  // 390×844 into 800×300: scale 1, drawn height 844 > 300, so it must NOT be
  // vertically centred (that would clip the top of the document).
  const { dom, controller } = harness({ preset: 'phone', containerWidth: 800, containerHeight: 300 })
  const frame = controller.apply('s1', 'tab1')
  check('a too-tall page is not vertically centred', frame.verticallyCentered === false, frame)
  check('a too-tall page keeps zero top offset', frame.offsetY === 0, frame)
  check(
    'a too-tall page is still centred horizontally',
    frame.offsetX === 205,
    frame,
  )
  check(
    'the too-tall page carries only a horizontal translate',
    /transform:translate\(205\.00px, 0\.00px\) scale\(1\)/.test(dom.guest.style.cssText),
    dom.guest.style.cssText,
  )
}

// --- centring is a no-op when nothing needs shrinking or offsetting ---------
{
  const { dom, controller } = harness({ preset: 'phone', containerWidth: 390, containerHeight: 844 })
  const frame = controller.apply('s1', 'tab1')
  check('an exactly-fitting page has no offsets', frame.offsetX === 0 && frame.offsetY === 0, frame)
  check(
    'an exactly-fitting page emits no translate at all',
    dom.guest.style.cssText.includes('transform:scale(1)'),
    dom.guest.style.cssText,
  )
}

// --- stale flex centring is cleared ----------------------------------------
// Found live via a geometry probe: a container left with flex centring by an
// earlier build double-counts against the transform's translate and shoves the
// page off to one side (gapLeft −271 vs gapRight 272). Applying must correct it
// in place, without needing a fresh page load.
{
  const { dom, controller } = harness({ preset: 'desktop', containerWidth: 640, containerHeight: 700 })
  dom.container.style.display = 'flex'
  dom.container.style.alignItems = 'center'
  dom.container.style.justifyContent = 'center'
  const frame = controller.apply('s1', 'tab1')
  check('a stale flex display is cleared', dom.container.style.display === '', dom.container.style.display)
  check('stale align-items is cleared', dom.container.style.alignItems === '', dom.container.style.alignItems)
  check('stale justify-content is cleared', dom.container.style.justifyContent === '', dom.container.style.justifyContent)
  check('the transform still carries the centring', frame.offsetY === 150, frame)
}

// --- switching back to auto removes the styles -----------------------------
{
  const { dom, state, controller } = harness({ preset: 'desktop', containerWidth: 640 })
  controller.apply('s1', 'tab1')
  check('desktop styled the guest before switching', dom.guest.style.cssText !== '')
  state.byTab.tab1 = { preset: 'auto' }
  const frame = controller.apply('s1', 'tab1')
  check('switching to auto clears the guest styles', dom.guest.style.cssText === '', dom.guest.style.cssText)
  check('switching to auto clears container clipping', dom.container.style.overflow === '', dom.container.style.overflow)
  check('switching to auto reports scale 1', frame.scale === 1, frame)
}

// --- custom size -----------------------------------------------------------
{
  const { dom, controller } = harness({ preset: 'custom', custom: { width: 500, height: 900 }, containerWidth: 1000 })
  const frame = controller.apply('s1', 'tab1')
  check('custom uses the stored width', dom.guest.style.cssText.includes('width:500px'), dom.guest.style.cssText)
  check('custom reports its own preset', frame.preset === 'custom', frame)
  check('custom keeps scale 1 in a wide column', frame.scale === 1, frame)
}

// --- a broken custom size falls back --------------------------------------
{
  const { controller } = harness({ preset: 'custom', custom: { width: 'nonsense' }, containerWidth: 800 })
  const frame = controller.apply('s1', 'tab1')
  check('a broken custom size falls back to phone', frame.preset === 'phone', frame)
  check('the fallback is reported to the caller', frame.fellBack === 'bad-width', frame)
}

// --- unmounted guest -------------------------------------------------------
{
  const { controller } = harness({ preset: 'phone', mounted: false })
  const frame = controller.apply('s1', 'tab1')
  check('an unmounted guest applies nothing', frame === undefined, frame)
  // The stored choice must survive so it can be applied when the tab mounts.
  check('the choice is still readable while unmounted', controller.frameOf('tab1') === undefined)
}

// --- an unknown tab --------------------------------------------------------
{
  const { controller } = harness({ preset: 'phone' })
  check('an unknown tab id applies nothing', controller.apply('s1', 'nope') === undefined)
}

// --- forget ----------------------------------------------------------------
{
  const { controller } = harness({ preset: 'phone' })
  controller.apply('s1', 'tab1')
  check('the frame is readable after apply', controller.frameOf('tab1') !== undefined)
  controller.forget('tab1')
  check('forget drops the frame', controller.frameOf('tab1') === undefined)
  check('forget on an unknown tab is safe', controller.forget('never-seen') === undefined)
}

// --- a tab whose guest left the document is pruned -------------------------
// Nothing outside the controller reliably reports a tab close, so without this
// the map and one ResizeObserver per tab id lived for the whole page lifetime —
// and `frameOf` kept answering for a tab that no longer existed, which is how the
// menu could quote a display scale for a closed tab.
{
  const { dom, controller } = harness({ preset: 'desktop', containerWidth: 640, containerHeight: 700 })
  controller.apply('s1', 'tab1')
  check('the frame is readable while the guest is connected', controller.frameOf('tab1') !== undefined)
  check('nothing is pruned while the guest is connected', controller.pruneDetached() === 0)

  // The built-in removes the guest element from the document on close.
  dom.guest.isConnected = false
  check('a detached guest is pruned', controller.pruneDetached() === 1)
  check('a pruned tab stops reporting a frame', controller.frameOf('tab1') === undefined)
  check('pruning is idempotent', controller.pruneDetached() === 0)

  // Re-applying for the same (now absent) tab must not resurrect the frame.
  dom.guest.isConnected = true
  controller.apply('s1', 'tab1')
  check('a re-applied tab reports its frame again', controller.frameOf('tab1') !== undefined)
}

// --- a carrier without isConnected is left alone ---------------------------
// The guard is `=== false` on purpose: a stub or future carrier that does not
// expose `isConnected` must not be pruned just for being different.
{
  const { dom, controller } = harness({ preset: 'phone', containerWidth: 800 })
  controller.apply('s1', 'tab1')
  delete dom.guest.isConnected
  check('a guest without isConnected is not pruned', controller.pruneDetached() === 0)
  check('its frame survives', controller.frameOf('tab1') !== undefined)
}

// --- describe --------------------------------------------------------------
async function describeChecks() {
  const { controller } = harness({ preset: 'phone', containerWidth: 800 })
  const described = await controller.describe('s1', 'tab1')
  check('describe reports the stored preset', described.preset === 'phone', described)
  // The page lays out at the fixed element width, not the wider column.
  check('describe reads the real page width from the guest', described.pageWidth === 390, described)
  check('describe reports mounted', described.mounted === true, described)

  const { controller: autoController } = harness({ preset: 'auto', containerWidth: 800 })
  const autoDescribed = await autoController.describe('s1', 'tab1')
  check('describe follows the column width in auto mode', autoDescribed.pageWidth === 800, autoDescribed)

  const { controller: unmounted } = harness({ preset: 'phone', mounted: false })
  const absent = await unmounted.describe('s1', 'tab1')
  check('describe reports an unmounted tab as not mounted', absent.mounted === false, absent)
  check('describe still reports the stored preset when unmounted', absent.preset === 'phone', absent)
}

describeChecks().then(() => {
  console.log(failures === 0 ? '\nALL VIEWPORT CONTROLLER CHECKS PASSED' : `\n${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
})
