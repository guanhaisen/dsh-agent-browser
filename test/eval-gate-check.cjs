// Verify the enableEval gate: with the flag off, the plugin must both omit the
// browser_eval tool AND deny cordis_inspect_query calls that reach the provider's
// eval method (the Inspect provider always declares it, so the tool list alone is
// not a security boundary).
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
  check(
    'browser_eval tool is not registered',
    !off.tools.some((tool) => tool.name === 'browser_eval'),
    off.tools.map((tool) => tool.name),
  )
  check('a guard is installed', off.guards.length === 1, off.guards.length)

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

  console.log(failures === 0 ? '\nALL GATE CHECKS PASSED' : `\n${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('ERROR', error)
  process.exit(1)
})
