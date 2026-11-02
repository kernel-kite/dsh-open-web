# dsh-open-web · 打开网页版 DeepSeek Harness

让桌面版 DSH 在你说“**帮我打开网页版 DeepSeek Harness**”时，直接用系统默认浏览器打开**已登录**的网页版，不需要再输入令牌、也不需要做任何设置。

## 它做了什么

1. 用 `webServer.protocol/port` 拼出本地 Web GUI 地址（`http://127.0.0.1:<端口>`）；
2. 调用宿主服务 `connection.authenticatedUrl(base)` 生成**带当前进程令牌**的地址——这正是桌面版窗口自己使用的登录链路；
3. 先自检：打开令牌地址看服务端是否下发 cookie，再带 cookie 访问裸地址确认返回 200（而不是 401）；
4. 用系统默认浏览器打开该地址。浏览器加载后服务端会铸 cookie，于是“打开即登录”。

## 工具

`open_web_ui`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `revealUrl` | boolean | 默认 `false`。设为 `true` 时在结果里返回带令牌的原始链接（仅当用户明确索要链接；该链接等同于本机登录凭据）。 |
| `dryRun` | boolean | 只生成并校验地址，不真的打开浏览器，用于自检。 |

返回值包含：`opened`、`method`（实际生效的启动方式）、`displayUrl`（脱敏地址）、`tokenUrlStatus`、`cookieIssued`、`baseStatus`、`loggedIn`、`startupSkipReady`、`notes`；`revealUrl: true` 时额外有 `rawUrl`；`dryRun: true` 时额外有 `clientReports`（最近几条客户端自检上报）。

## 第二个工具：`open_standalone_web`（另起一个 `dsh web` 实例）

上面的 `open_web_ui` 打开的是**当前桌面进程自带的网页版**——同一份会话、同一份插件。
`open_standalone_web` 打开的是**另起一个 `dsh web` 进程**——自己的 profile、自己的插件集、自己的会话，跟你手动在终端敲 `dsh web` 完全一样，只是不用等。

说“打开 web / 打开独立 web / 起一个 web / 另开一个 web / 后台 web”就会调用它。

**为什么是秒开**：插件一加载（默认延迟 1 秒避开 DSH 自身启动）就在后台把实例起好，也就是预热。
之后每次“打开 web”只是把已经缓存的、带令牌的地址交给系统浏览器，不再等进程启动。

地址是这样拿到的：`dsh web` 启动完会把已登录地址打印成一行 `dsh web: <url>`，
插件读这一行就够了，不需要自己铸令牌。该地址的令牌在进程存活期内可重复使用
（实测同一地址连续请求都返回 `303 + Set-Cookie`，cookie `Max-Age` 30 天），所以可以安全缓存、反复打开。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `action` | `"open"` \| `"close"` \| `"status"` | 默认 `open`：确保实例在跑并在浏览器打开；`close`：关掉实例；`status`：查询状态。 |
| `revealUrl` | boolean | 默认 `false`，只回脱敏地址；`true` 时回带令牌的原始链接。 |
| `dryRun` | boolean | 只把实例拉起来并校验，不开浏览器。 |

返回值包含：`action`、`opened`、`reused`（是否复用了预热好的实例）、`readyMs`（本次调用耗时）、`method`、`displayUrl`、`pid`、`notes`；失败时有 `error`（含子进程日志尾部）。

### 已经有实例在跑？直接复用，不再起第二个

如果你自己用 `dsh web`（或者一个看护脚本）常驻着一个实例，插件不会傻乎乎再起一个，而是**借用**它：

1. 先探测 `attachUrls`（默认 `http://127.0.0.1:3080/`）有没有响应；
2. 再读 `attachLogs`（默认 `%USERPROFILE%\dsh-web\web.log`）尾部 512 KB，找最后一条同源、带令牌的 `dsh web: <url>` 地址；
3. 两步都成立就返回 `mode: "attached"`、`pid: null`、`boots` 不增加——打开耗时 6 ms 级别，也不额外占内存。

语义差别只有一处：对借来的实例，`close` **只断开引用，不杀进程**（别人的进程不该被我杀）；要真停，还是停你自己的看护脚本。

### 可调配置

写在 profile 的用户补丁层（`$DSH_HOME/profiles/<profile>/cordis.patch.yml`），按行 id `open-web` 覆盖：

```yaml
- id: open-web
  config:
    prewarm: true            # 是否后台预热
    prewarmDelayMs: 1000     # 预热延迟（给 DSH 自己启动让路）
    bootTimeoutMs: 120000    # 等 dsh web 打印地址的上限
    idleTimeoutMs: 0         # 空闲回收；0 = 永不回收（与 DSH 同生命周期）
    attach: true             # 已有实例在跑就直接复用，不再起第二个
    attachUrls: ['http://127.0.0.1:3080/']
    attachLogs: ['%USERPROFILE%\\dsh-web\\web.log']
    attachProbeTimeoutMs: 800   # 探测超时，连不上就当没有
    # command: 'C:\path\to\dsh.cmd'   # 手动指定启动器（默认自动探测）
    # args: ['--host', '127.0.0.1']   # 追加给 dsh web 的参数
```

子进程什么时候结束：DSH 退出时一起关掉；`action: "close"` 关掉；
若把 `idleTimeoutMs` 设成正数，空闲超过该时间也会自动回收（此时浏览器里那个标签页会失效，恢复用一次“打开 web”即可）。
默认是 `0`——常驻预热的意义就是“随时能秒开”，回收等于下次重新付一次启动时间。

### 自检

```bash
node scripts/standalone-selftest.mjs                  # 用临时 DSH_HOME，不碰本机配置
node scripts/standalone-selftest.mjs --idle 5000      # 额外验证空闲回收
```

它会真的起一个 `dsh web` 进程，验证：能读到地址、地址可用（303 + `Set-Cookie`，带 cookie 再请求 200）、复用不重启、`status()` 报 PID、`stop()` 真的结束进程。

### 升级 DSH 之后的自检

插件本身不随 DSH 升级而失效，但**它依赖的环境**会变。`scripts/check-env.mjs` 一次性把这件事查清楚：

```bash
node scripts/check-env.mjs                    # 查 desktop profile
node scripts/check-env.mjs --profile web      # 查别的 profile
node scripts/check-env.mjs --exe "D:\...\DeepSeek Harness.exe"
```

九项检查：dsh 运行时版本、profile 是否存在、`dsh-github` 是否还在、**它的 peer 范围还覆盖当前运行时吗**、pnpm 补丁文件与 `patchedDependencies` 登记是否还在、有没有残留的版本豁免、插件能否编译加载、`apply()` 能否注册出两个工具、两段系统提示是否注入。

全部通过时退出码 0；有失败项退出码 1，并直接告诉你该跑哪条命令补救。
（读 `app.asar` 需要 Electron 的 fs，所以脚本发现自己跑在普通 Node 里时，会用 `ELECTRON_RUN_AS_NODE=1` 重新执行自己。）

## 网页端不播开场动画，桌面端照旧

桌面窗口和浏览器页面由同一个 Web 服务器提供、页面代码完全相同，所以“只在网页端关掉开场动画”是在页面里按**这次是不是浏览器打开**来判断的：

1. 工具交给浏览器的地址带一个片段标记：`…/?token=…#dsh-open-web`；
2. 插件通过 `ctx.webServer.tapIndex()` 往 index.html 的 `<head>` 最前面注入一小段前置脚本（`id="dsh-open-web-skip"`）；
3. 脚本看到该片段标记就设置 `window.__DSH_STARTUP_SKIP__ = true`（`dsh-startup-screen` 的运行时据此直接返回：不建 DOM、不播音、不清空应用），并按 `html[data-dsh-open-web]` 隐藏首屏黑幕、解除滚动锁，使浏览器页面第一帧就是应用本体；
4. 桌面窗口的地址不带该标记，脚本什么都不做 —— **桌面端开场动画原样保留，无需改动桌面端任何设置**（不动 `dsh-startup-screen` 的任何文件、也不动它的配置文件 `~/.dsh/dsh-startup.json`）。

片段标记按“独立的一段”精确匹配（`#dsh-open-web` 或 `#a=1&dsh-open-web`），因此 `#dsh-open-web-other` 这类无关片段不会被误判成网页端。

页面加载约 1 秒后会向 `/dsh-open-web/beacon?skip=&started=` 发一条只含两个布尔量的上报（存在内存里，最多 12 条），`dryRun` 调用的结果里会带上，用来确认“浏览器页面确实没播、桌面端确实照旧”。

## 自检

```bash
node scripts/selftest.mjs
```

不打开浏览器，只验证纯函数与登录校验的**负向**路径：参数校验（类型 / 未知键）、展示文本不残留令牌、启动候选命令形状、`probeLogin()` 对未带令牌的地址必须判为未登录（防止校验恒真）、以及开场动画跳过脚本的注入位置 / 幂等 / 关键点（12 项）。

```bash
node scripts/domtest.mjs
```

在假 DOM 里真正执行注入的那段前置脚本（7 项）：桌面地址（无标记、含各种无关片段）**不能**产生任何页面改动（不设 SKIP、不加属性、不插样式、不移除遮罩、不改滚动锁、不写 sessionStorage）；浏览器地址（带标记）必须置 SKIP、隐藏并移除黑幕、解除滚动锁、写 `dsh-startup-screen:shown`、上报 `skip=1&started=0`；`browserUrlWithMarker()` 只加片段、完整保留令牌查询串；脚本本身是 ES5 语法且不含 `</script>`。

## 平台支持

- **Windows**：依次尝试 `rundll32 url.dll,FileProtocolHandler` → `cmd /c start "" <url>` → `powershell Start-Process`；
- **macOS**：`open`；
- **Linux**：`xdg-open`。

全部失败时工具会返回失败原因，并提示可用 `revealUrl: true` 取链接手动打开。

## 兼容性与安全

- 不 import 任何 `@deepseek-ai/*` 包，也无需构建，直接以原始 JSON Schema 形状向 `ctx.tools.register()` 注册工具，因此本地目录安装可零解析风险加载。
- 独立 web 实例那部分（`standalone-web.js`）同样只用 Node 内置模块（`child_process`、`fs`、`path`）。
- 依赖服务：`tools`、`systemPrompt`、`connection`、`webServer`（写进 `inject`，缺失时插件不激活而不是抛错）。
- 所有注册都通过 `ctx.effect()`，插件被移除时自动清理。
- 令牌默认脱敏：工具结果、日志里都不会出现原始令牌。

## 安装

本地目录直接挂进 profile（不发布也能用）：

```bash
dsh plugin --profile desktop add "link:C:\path\to\dsh-open-web"
```

装完重启 DSH 即生效（插件在启动时组合进 profile，热加载不覆盖 `inject` 相关服务）。

## 发布到 npm / 插件市场

仓库本身可以直接用；要发给别人还有三步，都需要你自己的账号：

1. `package.json` 把 `name` 改成你想用的包名（例如 `dsh-open-web`），`version` 从 `1.0.0` 起，并**删掉 `"private": true`**；
2. `npm publish --access public`；
3. 在插件市场索引仓库里加一条该包的 entry（照抄同目录其它 dsh 插件的条目格式），提 PR。

发版前建议先跑一遍三套自检：`node scripts/selftest.mjs`、`node scripts/domtest.mjs`、`node scripts/standalone-selftest.mjs`。

## 附：常驻实例的日志轮转

`attach` 会读 `%USERPROFILE%\dsh-web\web.log` 找令牌地址，所以那个日志不能无限长、更不能被整份删掉（删了令牌行就没了，插件只能自己起新实例）。示例做法：

- `watchdog.vbs` 里把「超过 400 KB 就 `DeleteFile`」换成 `TrimLog`：只保留最后 N 行、失败静默、**永不删除原文件**；看护日志每月 400 行、`web.log` 在实例挂掉时的分支里裁到 1024 KB；
- `start-web.cmd` 启动前判断大小，超过 1 MB 就 `move /y "%LOG%" "%LOG%.1"`（此时应用还没起，文件是空闲的）。

VBScript 按 ANSI 读脚本文件，中文注释会变乱码——两份脚本里只写 ASCII 注释，行尾统一 CRLF。
