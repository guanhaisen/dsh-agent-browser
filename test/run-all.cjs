/**
 * Run every dsh-agent-browser check.
 *
 * The two Electron-backed checks must run under the packaged executable in Node
 * mode, because they import the real `dsh-tools` validators out of `app.asar`.
 * This runner locates that executable and drives both, then runs the pure-Node
 * page-helper check in this process.
 *
 * Usage: node test/run-all.cjs ["<path to DeepSeek Harness.exe>"]
 */
const { spawnSync } = require('node:child_process')
const { existsSync, readdirSync } = require('node:fs')
const { join, dirname, resolve } = require('node:path')

const here = __dirname

/** Find the packaged executable: explicit argument, env, or a nearby install. */
function findExecutable() {
  const candidates = []
  if (process.argv[2]) candidates.push(process.argv[2])
  if (process.env.DSH_DESKTOP_EXE) candidates.push(process.env.DSH_DESKTOP_EXE)

  // Walk up from the plugin looking for a sibling DeepSeekHarness install.
  let dir = here
  for (let depth = 0; depth < 6; depth++) {
    dir = dirname(dir)
    for (const name of ['DeepSeekHarness', 'DeepSeek Harness']) {
      candidates.push(join(dir, name, 'DeepSeek Harness.exe'))
    }
    try {
      for (const entry of readdirSync(dir)) {
        if (/harness/i.test(entry)) candidates.push(join(dir, entry, 'DeepSeek Harness.exe'))
      }
    } catch {
      // unreadable parent; keep walking
    }
  }
  return candidates.find((path) => path && existsSync(path))
}

const results = []
const run = (label, command, args, options = {}) => {
  process.stdout.write(`\n=== ${label} ===\n`)
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  const ok = result.status === 0
  results.push({ label, ok, status: result.status })
  if (result.error) console.error(`${label}: ${result.error.message}`)
  return ok
}

const exe = findExecutable()
if (exe === undefined) {
  console.error(
    'Could not locate "DeepSeek Harness.exe".\n' +
      'Pass it explicitly:  node test/run-all.cjs "D:\\path\\to\\DeepSeek Harness.exe"\n' +
      'or set DSH_DESKTOP_EXE.',
  )
  process.exit(2)
}
console.log(`using executable: ${exe}`)

const electronEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }

run('tool + manifest schemas', exe, ['--expose-internals', join(here, 'schema-check.cjs')], { env: electronEnv })
run('client half wiring', exe, ['--expose-internals', join(here, 'client-check.cjs')], { env: electronEnv })
run('page helper behavior', process.execPath, [join(here, 'page-helpers-check.cjs')])
run('enableEval gate', process.execPath, [join(here, 'eval-gate-check.cjs')])
run('viewport sizing math', process.execPath, [join(here, 'viewport-check.cjs')])
run('client apply wiring', process.execPath, [join(here, 'apply-check.cjs')])
run('viewport controller behavior', process.execPath, [join(here, 'viewport-controller-check.cjs')])

console.log('\n=== summary ===')
for (const entry of results) console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.label}`)
const failed = results.filter((entry) => !entry.ok)
console.log(failed.length === 0 ? '\nALL CHECKS PASSED' : `\n${failed.length} CHECK(S) FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
