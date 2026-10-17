/**
 * Run every dsh-agent-browser check.
 *
 * The Electron-backed checks must run under the packaged executable in Node
 * mode, because they import real modules out of `app.asar` — the `dsh-tools`
 * validators, the Client runtime, and the Cordis framework itself. This runner
 * locates that executable and drives them, then runs the pure-Node checks in
 * this process.
 *
 * Usage: node test/run-all.cjs ["<path to DeepSeek Harness.exe>"] [--offline]
 *
 * `--offline` skips the checks that need a packaged install, so CI can run
 * everything it is actually able to run instead of reporting a false failure.
 * Skipped checks are reported as SKIP, never as PASS.
 */
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const { findExecutable } = require('./paths.cjs')

const here = __dirname
const offline = process.argv.includes('--offline')

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

// Checks that need no packaged install.
const pureChecks = [
  ['page helper behavior', 'page-helpers-check.cjs'],
  ['enableEval gate', 'eval-gate-check.cjs'],
  ['browser-use provider slot', 'browser-use-check.cjs'],
  ['viewport sizing math', 'viewport-check.cjs'],
  ['client apply wiring', 'apply-check.cjs'],
  ['viewport controller behavior', 'viewport-controller-check.cjs'],
  ['tab opening stays in its Session', 'session-scope-check.cjs'],
  ['stalled pages, error pages and recovery', 'resilience-check.cjs'],
  ['host error explanations', 'host-error-check.cjs'],
  ['README anchors resolve', 'readme-anchors.cjs'],
]

// `--offline` is authoritative, not a fallback: it means "skip the checks
// that need a packaged install", whether or not one happens to be findable. That
// keeps a CI run reproducible on a machine that also has DSH installed.
const skipPackaged = offline || exe === undefined

if (exe === undefined && !offline) {
  console.error(
    'Could not locate "DeepSeek Harness.exe", needed by three checks that read the real\n' +
      'dsh-tools validators out of app.asar.\n' +
      'Pass it explicitly:  node test/run-all.cjs "/path/to/DeepSeek Harness.exe"\n' +
      'set DSH_DESKTOP_EXE, or run with --offline to skip those three checks.',
  )
  process.exit(2)
}
if (!skipPackaged) console.log(`using executable: ${exe}`)

// The Electron-backed checks run as their own processes, so the executable we
// resolved here must be handed down explicitly: in those children `argv[2]` is
// the check's own filename, not a path to the app.
const electronEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_EXE: exe ?? '' }

if (skipPackaged) {
  const reason = offline ? '--offline' : 'no packaged install found'
  for (const label of [
    'tool + manifest schemas',
    'client half wiring',
    'tool result contracts',
    'mounts on the real Cordis runtime',
  ]) {
    results.push({ label, ok: true, status: 'skipped' })
    process.stdout.write(`\n=== ${label} ===\nSKIPPED (${reason}: needs a packaged install)\n`)
  }
} else {
  run('tool + manifest schemas', exe, ['--expose-internals', join(here, 'schema-check.cjs')], { env: electronEnv })
  run('client half wiring', exe, ['--expose-internals', join(here, 'client-check.cjs')], { env: electronEnv })
  run('tool result contracts', exe, ['--expose-internals', join(here, 'contract-check.cjs')], { env: electronEnv })
  run('mounts on the real Cordis runtime', exe, ['--expose-internals', join(here, 'runtime-mount-check.cjs')], {
    env: electronEnv,
  })
}

for (const [label, file] of pureChecks) {
  run(label, process.execPath, [join(here, file)])
}

console.log('\n=== summary ===')
for (const entry of results) {
  const mark = entry.status === 'skipped' ? 'SKIP' : entry.ok ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${entry.label}`)
}
const failed = results.filter((entry) => !entry.ok && entry.status !== 'skipped')
console.log(failed.length === 0 ? '\nALL CHECKS PASSED' : `\n${failed.length} CHECK(S) FAILED`)
process.exit(failed.length === 0 ? 0 : 1)
