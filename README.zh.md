# dsh-agent-browser

[English](README.md) | 中文

让模型真正**使用**DSH 右侧 Sidebar 浏览器：读取页面文本、点击与输入、导航、切换视口尺寸、截图 —— 全部通过对话中的普通工具调用完成。

同时提供**手机 / 平板 / 电脑 / 自定义视口切换器**，不必离开应用就能看到站点在其它尺寸下的渲染效果。

```
browser_navigate { url: "https://example.com" }
browser_read     { mode: "elements" }     -> refs e1, e2, …
browser_act      { action: "type", ref: "e1", text: "hello" }
browser_act      { action: "click", ref: "e2" }
browser_screenshot {}                     -> 查看版面
browser_viewport { preset: "phone" }      -> 以 390×844 重新渲染
```

> **仅限桌面端。**工具驱动的是 Electron `<webview>` guest。Web profile 的 Sidebar 浏览器是 sandbox 的跨源 `<iframe>`，其 DOM 完全无法读取，因此这些工具会给出指名 Web profile 的明确原因，而不是假装可用。`browser_tabs` 仍会列出这些 tab —— 以 `mounted: true`、`carrier: "iframe"` 呈现 —— 因此你能看到该 tab 确实存在，以及它为何无法被驱动。

> **第三方非侵入式插件。**它从你的 DSH profile 挂载，绝不改动 `app.asar`，内置浏览器保持出厂状态。

- [安装](#install) —— 克隆、接入 profile、重启
- [工具](#tools) —— 模型可以调用的能力
- [该用哪个尺寸](#该用哪个尺寸) —— 选电脑或手机，别用默认
- [视口尺寸](#viewport-sizes) —— UI 一侧
- [已知限制](#known-limitations) —— 提问前请先读

<a id="tools"></a>
## 工具

| 工具 | 作用 |
|---|---|
| `browser_tabs` | 列出当前 Session 的浏览器 tab：id、标题、url、加载状态、是否已挂载可驱动、哪个是 `active`，以及它的 `carrier`（桌面端为 `webview`，Web 为 `iframe`）。 |
| `browser_read` | 读取一个 tab：`mode: 'text'`（默认）返回可见文本，`'elements'` 返回可操作的交互元素，`'html'` 返回页面 HTML。`truncated` 表示撞到了元素数量上限 —— 隐藏元素会被静默过滤，绝不计入截断。 |
| `browser_act` | `click`、`type`、`press`、`scroll`、`select` 或 `wait`。用 `'elements'` 读取得到的 `ref` 定位元素，或用 CSS `selector`。 |
| `browser_screenshot` | 截取可见视口，作为模型能看到的图片块返回。传 `preset` 即可一次调用完成「设尺寸 + 截图」；结果会报告它实际使用的尺寸。 |
| `browser_navigate` | 在新 tab 打开 URL，或导航已有 tab。 |
| `browser_viewport` | 读取或修改 tab 的视口尺寸：`auto`、`phone`（390×844）、`tablet`（834×1112）、`desktop`（1280×800）或 `custom`。页面会真实重排，因此站点自身的响应式断点会生效。省略 `tabId` 时作用于唯一已挂载的 tab；读取时总会报告它实际解析到的 tab。 |
| `browser_eval` | 在页面中执行 JavaScript。**默认关闭**（见配置）。表达式返回其值；语句体返回它显式 `return` 的内容。 |

一次典型循环：

```
browser_navigate { url: "https://example.com" }
browser_read     { mode: "elements" }          -> refs e1, e2, …
browser_act      { action: "type", ref: "e1", text: "hello" }
browser_act      { action: "click", ref: "e2" }
browser_read     { mode: "text" }              -> 确认变化
browser_screenshot { preset: "desktop" }       -> 查看真实的桌面版面
browser_screenshot { preset: "phone" }         -> 以及 390px 宽的版面
```

当 Session 只有一个已挂载的浏览器 tab 时，可以省略 `tabId`。若有多个，先调用 `browser_tabs`，并指明你要用的那个。

## 该用哪个尺寸

**不要用默认尺寸截图。**默认视口是 `auto`，也就是 Sidebar **栏宽** —— 通常 400–700 CSS 像素。这不是任何真实设备使用的宽度：它会触发真实访客永远看不到的断点，因此在该尺寸下截图会**歪曲**页面。请有意选择尺寸：

| 任务 | 使用 | 尺寸 |
|---|---|---|
| 浏览或审查普通站点 | `preset: "desktop"` | 1280×800 |
| 设计、修复或检查手机页面 / 移动端版面 | `preset: "phone"` | 390×844 |
| 检查中间断点 | `preset: "tablet"` | 834×1112 |
| 特定尺寸（1440 笔记本、1024 平板等） | `preset: "custom"` | 自行填写 |

工具描述里也写了这些，所以模型无需被提醒就会这么做。两种落实方式：

- **直接在指定尺寸下截图** —— `browser_screenshot { preset: "phone" }` 在**一次调用**里完成设尺寸与截图。优先用这种方式：不会在两次调用之间被遗忘。
- **设一次，之后持续截图** —— `browser_viewport { preset: "desktop" }` 会持久保存在该 tab 上，之后不带 preset 的 `browser_screenshot` 会继承它。

每个截图结果都会报告它**实际**截取的尺寸（`preset`、`pageWidth`、`pageHeight`、`scale`），因此截错尺寸在回答中是**可见**的，而不是静默误导。

<a id="viewport-sizes"></a>
## 视口尺寸（手机 / 电脑 / 自定义）

浏览器 tab 默认按 Sidebar 栏宽渲染。切换视口会让页面以真实的手机、平板或电脑宽度进行排版，因此站点自身的 media query 会生效，你看到的就是该尺寸下真实的版面。该选哪个见上面的 *该用哪个尺寸* —— 简单说：`auto` 就是栏宽，截图时你几乎永远不想要它。

三种操作方式：

- **右键点击 tab** —— tab 栏没有“⋯”按钮。docking kit 通过**右键**（其 `onContextMenu` 处理器）打开 tab 菜单，这些选项就出现在该菜单的*视口尺寸*下。当前选项带勾选标记。只开一个 tab 时，菜单本来只有*关闭*，正是这些选项让它值得打开。
- **设置 → 通用 → 浏览器视口** —— 新 tab 继承的默认值。
- **快捷键** —— `browser.viewport.cycle` 在聚焦的浏览器 tab 上循环切换 自适应 → 手机 → 平板 → 电脑。它**默认不绑定按键**，以免抢占已有组合键；请到*设置 → 快捷键*里搜索“viewport”自行绑定。

`browser_viewport` 把同样的控制权交给模型。读取时会同时报告预设和页面**实际**排版的 CSS 像素宽度：

```json
{ "tabId": "tab3", "preset": "phone", "pageWidth": 390, "pageHeight": 844,
  "targetWidth": 390, "scale": 0.62, "mounted": true }
```

读取时按与写入相同的方式解析隐式 tab，因此 `tabId` 总会被报告 —— 省略它时作用于 Session 中唯一的浏览器 tab；指名一个不存在的 tab 会被拒绝，并给出与其它工具相同的错误。

### 实现原理，以及为何不用 zoom

guest 是 Electron `<webview>`，而该元素的盒子**就是**页面的视口：宽 390px 的元素会让文档以 390 CSS 像素排版。要在窄栏中显示更宽的视口，只对显示做缩放：把元素放在裁剪容器内缩小，并在 Sidebar 尺寸变化时由 `ResizeObserver` 重算缩放比。页面排版保持真实，只有呈现被缩小。读取结果里的 `pageWidth` 来自 guest 自身的 `window.innerWidth`，因此它报告的始终是页面的真实认知。

刻意**不使用** `<webview>.setZoomFactor()`。Chromium 的缩放策略是 same-origin，缩放一个 tab 会连带缩放同站点的其它 tab —— 同一 workspace 的 tab 共享 storage partition。用元素盒子加 CSS transform 才能让每个 tab 相互独立。

### 摆放位置

带尺寸的页面在栏中**居中**（横向居中，能放得下时纵向也居中），看起来像设备预览，而不是挤在左上角。居中通过把 `translate(...)` 放在 transform 列表中 `scale(...)` **之前**实现：因此偏移量是未经缩放的栏像素，而缩放仍然绕元素左上角进行。

两处刻意的取舍：

- **不用 flexbox 居中。**flex 居中的是元素的*布局*盒，也就是未缩放的目标尺寸（1280px 放进约 650px 的栏），它会把缩放后的结果推到一边，而 translate 又会做一遍同样的事。只保留一种机制；每次 apply 都会清除残留的 flex 居中样式，使已被错误设置的容器就地纠正。
- **比栏更高的页面顶部对齐，而非居中。**把一个 844px 高的手机页面在更矮的栏中纵向居中，会同时裁掉上下两端，正好藏住文档开头。

值得了解的后果：

- 在窄栏中以电脑宽度显示时，文字确实会变小 —— 这是看到真实桌面版面的诚实代价。可用 `custom` 尺寸（240–3840 × 320–2160）在版面与可读性之间取舍。
- 已打开但未挂载的 tab 暂时无法调整；选择会被保存，并在你点击该 tab 的瞬间应用。恢复的 Session 会在加载后不久重新应用已保存的预设。
- 尺寸按 tab 记忆，存于 `localStorage` 的 `dsh.agent-browser.viewport.v1`，重启后依然有效。
- **高度同样是预设的真实高度。**一个“电脑 1280×800”的 tab 会以恰好 1280×800 排版，然后在栏内缩小绘制。曾尝试把高度放大以填满栏位，但被否决：那会拉伸视口（该预设排成了 1571px 高），并静默破坏 `100vh` 和所有按高度布局的页面。因此缩放结果常比栏更矮 —— 现在表现为页面上下两侧均衡的留白。

## 配置

在 profile 的 `cordis.patch.yml` 中：

```yaml
- id: dsh-agent-browser
  name: dsh-agent-browser
  config:
    # 注册 browser_eval。它会在页面中执行任意脚本，因此除非部署方明确开启，
    # 否则保持关闭。
    enableEval: false
    # browser_read 的 text/html 字符预算。
    maxReadChars: 20000
    # browser_screenshot 交付前缩小到的最大宽度。
    screenshotMaxWidth: 1568
```

Inspect 通道还有一个进程级的 client 查询超时，默认 10 秒。较慢的页面可能超时，可在持有该注册表的 runner 上提高：

```yaml
- id: cordis-host-runner
  name: '@deepseek-ai/dsh-cordis-host-runner'
  config:
    clientInspectTimeoutMs: 60000
```

每次浏览器调用有自己 **6 秒**的预算用于等待页面，刻意低于上述 10 秒默认值，以便较慢的页面回答“仍在加载”，而不会变成不透明的传输超时。该预算覆盖整次调用，而非其中某一步：`browser_act { action: "wait" }`、导航后的 settle、点击后的停顿都从同一个截止时间中扣除，因此任何单次调用都不会超出调用方。若想要更高的上限，请调高上面的 `clientInspectTimeoutMs` —— 插件自身的预算仍为 6 秒，目前不可配置。

## 实现结构

```
model → browser_* tool (Host)
          └─ ctx.cordisInspect.query('client', 'AgentBrowser', <method>, …)
                └─ WebSocket/RPC → the page → Client Inspect provider
                      └─ finds the tab's guest by carrier
                         [data-sidebar-right-session] > [data-sidebar-right-tab]
                           ├─ <webview>  executeJavaScript(...) / capturePage()
                           └─ <iframe>   refused: Web profile, unreadable
                ← lossless JSON
          └─ screenshot: ctx.attachments.saveImage() → { type: 'image', attachment }
```

两个值得了解的设计选择：

- **使用 Inspect 通道，而非私有传输。**`cordisInspect` 是唯一的一等 Host→Client 请求/响应机制：它按 requestId 关联、遵守工具调用的 `AbortSignal`，并依据声明的 JSON schema 校验输入与输出。复用它意味着不需要新的线协议。
- **页面通过自身的载体驱动。**每个页面侧 helper 都用 `toString()` 序列化，并在 `executeJavaScript` 前包进一个 IIFE，因此各 helper 之间可见，却不会污染被访问页面的全局命名空间。

provider 在 `[data-sidebar-right-session]` 内读取 `[data-sidebar-right-tab]`，把 tab 映射到它的 guest。桌面端浏览器 tab 声明了 `keepMounted`，因此 tab 在切换 tab、切换 Session、折叠与浮动时都保留 DOM —— 这正是工具能够触达用户当前并未查看的 tab 的原因。

两种载体都会被识别。内置实现给桌面端 guest 打上 `<webview data-sidebar-browser-frame="webview">`，给 Web guest 打上 `<iframe data-sidebar-browser-frame="iframe">`；driver 匹配二者，并把找到的哪一种作为 `carrier` 报告。只有 webview 可驱动，因此 iframe 情况会被指名拒绝，而不会被报告成 tab 缺失。

视口尺寸复用同一条发现路径，但仅适用于 webview 载体：预设会写到 guest 自身的盒子上，而 iframe 并不向宿主渲染进程暴露该盒子。尺寸调节不新增自己的 DOM：只在 guest 及其既有的父容器上设置内联样式，因为内置呈现层在每次重新呈现时会重新 append 该元素，任何由本插件插入的 wrapper 都会被立刻移出。内置组件只设置 `className`、从不设置 `style`，因此 React 不会动这些内联样式。guest 已离开文档的 tab，其状态会在重新应用时被清理，因此已关闭的 tab 既不会让 `ResizeObserver` 继续存活，也不会报告过期的缩放比。

控件位于公开的加法式座位 —— `sidebar.right.tab.menu.item` 与 `settings.general.item` —— 而非替换任何东西，因此内置浏览器保持原样工作，禁用插件时整个特性完全消失。

## 安全性

工具继承内置浏览器已有的全部限制，不添加任何自身的放宽：

- guest 保持 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`、`webSecurity: true`。
- 主进程仍然拒绝 DSH 应用源、非 HTTP(S) 协议、携带凭据的地址，并且仍然拒绝下载、权限请求、原生弹窗与 webview 嵌套。
- `executeJavaScript` 在页面自身的世界中执行；宿主渲染进程从不向被访问内容暴露 Node 或 Electron。
- `browser_eval` 默认关闭。开启它等于让模型在页面中执行任意脚本 —— 请视同把该源的 shell 权限交出去。**该开关在 Host 侧强制执行，而不只是在工具列表里隐藏。**Client provider 始终声明 `eval` 方法，而模型同时持有 `cordis_inspect_query`，可以直接触达该方法；Client 半身读不到插件配置（boot manifest 的行不携带配置），因此 Host 半身安装了一个工具 guard：只要 `enableEval` 不为 `true`，就拒绝指向 `client` → `AgentBrowser` → `eval` 的 `cordis_inspect_query` 调用。
- **`browser_eval` 在页面自身的世界中执行代码。**先尝试按表达式求值，只有真正的 `SyntaxError` 才会回退为按语句体执行 —— 运行时错误绝不重试，因为已经产生副作用的语句体绝不能被跑第二遍。

**页面内容是未受信数据。**页面显示的任何内容都可能尝试 prompt injection。请把工具输出当作需要推理的数据，永远不要当作指令。

<a id="known-limitations"></a>
## 已知限制
- **仅限桌面端**，如上所述。
- **仅限已挂载的 tab。**已打开但尚未挂载的 tab 无法驱动；工具会说明这一点，并请你先点击该 tab 一次。（实际上 tab 一经打开或恢复就会挂载。）设置视口是例外：它会被保存，并在 tab 挂载时应用。
- **`shortcuts.register` 必须提供 `defaults`。**遗漏它会在 `apply()` 期间抛错，从而让整个 client 半身（含 Inspect provider）失效，且只表现为 `web boot: … did not activate`。本插件提供 `defaults: {}`；`test/apply-check.cjs` 守护这个形状，使该故障无法静默重现。
- **菜单项从标准 slot prop 读取 `sessionId`。**仅当未来的 shell 不再提供它时，才回退到外层的 `[data-sidebar-right-session]`，因此两条路径下控件都可用。
- **tab 菜单是右键菜单，不是“⋯”按钮。**kit 的 tab 栏没有溢出按钮；菜单由 tab 的 `onContextMenu` 处理器打开。自定义尺寸表单刻意**未使用** `Modal`：kit 会在其元素之外的任何 `pointerdown` 时关闭菜单，而 `Modal` 会 portal 到 `document.body`，因此 portal 出来的对话框会在首次点击时自我销毁。该表单改为内联渲染，并拦截指针事件。
- **`jsx(type, props, key)` 的第三个参数是 React key，而非 children。**本插件曾经正是因此出过 bug：把标签文字传到第三个参数，编译通过却渲染出*空白*按钮（线上菜单显示了六行空项）。children 始终应放进 `props.children`。`test/apply-check.cjs` 断言每个菜单项都带有非空标签。
- **一个 `store` handle 只能挂载在一个 slot scope 下。**在注册项上声明 `store` 会让渲染器绑定 `useStore`/`actions`，但同一个 handle 无法挂在两个不同 scope 下 —— 本插件需要把状态同时用于 session scope 的座位（tab 菜单）与 root scope 的座位（设置 → 通用），这样做会抛出 `store handle mounted under … is already mounted under scope …`。因此 store 以普通 prop 传递，组件直接用 `React.useSyncExternalStore` 订阅。快照必须保持引用稳定；`test/apply-check.cjs` 断言组件未声明 `store` handle。
- **无法交付的截图仍会正常作答。**若未挂载 attachment store，或 store 拒绝了该图片（例如截图过大），结果会丢弃字节并在 `note` 中说明原因，而不是让调用失败。
- **截图默认使用 Sidebar 栏宽。**`auto` 通常是 400–700 CSS 像素，并非真实设备尺寸。当版面重要时，请传 `preset`（或先用 `browser_viewport` 设好）。
- **截图只含视口** —— 没有整页截图。
- **`ref` 会在页面重新渲染后失效。**过期的 ref 会被拒绝，并提示你重新读取元素；绝不猜测。
- **多窗口。**client Inspect 查询是广播的，第一个有效的页面回答胜出，因此开多个窗口时，回答可能来自另一个窗口。单窗口使用不受影响。
- **文本提取使用 `innerText`** —— 它反映的是渲染结果，因此屏幕外或虚拟化列表的内容可能缺失。需要更多内容时用 `mode: 'html'` 或 `browser_eval`。
- **`active` 需要有屏幕上的 Session。**它来自应用自身的 `sidebarRight.commandTarget()`，后者报告聚焦分栏的 tab 或屏幕上 Session 的活动 tab。对于当前未显示的 Session，它无法作答，此时每个 tab 的 `active` 都退化为“是否已挂载”—— 与未来版本移除该方法时使用的是同一套回退。
- **视口尺寸在构造上仅限桌面端。**预设写入的是 guest 自身的盒子，只有 `<webview>` 载体具备该盒子；Web profile 的 `<iframe>` tab 会报告其已保存的预设，但永远不会被调整尺寸。
- **Inspect 通道的文档定位是只读**，而本插件用它承载写操作（点击、输入、导航）。目前没有任何机制强制这一点，但若未来版本加入该约束，本插件将需要自己的传输层。
- **插件代码改动需要重启。**profile 配置受监视，因此 `config:` 改动会实时重新应用，但 loader 会保留已导入的模块；修改 `index.js` 或 `client.js` 需要下次启动才生效（`client.js` 可通过刷新页面生效）。
- **自动选中 bundle 是安装器的行为，不是保证。**新安装的包若声明了 `dsh.bundle`，会被追加到 `dsh.profile.bundles`，这也是「一条命令就够」的原因。若未来版本不再这样做，请手工把 `"dsh-agent-browser"` 加入 `dsh.profile.bundles` 并重启。
- **应用运行期间，CLI 无法向 profile 安装。**请改用 Plugins 页或 agent 工具，或先完全退出应用。

<a id="install"></a>
## 安装

这是一个第三方 **bundle 插件**：它从你的 DSH profile 加载，而非从 `app.asar`。已安装的应用不被修改，因此卸载是彻底的，应用更新也不会覆盖它。

DSH 自带插件管理器，而本仓库是合法的 bundle，因此**一条命令就够**。不需要克隆，不需要手工改文件，不需要手工建链接。

### 方式 A —— 一条命令（CLI）

```bash
dsh plugin --profile desktop add github:guanhaisen/dsh-agent-browser
```

**请先完全退出 DeepSeek Harness。**该 CLI 不会去动正在运行的应用所持有的 profile；下面两种方式则可在运行中安装。

### 方式 B —— Plugins 页面（无需终端）

1. 打开侧边栏的 **Plugins** 入口。
2. 选择安装，粘贴同一个规格：`github:guanhaisen/dsh-agent-browser`。
3. 观察 pnpm 输出，然后确认。

已安装的 bundle 会出现在该页面，你也可以在这里停用、移除它们，或打开它们注册的配置页。

### 方式 C —— 让 Agent 装

让模型在 `desktop` profile 中安装 `github:guanhaisen/dsh-agent-browser`；它会使用 `plugin_manager` 工具。每个工具动作都需要 `danger-full-access` 或一次批准。

### 钉住版本（建议用于稳定环境）

上述规格跟踪 `master`。若想停在某个已发布版本：

```bash
dsh plugin --profile desktop add 'github:guanhaisen/dsh-agent-browser#v0.1.0'
```

### 安装器替你完成了什么

以下都不需要你手写：

- 把依赖写入 `<dsh-home>/profiles/desktop/package.json`；
- **自动把该 bundle 追加到 `dsh.profile.bundles`** —— 新装的包只要声明了 `dsh.bundle`，就会被并入该列表，而正是这个列表让它真正挂载；
- 调用应用自带的 pnpm（无需另行安装 pnpm）；
- 并且由于桌面端组合包含 HMR，改动会**实时生效，无需重启**。

如果工具没有出现，说明 bundle 未被选中：把 `"dsh-agent-browser"` 加入 `<dsh-home>/profiles/desktop/package.json` 的 `dsh.profile.bundles`，然后重启。

### 按需开关工具

可选 —— 默认值是安全的。在 `<dsh-home>/profiles/desktop/cordis.patch.yml` 中：

```yaml
- id: dsh-agent-browser
  name: dsh-agent-browser
  config:
    enableEval: false        # 除非你想让模型在页面中执行 JS，否则保持 false
    maxReadChars: 20000
    screenshotMaxWidth: 1568
```

如果需要较大的截图，也请提高 Inspect 超时，因为较慢的页面可能超过默认的 10 秒：

```yaml
- id: cordis-host-runner
  name: '@deepseek-ai/dsh-cordis-host-runner'
  config:
    clientInspectTimeoutMs: 60000
```

`config:` 改动会实时重新应用；修改插件自身的 `index.js` 则需要重启。

### 控件出现的位置

- 模型获得六个工具（`enableEval: true` 时七个）。
- **右键点击浏览器 tab**，可看到*视口尺寸*（自适应 / 手机 / 平板 / 电脑 / 自定义）。
- **设置 → 通用 → 浏览器视口**设置新 tab 的默认值。
- `browser.viewport.cycle` 已注册但**默认不绑定按键**；想要键盘快捷键请到*设置 → 快捷键*绑定。

让模型调用 `browser_tabs` 即可验证 —— 它应列出你在右侧 Sidebar 打开的 tab。

### 卸载

使用 Plugins 页面的移除操作，或：

```bash
dsh plugin --profile desktop remove dsh-agent-browser
```

两者都会移除依赖与 `bundles` 条目。若想保留安装但停用，把该 bundle 关掉（或只删除 `bundles` 条目）并重启。`app.asar` 未被触碰，因此内置浏览器回到与出厂完全一致的行为。

### 手工安装（兜底）

仅当上述方式不可用时才用 —— 网络无法访问 GitHub、机器上没有 pnpm，或者你要改插件源码（本地 link 让你的改动无需重新发布即可生效）。

1. **克隆到一个固定位置**（不要放在应用安装目录内）：

   ```bash
   git clone https://github.com/guanhaisen/dsh-agent-browser.git
   ```

2. **把它加入你的桌面端 profile。**编辑 `<dsh-home>/profiles/desktop/package.json` —— `<dsh-home>` 在 Windows 上通常是 `C:\Users\<you>\.dsh`，其它平台是 `~/.dsh`：

   ```json
   {
     "dependencies": {
       "dsh-agent-browser": "link:/absolute/path/to/dsh-agent-browser"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "...你原有的 bundles...",
           "dsh-agent-browser"
         ]
       }
     }
   }
   ```

   两部分都必需：`link:` 依赖让包可被解析，`bundles` 条目才真正挂载它。

3. **让 Node 能解析到该包。**可以运行你 profile 的包管理器，也可以手工建立链接：

   ```powershell
   # Windows，无需管理员权限
   New-Item -ItemType Junction `
     -Path  "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-agent-browser" `
     -Target "<克隆目录的绝对路径>"
   ```

   ```bash
   # macOS / Linux
   ln -s /absolute/path/to/dsh-agent-browser \
         ~/.dsh/profiles/desktop/node_modules/dsh-agent-browser
   ```

4. **重启应用。**

不要对同一个包同时使用手工 link 与安装器：管理器会尝试替换该链接，pnpm 在 Windows 上可能报 `EPERM: rename` 失败。二选一。

### 环境要求

- **仅桌面端应用。**工具驱动 Electron `<webview>` guest。Web profile 渲染的是 sandbox 的跨源 `<iframe>`，其 DOM 无法读取，因此工具会报告指名 Web profile 的明确原因，而不是假装可用；`browser_tabs` 仍会把它列为 `mounted: true`、`carrier: "iframe"`。
- **DSH `0.2.0-rc.2`** 是构建与验证所依据的版本。插件依赖公开契约（Inspect provider 注册表、`sidebar.right.tab.menu.item` 与 `settings.general.item` 座位，以及 `[data-sidebar-right-*]` DOM 属性），因此应能跨补丁更新存活 —— 但若某个契约发生迁移，请见*已知限制*。
- **Node 20+** 用于运行测试套件。

## 测试

八个套件，不使用测试框架 —— 都是失败即非零退出的普通 Node 脚本。可执行文件会自动定位（同级安装，或树上层的 `DeepSeek Harness.exe`）；通常你不需要传它。

```bash
node test/run-all.cjs
```

如果你的安装位置比较特殊，用两种方式之一显式指定：

```bash
node test/run-all.cjs "/path/to/DeepSeek Harness.exe"
# 或
DSH_DESKTOP_EXE="/path/to/DeepSeek Harness.exe" node test/run-all.cjs
```

有三个套件会从应用的 `app.asar` 导入真实校验器，因此没有打包好的安装就无法运行。在没有安装的机器上 —— 例如 CI —— 传 `--offline` 只跳过那三个；它们会报告为 `SKIP`，绝不报告为通过：

```bash
node test/run-all.cjs --offline
```

| 套件 | 锁定什么 |
|---|---|
| `schema-check` | 每个工具的原始 JSON Schema 对比真实的 `dsh-tools` 校验器，并断言每个工具的 `required` 字段与其是否接受空调用相符。 |
| `client-check` | Client provider manifest、`pageCall` 代码生成、在 stub DOM 中的 guest 查找、`getViewport` 的隐式 tab 解析，以及 Web profile 的拒绝行为。 |
| `page-helpers-check` | 读取 / 点击 / 输入 / 选择 / 拒绝路径，针对 DOM stub 运行。 |
| `eval-gate-check` | Host 侧的 `enableEval` guard，包括 `cordis_inspect_query` 绕过路径。 |
| `viewport-check` | 尺寸计算、校验与钳制，以及 `setViewport` 的分发接线。 |
| `apply-check` | `apply()` 激活与座位注册 —— 这一项失败意味着整个 client 半身失效。 |
| `viewport-controller-check` | 哪个元素获得哪些内联样式、居中、回退、未挂载的 tab。 |
| `contract-check` | 每个工具的**真实**结果形状 —— 成功与降级 —— 经过注册表自身的 lossless-JSON detach 与输出 schema 校验，外加 `truncated` 标志语义与活动 tab 报告。 |

其中三个必须在打包后的可执行文件里以 Node 模式运行，因为它们从 `app.asar` 导入真实校验器；`run-all.cjs` 会替你处理。

若干断言的存在，是因为曾经出过只在运行时才可见的 bug：遗漏 `shortcuts.register` 的 defaults 会静默让整个 client 半身失效；`jsx(type, props, key)` 把标签当作 React key 会渲染出空白按钮；`Modal` portal 到 kit 的点击穿透边界之外会让菜单自我关闭；视口高度被拉伸会破坏 `100vh`。

`contract-check` 出于同样的原因存在。绿色的 `schema-check` 完全不能证明某个结果真的能被返回：`browser_viewport` 的读取遗漏了它自己输出 schema 所要求的 `tabId`，而 `browser_screenshot` 的两条兜底路径都输出了 `base64: undefined`，而注册表的 lossless-JSON detach 会直接拒绝后者 —— 于是一个文档中写明可用的读取调用、以及每一次优雅的截图降级，都会在运行时抛错。该套件现在把每个工具的真实结果送入注册表的两个阶段，并直接驱动 Host 的截图分支，使其形状无法漂移。

## 模型体验

七个工具进入模型可见的工具列表（`enableEval: false` 时六个）。工具 schema 稳定；结果是 lossless JSON。截图每次调用会增加一个图片块，因此消耗图片 token —— 文本优先用 `browser_read`，当版面或视觉状态重要时再用 `browser_screenshot`。

工具结果绝不会在模型需要据以推理的事实位置上给出 `null` 或缺失值：无法交付的截图会在 `note` 中说明，而不是返回不可用的字节；`browser_read` 的 `truncated` 区分“列表撞到了上限”与“隐藏元素被过滤”；`browser_tabs` 会报告每个 tab 的 `carrier`，因此 Web profile 的 tab 是**可见地不可驱动**，而不是看起来根本不存在。

截图会自报所用视口。结果包含 `preset`、`pageWidth`、`pageHeight` 与 `scale`，因此模型能判断自己实际截的是哪个尺寸 —— 而工具描述会告诉它：浏览普通站点时传 `preset: "desktop"`，做移动端工作时传 `preset: "phone"`，而不是把视口留在 `auto` 栏宽上。

## 许可

[MIT](LICENSE)。
