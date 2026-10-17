// Verify the plugin mounts on the REAL Cordis runtime out of app.asar, not a
// hand-written fake. A fake ctx proves the code's own logic; only the real
// framework proves `ctx.get('browserUse')` is a legitimate call that returns
// undefined instead of throwing on a missing service.
//
// Run with ELECTRON_RUN_AS_NODE=1 so Electron's asar support can read app.asar.
const { pathToFileURL } = require('node:url')
const { join } = require('node:path')
const { asarModulePath, pluginFile, fileUrl } = require('./paths.cjs')

const PLUGIN = pluginFile('index.js')

async function main() {
  // Resolve the real Cordis the packaged app ships.
  const cordisEntry = asarModulePath('@deepseek-ai', 'cordis', 'lib', 'index.js')
  const cordis = await import(fileUrl(cordisEntry))
  const Context = cordis.Context ?? cordis.default?.Context ?? cordis.default
  if (typeof Context !== 'function') {
    console.error('FAIL could not resolve Cordis Context from', cordisEntry)
    console.error('exports:', Object.keys(cordis).join(', '))
    process.exit(1)
  }
  console.log('ok   loaded real Cordis Context from app.asar')

  let failures = 0
  const check = (label, condition, detail) => {
    if (condition) console.log('ok  ', label)
    else {
      console.error('FAIL', label, detail === undefined ? '' : JSON.stringify(detail))
      failures++
    }
  }

  // --- 1. The real framework must answer `get('browserUse')` with undefined --
  const ctx = new Context()
  let readError
  let value = 'unset'
  try {
    value = ctx.get('browserUse')
  } catch (error) {
    readError = error
  }
  check(
    "real ctx.get('browserUse') does not throw on the missing service",
    readError === undefined,
    readError === undefined ? undefined : String(readError),
  )
  check('and it reads as undefined, which is the optional path', value === undefined, String(value))

  // --- 2. The plugin must mount without the service ------------------------
  const tools = []
  const fakeTools = {
    register(definition) {
      tools.push(definition)
      return () => {}
    },
    guard() {
      return () => {}
    },
  }
  // Provide the `tools` service the way the harness does, so inject resolves.
  ctx.provide('tools', fakeTools)

  const plugin = await import(fileUrl(PLUGIN))
  let mountError
  try {
    plugin.apply(ctx, { enableEval: false })
  } catch (error) {
    mountError = error
  }
  check('the plugin mounts on the real Context', mountError === undefined, mountError === undefined ? undefined : String(mountError))

  // A real Cordis `inject` activates asynchronously once its dependency is
  // present, so the registrations land on a later microtask/tick rather than
  // during apply(). Give the framework a turn before asserting.
  for (let attempt = 0; attempt < 50 && tools.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  check('and registers its tools', tools.length === 8, tools.map((tool) => tool.name))

  console.log(failures === 0 ? '\nALL REAL-RUNTIME CHECKS PASSED' : `\n${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('ERROR', error)
  process.exit(1)
})
