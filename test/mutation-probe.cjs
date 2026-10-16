// Reintroduce each original defect in turn and confirm resilience-check goes red.
// A check that cannot fail proves nothing.
const { readFileSync, writeFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

const dir = join(__dirname, '..')
const CLIENT = join(dir, 'client.js')

// This checkout has `core.autocrlf=true`, so the tracked sources are CRLF while
// the anchors below are written with plain newlines. Match on a normalized copy
// and restore the original endings when writing, or every multi-line anchor
// silently misses and the probe reports a false "not guarded".
const raw = readFileSync(CLIENT, 'utf8')
const usesCrlf = raw.includes('\r\n')
const original = raw.replace(/\r\n/g, '\n')
const restore = (text) => (usesCrlf ? text.replace(/\n/g, '\r\n') : text)

const mutations = [
  {
    label: 'unbounded screenshot capture (the 60s stall)',
    from: `        let image = await raceBudget(guest.capturePage(), budgetLeft(deadline), 'the screenshot')`,
    to: `        let image = await guest.capturePage()`,
  },
  {
    label: 'unbounded page script (the stalled read)',
    from: `          return await raceBudget(
            guest.executeJavaScript(pageCall(helper, args), true),
            budgetMs,
            'the page script',
          )`,
    to: `          return await guest.executeJavaScript(pageCall(helper, args), true)`,
  },
  {
    label: 'unbounded navigation',
    from: `          await raceBudget(
            resolved.guest.loadURL(url),
            budgetLeft(deadline),
            'the navigation',
          )`,
    to: `          await resolved.guest.loadURL(url)`,
  },
  {
    label: 'viewports not confirmed (reports the stale size)',
    from: `        if (guest !== undefined) {
          confirmation = await this.confirmSize(guest, target, Math.max(0, deadline - Date.now()))
        }`,
    to: `        if (false) {
          confirmation = await this.confirmSize(guest, target, Math.max(0, deadline - Date.now()))
        }`,
  },
  {
    label: 'custom size echoed for every preset',
    from: `          custom: preset === 'custom' ? snapshot.custom : undefined,`,
    to: `          custom: snapshot.custom,`,
  },
  {
    label: "Electron's URL overrides the page's (hides the error page)",
    from: `        if (identity === undefined) {
          try {
            if (guest.getURL()) url = guest.getURL()`,
    to: `        if (true) {
          try {
            if (guest.getURL()) url = guest.getURL()`,
  },
  {
    label: 'screenshots capture the error page as success',
    from: `        if (before.failed) {`,
    to: `        if (false && before.failed) {`,
  },
  {
    label: 'closing an unknown tab reports success',
    from: `        if (!this.inventory(sessionId).some((tab) => tab.tabId === tabId)) {
          throw new Error(\`no browser tab "\${tabId}" in this Session. Call browser_tabs to list them.\`)
        }
        this.closeBrowserTab(sessionId, tabId)`,
    to: `        this.closeBrowserTab(sessionId, tabId)`,
  },
  {
    label: 'a wedged page captured as a blank image',
    from: `        if (before.unverified) {
          throw new Error(
            'the page did not answer, so a screenshot could not be verified.`,
    to: `        if (false && before.unverified) {
          throw new Error(
            'the page did not answer, so a screenshot could not be verified.`,
  },
  {
    label: 'tab listing spends a full probe budget per tab',
    // The pre-fix code called describe() with no budget, so it fell back to the
    // DEFAULT per-probe budget for every tab. Mutating to `budgetLeft(deadline)`
    // would be wrong: that is already bounded and would prove nothing.
    from: `            const allowance = Math.min(share, Math.max(0, budgetLeft(deadline)))
            const described = await this.describe(entry.element, allowance)`,
    to: `            const described = await this.describe(entry.element)`,
  },
  {
    label: 'custom viewport confirmed against a fallback size',
    from: `        const target = resolveViewport({
          preset: snapshot.byTab[tabId]?.preset ?? preset,
          custom: snapshot.custom,
        })`,
    to: `        const target = resolveViewport({ preset })`,
  },
  {
    label: 'reload has no cache bypass',
    from: `        if (ignoreCache && bypassesCache) guest.reloadIgnoringCache()`,
    to: `        if (false && ignoreCache && bypassesCache) guest.reloadIgnoringCache()`,
  },
]

let problems = 0
try {
  for (const mutation of mutations) {
    if (!original.includes(mutation.from)) {
      console.error(`SKIP  ${mutation.label}\n      anchor not found — the mutation needs updating`)
      problems++
      continue
    }
    const mutated = original.replace(mutation.from, mutation.to)
    writeFileSync(CLIENT, restore(mutated))
    let failed = false
    let output = ''
    try {
      execFileSync(process.execPath, [join(dir, 'test', 'resilience-check.cjs')], { stdio: 'pipe' })
    } catch (error) {
      failed = true
      // The checks report failures on stderr, so read both streams.
      output = String(error.stdout ?? '') + String(error.stderr ?? '')
    }
    const firstFailure = /FAIL .*/.exec(output)?.[0] ?? ''
    console.log(
      `${failed ? 'RED  ' : 'GREEN'} ${mutation.label}${failed ? `\n      -> ${firstFailure.slice(0, 110)}` : '  <-- THE CHECK DOES NOT GUARD THIS'}`,
    )
    if (!failed) problems++
  }
} finally {
  // Restore unconditionally: this script rewrites a tracked source file, and an
  // interrupted run must not leave the plugin mutated.
  writeFileSync(CLIENT, restore(original))
}

console.log(problems === 0 ? '\nEVERY MUTATION WAS CAUGHT' : `\n${problems} PROBLEM(S)`)
process.exit(problems === 0 ? 0 : 1)
