// Validate the plugin's raw tool definitions against the real registry validator.
// Run with ELECTRON_RUN_AS_NODE=1 so Electron's asar support can read app.asar.
const { asarToolsPath, pluginFile, fileUrl } = require('./paths.cjs')

const ASAR_TOOLS = asarToolsPath()
const PLUGIN = pluginFile('index.js')

async function main() {
  const tools = await import(fileUrl(ASAR_TOOLS))
  const names = Object.keys(tools)
  console.log('dsh-tools exports:', names.filter((n) => /assert|validate|defineTool/i.test(n)).join(', '))

  const { assertSupportedJsonSchema, validateJsonSchemaValue } = tools
  if (typeof assertSupportedJsonSchema !== 'function') {
    console.error('MISSING assertSupportedJsonSchema')
    process.exit(1)
  }

  // Capture the definitions the plugin registers.
  const registered = []
  const fakeTools = {
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  }
  const fakeCtx = {
    get: () => undefined,
    inject(deps, callback) {
      // Run the callback with a scope whose `tools` is our recorder.
      callback({ tools: fakeTools, effect: (fn) => fn() })
    },
  }

  const plugin = await import(fileUrl(PLUGIN))
  plugin.apply(fakeCtx, { enableEval: true })

  console.log('\nregistered tools:', registered.map((d) => d.name).join(', '))
  let failures = 0

  for (const definition of registered) {
    const label = `tool "${definition.name}"`
    if (typeof definition.output?.render !== 'function') {
      console.error(`FAIL ${label}: output.render must be a function`)
      failures++
      continue
    }
    try {
      assertSupportedJsonSchema(definition.parameters)
      console.log(`ok   ${label} parameters schema`)
    } catch (error) {
      console.error(`FAIL ${label} parameters: ${error.message}`)
      failures++
    }
    try {
      assertSupportedJsonSchema(definition.output.schema)
      console.log(`ok   ${label} output schema`)
    } catch (error) {
      console.error(`FAIL ${label} output: ${error.message}`)
      failures++
    }
    // An empty object must be a valid call for every tool that takes no required
    // argument, and must be REFUSED for one that does. Printing this without
    // asserting is how a schema that could never be satisfied shipped.
    const violations = validateJsonSchemaValue(definition.parameters, {}, '')
    const requiresSomething = Array.isArray(definition.parameters.required) && definition.parameters.required.length > 0
    if (requiresSomething) {
      if (violations.length === 0) {
        console.error(`FAIL ${label}: declares required ${JSON.stringify(definition.parameters.required)} but accepts {}`)
        failures++
      } else {
        console.log(`ok   ${label} refuses an empty call, as its required fields demand`)
      }
    } else if (violations.length > 0) {
      console.error(`FAIL ${label}: accepts no arguments yet rejects {} — ${violations.join('; ')}`)
      failures++
    } else {
      console.log(`ok   ${label} accepts an empty call`)
    }
  }

  // Spot-check that a realistic call validates.
  const read = registered.find((d) => d.name === 'browser_read')
  const good = validateJsonSchemaValue(read.parameters, { mode: 'elements' }, '')
  console.log('\nbrowser_read {mode:"elements"} violations:', good.length === 0 ? 'none' : good.join('; '))
  const bad = validateJsonSchemaValue(read.parameters, { mode: 'nope' }, '')
  console.log('browser_read {mode:"nope"} violations:', bad.length > 0 ? 'correctly rejected' : 'NOT REJECTED (bug)')

  console.log(failures === 0 ? '\nALL SCHEMAS VALID' : `\n${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('ERROR', error)
  process.exit(1)
})
