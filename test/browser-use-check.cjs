// Verify the optional `browserUse` provider claim.
//
// The service is declared in the harness API catalog but is NOT provided by any
// shipped package in 0.2.1-rc.2. That makes the undefined case the one that
// matters most: a hard dependency would leave the plugin waiting forever and
// silently disable every browser tool. So the contract under test is:
//
//   1. service absent  -> plugin loads, tools register, nothing throws
//   2. service present -> the exclusive slot is claimed under the plugin's name
//   3. claim rejected  -> tools still work, the failure is reported not thrown
//   4. unload          -> the slot is released, so a reload can re-claim it
const { pathToFileURL } = require('node:url')
const { join } = require('node:path')

const PLUGIN = pathToFileURL(join(__dirname, '..', 'index.js')).href

/** Collect console.error calls made during one load(). */
async function load({ browserUse, config } = {}) {
  const tools = []
  const guards = []
  const errors = []
  const disposers = []

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

  const services = { tools: fakeTools }
  if (browserUse !== undefined) services.browserUse = browserUse

  const ctx = {
    get: (name) => services[name],
    inject: (_deps, callback) =>
      callback({
        tools: fakeTools,
        effect: (fn) => {
          const disposer = fn()
          if (typeof disposer === 'function') disposers.push(disposer)
          return disposer
        },
      }),
  }

  const originalError = console.error
  console.error = (...args) => {
    errors.push(args.join(' '))
  }
  try {
    const plugin = await import(PLUGIN)
    plugin.apply(ctx, config)
    // Let the non-awaited claim settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    return { tools, guards, errors, disposers }
  } finally {
    console.error = originalError
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
  // --- 1. absent: the case that ships today --------------------------------
  const absent = await load({})
  check(
    'loads and registers every tool when browserUse is absent',
    absent.tools.length === 8,
    absent.tools.map((tool) => tool.name),
  )
  check('no error is reported when the service is simply absent', absent.errors.length === 0, absent.errors)
  check(
    'the browser tools are present without the service',
    absent.tools.some((tool) => tool.name === 'browser_read'),
    absent.tools.map((tool) => tool.name),
  )

  // --- 2. present: the slot is claimed under this plugin's name ------------
  const claims = []
  const present = await load({
    browserUse: {
      register(name) {
        claims.push(name)
        return Promise.resolve(() => {})
      },
    },
  })
  check('the provider slot is claimed exactly once', claims.length === 1, claims)
  check('the claim is made under the plugin name', claims[0] === 'dsh-agent-browser', claims)
  check('tools still register when the claim succeeds', present.tools.length === 8, present.tools.length)
  check('a successful claim reports nothing', present.errors.length === 0, present.errors)

  // --- 3. rejected: a lost race must not disable the tools ----------------
  const rejected = await load({
    browserUse: {
      register() {
        return Promise.reject(new Error('already owned by another plugin'))
      },
    },
  })
  check('tools still register when the claim is rejected', rejected.tools.length === 8, rejected.tools.length)
  check('the rejection is reported', rejected.errors.length === 1, rejected.errors)
  check(
    'the report names the slot and keeps the tools usable',
    /browser-use provider slot/.test(rejected.errors[0] ?? '') &&
      /tools still work/.test(rejected.errors[0] ?? ''),
    rejected.errors,
  )

  // --- 4. unload releases the slot ----------------------------------------
  let released = 0
  const releasable = await load({
    browserUse: {
      register() {
        return Promise.resolve(() => {
          released++
        })
      },
    },
  })
  check('a disposer is installed for the claim', releasable.disposers.length >= 1, releasable.disposers.length)
  for (const dispose of releasable.disposers) dispose()
  check('unloading releases the provider slot', released === 1, released)

  // Unload before the claim settles must still release once it lands.
  let lateReleased = 0
  let settleClaim
  const slow = await load({
    browserUse: {
      register() {
        return new Promise((resolve) => {
          settleClaim = resolve
        })
      },
    },
  })
  for (const dispose of slow.disposers) dispose()
  settleClaim(() => {
    lateReleased++
  })
  await new Promise((resolve) => setTimeout(resolve, 0))
  check('a claim that settles after unload is released too', lateReleased === 1, lateReleased)

  console.log(failures === 0 ? '\nALL BROWSER-USE CHECKS PASSED' : `\n${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('ERROR', error)
  process.exit(1)
})
