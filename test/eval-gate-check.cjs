// Verify the enableEval gate: with the flag off, the plugin must deny every route
// to page evaluation — the browser_eval tool AND cordis_inspect_query calls that
// reach the provider's eval method (the Inspect provider always declares it, so
// the tool list alone is not a security boundary).
//
// The tool is now REGISTERED even when off, and refuses when called. That is
// deliberate: two agent reports show that an invisible capability gets rebuilt as
// an iframe-probe workaround written into the user's own project, which is worse
// than telling the model the capability exists and how to enable it. So the
// contract under test is "cannot execute", not "is absent".
const { pathToFileURL } = require('node:url')
const { join } = require('node:path')

const PLUGIN = pathToFileURL(join(__dirname, '..', 'index.js')).href

/** Capture registered tools and guards from one apply() with the given config. */
async function load(config) {
  const tools = []
  const guards = []
  const fakeTools = {
    register(definition) {
      tools.push(definition)
      return () => {}
    },
    guard(fn) {
      guards.push(fn)
      return () => {}
    },
  }
  const ctx = {
    get: () => undefined,
    inject: (_deps, callback) => callback({ tools: fakeTools, effect: (fn) => fn() }),
  }
  const plugin = await import(PLUGIN)
  plugin.apply(ctx, config)
  return { tools, guards }
}

/** Ask every guard whether it denies this call. */
function denied(guards, name, args) {
  for (const guard of guards) {
    const reason = guard({ name, arguments: args })
    if (typeof reason === 'string') return reason
  }
  return undefined
}

/** Call a registered tool and report how it settled. */
async function invoke(tools, name, args) {
  const tool = tools.find((entry) => entry.name === name)
  if (tool === undefined) return { missing: true }
  try {
    const value = await tool.execute(args, { agent: { id: 'a' }, signal: undefined })
    return { value }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

let failures = 0
const check = (label, condition, detail) => {
  if (condition) console.log('ok  ', label)
  else {
    console.error('FAIL', label, detail === undefined ? '' : JSON.stringify(detail))
    failures++
  }
}

async function main() {
  // --- default: eval off ---------------------------------------------------
  const off = await load({})
  // Registered on purpose, so the capability is discoverable rather than
  // unguessable. See the comment on the registration in index.js.
  check(
    'browser_eval is registered even when disabled, so it can be discovered',
    off.tools.some((tool) => tool.name === 'browser_eval'),
    off.tools.map((tool) => tool.name),
  )
  check('a guard is installed', off.guards.length === 1, off.guards.length)

  // ...but it must not execute.
  const refused = await invoke(off.tools, 'browser_eval', { code: '1+1' })
  check('calling browser_eval while disabled fails', refused.error !== undefined, refused)
  check(
    'the refusal names the config switch and how to enable it',
    /enableEval/.test(refused.error ?? '') && /Set it to true/.test(refused.error ?? ''),
    refused.error,
  )
  check(
    'the refusal warns against the probe-page workaround',
    /probe pages/.test(refused.error ?? ''),
    refused.error,
  )

  const evalArgs = { platform: 'client', provider: 'AgentBrowser', method: 'eval', input: { code: '1+1' } }
  check(
    'inspect query reaching eval is denied',
    typeof denied(off.guards, 'cordis_inspect_query', evalArgs) === 'string',
  )
  check(
    'denial names the config switch',
    /enableEval/.test(denied(off.guards, 'cordis_inspect_query', evalArgs) ?? ''),
  )

  // Everything else must stay allowed.
  check(
    'inspect query for read is allowed',
    denied(off.guards, 'cordis_inspect_query', { platform: 'client', provider: 'AgentBrowser', method: 'read' }) === undefined,
  )
  check(
    'inspect query for another provider is allowed',
    denied(off.guards, 'cordis_inspect_query', { platform: 'client', provider: 'Slots', method: 'eval' }) === undefined,
  )
  check(
    'host inspect query is allowed',
    denied(off.guards, 'cordis_inspect_query', { platform: 'host', provider: 'AgentBrowser', method: 'eval' }) === undefined,
  )
  check('other tools are allowed', denied(off.guards, 'browser_read', {}) === undefined)
  check(
    'malformed arguments do not throw',
    denied(off.guards, 'cordis_inspect_query', null) === undefined,
  )

  // --- opt-in: eval on ----------------------------------------------------
  const on = await load({ enableEval: true })
  check(
    'browser_eval tool is registered when enabled',
    on.tools.some((tool) => tool.name === 'browser_eval'),
    on.tools.map((tool) => tool.name),
  )
  check('no guard is installed when enabled', on.guards.length === 0, on.guards.length)

  // With the switch on, the tool must actually reach the provider. No registry
  // is mounted in this harness, so the failure proves it got PAST the gate — the
  // distinction that matters is "refused by config" vs "tried to run".
  const attempted = await invoke(on.tools, 'browser_eval', { code: '1+1' })
  check(
    'an enabled browser_eval reaches the provider instead of being refused',
    attempted.error !== undefined && !/enableEval/.test(attempted.error),
    attempted.error,
  )

  console.log(failures === 0 ? '\nALL GATE CHECKS PASSED' : `\n${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('ERROR', error)
  process.exit(1)
})
