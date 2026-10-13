// Verify the viewport sizing math and validation, plus the client bundle's
// shape, without a live DSH page.
//
// The pure helpers are reached by loading the browser half through a stub
// module loader, exactly as test/client-check.cjs does.
const vm = require('node:vm')
const fs = require('node:fs')
const { join } = require('node:path')

const CLIENT = join(__dirname, '..', 'client.js')

/** Load the browser half with stub modules and return its exports. */
function loadBundle() {
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
    Math,
    CSS: { escape: (value) => value },
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ style: {}, dataset: {}, appendChild() {}, setAttribute() {} }),
    },
  }
  sandbox.globalThis = sandbox
  sandbox.window.document = sandbox.document
  vm.createContext(sandbox)
  vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), sandbox, { filename: 'client.js' })

  if (!captured) throw new Error('bundle did not register with __ModuleLoader__')
  // `react` and friends are only needed by the components, not the pure helpers,
  // so a throwing require is fine for this test's purposes.
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
          create: () => ({
            actions: {},
            getSnapshot: () => decl.init(),
            subscribe: () => () => {},
          }),
        }),
      }
    }
    throw new Error(`unexpected require("${spec}")`)
  })
  return exports
}

const bundle = loadBundle()
const internals = bundle.__viewport

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log('ok  ', label)
  else {
    console.error('FAIL', label, detail === undefined ? '' : JSON.stringify(detail))
    failures++
  }
}

// --- computeScale ----------------------------------------------------------
const {
  computeScale,
  computePlacement,
  normalizeViewportSize,
  resolveViewport,
  VIEWPORT_LIMITS,
  VIEWPORT_PRESETS,
} = internals

check('scale is 1 when the column is wider than the target', computeScale(390, 800) === 1)
check('scale is 1 at exactly the target width', computeScale(390, 390) === 1)
check('scale shrinks when the column is narrower', Math.abs(computeScale(1280, 640) - 0.5) < 1e-9)
check('scale handles a very narrow column', Math.abs(computeScale(1280, 320) - 0.25) < 1e-9)
check('scale guards a zero target', computeScale(0, 500) === 1)
check('scale guards a zero column', computeScale(1280, 0) === 1)
check('scale guards NaN', computeScale(Number.NaN, 500) === 1 && computeScale(1280, Number.NaN) === 1)
check('scale guards negative input', computeScale(-100, 500) === 1 && computeScale(1280, -5) === 1)

// --- normalizeViewportSize -------------------------------------------------
check('clamps below the minimum width', normalizeViewportSize({ width: 10, height: 844 }).width === VIEWPORT_LIMITS.minWidth)
check('clamps above the maximum width', normalizeViewportSize({ width: 99999, height: 844 }).width === VIEWPORT_LIMITS.maxWidth)
check('clamps below the minimum height', normalizeViewportSize({ width: 390, height: 1 }).height === VIEWPORT_LIMITS.minHeight)
check('clamps above the maximum height', normalizeViewportSize({ width: 390, height: 99999 }).height === VIEWPORT_LIMITS.maxHeight)
check('rounds fractional input', normalizeViewportSize({ width: 390.6, height: 844.4 }).width === 391)
check('refuses a non-numeric width', normalizeViewportSize({ width: 'x', height: 844 }).reason === 'bad-width')
check('refuses a missing height', normalizeViewportSize({ width: 390 }).reason === 'bad-height')
check('refuses NaN', normalizeViewportSize({ width: Number.NaN, height: 844 }).reason === 'bad-width')
check('refuses Infinity', normalizeViewportSize({ width: Infinity, height: 844 }).reason === 'bad-width')
check('refuses a non-object', normalizeViewportSize(null).reason === 'not-an-object')

// --- resolveViewport -------------------------------------------------------
check('auto resolves without dimensions', resolveViewport({ preset: 'auto' }).width === undefined)
check('phone resolves to 390x844', resolveViewport({ preset: 'phone' }).width === 390)
check('desktop resolves to 1280x800', resolveViewport({ preset: 'desktop' }).width === 1280)
check('an unknown preset falls back to auto', resolveViewport({ preset: 'nope' }).preset === 'auto')
check('a missing selection falls back to auto', resolveViewport(undefined).preset === 'auto')
check('custom uses the stored size', resolveViewport({ preset: 'custom', custom: { width: 500, height: 900 } }).width === 500)
const badCustom = resolveViewport({ preset: 'custom', custom: { width: 'x' } })
check('a broken custom size falls back to phone', badCustom.preset === 'phone' && badCustom.fellBack === 'bad-width')

// --- preset table sanity ---------------------------------------------------
const ids = VIEWPORT_PRESETS.map((entry) => entry.id)
check('every preset id is unique', new Set(ids).size === ids.length)
check('presets include auto, phone, tablet, desktop, custom', ['auto', 'phone', 'tablet', 'desktop', 'custom'].every((id) => ids.includes(id)))
check(
  'every sized preset is inside the accepted limits',
  VIEWPORT_PRESETS.filter((entry) => entry.width !== undefined).every(
    (entry) =>
      entry.width >= VIEWPORT_LIMITS.minWidth &&
      entry.width <= VIEWPORT_LIMITS.maxWidth &&
      entry.height >= VIEWPORT_LIMITS.minHeight &&
      entry.height <= VIEWPORT_LIMITS.maxHeight,
  ),
  VIEWPORT_PRESETS,
)

// --- computePlacement ------------------------------------------------------
// The scaled page must sit in the MIDDLE of the column, not pinned to a corner.
{
  // 1280×800 into 640×700: scale 0.5 -> 640×400 drawn, 0 across, 150 down.
  const placed = computePlacement(1280, 800, 640, 700)
  check('placement scales to fit the width', Math.abs(placed.scale - 0.5) < 1e-9, placed)
  check('placement reports the scaled size', placed.scaledWidth === 640 && placed.scaledHeight === 400, placed)
  check('placement needs no horizontal offset when the width fits exactly', placed.offsetX === 0, placed)
  check('placement centres vertically when there is room', placed.offsetY === 150, placed)
  check('placement reports vertical centring', placed.verticallyCentered === true, placed)
}

{
  // Width is not the binding constraint here: 390 into 800 leaves 205px a side.
  const placed = computePlacement(390, 844, 800, 1200)
  check('placement centres a narrower page horizontally', placed.offsetX === 205, placed)
  check('placement centres it vertically too', placed.offsetY === (1200 - 844) / 2, placed)
}

{
  // A page taller than the column must NOT be vertically centred: that would
  // clip the top of the document, hiding where reading starts.
  const placed = computePlacement(390, 844, 800, 300)
  check('placement refuses to centre a too-tall page', placed.verticallyCentered === false, placed)
  check('placement top-anchors a too-tall page', placed.offsetY === 0, placed)
  check('placement still centres a too-tall page horizontally', placed.offsetX === 205, placed)
}

{
  // Exactly fitting: no offsets at all, so no needless translate is emitted.
  const placed = computePlacement(390, 844, 390, 844)
  check('placement adds no offsets for an exact fit', placed.offsetX === 0 && placed.offsetY === 0, placed)
}

{
  // Degenerate input must not produce NaN offsets, which would invalidate CSS.
  const placed = computePlacement(1280, 800, 0, 0)
  check(
    'placement never yields NaN offsets',
    Number.isFinite(placed.offsetX) && Number.isFinite(placed.offsetY),
    placed,
  )
  const negative = computePlacement(1280, 800, -5, -5)
  check(
    'placement clamps negative geometry to zero',
    negative.offsetX === 0 && negative.offsetY === 0,
    negative,
  )
}

// --- setViewport dispatch wiring -------------------------------------------
// Guards a bug found live: the provider called `select(sessionId, input)` while
// the controller signature is `select(sessionId, tabId, input)`, so the options
// bag landed in the tabId slot and every set failed with "reading 'preset'".
async function dispatchChecks() {
  const calls = []
  const recording = {
    apply: () => undefined,
    applyAll: () => undefined,
    describe: async (sessionId, tabId) => ({ tabId, preset: 'auto' }),
    select: async (...args) => {
      calls.push(args)
      return { preset: args[2]?.preset }
    },
    frameOf: () => undefined,
    forget: () => {},
  }
  const sidebarRight = {
    openTabs: { getSnapshot: () => [{ sessionId: 's1', tabId: 'tab-9', kind: 'browser', contentId: 'c' }] },
    openTab: () => {},
  }
  const provider = bundle.buildProvider({ sidebarRight, get: () => undefined }, recording)

  // An explicit tabId must arrive in the tabId slot, not the options slot.
  await provider.query('setViewport', { tabId: 'tab-9', preset: 'phone' }, { sessionId: 's1' })
  check(
    'setViewport forwards tabId and options in the right slots',
    calls.length === 1 && calls[0][0] === 's1' && calls[0][1] === 'tab-9' && calls[0][2]?.preset === 'phone',
    calls,
  )

  // Omitting tabId in a single-tab Session must still resolve that tab.
  calls.length = 0
  await provider.query('setViewport', { preset: 'desktop' }, { sessionId: 's1' })
  check(
    'setViewport resolves the only tab when tabId is omitted',
    calls.length === 1 && calls[0][1] === 'tab-9' && calls[0][2]?.preset === 'desktop',
    calls,
  )

  // A read must not reach the write path.
  calls.length = 0
  const read = await provider.query('getViewport', { tabId: 'tab-9' }, { sessionId: 's1' })
  check('getViewport never calls select', calls.length === 0, calls)
  check('getViewport reports the requested tab', read.tabId === 'tab-9', read)

  // Every viewport method the Host tool can name must exist on the manifest.
  const names = provider.manifest.methods.map((method) => method.name)
  check('manifest declares getViewport and setViewport', names.includes('getViewport') && names.includes('setViewport'), names)
}

// --- provider surface ------------------------------------------------------
check('provider still exposes the agent methods', typeof bundle.buildProvider === 'function')
check('client injects the services the viewport UI needs', ['cordisInspect', 'sidebarRight', 'slots', 'shortcuts', 'locale'].every((key) => bundle.inject.includes(key)), bundle.inject)

dispatchChecks().then(() => {
  console.log(failures === 0 ? '\nALL VIEWPORT CHECKS PASSED' : `\n${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
})
