// Exercise the page-side helpers for real: extract the generated source from the
// bundle and run it against a small DOM stub, so read/click/type behavior is
// verified rather than assumed.
const vm = require('node:vm')
const fs = require('node:fs')
const { pluginFile } = require('./paths.cjs')

const CLIENT = pluginFile('client.js')

// --- A DOM stub with just enough surface for the helpers ---------------------
function makeElement(tag, props = {}) {
  const el = {
    tagName: tag.toUpperCase(),
    isConnected: true,
    value: props.value ?? '',
    innerText: props.innerText ?? '',
    textContent: props.textContent ?? props.innerText ?? '',
    disabled: props.disabled ?? false,
    isContentEditable: props.contentEditable ?? false,
    labels: [],
    attributes: { ...(props.attributes ?? {}) },
    _listeners: {},
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null
    },
    setAttribute(name, value) {
      this.attributes[name] = value
    },
    getClientRects() {
      return props.hidden ? [] : [{}]
    },
    scrollIntoView() {},
    scrollBy() {},
    focus() {
      dom.activeElement = el
    },
    click() {
      el.clicked = (el.clicked ?? 0) + 1
      const handler = el._listeners.click
      if (handler) handler()
    },
    dispatchEvent(event) {
      const handler = el._listeners[event.type]
      if (handler) handler(event)
      return true
    },
    addEventListener(type, handler) {
      el._listeners[type] = handler
    },
    querySelector() {
      return null
    },
  }
  if (tag === 'select') {
    el.options = (props.options ?? []).map((option) => ({
      value: option.value,
      text: option.text ?? option.value,
    }))
  }
  return el
}

const button = makeElement('button', { innerText: 'Submit', attributes: { id: 'go' } })
const input = makeElement('input', { attributes: { id: 'q', placeholder: 'Search', name: 'q' } })
const hidden = makeElement('button', { innerText: 'Hidden', hidden: true })
const select = makeElement('select', {
  attributes: { id: 'pick' },
  options: [
    { value: 'a', text: 'Alpha' },
    { value: 'b', text: 'Beta' },
  ],
})
const all = [button, input, hidden, select]

let clicked = false
button.addEventListener('click', () => {
  clicked = true
})

const dom = {
  activeElement: null,
  body: { innerText: 'Hello world\n\nSubmit' },
  documentElement: { outerHTML: '<html><body>Hello</body></html>' },
  title: 'Test Page',
  readyState: 'complete',
}

const sandbox = {
  document: {
    title: dom.title,
    readyState: dom.readyState,
    body: dom.body,
    documentElement: dom.documentElement,
    activeElement: null,
    querySelector(selector) {
      if (selector.includes('data-sidebar-right-session')) return sessionRoot
      if (selector === '#go') return button
      if (selector === '#q') return input
      if (selector === '#pick') return select
      if (selector === '#missing') return null
      if (selector === ':::bad') throw new Error('invalid selector')
      return null
    },
    querySelectorAll(selector) {
      // The driver asks for tab wrappers; the page helpers ask for elements.
      if (selector === '[data-sidebar-right-tab]') return [wrapper]
      return all
    },
  },
  location: { href: 'https://example.test/page' },
  getComputedStyle: (el) => ({
    visibility: 'visible',
    display: 'block',
    opacity: el === hidden ? '0' : '1',
  }),
  HTMLInputElement: { prototype: {} },
  HTMLTextAreaElement: { prototype: {} },
  Event: class Event {
    constructor(type, init) {
      this.type = type
      this.bubbles = init?.bubbles ?? false
    }
  },
  KeyboardEvent: class KeyboardEvent {
    constructor(type, init) {
      this.type = type
      this.key = init?.key
      this.defaultPrevented = false
    }
  },
  Map,
  Array,
  Object,
  JSON,
  String,
  Number,
  Boolean,
  Error,
  Promise,
  setTimeout,
  clearTimeout,
  console,
}
sandbox.window = sandbox
sandbox.globalThis = sandbox

// Register the input value descriptor so pageType's native-setter path works.
let inputValue = ''
Object.defineProperty(sandbox.HTMLInputElement.prototype, 'value', {
  configurable: true,
  get() {
    return inputValue
  },
  set(next) {
    inputValue = next
  },
})
// Keep the element's own `value` in sync with the native setter.
Object.defineProperty(input, 'value', {
  configurable: true,
  get() {
    return inputValue
  },
  set(next) {
    inputValue = next
  },
})

let captured
sandbox.window.__ModuleLoader__ = {
  load(registration) {
    captured = registration
  },
}
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(CLIENT, 'utf8'), sandbox, { filename: 'client.js' })

// Pull the page helpers out of the generated source by running one call and
// then reusing the same prelude in our own context.
const executed = []
const guest = {
  executeJavaScript(code) {
    executed.push(code)
    return Promise.resolve(vm.runInContext(code, sandbox))
  },
  isLoading: () => false,
  getURL: () => 'https://example.test/page',
  getTitle: () => 'Test Page',
}

// In the real app the driver runs in the DSH renderer document while the page
// helpers run inside the guest. This stub serves both, so it answers the
// driver's session lookup and the page helpers' element selectors.
const domLookup = {
  querySelector(selector) {
    if (selector.includes('data-sidebar-right-session')) return sessionRoot
    if (selector === '#go') return button
    if (selector === '#q') return input
    if (selector === '#pick') return select
    if (selector === '#missing') return null
    if (selector === ':::bad') throw new Error('invalid selector')
    return null
  },
  querySelectorAll(selector) {
    if (selector === '[data-sidebar-right-tab]') return [wrapper]
    return all
  },
}
const wrapper = {
  dataset: { sidebarRightTab: 'tab-1' },
  closest: () => sessionRoot,
  querySelector: (selector) => (selector.includes('webview') ? guest : null),
}
const sessionRoot = { dataset: { sidebarRightSession: 's1' }, querySelectorAll: domLookup.querySelectorAll }
sandbox.document.querySelector = domLookup.querySelector
sandbox.document.querySelectorAll = domLookup.querySelectorAll

/** Stub the shell-provided seed modules the bundle imports. */
function stubRequire(spec) {
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

const pluginExports = captured.factory(stubRequire)
const provider = pluginExports.buildProvider(
  {
    sidebarRight: {
      openTabs: { getSnapshot: () => [{ sessionId: 's1', tabId: 'tab-1', kind: 'browser', contentId: 'c' }] },
      openTab: () => {},
    },
  },
  // The viewport controller is only exercised by viewport-check.cjs; the driver
  // tests pass a stub so they stay focused on page interaction.
  { apply: () => undefined, describe: async () => ({}), select: async () => ({}) },
)

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log('ok  ', label)
  else {
    console.error('FAIL', label, detail === undefined ? '' : JSON.stringify(detail))
    failures++
  }
}

async function main() {
  const read = await provider.query('read', { mode: 'text' }, { sessionId: 's1' })
  check('read returns url/title', read.url === 'https://example.test/page' && read.title === 'Test Page', read)
  check('read returns visible text', read.text.includes('Hello world'), read.text)
  check('read reports not truncated', read.truncated === false, read.truncated)

  const elements = await provider.query('read', { mode: 'elements' }, { sessionId: 's1' })
  const refs = elements.elements.map((e) => e.ref)
  check('elements are numbered from e1', refs[0] === 'e1', refs)
  check('hidden element excluded by opacity', !elements.elements.some((e) => e.text === 'Hidden'), elements.elements)
  // The stub's `hidden` button is filtered out by geometry, so exactly one
  // candidate is dropped for visibility. That must NOT read as truncation: the
  // flag means the element cap was reached. It used to compare every match
  // against the kept list, which made it permanently true on real pages.
  check(
    'filtered-out elements are not reported as truncation',
    elements.truncated === false,
    { truncated: elements.truncated, returned: elements.elements.length },
  )
  const buttonEntry = elements.elements.find((e) => e.tag === 'button')
  const inputEntry = elements.elements.find((e) => e.tag === 'input')
  check('button labelled from its text', buttonEntry?.text === 'Submit', buttonEntry)
  check('input labelled from placeholder', inputEntry?.text === 'Search', inputEntry)

  // Click through the ref the read returned.
  const actClick = await provider.query(
    'act',
    { action: 'click', ref: buttonEntry.ref },
    { sessionId: 's1' },
  )
  check('click reports ok', actClick.ok === true, actClick)
  check('click actually reached the element', clicked === true, clicked)

  // Type through the ref.
  const actType = await provider.query(
    'act',
    { action: 'type', ref: inputEntry.ref, text: 'hello dsh' },
    { sessionId: 's1' },
  )
  check('type reports ok', actType.ok === true, actType)
  check('type set the element value', inputValue === 'hello dsh', inputValue)

  // Select by visible label.
  const actSelect = await provider.query(
    'act',
    { action: 'select', selector: '#pick', text: 'Beta' },
    { sessionId: 's1' },
  )
  check('select by label works', actSelect.ok === true && actSelect.value === 'b', actSelect)

  // A stale ref must be refused with guidance, not silently mis-clicked.
  try {
    await provider.query('act', { action: 'click', ref: 'e99' }, { sessionId: 's1' })
    check('unknown ref rejected', false)
  } catch (error) {
    check('unknown ref rejected', /read the elements again/.test(error.message), error.message)
  }

  // An invalid selector must be refused.
  try {
    await provider.query('act', { action: 'click', selector: ':::bad' }, { sessionId: 's1' })
    check('invalid selector rejected', false)
  } catch (error) {
    check('invalid selector rejected', /not valid CSS/.test(error.message), error.message)
  }

  // --- browser_eval: expressions AND statements -----------------------------
  // The description promises statements, and only an expression used to work, so
  // `const a = 1; a + 1` failed with a SyntaxError the model could do nothing
  // about. These run the real generated source, so the fallback is exercised.
  {
    const expression = await provider.query('eval', { code: '1 + 1' }, { sessionId: 's1' })
    check('eval evaluates an expression', expression.value === 2 && expression.kind === 'number', expression)

    const pageRead = await provider.query('eval', { code: 'document.title' }, { sessionId: 's1' })
    check('eval can read the page', pageRead.value === 'Test Page', pageRead)

    // A statement body must RUN rather than being refused as a syntax error. Its
    // value is undefined unless it returns explicitly, which is what the tool
    // description now promises.
    const statements = await provider.query('eval', { code: 'const a = 1; a + 2' }, { sessionId: 's1' })
    check(
      'eval runs a statement body instead of rejecting it',
      statements.kind === 'undefined' && statements.value === null,
      statements,
    )

    const withReturn = await provider.query(
      'eval',
      { code: 'const x = 4; if (x > 1) { return x * 2 }' },
      { sessionId: 's1' },
    )
    check('eval honours an explicit return', withReturn.value === 8, withReturn)

    const noReturn = await provider.query('eval', { code: 'const unused = 1;' }, { sessionId: 's1' })
    check(
      'a statement body with no return reports undefined rather than throwing',
      noReturn.kind === 'undefined' && noReturn.value === null,
      noReturn,
    )

    // The security-relevant property of the fallback: a RUNTIME error must not be
    // retried as a statement body, because the expression already ran and may
    // have had a side effect. Only a syntax error may fall back.
    const before = await provider.query('eval', { code: 'window.__probeRuns' }, { sessionId: 's1' })
    check('the side-effect probe starts unset', before.kind !== 'number', before)
    try {
      await provider.query(
        'eval',
        { code: "(() => { window.__probeRuns = (window.__probeRuns || 0) + 1; throw new Error('boom') })()" },
        { sessionId: 's1' },
      )
      check('a runtime error surfaces instead of being retried', false, 'it resolved')
    } catch (error) {
      check('a runtime error surfaces instead of being retried', /boom/.test(error.message), error.message)
    }
    const after = await provider.query('eval', { code: 'window.__probeRuns' }, { sessionId: 's1' })
    check(
      'a throwing expression runs exactly once (no statement-body retry)',
      after.value === 1,
      after,
    )
  }

  // ---------------------------------------------------------------------
  // wait with a condition.
  //
  // This is the capability that did not exist: every wait was a fixed sleep,
  // because `settle` is driven by Electron's NAVIGATION loading state, which a
  // single-page app clears as soon as its scripts arrive — long before the
  // framework has mounted. A report measured the cost of guessing instead: too
  // short on a slow machine, wasted time on a fast one.
  // ---------------------------------------------------------------------
  {
    // The element appears only after a few polls, which is the case a sleep
    // cannot express: the page is "loaded" the whole time.
    let visibleAfter = 2
    const appearing = makeElement('div', { innerText: 'Ready' })
    appearing.getClientRects = () => (visibleAfter <= 0 ? [{}] : [])
    domLookup.querySelector = (selector) => {
      if (selector.includes('data-sidebar-right-session')) return sessionRoot
      if (selector === '#go') return button
      if (selector === '#q') return input
      if (selector === '#pick') return select
      if (selector === '#late') {
        visibleAfter -= 1
        return appearing
      }
      if (selector === '#never') return null
      if (selector === ':::bad') throw new Error('invalid selector')
      return null
    }
    sandbox.document.querySelector = domLookup.querySelector

    const waited = await provider.query(
      'act',
      { action: 'wait', selector: '#late', state: 'visible', timeoutMs: 2000 },
      { sessionId: 's1' },
    )
    check('a condition wait reports that it matched', waited.matched === true, waited)
    check('the wait reports the state it waited for', waited.state === 'visible', waited)
    check('the wait reports how long it took', typeof waited.waitedMs === 'number', waited)

    // A condition that never holds must FAIL, not return ok:true — otherwise the
    // caller reads it as "it is ready now", which is the whole reason to name a
    // condition in the first place.
    let miss
    try {
      await provider.query(
        'act',
        { action: 'wait', selector: '#never', state: 'visible', timeoutMs: 200 },
        { sessionId: 's1' },
      )
    } catch (error) {
      miss = error
    }
    check('a condition that never holds fails instead of reporting success', miss !== undefined, String(miss))
    check(
      'the failure names the selector, the state and the elapsed time',
      /#never/.test(String(miss?.message)) && /visible/.test(String(miss?.message)) && /within/.test(String(miss?.message)),
      String(miss?.message),
    )

    // `attached` and `visible` are genuinely different questions, and conflating
    // them is the documented trap: an element can exist while `display: none`,
    // which is how a report counted hidden rows as present and concluded a layout
    // had no overflow.
    const attachedOnly = makeElement('div', { innerText: 'Hidden but present' })
    attachedOnly.getClientRects = () => []
    domLookup.querySelector = (selector) => {
      if (selector.includes('data-sidebar-right-session')) return sessionRoot
      if (selector === '#go') return button
      if (selector === '#q') return input
      if (selector === '#pick') return select
      if (selector === '#ghost') return attachedOnly
      if (selector === ':::bad') throw new Error('invalid selector')
      return null
    }
    sandbox.document.querySelector = domLookup.querySelector

    const attached = await provider.query(
      'act',
      { action: 'wait', selector: '#ghost', state: 'attached', timeoutMs: 500 },
      { sessionId: 's1' },
    )
    check('an attached-but-invisible element satisfies state attached', attached.matched === true, attached)

    let notVisible
    try {
      await provider.query(
        'act',
        { action: 'wait', selector: '#ghost', state: 'visible', timeoutMs: 200 },
        { sessionId: 's1' },
      )
    } catch (error) {
      notVisible = error
    }
    check(
      'the same element does NOT satisfy state visible',
      notVisible !== undefined,
      String(notVisible),
    )

    // 'hidden' must be satisfied by ABSENT as well as invisible: waiting out a
    // spinner that gets removed is the common case.
    const hiddenWait = await provider.query(
      'act',
      { action: 'wait', selector: '#never', state: 'hidden', timeoutMs: 500 },
      { sessionId: 's1' },
    )
    check('state hidden is satisfied by an absent element', hiddenWait.matched === true, hiddenWait)

    // An invalid selector is a caller mistake, not a timeout: it must be reported
    // as such immediately rather than after burning the whole budget and then
    // blaming the page.
    let invalid
    try {
      await provider.query(
        'act',
        { action: 'wait', selector: ':::bad', state: 'visible', timeoutMs: 2000 },
        { sessionId: 's1' },
      )
    } catch (error) {
      invalid = error
    }
    check(
      'an invalid selector is refused as invalid, not as a timeout',
      /not valid CSS/.test(String(invalid?.message)),
      String(invalid?.message),
    )

    // An unknown state is refused rather than silently treated as the default.
    let badState
    try {
      await provider.query(
        'act',
        { action: 'wait', selector: '#go', state: 'sideways', timeoutMs: 200 },
        { sessionId: 's1' },
      )
    } catch (error) {
      badState = error
    }
    check('an unknown state is refused', /unknown wait state/.test(String(badState?.message)), String(badState?.message))

    // The bare sleep must keep working unchanged: a caller that passes only
    // timeoutMs is not asking for a condition.
    const slept = await provider.query('act', { action: 'wait', timeoutMs: 10 }, { sessionId: 's1' })
    check('a wait with no condition still just sleeps', slept.ok === true && slept.matched === undefined, slept)

    domLookup.querySelector = (selector) => {
      if (selector.includes('data-sidebar-right-session')) return sessionRoot
      if (selector === '#go') return button
      if (selector === '#q') return input
      if (selector === '#pick') return select
      if (selector === '#missing') return null
      if (selector === ':::bad') throw new Error('invalid selector')
      return null
    }
    sandbox.document.querySelector = domLookup.querySelector
  }

  console.log(failures === 0 ? '\nALL PAGE HELPER CHECKS PASSED' : `\n${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('ERROR', error)
  process.exit(1)
})
