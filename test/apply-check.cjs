// Run the browser half's apply() against a realistic fake Client context, to
// catch a throw that would take the whole plugin down (including the Inspect
// provider) when the page loads the real bundle.
const vm = require('node:vm')
const fs = require('node:fs')
const { join } = require('node:path')

const CLIENT = join(__dirname, '..', 'client.js')

/** Minimal React stand-in: enough for module scope and component definitions. */
// A stateful `useState` stand-in. Component tests render, invoke a handler that
// sets state, then render again — so the setter has to persist, and each render
// pass has to restart the hook cursor the way React does.
let hookState = []
let hookCursor = 0

/** Restart the hook cursor before a fresh render pass. */
function resetHooks() {
  hookCursor = 0
}

/** Clear all hook state between unrelated scenarios. */
function clearHooks() {
  hookState = []
  hookCursor = 0
}

const ReactStub = {
  useState: (initial) => {
    const index = hookCursor++
    if (!(index in hookState)) hookState[index] = typeof initial === 'function' ? initial() : initial
    return [
      hookState[index],
      (next) => {
        hookState[index] = typeof next === 'function' ? next(hookState[index]) : next
      },
    ]
  },
  useRef: (initial) => ({ current: initial }),
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn(),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useSyncExternalStoreWithSelector: (subscribe, getSnapshot, _server, selector) => selector(getSnapshot()),
  createElement: () => null,
  Fragment: 'fragment',
}

function makeSandbox() {
  const errors = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(registration) {
          sandbox.__captured = registration
        },
      },
    },
    console: {
      log: (...args) => console.log(...args),
      warn: (...args) => console.warn('WARN', ...args),
      error: (...args) => {
        errors.push(args.map(String).join(' '))
        console.error('PAGE-ERROR', ...args)
      },
      info: () => {},
    },
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
    ResizeObserver: class {
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
      key(index) {
        return [...this.store.keys()][index] ?? null
      },
      get length() {
        return this.store.size
      },
    },
  }
  const documentStub = {
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ style: {}, dataset: {}, appendChild() {}, setAttribute() {} }),
    head: { appendChild() {} },
  }
  sandbox.document = documentStub
  sandbox.window.document = documentStub
  sandbox.globalThis = sandbox
  sandbox.__errors = errors
  return sandbox
}

const sandbox = makeSandbox()
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), sandbox, { filename: 'client.js' })

const captured = sandbox.__captured
if (!captured) {
  console.error('FAIL: bundle did not register')
  process.exit(1)
}

const requireStub = (spec) => {
  if (spec === 'react') return ReactStub
  // Build real element trees so tests can walk into the rendered output; the
  // shape mirrors React's `{ type, props }` closely enough to introspect.
  if (spec === 'react/jsx-runtime') {
    return {
      jsx: (type, props) => ({ type, props: props ?? {} }),
      jsxs: (type, props) => ({ type, props: props ?? {} }),
    }
  }
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
    // Components the plugin renders must at least exist as identifiers.
    return new Proxy({}, { get: (_t, prop) => (typeof prop === 'string' ? () => null : undefined) })
  }
  if (spec === '@deepseek-ai/dsh-client-store') {
    return {
      defineStore: (decl) => ({
        spec: decl,
        create: () => ({
          actions: new Proxy({}, { get: () => () => {} }),
          getSnapshot: () => decl.init(),
          subscribe: () => () => {},
          clearPersisted: () => {},
        }),
      }),
    }
  }
  throw new Error(`unexpected require("${spec}")`)
}

const pluginExports = captured.factory(requireStub)

// --- A realistic Client context -------------------------------------------
const registered = { slots: [], shortcuts: [], providers: [], effects: [], locales: [] }

const makeSlotScope = () => ({
  register(options, component) {
    registered.slots.push({ options, component })
    return () => {}
  },
  inject(key, callback) {
    const effect = callback()
    registered.effects.push({ key, effect })
    return () => {}
  },
})

const ctx = {
  effect(fn, label) {
    const disposer = fn()
    registered.effects.push({ label, disposer })
    return () => {}
  },
  get: () => undefined,
  locale: {
    bind: (ns) => {
      const t = (key, params) => {
        if (params === undefined) return key
        return Object.entries(params).reduce((acc, [k, v]) => acc.replaceAll(`{${k}}`, String(v)), key)
      }
      return t
    },
    register(ns, dict) {
      registered.locales.push(ns)
      return () => {}
    },
  },
  slots: makeSlotScope(),
  shortcuts: {
    register(definition) {
      registered.shortcuts.push(definition)
      return () => {}
    },
    get catalog() {
      return []
    },
  },
  sidebarRight: {
    openTabs: { getSnapshot: () => [] },
    openTab: () => {},
    commandTarget: () => undefined,
  },
  cordisInspect: {
    register(provider) {
      registered.providers.push(provider)
      return () => {}
    },
  },
}

let failures = 0
try {
  pluginExports.apply(ctx)
  console.log('ok   apply() completed without throwing')
} catch (error) {
  console.error('FAIL apply() threw:', error?.stack ?? error)
  failures++
}

// The provider must be registered — its absence is what took the live plugin down.
const providerIds = registered.providers.map((p) => p.manifest?.id)
if (providerIds.includes('AgentBrowser')) {
  console.log('ok   AgentBrowser provider registered')
} else {
  console.error('FAIL AgentBrowser provider missing; registered:', providerIds)
  failures++
}

const slotIds = registered.slots.map((entry) => entry.options?.id)
if (slotIds.includes('agent-browser-viewport')) console.log('ok   viewport menu slot registered')
else {
  console.error('FAIL viewport menu slot missing; registered:', slotIds)
  failures++
}
if (slotIds.includes('browser-viewport')) console.log('ok   viewport settings row registered')
else {
  console.error('FAIL viewport settings row missing; registered:', slotIds)
  failures++
}

const shortcutIds = registered.shortcuts.map((entry) => entry.id)
if (shortcutIds.includes('browser.viewport.cycle')) console.log('ok   viewport shortcut registered')
else {
  console.error('FAIL viewport shortcut missing; registered:', shortcutIds)
  failures++
}

// The shortcuts registry reads `definition.defaults[`${runtime}:${platform}`]`
// unconditionally, so a missing `defaults` throws during apply() and takes the
// whole client half down — including the Inspect provider. That was a real live
// outage, so the shape is guarded explicitly here.
for (const entry of registered.shortcuts) {
  if (entry.defaults === null || typeof entry.defaults !== 'object') {
    console.error(`FAIL shortcut "${entry.id}" has no defaults map; registration would throw`)
    failures++
  }
  for (const field of ['id', 'label', 'regions', 'modals', 'resolve']) {
    if (entry[field] === undefined) {
      console.error(`FAIL shortcut "${entry.id}" is missing "${field}"`)
      failures++
    }
  }
}

if (registered.locales.includes('agentBrowser')) console.log('ok   agentBrowser locale registered')
else {
  console.error('FAIL agentBrowser locale missing; registered:', registered.locales)
  failures++
}

// Every slot registration must carry the two-argument component form.
for (const entry of registered.slots) {
  if (typeof entry.component !== 'function') {
    console.error(`FAIL slot "${entry.options?.id}" was registered without a component function`)
    failures++
  }
}

// --- Render the components with stub props to catch render-time throws -----
// The store travels as a plain prop on the inject face rather than as a declared
// `store` handle, because one handle may only be mounted under a single slot
// scope and this plugin uses it from both a session- and a root-scoped slot.
const sampleState = { byTab: {}, custom: { width: 390, height: 844 }, lastPreset: 'auto' }
const viewportStoreStub = {
  getSnapshot: () => sampleState,
  subscribe: () => () => {},
  actions: new Proxy({}, { get: () => () => {} }),
}

// Seed the module-scope runtime the menu and settings row read from closure.
// The components deliberately do not take these as injected props: an undefined
// prop would throw during render, and a thrown entry vanishes silently — with a
// single tab open the kit has no Close item, so the menu would not open at all.
const viewportControllerStub = {
  apply: () => undefined,
  applyAll: () => undefined,
  frameOf: () => undefined,
  findGuest: () => ({}),
  forget: () => {},
}
pluginExports.__viewport.setRuntime({
  store: viewportStoreStub,
  controller: viewportControllerStub,
  sync: () => {},
})

for (const entry of registered.slots) {
  if (entry.options?.store !== undefined) {
    console.error(
      `FAIL slot "${entry.options?.id}" declares a store handle; one handle cannot mount under two scopes`,
    )
    failures++
  }
  try {
    entry.component({
      tab: { id: 'tab1', kind: 'browser' },
      dismiss: () => {},
      t: (key) => key,
    })
    console.log(`ok   rendered slot "${entry.options?.id}"`)
  } catch (error) {
    console.error(`FAIL rendering slot "${entry.options?.id}":`, error?.stack ?? error)
    failures++
  }
}

// The snapshot the components read must be identity-stable: a fresh object per
// call would re-render forever.
if (Object.is(sampleState, sampleState) && Object.is(viewportStoreStub.getSnapshot(), viewportStoreStub.getSnapshot())) {
  console.log('ok   the store snapshot is identity-stable')
} else {
  console.error('FAIL the store snapshot changes identity between calls')
  failures++
}

// The menu component must return null for a non-browser tab.
const menuEntry = registered.slots.find((entry) => entry.options?.id === 'agent-browser-viewport')
if (menuEntry) {
  const result = menuEntry.component({
    tab: { id: 'tab2', kind: 'terminal' },
    dismiss: () => {},
    t: (key) => key,
  })
  if (result === null) console.log('ok   menu renders nothing for a non-browser tab')
  else {
    console.error('FAIL menu should render null for a non-browser tab, got:', result)
    failures++
  }
}

// The low-scale hint must appear only when the page is scaled well below 100%,
// and must carry the real percentage rather than a fixed string.
if (menuEntry) {
  // `sessionId` is a standard slot prop; when present it must be used directly
  // rather than falling back to reading the DOM for the owning Session.
  {
    const applied = []
    pluginExports.__viewport.setRuntime({
      store: viewportStoreStub,
      controller: {
        apply: (sessionId, tabId) => applied.push([sessionId, tabId]),
        frameOf: () => undefined,
        findGuest: () => ({}),
      },
      sync: () => {},
    })
    const rendered = menuEntry.component({
      tab: { id: 'tab1', kind: 'browser' },
      dismiss: () => {},
      t: (key) => key,
      sessionId: 'session-from-prop',
    })
    // Reach the first preset item's onSelect through the rendered element tree.
    const group = rendered?.props?.children?.[0]
    const firstItem = group?.props?.children?.[0]
    if (typeof firstItem?.props?.onSelect === 'function') {
      firstItem.props.onSelect()
      if (applied.some(([sessionId]) => sessionId === 'session-from-prop')) {
        console.log('ok   the menu uses the sessionId slot prop directly')
      } else {
        console.error('FAIL the menu did not use the sessionId prop:', applied)
        failures++
      }
    } else {
      console.error('FAIL could not reach the menu items to exercise a selection')
      failures++
    }
  }

  const renderWithScale = (scale) => {
    const calls = []
    pluginExports.__viewport.setRuntime({
      store: viewportStoreStub,
      controller: { apply: () => undefined, frameOf: () => ({ scale, preset: 'desktop', viewportWidth: 1280 }), findGuest: () => ({}) },
      sync: () => {},
    })
    menuEntry.component({
      tab: { id: 'tab1', kind: 'browser' },
      dismiss: () => {},
      t: (key, params) => {
        calls.push({ key, params })
        return key
      },
    })
    return calls.find((entry) => entry.key === 'viewport.scaleNote')
  }

  const tiny = renderWithScale(0.2)
  if (tiny?.params?.percent === 20) console.log('ok   the low-scale hint reports the real percentage')
  else {
    console.error('FAIL the low-scale hint is missing or wrong at 20%:', tiny)
    failures++
  }

  if (renderWithScale(1) === undefined) console.log('ok   no hint when the page is not shrunk')
  else {
    console.error('FAIL the low-scale hint showed at scale 1')
    failures++
  }

  // The docking kit's tab menu dismisses on ANY pointerdown outside its own
  // element, and `Modal` portals to document.body. A portaled custom-size dialog
  // would therefore destroy itself on first click. The form must be rendered
  // inline and must stop pointer events from escaping to that listener.
  {
    // Start from a clean hook slate, then reset the cursor before each render
    // pass so the component reads the same slots it wrote.
    clearHooks()
    resetHooks()
    pluginExports.__viewport.setRuntime({
      store: viewportStoreStub,
      controller: { apply: () => undefined, frameOf: () => undefined, findGuest: () => ({}) },
      sync: () => {},
    })
    const rendered = menuEntry.component({
      tab: { id: 'tab1', kind: 'browser' },
      dismiss: () => {},
      t: (key) => key,
    })
    // Open the custom form via the "custom" item, which is the last entry.
    const group = rendered?.props?.children?.[0]
    const groupItems = group?.props?.children
    const customItem = Array.isArray(groupItems) ? groupItems[groupItems.length - 1] : undefined
    if (typeof customItem?.props?.onSelect !== 'function') {
      console.error('FAIL could not reach the custom-size menu item')
      failures++
    } else {
      customItem.props.onSelect()
      // Re-render: with customOpen true the form appears after the group.
      resetHooks()
      const withForm = menuEntry.component({
        tab: { id: 'tab1', kind: 'browser' },
        dismiss: () => {},
        t: (key) => key,
      })
      // The stub's jsx does not invoke components, so render the form element
      // itself to reach the handlers it puts on its own root node.
      const formElement = withForm?.props?.children?.[1]
      resetHooks()
      const form =
        formElement !== null && typeof formElement?.type === 'function'
          ? formElement.type(formElement.props)
          : undefined
      const stopsPointerDown = typeof form?.props?.onPointerDown === 'function'
      const stopsClick = typeof form?.props?.onClick === 'function'
      if (stopsPointerDown && stopsClick) {
        // Both handlers must actually stop propagation.
        let stopped = 0
        form.props.onPointerDown({ stopPropagation: () => stopped++ })
        form.props.onClick({ stopPropagation: () => stopped++ })
        if (stopped === 2) console.log('ok   the custom-size form keeps clicks inside the menu')
        else {
          console.error('FAIL the custom-size form does not stop event propagation')
          failures++
        }
      } else {
        console.error('FAIL the custom-size form does not guard pointer events:', {
          stopsPointerDown,
          stopsClick,
        })
        failures++
      }
    }
  }
}

// A restored Session mounts its browser tabs AFTER the plugin loads, so a saved
// preset must be re-applied on a later tick. Drive apply() again with a tab that
// only appears on the second read and assert the effect scheduled work.
{
  let reads = 0
  const appliedTabs = []
  const lateCtx = {
    ...ctx,
    sidebarRight: {
      openTabs: {
        getSnapshot: () => {
          reads++
          // Empty at load, then the restored tab shows up.
          return reads === 1 ? [] : [{ sessionId: 's1', tabId: 'restored', kind: 'browser', contentId: 'c' }]
        },
      },
      openTab: () => {},
      commandTarget: () => undefined,
    },
  }
  const realSetTimeout = sandbox.setTimeout
  const pending = []
  sandbox.setTimeout = (fn, delay) => {
    pending.push({ fn, delay })
    return pending.length
  }
  try {
    // Re-run apply against the late-mounting context.
    pluginExports.apply(lateCtx)
  } finally {
    sandbox.setTimeout = realSetTimeout
  }
  if (pending.length === 0) {
    console.error('FAIL no reconcile was scheduled for a late-mounting tab')
    failures++
  } else {
    console.log(`ok   reconcile scheduled ${pending.length} follow-up passes`)
  }

  // Running the scheduled pass must reach the tab that appeared late.
  const reconcileCalls = []
  sandbox.setTimeout = () => 0
  try {
    const probeCtx = {
      ...lateCtx,
      sidebarRight: {
        ...lateCtx.sidebarRight,
        openTabs: {
          getSnapshot: () => [{ sessionId: 's1', tabId: 'restored', kind: 'browser', contentId: 'c' }],
        },
      },
    }
    // The controller is real here, so a missing guest simply applies nothing;
    // what matters is that the reconcile path runs without throwing.
    pluginExports.apply(probeCtx)
    reconcileCalls.push('ran')
  } catch (error) {
    console.error('FAIL reconcile pass threw:', error?.message ?? error)
    failures++
  } finally {
    sandbox.setTimeout = realSetTimeout
  }
}

// The failure mode that broke this live: the kit only opens a tab's menu when
// its extras are non-empty (`onClose !== undefined || extras.some(g => g !== "")`),
// and with a single tab open the kit contributes no Close item. A component that
// throws therefore removes the menu entirely — no error the user can see. So the
// menu must render with nothing but the owner props the kit actually passes.
if (menuEntry) {
  clearHooks()
  resetHooks()
  try {
    const bare = menuEntry.component({
      tab: { id: 'tab1', kind: 'browser' },
      dismiss: () => {},
      t: (key) => key,
    })
    // A Fragment with a MenuGroup is the shape the kit needs.
    const hasGroup = bare?.props?.children?.[0] !== undefined
    if (hasGroup) console.log('ok   the menu renders with only the owner props the kit passes')
    else {
      console.error('FAIL the menu produced nothing with bare owner props')
      failures++
    }
  } catch (error) {
    console.error('FAIL the menu threw with bare owner props:', error?.stack ?? error)
    failures++
  }

  // And it must survive a runtime that was never seeded, rather than throwing.
  pluginExports.__viewport.setRuntime(undefined)
  clearHooks()
  resetHooks()
  try {
    menuEntry.component({ tab: { id: 'tab1', kind: 'browser' }, dismiss: () => {}, t: (key) => key })
    console.log('ok   the menu does not throw when the runtime is unset')
  } catch (error) {
    console.error('FAIL the menu threw when the runtime was unset:', error?.stack ?? error)
    failures++
  }
  // Restore for any later checks.
  pluginExports.__viewport.setRuntime({
    store: viewportStoreStub,
    controller: viewportControllerStub,
    sync: () => {},
  })
}

  // Regression guard for the bug that shipped: `jsx(type, props, key)` takes the
  // React KEY as its third argument, not children. Passing a label there compiles
  // and renders an EMPTY button — the live menu showed six blank items. Every
  // menu entry must carry its text in `props.children`.
  {
    pluginExports.__viewport.setRuntime({
      store: viewportStoreStub,
      controller: { apply: () => undefined, frameOf: () => undefined, findGuest: () => ({}) },
      sync: () => {},
    })
    clearHooks()
    resetHooks()
    const rendered = menuEntry.component({
      tab: { id: 'tab1', kind: 'browser' },
      dismiss: () => {},
      // Echo the key back so an empty label is detectable.
      t: (key) => key,
    })
    const group = rendered?.props?.children?.[0]
    const items = group?.props?.children ?? []
    const unlabelled = items.filter((item) => {
      const children = item?.props?.children
      return typeof children !== 'string' || children.trim() === ''
    })
    if (items.length > 0 && unlabelled.length === 0) {
      console.log(`ok   all ${items.length} menu items carry a text label`)
    } else {
      console.error('FAIL menu items rendered without a label (jsx 3rd arg is the key, not children):', {
        total: items.length,
        unlabelled: unlabelled.length,
      })
      failures++
    }
  }

if (sandbox.__errors.length > 0) {
  console.error('FAIL page console.error was called:', sandbox.__errors)
  failures++
}

console.log(failures === 0 ? '\nALL APPLY CHECKS PASSED' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
