# dsh-agent-browser

Let the model actually **use** the DSH right-Sidebar browser: read a page's text,
click and type in it, navigate, size the viewport, and take screenshots — from
ordinary tool calls in the conversation.

It also adds a **phone / tablet / desktop / custom viewport switcher**, so you can
see how a site renders at another size without leaving the app.

```
browser_navigate { url: "https://example.com" }
browser_read     { mode: "elements" }     -> refs e1, e2, …
browser_act      { action: "type", ref: "e1", text: "hello" }
browser_act      { action: "click", ref: "e2" }
browser_screenshot {}                     -> see the layout
browser_viewport { preset: "phone" }      -> re-render at 390×844
```

> **Desktop only.** The tools drive an Electron `<webview>` guest. In Web
> profiles the Sidebar browser is a sandboxed cross-origin `<iframe>`, whose DOM
> cannot be read at all, so the tools answer with an explicit reason instead of
> pretending to work.

> **Third-party, non-invasive plugin.** It mounts from your DSH profile, never
> touches `app.asar`, and leaves the built-in browser exactly as shipped.

- [Install](#install) — clone, wire into your profile, restart
- [Tools](#tools) — what the model can call
- [Viewport sizes](#viewport-sizes-phone--desktop--custom) — the UI side
- [Known limitations](#known-limitations) — read before filing an issue

## Tools

| Tool | What it does |
|---|---|
| `browser_tabs` | List this Session's browser tabs: id, title, url, loading state, whether each is mounted and drivable. |
| `browser_read` | Read a tab: `mode: 'text'` (default) for visible text, `'elements'` for the interactive elements you can act on, `'html'` for page HTML. |
| `browser_act` | `click`, `type`, `press`, `scroll`, `select`, or `wait`. Target an element by the `ref` from a `'elements'` read, or by a CSS `selector`. |
| `browser_screenshot` | Capture the visible viewport as an image block the model can see. |
| `browser_navigate` | Open a URL in a new tab, or navigate an existing one. |
| `browser_viewport` | Read or change the tab's viewport size: `auto`, `phone` (390×844), `tablet` (834×1112), `desktop` (1280×800) or `custom`. The page reflows for real, so its own responsive breakpoints apply. |
| `browser_eval` | Run JavaScript in the page. **Off by default** (see configuration). |

A typical loop:

```
browser_navigate { url: "https://example.com" }
browser_read     { mode: "elements" }          -> refs e1, e2, …
browser_act      { action: "type", ref: "e1", text: "hello" }
browser_act      { action: "click", ref: "e2" }
browser_read     { mode: "text" }              -> confirm what changed
browser_screenshot {}                          -> see the layout
browser_viewport { preset: "phone" }           -> check the mobile layout
browser_screenshot {}                          -> 390px-wide render
```

`tabId` may be omitted whenever the Session has exactly one mounted browser tab.
With several, call `browser_tabs` first and name the one you mean.

## Viewport sizes (phone / desktop / custom)

A browser tab normally renders at the Sidebar column's width. Switching the
viewport makes the page lay out at a real phone, tablet or desktop width instead,
so a site's own media queries fire and you see the layout that size really
produces.

Three ways to drive it:

- **Right-click the tab** — the tab strip has no "⋯" button. The kit opens a
  tab's menu on **right-click** (its `onContextMenu` handler), and that menu is
  where these items appear, under *Viewport size*. The current choice is ticked.
  With only one tab open the menu is otherwise just *Close tab*; these items are
  what make it worth opening.
- **Settings → General → Browser viewport** — the default that new tabs inherit.
- **Shortcut** — `browser.viewport.cycle` cycles fit → phone → tablet → desktop
  for the focused browser tab. It **ships unbound** so it never steals a chord;
  bind it yourself in *Settings → Shortcuts* and search for "viewport".

`browser_viewport` exposes the same control to the model. Reading it reports both
the preset and the CSS pixel width the page is actually laying out at:

```json
{ "tabId": "tab3", "preset": "phone", "pageWidth": 390, "pageHeight": 844,
  "targetWidth": 390, "scale": 0.62, "mounted": true }
```

### How it works, and why not zoom

The guest is an Electron `<webview>`, and that element's box **is** the page's
viewport: a 390px-wide element makes the document lay out at 390 CSS pixels. To
show a viewport wider than the column, the element is scaled down for display
only, inside a clipping container, and the scale is recomputed by a
`ResizeObserver` when the Sidebar is resized. The page's layout stays truthful;
only the presentation shrinks. `pageWidth` in the read-back is the guest's own
`window.innerWidth`, so it always reports what the page believes.

`<webview>.setZoomFactor()` is deliberately **not** used. Chromium's zoom policy
is same-origin, so zooming one tab would also zoom any other tab showing the same
site — tabs in one workspace share a storage partition. Element box plus a CSS
transform keeps every tab independent.

### Placement

A sized page is **centred** in the column, both across and (when it fits) down,
so it reads as a device preview rather than a page jammed into the top-left
corner. Centring is done with `translate(...)` placed *before* `scale(...)` in
the transform list: the offsets are therefore in unscaled column pixels while the
scale still happens about the element's top-left corner.

Two deliberate limits:

- **Flexbox is not used for centring.** Flex would centre the element's *layout*
  box, which is the full unscaled target (1280px inside a ~650px column), so it
  would push the scaled result off to one side while the translate did the same
  job again. One mechanism only; leftover flex centring is cleared on every apply
  so an already-styled container is corrected in place.
- **A page taller than the column is top-anchored, not centred.** Vertically
  centring an 844px-tall phone page in a shorter column would clip both ends and
  hide where the document starts.

Consequences worth knowing:

- At a desktop width in a narrow column, text is genuinely smaller — that is the
  honest cost of seeing the real desktop layout. Use a `custom` size (240–3840 ×
  320–2160) to trade layout for legibility.
- A tab that is open but not mounted cannot be resized yet; the choice is stored
  and applied the moment you click that tab. A restored Session re-applies saved
  presets shortly after load.
- Sizes are remembered per tab in `localStorage` under
  `dsh.agent-browser.viewport.v1` and survive a restart.
- **The height is the preset's real height too.** A "desktop 1280×800" tab lays
  out at exactly 1280×800 and is then drawn scaled-down inside the column.
  Scaling the height up to fill the column was tried and rejected: it stretched
  the viewport (that preset laid out 1571px tall) and silently broke `100vh` and
  every height-driven layout. The scaled result is therefore often shorter than
  the column — which now shows as balanced space above and below the page.

## Configuration

In the profile's `cordis.patch.yml`:

```yaml
- id: dsh-agent-browser
  name: dsh-agent-browser
  config:
    # Register browser_eval. It runs arbitrary script in the page, so it stays
    # off unless a deployment opts in.
    enableEval: false
    # Character budget for browser_read text/html.
    maxReadChars: 20000
    # browser_screenshot downscales to at most this width before delivery.
    screenshotMaxWidth: 1568
```

The Inspect channel also has a process-wide client-query timeout, defaulting to
10 s. A slow page can exceed it, so raise it on the runner that owns the
registry:

```yaml
- id: cordis-host-runner
  name: '@deepseek-ai/dsh-cordis-host-runner'
  config:
    clientInspectTimeoutMs: 60000
```

## How it works

```
model → browser_* tool (Host)
          └─ ctx.cordisInspect.query('client', 'AgentBrowser', <method>, …)
                └─ WebSocket/RPC → the page → Client Inspect provider
                      └─ finds the tab's <webview> by
                         [data-sidebar-right-session] > [data-sidebar-right-tab]
                           ├─ executeJavaScript(...)  read DOM, click, type
                           └─ capturePage()           screenshot
                ← lossless JSON
          └─ screenshot: ctx.attachments.saveImage() → { type: 'image', attachment }
```

Two design choices worth knowing:

- **The Inspect channel, not a private transport.** `cordisInspect` is the
  one first-class Host→Client request/response mechanism: it correlates by
  requestId, honours the tool call's `AbortSignal`, and validates input and
  output against declared JSON schemas. Reusing it means no new wire protocol.
- **The page is driven through its own carrier.** Each page-side helper is
  serialized with `toString()` and wrapped in a single IIFE before
  `executeJavaScript`, so the helpers see each other without touching the
  visited page's globals.

The provider reads `[data-sidebar-right-tab]` inside
`[data-sidebar-right-session]` to map a tab to its guest. Desktop browser tabs
declare `keepMounted`, so a tab keeps its DOM across tab switches, Session
switches, collapse and floating — which is what lets a tool reach a tab the user
is not currently looking at.

Viewport sizing rides the same discovery path. It adds no DOM of its own: it sets
inline styles on the guest and on the guest's existing parent container, because
the built-in presentation re-appends the element on every re-present, which would
move it straight back out of any wrapper this plugin inserted. The built-in
component sets `className` and never `style`, so React leaves those inline styles
alone.

The controls sit in public additive seats — `sidebar.right.tab.menu.item` and
`settings.general.item` — rather than replacing anything, so the built-in
browser keeps working untouched and the whole feature disappears when the plugin
is disabled.

## Safety

The tools inherit every restriction the built-in browser already enforces, and
add none of their own relaxations:

- The guest keeps `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`, `webSecurity: true`.
- The main process still refuses the DSH application origin, non-HTTP(S)
  schemes, and addresses carrying credentials, and still denies downloads,
  permissions, native popups and webview nesting.
- `executeJavaScript` runs in the page's own world; the host renderer never
  exposes Node or Electron to visited content.
- `browser_eval` is off by default. Turning it on lets the model run arbitrary
  script in the page — treat it like granting shell access to that origin.
  **The switch is enforced on the Host, not just in the tool list.** The Client
  provider always declares an `eval` method, and the model also holds
  `cordis_inspect_query`, which can reach that method directly; a Client half
  cannot read plugin config (boot-manifest rows carry none), so the Host half
  installs a tool guard that denies `cordis_inspect_query` calls targeting
  `client` → `AgentBrowser` → `eval` whenever `enableEval` is not `true`.

**Page content is untrusted data.** Anything a page shows can attempt prompt
injection. Treat tool output as data to reason about, never as instructions.

## Known limitations

- **Desktop only**, as above.
- **Mounted tabs only.** A tab that is open but not yet mounted cannot be
  driven; the tool says so and asks you to click that tab once. (In practice
  tabs mount as soon as they are opened or restored.) Setting a viewport is the
  exception: it is stored and applied when the tab mounts.
- **`shortcuts.register` requires a `defaults` map.** Omitting it throws during
  `apply()`, which takes down the entire client half — the Inspect provider
  included — and surfaces only as `web boot: … did not activate`. This plugin
  ships `defaults: {}`; `test/apply-check.cjs` guards the shape so the outage
  cannot come back silently.
- **The menu item reads `sessionId` from a standard slot prop.** It falls back to
  the enclosing `[data-sidebar-right-session]` only if a future shell stops
  providing it, so the control keeps working either way.
- **The tab menu is a right-click menu, not a "⋯" button.** The kit's tab strip
  has no overflow button; the menu is opened by the tab's `onContextMenu`
  handler. `Modal` is deliberately **not** used for the custom-size form: the kit
  dismisses the menu on any `pointerdown` outside its own element, and `Modal`
  portals to `document.body`, so a portaled dialog would destroy itself on first
  click. The form renders inline and stops pointer events instead.
- **`jsx(type, props, key)` takes the React KEY third — not children.** This
  plugin shipped a bug from exactly that: labels were passed as the third
  argument, which compiles and renders *empty* buttons (the live menu showed six
  blank rows). Children always go in `props.children`.
  `test/apply-check.cjs` asserts every menu item carries a non-empty label.
- **A `store` handle can only mount under one slot scope.** Declaring `store` on
  a registration makes the renderer bind `useStore`/`actions`, but the same
  handle cannot be mounted under two different scopes — this plugin needs its
  state in both a session-scoped slot (the tab menu) and a root-scoped one
  (Settings → General), and doing so throws
  `store handle mounted under … is already mounted under scope …`. So the store
  is passed as a plain prop and the components subscribe with
  `React.useSyncExternalStore` directly. The snapshot must be identity-stable;
  `test/apply-check.cjs` asserts the components declare no `store` handle.
- **Screenshots are viewport-only** — there is no full-page capture.
- **`ref` values expire** when the page re-renders. A stale ref is refused with
  a message telling you to read the elements again; it is never guessed at.
- **Multiple windows.** A client Inspect query is broadcast and the first valid
  page answer wins, so with several windows open an answer may come from a
  different window. Single-window use is unaffected.
- **Text extraction is `innerText`** — it reflects what is rendered, so
  off-screen or virtualized list content may be absent. Use `mode: 'html'` or
  `browser_eval` when you need more.
- **The Inspect channel is documented as read-only** and this plugin uses it to
  carry write operations (click, type, navigate). Nothing enforces that today,
  but if a future release adds such a constraint, this plugin would need its own
  transport instead.
- **Plugin code changes need a restart.** The profile config is watched, so a
  `config:` change re-applies live, but the loader keeps the module it already
  imported; editing `index.js` or `client.js` takes effect on the next launch
  (a page refresh picks up `client.js`).

## Install

This is a third-party **bundle plugin**: it is loaded from your DSH profile, not
from `app.asar`. Nothing in the installed application is modified, so an
uninstall is exact and an app update cannot clobber it.

1. **Clone it somewhere permanent** (not inside the app install):

   ```bash
   git clone https://github.com/guanhaisen/dsh-agent-browser.git
   ```

2. **Add it to your Desktop profile.** Edit
   `<dsh-home>/profiles/desktop/package.json` — `<dsh-home>` is usually
   `C:\Users\<you>\.dsh` on Windows or `~/.dsh` elsewhere:

   ```json
   {
     "dependencies": {
       "dsh-agent-browser": "link:/absolute/path/to/dsh-agent-browser"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "...your existing bundles...",
           "dsh-agent-browser"
         ]
       }
     }
   }
   ```

   Both parts are required: the `link:` dependency makes the package resolvable,
   and the `bundles` entry is what actually mounts it.

3. **Make the package resolvable to Node.** Either run your profile's package
   manager, or — if that pulls from the network you would rather avoid — create
   the link by hand:

   ```powershell
   # Windows, from an elevated shell is NOT required
   New-Item -ItemType Junction `
     -Path  "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-agent-browser" `
     -Target "<absolute path to the clone>"
   ```

   ```bash
   # macOS / Linux
   ln -s /absolute/path/to/dsh-agent-browser \
         ~/.dsh/profiles/desktop/node_modules/dsh-agent-browser
   ```

4. **Enable the tools you want** in `<dsh-home>/profiles/desktop/cordis.patch.yml`
   (optional — the defaults are safe):

   ```yaml
   - id: dsh-agent-browser
     name: dsh-agent-browser
     config:
       enableEval: false        # leave false unless you want the model to run JS in pages
       maxReadChars: 20000
       screenshotMaxWidth: 1568
   ```

   Also raise the Inspect timeout if you take large screenshots, since a slow
   page can exceed the 10 s default:

   ```yaml
   - id: cordis-host-runner
     name: '@deepseek-ai/dsh-cordis-host-runner'
     config:
       clientInspectTimeoutMs: 60000
   ```

5. **Restart the application.** A new loader row is only read at startup.

After restarting, ask the model to call `browser_tabs` — if it returns the tabs
you have open in the right Sidebar, the plugin is live.

### Where the controls appear

- The model gains six tools (seven with `enableEval: true`).
- **Right-click a browser tab** for *Viewport size* (fit / phone / tablet /
  desktop / custom).
- **Settings → General → Browser viewport** sets the default for new tabs.
- `browser.viewport.cycle` is registered but **ships unbound**; bind it in
  *Settings → Shortcuts* if you want a keyboard shortcut.

### Rollback

Remove the `dsh-agent-browser` entry from `dsh.profile.bundles`, delete the
`node_modules/dsh-agent-browser` link, and restart. Nothing in `app.asar` is
touched, so the built-in browser returns to exactly its shipped behavior. To keep
the plugin but disable it temporarily, delete only the `bundles` entry.

### Requirements

- **Desktop app only.** The tools drive an Electron `<webview>` guest. Web
  profiles render a sandboxed cross-origin `<iframe>` whose DOM cannot be read,
  so the tools report an explicit reason instead of pretending to work.
- **DSH `0.2.0-rc.2`** was the version this was built and verified against.
  The plugin relies on public contracts (the Inspect provider registry, the
  `sidebar.right.tab.menu.item` and `settings.general.item` seats, and the
  `[data-sidebar-right-*]` DOM attributes), so it should survive patch updates —
  but see *Known limitations* for what happens if a contract moves.
- **Node 20+** to run the test suite.

## Tests

Seven suites, no test framework — plain Node scripts that exit non-zero on
failure. The executable is located automatically (a sibling install, or
`DeepSeek Harness.exe` somewhere up the tree); normally you do not pass it.

```bash
node test/run-all.cjs
```

If your install is somewhere unusual, point at it explicitly, either way:

```bash
node test/run-all.cjs "/path/to/DeepSeek Harness.exe"
# or
DSH_DESKTOP_EXE="/path/to/DeepSeek Harness.exe" node test/run-all.cjs
```

Two suites import the real validators out of the application's `app.asar`, so
they cannot run without a packaged install. On a machine that has none — CI, for
instance — pass `--offline` to skip just those two; they are reported as `SKIP`,
never as a pass:

```bash
node test/run-all.cjs --offline
```

| Suite | What it pins down |
|---|---|
| `schema-check` | Every tool's raw JSON Schema against the real `dsh-tools` validator. |
| `client-check` | The Client provider manifest, `pageCall` codegen, and guest lookup in a stub DOM. |
| `page-helpers-check` | Read / click / type / select / refusal paths, run against a DOM stub. |
| `eval-gate-check` | The Host-side `enableEval` guard, including the `cordis_inspect_query` bypass. |
| `viewport-check` | Sizing math, validation and clamping, and `setViewport` dispatch wiring. |
| `apply-check` | `apply()` activation and seat registration — if this fails, the whole client half is down. |
| `viewport-controller-check` | Which element gets which inline style, centring, fallbacks, unmounted tabs. |

Two of these must run under the packaged executable in Node mode, because they
import the real validators out of `app.asar`; `run-all.cjs` does that for you.

Several assertions exist because a bug shipped once and was only visible at
runtime: a missing `shortcuts.register` defaults map that silently took the
entire client half down, `jsx(type, props, key)` labels passed as the React key
rendering blank buttons, a menu that dismissed itself because `Modal` portals
outside the kit's click-through boundary, and a viewport height that stretched
the page and broke `100vh`.

## Model experience

Seven tools enter the model-facing tool list (six with `enableEval: false`). The
tool schemas are stable; results are lossless JSON. Screenshots add one image
block per call, so they consume image tokens — prefer `browser_read` for text
and reach for `browser_screenshot` when layout or visual state matters.

## License

[MIT](LICENSE).

