// Reintroduce each original defect in turn and confirm the relevant suite goes
// red. A check that cannot fail proves nothing.
//
// Two source files are mutated, because the defects live on both sides of the
// wire: the Client half owns capture, budgets and visibility, while the Host half
// owns how a failure is EXPLAINED to the model. Each mutation names the file it
// applies to and the check that must catch it, and only that file is rewritten
// for that run.
const { readFileSync, writeFileSync } = require('node:fs')
const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

const dir = join(__dirname, '..')
const CLIENT = join(dir, 'client.js')
const HOST = join(dir, 'index.js')

// This checkout has `core.autocrlf=true`, so the tracked sources are CRLF while
// the anchors below are written with plain newlines. Match on a normalized copy
// and restore the original endings when writing, or every multi-line anchor
// silently misses and the probe reports a false "not guarded".
const sources = {}
for (const path of [CLIENT, HOST]) {
  const raw = readFileSync(path, 'utf8')
  sources[path] = { original: raw.replace(/\r\n/g, '\n'), usesCrlf: raw.includes('\r\n') }
}
const restore = (path, text) => (sources[path].usesCrlf ? text.replace(/\n/g, '\r\n') : text)

/** The default check for Client-half mutations. */
const RESILIENCE = 'resilience-check.cjs'

const mutations = [
  {
    label: 'unbounded screenshot capture (the 60s stall)',
    from: `          image = await raceBudget(guest.capturePage(), budgetLeft(deadline), 'the screenshot')`,
    to: `          image = await guest.capturePage()`,
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
          const visibility = this.visibleDiagnosis(sessionId, tabId)
          throw new Error(
            'the page did not answer, so a screenshot could not be verified.`,
    to: `        if (false && before.unverified) {
          const visibility = this.visibleDiagnosis(sessionId, tabId)
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
  {
    label: 'a failed capture blames reachability and prescribes reload',
    // The pre-fix message: the provider's own reason was wrapped in a false
    // explanation, and the advice it gave was measured as ineffective.
    from: `          const visibility = this.visibleDiagnosis(sessionId, tabId)
          throw new Error(
            \`the screenshot failed: \${reason}\` +
              (visibility === undefined ? '' : \` — \${visibility}\`) +
              '. The page was readable at the same moment, so the browser itself is fine: this is ' +
              'the capture path. Click this tab in the right Sidebar so it is the one being drawn ' +
              '(a hidden tab is not composited), or capture a different tab.',
          )`,
    to: `          throw new Error(
            \`the in-app browser is not reachable from this Session: \${reason}. \` +
              'Use a Desktop Session, then retry. reload the tab and try again.',
          )`,
  },
  {
    label: 'the visibility diagnosis reads the open flag off the wrong element',
    // `document.querySelector` returns the OUTER per-Conversation wrapper; the
    // open flag lives on the INNER panel. Reading it from the outer element makes
    // every tab look collapsed, which is the shape of the real DOM.
    from: `          const panel = wrapper.closest?.('[data-sidebar-right-panel]')`,
    to: `          const panel = root`,
  },
  {
    label: 'visibility is ruled out without evidence',
    from: `          if (panel !== null && panel !== undefined && sawSelection) {`,
    to: `          if (true) {`,
  },
  {
    label: 'a provider failure is blamed on reachability',
    file: HOST,
    check: 'host-error-check.cjs',
    // The classifier regression: testing for "timed out" before recognising a
    // provider answer swallows the only real diagnosis, because the channel wraps
    // every provider answer in its own timeout text.
    from: `    const answered = /Client failure:\\s*([\\s\\S]+)$/.exec(message)`,
    to: `    const answered = null`,
  },
  {
    label: 'browser_eval is invisible when disabled',
    file: HOST,
    check: 'eval-gate-check.cjs',
    // The pre-fix design: only registered when the switch is on, which made the
    // capability unguessable and drove two agents to rebuild it as iframe probe
    // pages written into their own project.
    from: `    const evalEnabled = settings.enableEval === true
    scope.effect(`,
    to: `    const evalEnabled = settings.enableEval === true
    if (evalEnabled) scope.effect(`,
  },
]

let problems = 0
const touched = new Set()
try {
  for (const mutation of mutations) {
    const file = mutation.file ?? CLIENT
    const check = mutation.check ?? RESILIENCE
    const original = sources[file].original
    if (!original.includes(mutation.from)) {
      console.error(`SKIP  ${mutation.label}\n      anchor not found in ${file} — the mutation needs updating`)
      problems++
      continue
    }
    writeFileSync(file, restore(file, original.replace(mutation.from, mutation.to)))
    touched.add(file)
    let failed = false
    let output = ''
    try {
      execFileSync(process.execPath, [join(dir, 'test', check)], { stdio: 'pipe' })
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
  // Restore unconditionally: this script rewrites tracked source files, and an
  // interrupted run must not leave the plugin mutated.
  for (const file of touched) writeFileSync(file, restore(file, sources[file].original))
}

console.log(problems === 0 ? '\nEVERY MUTATION WAS CAUGHT' : `\n${problems} PROBLEM(S)`)
process.exit(problems === 0 ? 0 : 1)
