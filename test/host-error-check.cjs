// Verify how the Host half explains a failed Client query.
//
// This is a pure-Node check on purpose. The same behaviour is asserted in
// `contract-check`, but that suite only runs where a packaged install exists
// (it needs the real validators out of `app.asar`), so on any other machine the
// Host's error mapping went untested. It is worth testing everywhere, because it
// is the layer the model actually reads: a report showed every screenshot failure
// explained as "the in-app browser is not reachable from this Session … Use a
// Desktop Session", while the user WAS on a Desktop Session and `browser_read`
// worked against the same tab throughout. The provider's own diagnosis — the only
// useful part — was buried under a false explanation and an ineffective remedy.
//
// The three shapes below are the real ones, taken from the live reports.
const { pathToFileURL } = require('node:url')
const { join } = require('node:path')

const PLUGIN = pathToFileURL(join(__dirname, '..', 'index.js')).href

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log('ok  ', label)
  else {
    console.error('FAIL', label, detail === undefined ? '' : JSON.stringify(detail))
    failures++
  }
}

/**
 * Register the Host tools over a registry that always fails with `message`, then
 * run one tool and report what the model would see.
 * @param message - the error the Inspect registry throws.
 * @returns `{ threw, message }`.
 */
async function outcomeFor(message) {
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
  const ctx = {
    get: (name) => (name === 'cordisInspect' ? { query: async () => { throw new Error(message) } } : undefined),
    inject: (_deps, callback) => callback({ tools: fakeTools, effect: (fn) => fn() }),
  }
  const plugin = await import(PLUGIN)
  plugin.apply(ctx, {})
  const tool = registered.find((entry) => entry.name === 'browser_tabs')
  if (tool === undefined) return { threw: false, message: 'browser_tabs was not registered' }
  try {
    await tool.execute({}, { agent: { id: 'a' }, signal: undefined })
    return { threw: false, message: '' }
  } catch (error) {
    return { threw: true, message: error instanceof Error ? error.message : String(error) }
  }
}

async function main() {
  // --- a provider that ANSWERED -------------------------------------------
  // Note the shape: the provider's reason arrives wrapped in the channel's own
  // `timed out after …`, so a classifier that tests for "timed out" first
  // swallows the diagnosis. Both live examples are here, including the Electron
  // one that names the actual failure.
  const answered = [
    'AgentBrowser.screenshot: Client inspect query AgentBrowser.screenshot timed out after 60000ms. Client failure: provider-error: the screenshot did not answer within 13s.',
    "AgentBrowser.screenshot: Client inspect query AgentBrowser.screenshot timed out after 60000ms. Client failure: provider-error: Error invoking remote method 'GUEST_VIEW_MANAGER_CALL': Error: UnknownVizError.",
  ]
  for (const message of answered) {
    const outcome = await outcomeFor(message)
    const label = message.slice(-38)
    check(`a provider failure is surfaced: …${label}`, outcome.threw, outcome.message)
    check(
      `a provider failure is not called unreachable: …${label}`,
      !/not reachable from this Session/.test(outcome.message),
      outcome.message,
    )
    check(
      `a provider failure does not blame the Session kind: …${label}`,
      !/Use a Desktop Session/.test(outcome.message),
      outcome.message,
    )
    check(
      `the provider's own reason survives: …${label}`,
      /Client failure:/.test(outcome.message) &&
        (outcome.message.includes('did not answer within 13s') || outcome.message.includes('UnknownVizError')),
      outcome.message,
    )
  }

  // --- nothing answered at all --------------------------------------------
  // No provider, no page, no such method: "unreachable" is exactly right here.
  const unreachable = [
    'AgentBrowser.listTabs: Client Cordis inspect provider "AgentBrowser" is not registered',
    'AgentBrowser.read: Client inspect query AgentBrowser.read has no connected Harness page. Open or reconnect the Harness page, then retry.',
    'AgentBrowser.read: Client inspect provider "AgentBrowser" has no method "read"',
  ]
  for (const message of unreachable) {
    const outcome = await outcomeFor(message)
    check(
      `a genuinely unreachable browser keeps that explanation: ${message.slice(0, 44)}…`,
      outcome.threw && /not reachable from this Session/.test(outcome.message),
      outcome.message,
    )
  }

  // A bare channel timeout has no provider answer, so the cause cannot be known
  // from here. It must say so rather than assert one — and it must not prescribe
  // reloading, which a live report measured as ineffective for exactly this case.
  {
    const outcome = await outcomeFor(
      'AgentBrowser.read: Client inspect query AgentBrowser.read timed out after 10000ms. Open or reconnect the Harness page, then retry.',
    )
    check('a silent timeout is reported as unreachable', /not reachable from this Session/.test(outcome.message), outcome.message)
    check(
      'a silent timeout names the visibility possibility rather than asserting it',
      /Sidebar is open/.test(outcome.message),
      outcome.message,
    )
    check('a silent timeout does not prescribe reload', !/reload/.test(outcome.message), outcome.message)
  }

  // --- failures that must pass through untouched --------------------------
  // "Not reachable" would be a false explanation for both: a cancelled call was
  // reachable, and a schema disagreement cannot be fixed by retrying.
  const passedThrough = [
    'AgentBrowser.read: Client inspect query AgentBrowser.read was cancelled',
    'Client Cordis inspect read rejected input: "value.tabId" is required',
  ]
  for (const message of passedThrough) {
    const outcome = await outcomeFor(message)
    check(
      `a non-reachability failure is passed through: ${message.slice(0, 44)}…`,
      outcome.threw && !/not reachable from this Session/.test(outcome.message) && outcome.message.includes(message),
      outcome.message,
    )
  }

  console.log(failures === 0 ? '\nALL HOST ERROR CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('host error check crashed:', error)
  process.exit(1)
})
