/**
 * Path resolution shared by every check.
 *
 * Nothing here hardcodes a machine-specific location. The plugin's own files are
 * derived from this file's directory, so a fresh clone runs the suite wherever it
 * sits, and the packaged DSH install is discovered the same way `run-all.cjs`
 * does it: an explicit argument, then `DSH_DESKTOP_EXE`, then a walk up the tree
 * looking for a sibling installation.
 *
 * The Electron-backed checks need `dsh-tools` out of `app.asar`, which only the
 * packaged executable can read — hence the executable hunt rather than a plain
 * `require`.
 */
const { existsSync, readdirSync } = require('node:fs')
const { join, dirname } = require('node:path')

/** The plugin root (this file lives in `<root>/test/`). */
const PLUGIN_ROOT = dirname(__dirname)

/** Absolute path to a plugin file, e.g. `pluginFile('client.js')`. */
function pluginFile(name) {
  return join(PLUGIN_ROOT, name)
}

/**
 * Locate the packaged Desktop executable.
 *
 * Order matters. `run-all.cjs` spawns the Electron-backed checks as separate
 * processes, where `argv[2]` is the CHECK's own filename rather than an
 * executable path, so `DSH_DESKTOP_EXE` (which the runner sets) is consulted
 * first. A direct invocation like `node test/schema-check.cjs "/path/to/exe"`
 * still works because the argument is tried next.
 * @returns the absolute path, or undefined when it cannot be found.
 */
function findExecutable() {
  const candidates = []
  if (process.env.DSH_DESKTOP_EXE) candidates.push(process.env.DSH_DESKTOP_EXE)
  if (process.argv[2] && /\.exe$/i.test(process.argv[2])) candidates.push(process.argv[2])

  // Walk up from the plugin looking for a sibling DeepSeekHarness install.
  let dir = PLUGIN_ROOT
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
      // Unreadable parent; keep walking.
    }
  }
  return candidates.find((path) => path && existsSync(path))
}

/**
 * Absolute path to `dsh-tools` inside the packaged `app.asar`.
 *
 * The Electron checks import this to reach the real schema validators, so an
 * unresolvable install must be reported clearly rather than as a module error.
 * @returns the path to `.../app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`.
 */
function asarToolsPath() {
  const exe = findExecutable()
  if (exe === undefined) {
    throw new Error(
      'Could not locate "DeepSeek Harness.exe", which this check needs to read the real\n' +
        'dsh-tools validators out of app.asar.\n' +
        'Pass it explicitly:  node test/<check>.cjs "/path/to/DeepSeek Harness.exe"\n' +
        'or set DSH_DESKTOP_EXE.',
    )
  }
  return join(dirname(exe), 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
}

/** A `file://` URL for dynamic import, with Windows separators normalised. */
function fileUrl(path) {
  return 'file:///' + path.replace(/\\/g, '/')
}

module.exports = { PLUGIN_ROOT, pluginFile, findExecutable, asarToolsPath, fileUrl }
