# 架构与踩坑记录

这份文档记录**从二进制里挖出来的事实**，以及为什么某些看起来更简单的做法不行。
结论都来自对 Koodo Reader 2.4.3 的 `app.asar` 反编译与 DSH 桌面版 0.2.0-rc.2 的实测。

---

## 1. Koodo 的 AI 接缝

Koodo 的 AI 客户端（`chat/completions`）行为，反编译自 `build/static/js/main.*.js`：

```js
// 请求构造（流式）
new ChatStream(endpoint + "/chat/completions", {
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
  payload: JSON.stringify({ model, messages, stream: true }),
  method: "POST",
});
// 事件：open / message / error；message 里解析 choices[0].delta.content，"[DONE]" 收尾
// 消息历史：[...history, { role: "user", content: prompt }].slice(-5)   ← 只留最后 5 条
```

设置页的 **Test** 按钮走另一条路（非流式）：

```js
const url = endpoint.endsWith("/") ? endpoint + "chat/completions" : endpoint + "/chat/completions";
await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + apiKey },
  body: JSON.stringify({ model, messages: [{ role: "user", content: "Hi, just testing. Reply with OK." }], max_tokens: 10 }),
});
// 读 choices[0].message.content
```

**为什么指向本机端点是被支持的用法**：内置 provider 列表里有

```js
{ id: "ollama",   defaultEndpoint: "http://localhost:11434/v1", modelsEndpoint: ".../models" },
{ id: "lmstudio", defaultEndpoint: "http://localhost:1234/v1",  modelsEndpoint: ".../models" },
{ id: "vllm",     defaultEndpoint: "http://localhost:8000/v1",  modelsEndpoint: ".../models" },
```

这三家**不需要 API Key**（源码里有 `"ollama"===selectedProvider || "lmstudio"===... || "vllm"===...` 的放行分支），
说明渲染进程访问本机 HTTP 服务是产品自身就在走的路径。本项目的网关因此只需要补上 CORS 头。

---

## 2. 插件机制

### 2.1 粘贴的是 JSON，`script` 会被 eval

安装入口（插件设置页）：

```js
value = document.querySelector("#voice-add-content-box").value
plugin = JSON.parse(value)          // ← 没有 try/catch
plugin.key = plugin.identifier
await C4(plugin)                    // ← 校验，见下
// voice 类型会在这里再 eval 一次并调用 window.getTTSVoice
saveRecord(plugin, "plugins") / updateRecord(plugin, "plugins")
```

校验函数 `C4` 的全部逻辑：

```js
J = async (t) => {
  const hash = await generateSHA256Hash(t.script);
  return hash === t.scriptSHA256;
};
// generateSHA256Hash: TextEncoder(script) → crypto.subtle.digest("SHA-256")
//                     → 逐字节 toString(16).padStart(2,"0") → 小写十六进制
```

**没有签名、没有白名单** —— 哈希是自查完整性，自己算即可。

### 2.2 官方字段集

从 `https://api.koodoreader.com/api/get_plugins?name=<lang>` 拉到的 37 个官方插件对象：

```
translation × 11 / dictionary × 13 / voice × 13

字段集合：
  { identifier, type, displayName, icon, version, config, script, scriptSHA256, langList }
  voice 额外有 voiceList；部分 dictionary 有 url
```

外层包了一层 `{ name, feature, websiteName, websiteUrl, configuration, plugin: {...} }`，
**粘贴进输入框的是内层的 `plugin` 对象**。

### 2.3 哪些类型会执行脚本

全量扫描 `eval(` 调用点，只有三处与插件有关：

| 类型 | 调用点 | 脚本要注册 |
| --- | --- | --- |
| `translation` | `translateFunc = plugin.script; eval(translateFunc); window.translate(text, 源语言, 目标语言, axios, plugin.config)` | `window.translate` |
| `dictionary` | `dictFunc = plugin.script; eval(dictFunc); window.getDictText(text, "auto", 目标语言, axios, t, plugin.config)` | `window.getDictText` |
| `voice` | `voiceFunc = plugin.script; eval(voiceFunc); window.getTTSVoice(plugin.config)` | `window.getTTSVoice` |

`window.translate` 的返回值如果以 `https://` 开头，Koodo 会当成链接用浏览器打开；否则直接显示。

**执行上下文很重要**：这段 `eval` 是**严格模式模块里的直接 eval**，所以 `var`/`function` 声明
**不会**泄漏到全局 —— 脚本里必须显式写 `window.xxx = ...`。本项目的 `script.js` 因此把状态挂在
`window.__dshAgentState` 上，并且在多次 eval 之间做幂等判断。

脚本**会被反复 eval**（翻译插件＝每次划词翻译一次），所以注入 UI 的逻辑必须有幂等守卫。

---

## 3. 常驻：为什么必须用 CDP

### 3.1 插件没有启动钩子

脚本只在**用到该插件**时执行。想「开机就在」就得另找入口。

### 3.2 Koodo 会重载整个渲染进程

`main.js` 里有：

```js
ipcMain.handle("reload-main", (event, arg) => { if (mainWin) { mainWin.reload(); } });
```

渲染进程侧对应的调用（从阅读器返回书架时会触发）：

```js
const reload = () => { isDesktop ? window.require("electron").ipcRenderer.invoke("reload-main", "ping") : window.location.reload(); };
```

注入到 `document.body` 的节点和 `window` 上的钩子**全部消失**。这就是「唤醒之后回到主界面又丢」的根因。

### 3.3 能用的入口只有 CDP 的每文档钩子

启动器带 `--remote-debugging-port=<port>`（Electron 默认只监听回环）启动 Koodo，然后：

```js
await send("Page.enable");
await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT_SRC });
await send("Runtime.evaluate", { expression: INJECT_SRC });   // 当前文档补注入一次
```

`addScriptToEvaluateOnNewDocument` **每个新文档都会执行**，包括 `reload-main` 触发的那次。
监督进程还会盯着 `/json/list`，目标变了（渲染进程被重建）就重新挂上去。

---

## 4. DSH 侧：stdio JSON-RPC SDK

DSH 自带一个给进程外客户端用的 SDK 服务（挂载在官方 `sdk` profile 上）：

```bash
dsh <profile> --help        # 打印帮助并退出
dsh <profile>               # 在 stdio 上serve JSON-RPC
```

协议（`@deepseek-ai/dsh-sdk-protocol`）：

| 方向 | 方法 | 说明 |
| --- | --- | --- |
| client→server | `initialize` | `{ provider, model, cwd, reasoningEffort?, maxTokens? }` → `{ serverInfo }` |
| client→server | `session/prompt` | `{ sessionId, contentBlocks }` → `{ messageId }`（仅表示入队成功） |
| client→server | `shutdown` | 无参数 → `{}` |
| server→client | `session.event` | 每个会话事件（全量、不过滤） |
| server→client | `session.status` | 整个 agent 的 `running` / `idle` 转换 |

实测要点：

- `session/prompt` 的参数名是 **`contentBlocks`**（不是 `content`）
- **会话 id 会持久化**：重复用同一个 `sessionId` 会报 `session "x" already exists`，每次新建要带时间戳
- `initialize` 里 `provider` 必须是被注册过的适配器；官方 `sdk` 组合只自动挂 DeepSeek，所以用 `deepseek-official`
- 事件流里：`assistant/message` 的 `data.message.content[]` 里 `type: "text"` 是正文；
  同一条事件的 `data.stream[]` 里有 `{"type":"text-chunks","dt":[...],"texts":[...]}` ——
  **原始分片与到达间隔**，本项目用它复现打字机节奏
- 权限来自环境变量：`sandbox-policy.mode = process.env.DSH_PERMISSION_MODE ?? "workspace-write"`，
  `approval.policy = mode === "danger-full-access" ? "never" : "ask"`
  → headless 下没有审批应答方，**必须**用 `danger-full-access`，否则需要审批的工具调用 fail closed

### 进度帧的设计

智能体跑一个真实任务时会连跑几十个工具步骤，而正文可能很久不出一句话
（实测一次：94 秒、25 步才出最终答复）。于是网关在 OpenAI 流里多发一个 **额外字段**：

```json
{"choices":[{"index":0,"delta":{},"finish_reason":null}],
 "dsh":{"kind":"progress","phase":"tool","turn":26,"step":21,"tool":"pwsh","summary":"Apply author fills..."}}
```

Koodo 自带的 AI 客户端只读 `choices[0].delta.content`，会**安全忽略**未知字段；
本项目的面板读 `dsh` 来显示进度条。这样既不影响原生行为，又能给面板加反馈。

---

## 5. 踩坑清单

### 5.1 插件 JSON 缺 `icon` → 静默失败

Koodo 写插件走 SQLite 具名参数。缺字段时：

```
Uncaught (in promise) Error: Error invoking remote method 'database-command':
RangeError: Missing named parameter "icon"
```

而安装代码没有 `try/catch`，表现是**点了确认毫无反应**。这个坑是靠
`%APPDATA%\koodo-reader\logs\debug.log` 里重复几百次的报错定位的。

### 5.2 `JSON.parse` 失败同样静默

把 PowerShell 命令误粘进输入框：

```
Uncaught (in promise) SyntaxError: Unexpected token 'G', "Get-Conten"... is not valid JSON
```

依旧毫无反应。**判据**：弹「插件验证失败」＝ JSON 合法但哈希不符；
什么都不弹 ＝ 压根不是合法 JSON（或后续抛异常）。

因此本项目的插件 JSON 刻意做到**纯 ASCII、零转义**：
`script` 里不出现双引号与反斜杠，JSON 就不需要 `\"` 转义，复制粘贴时不会因为丢反斜杠而坏掉。
（家目录可能含中文，所以路径用 `os.homedir()` 在渲染进程里**现算**，而不是写进 JSON。）

### 5.3 节点路径在 `app.asar` 里，普通 Node 看不见

`fs.existsSync("<...>/app.asar/dsh/...")` 在**纯 Node** 下返回 false ——
只有 Electron 的 asar 层能读 asar。所以安装器与网关都**不对 asar 内的路径做存在性校验**，
只校验可执行文件本身。（这个坑在安装器和网关各犯过一次，都是靠端到端测试抓出来的。）

### 5.4 往 `app.asar.unpacked/` 放同名文件不生效

Koodo 的 Electron 熔断器状态（读 `Koodo Reader.exe` 里的 fuse 表）：

```
EnableEmbeddedAsarIntegrityValidation   禁用
OnlyLoadAppFromAsar                     禁用
```

看起来两条都放行，但实测把打过补丁的 `main.js` 放进 `app.asar.unpacked/` **完全没有效果** ——
Electron 的 asar 层是按头部里的 `unpacked` 标志决定读哪边的，不看目录里有没有同名文件。

### 5.5 `NODE_OPTIONS=--require` 在主进程不生效

`EnableNodeOptionsEnvironmentVariable` 熔断器是**启用**的，但 Electron 对 `NODE_OPTIONS`
只放行一个白名单，`--require` 不在里面。实测：模块**根本没被加载**（探针文件不出现）。

> 第一版探针写在 `app` 检查之后，结果分不清「模块没加载」和「加载了但不在主进程」——
> 探针要写在模块第一行。

### 5.6 Windows 批处理的编码

`.cmd` 文件里的 UTF-8 中文会被 `cmd.exe` 按本地代码页解析，导致命令被拆错
（实测报 `'DO_GW_PORT' is not recognized as an internal or external command`）。
**生成 .cmd 时保持内容纯 ASCII**，路径用 `%~dp0` 在运行时取。

### 5.7 PowerShell 的 `ConvertFrom-Json` 不接受空键

官方 Pot 插件的 `langList` 是 `{"": "Automatic"}`。JS 的 `JSON.parse` 无所谓，
但 Windows PowerShell 的 `ConvertFrom-Json` 会直接报
`Cannot process argument because the value of argument "name" is not valid`。
项目的诊断脚本因此改用 `{"Automatic": "Automatic"}`。

### 5.8 Koodo 会把启动参数当书打开

带 `--remote-debugging-port=9222` 启动时，主进程会尝试把
`--remote-debugging-port=9222` 当成本地文件导入，日志里留下一条无害的
`ENOENT: no such file or directory, open 'D:\Koodo Reader\--remote-debugging-port=9222'`。

---

## 6. 排查入口

| 想查什么 | 去哪 |
| --- | --- |
| Koodo 界面「点了没反应」 | `%APPDATA%\koodo-reader\logs\debug.log`（**渲染进程 console 全量落盘**） |
| 常驻注入有没有生效 | 运行时目录的 `supervisor.log` |
| 网关收到什么、回什么 | 网关窗口的输出（或 `KOODO_GW_VERBOSE=1`） |
| 智能体到底干了什么 | DSH 会话日志 `~/.dsh/sessions/<...>/session.v4.jsonl.zstd`（**多帧 zstd**，要逐帧解压） |
| 插件是否已装 | Koodo 设置 → 插件页的「已安装」列表 |
