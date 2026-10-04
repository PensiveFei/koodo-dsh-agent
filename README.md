# koodo-dsh-agent

[![MIT license](https://img.shields.io/github/license/PensiveFei/koodo-dsh-agent)](https://github.com/PensiveFei/koodo-dsh-agent/blob/main/LICENSE)
[![release](https://img.shields.io/github/v/release/PensiveFei/koodo-dsh-agent)](https://github.com/PensiveFei/koodo-dsh-agent/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/PensiveFei/koodo-dsh-agent/ci.yml)](https://github.com/PensiveFei/koodo-dsh-agent/actions/workflows/ci.yml)

把 [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness)（DSH）**智能体**接进
[Koodo Reader](https://github.com/koodo-reader/koodo-reader)。

不是又一个翻译插件 —— 是让**能读写文件、能跑命令、有工具的智能体**住进阅读器，
在书页旁边跟你对话。

```
你在 Koodo 里划一段字 / 打开面板提问
        │
        ▼
   悬浮的智能体面板  ──HTTP──▶  本机网关  ──stdio JSON-RPC──▶  DSH 智能体
   （插件注入的 UI）           (Node)                        （工具 / 文件 / 子智能体）
```

## 实际效果

| ![实机演示 ①](https://raw.githubusercontent.com/PensiveFei/koodo-dsh-agent/main/docs/showcase/showcase-1.png) | ![实机演示 ②](https://raw.githubusercontent.com/PensiveFei/koodo-dsh-agent/main/docs/showcase/showcase-2.png) |
| --- | --- |
| 实机演示 ① | 实机演示 ② |

> 两张都是在 Koodo Reader 里实际运行的截图。
> 想加更多截图，放进 `docs/showcase/` 即可（命名与引用方式见该目录的 README）。

## 能做什么

- **悬浮智能体面板**：点开即聊，流式输出，可拖动，对话历史本地留存；提问时默认把**当前页文本**一起带上，所以它能回答「这段什么意思」
- **划词翻译 / 划词查词由智能体接管**：出来的不是机器翻译，而是智能体的回答（可读当前书上下文）
- **带进度反馈**：智能体跑工具时会显示「第 N 步 · 工具名：在做什么 · 已等待 Ns」，不会长时间只有一个省略号
- **常驻**：用启动器启动后，面板开机就在；从阅读器回到书架（Koodo 会重载渲染进程）也不会丢
- **被中断的回答会补回**：提问与回答**边产生边落盘**；万一页面中途被重载（智能体为核验落盘会自己重载页面），
  面板下次注入时会用 `turnId` 从网关把这一轮的回答要回来，并标注「由网关补回」
- **只读审计友好**：不修改 Koodo 任何文件，随时可以撤掉

## 怎么工作（三段链路）

### 1. Koodo 的 AI 接缝是 OpenAI 兼容端点

反编译 Koodo 2.4.3 的 `app.asar` 得到的行为：

- `POST {endpoint}/chat/completions`，头 `Authorization: Bearer {apiKey}`
- body `{ model, messages, stream: true }`，**SSE 流式**，逐块读 `choices[0].delta.content`，以 `data: [DONE]` 结束
- 设置页的 **Test** 按钮走**非流式**，读 `choices[0].message.content`
- 历史只截**最后 5 条**；内置 provider 列表里 `ollama` / `lmstudio` / `vllm` 指向本机端口且不需要 API Key —— 说明「指向本机自建端点」是官方支持的用法

本项目的网关就是挂在这个接缝上。

### 2. 插件脚本能跑代码

Koodo 的「添加自定义插件」接受的是一段 **JSON**，其中 `script` 字段会被
`eval(plugin.script)` 在**渲染进程**里执行。安装时的校验只有一条：

```
SHA256(UTF-8(script)) === scriptSHA256      // 小写十六进制，无签名、无白名单
```

会执行脚本的只有三种类型，各自调一个全局函数：

| 类型 | 脚本要注册 | Koodo 的调用 |
| --- | --- | --- |
| `translation` | `window.translate` | `(text, 源语言, 目标语言, axios, config) => Promise<string>` |
| `dictionary` | `window.getDictText` | `(text, 源, 目标, axios, t, config) => Promise<string>` |
| `voice` | `window.getTTSVoice` | `(config) => 语音列表` |

本项目同时注册了前两个，所以既能接管划词翻译，也能接管划词查词。

### 3. 常驻靠 CDP 的每文档钩子

插件机制的脚本**只在用到该插件时才执行**，没有启动钩子；而且 Koodo 从阅读器回到书架时会调
`mainWin.reload()`（主进程里的 IPC `reload-main`），**整个渲染进程重载** —— 注入的 DOM 和脚本会全部消失。

所以启动器会带一个**回环调试端口**启动 Koodo，由监督进程通过 CDP 的
`Page.addScriptToEvaluateOnNewDocument` 注入面板。这个钩子**每个新文档都会执行**，
包括 `reload-main` 触发的那次 —— 面板因此既能在启动时就在，也不会因为切界面而丢。

## 结构

```
├── install.mjs              安装向导：探测路径、生成运行时、产出插件 JSON
├── koodo-plugin/
│   ├── script.js            面板脚本（注入 UI + 注册两个钩子）
│   └── plugin-format.mjs    插件格式规则与校验（安装器与测试共用）
├── gateway/
│   └── gateway.mjs          OpenAI 兼容网关 ⇄ DSH stdio JSON-RPC SDK
├── launcher/
│   └── launch.mjs           监督进程：拉起网关 + 带调试端口启动 Koodo + CDP 注入
├── tests/
│   ├── check.mjs            离线自检（CI 跑这个）
│   └── hook-test.mjs        钩子端到端测试（--live 时真的打网关）
└── docs/
    ├── ARCHITECTURE.md      原理与踩坑记录
    └── showcase/            README 用的截图
```

安装后所有生成物都落在**运行时目录**（默认 `~/.koodo-dsh-agent/`），仓库本身可以删掉：

```
~/.koodo-dsh-agent/
├── config.json             所有路径与端口
├── panel.js                面板脚本（安装器按你的网关地址生成）
├── gateway.mjs             网关
├── launch.mjs              监督进程
├── plugin-translation.json  ★ 粘进 Koodo 的就是这个
├── plugin-dictionary.json   可选：划词查词
├── koodo-dsh.cmd            启动器（Windows）
├── start-gateway.cmd        只启动网关
├── workspace/               智能体默认工作目录
└── supervisor.log           监督进程日志
```

## 支持平台

| 平台 | 状态 |
| --- | --- |
| Windows | **已实测**（Koodo 2.4.3 + DSH 桌面版 0.2.0-rc.2 + Node 24） |
| macOS / Linux | 安装向导已按平台分支处理路径，但**未实测**。常驻注入依赖 Electron 的调试端口，理论可行；不常驻的话仍可用「划词激活」模式 |

## 前置条件

- **Koodo Reader 2.4.x 桌面版**（在 2.4.3 上验证；插件机制来自对它的反编译）
- **DSH 桌面版**（智能体后端）。安装向导会从官方 `sdk` 模板创建一个独立 profile（默认名 `koodo-gw`），**不动你现有的 profile**
- **Node.js 22+**（网关与监督进程；常驻注入用了全局 `WebSocket`，那是 Node 22 起才稳定的）

## 安装

```bash
git clone https://github.com/PensiveFei/koodo-dsh-agent.git
cd koodo-dsh-agent
node install.mjs
```

安装向导会：探测 Koodo 与 DSH 位置 → 建 DSH profile → 把运行时文件写进 `~/.koodo-dsh-agent/`
→ 生成两份插件 JSON（内含现算的 SHA-256）并按 Koodo 的校验路径自校验。

常用参数：

```bash
node install.mjs --koodo "D:\Koodo Reader\Koodo Reader.exe"   # 手动指定 Koodo
node install.mjs --dsh    "F:\DSH"                            # 手动指定 DSH（含 resources/ 的那层）
node install.mjs --agent-cwd "D:\我的笔记"                    # 智能体的工作目录
node install.mjs --dir    "D:\koodo-dsh"                      # 自定义运行时目录
node install.mjs --clip                                       # 顺带把插件 JSON 放进剪贴板
node install.mjs --shortcut                                   # 顺带建桌面快捷方式
```

## 快速开始（约 5 分钟）

1. **装插件**：Koodo → 设置 → 插件 → 添加自定义插件 → 粘贴
   `~/.koodo-dsh-agent/plugin-translation.json` 的**全部内容** → 确认
   （想连划词查词也接管，再粘一次 `plugin-dictionary.json`）
2. **启动**：运行 `~/.koodo-dsh-agent/koodo-dsh.cmd`（或桌面快捷方式）
   它会拉起网关、带调试端口启动 Koodo、注入面板
3. **用**：右下角出现 `DSH` 圆球，点开就能聊；书里划一段字点翻译即是智能体作答

> 不想常驻也行：直接启动 Koodo，插件仍然装着，只是要**先划一次词**才会激活面板
> （插件脚本的设计如此：没有启动钩子），而且回到书架后需要再划一次。

## 用法

### 面板

- 圆球可拖动；标题栏左侧的圆点：**绿=网关正常，红=网关不通**
- 输入框 Enter 发送，Shift+Enter 换行
- 「带上当前页文本」默认勾选：把当前选中文字（没选中就从 EPUB/PDF 的 iframe 里取当前页文本）一并交给智能体
- 底部状态栏实时显示进度：`第 21 步 · pwsh：Apply author fills · 34s`

### 读写的范围

智能体能读写的范围由 `config.json` 里的 `agentCwd` 决定（默认 `~/.koodo-dsh-agent/workspace`）：

- 想让它帮你整理笔记：指向你的 Obsidian vault
- 想让它操作书库元数据：指向书库所在目录

### 网关接口

| 端点 | 说明 |
| --- | --- |
| `GET /health` | 自检，回显当前路由、工作目录、权限 |
| `GET /v1/models` | 模型列表 |
| `POST /v1/chat/completions` | OpenAI 兼容（流式与非流式都支持） |
| `POST /koodo/reset` | 重开对话（丢掉上下文） |
| `POST /koodo/shutdown` | 优雅关闭运行时 |

### 常用环境变量（优先级高于 config.json）

`KOODO_GW_PORT`、`KOODO_GW_CWD`、`KOODO_GW_MODEL`、`KOODO_GW_PROVIDER`、
`KOODO_GW_PERMISSION`、`DSH_EXE`、`DSH_CLI`、`KOODO_DSH_DEBUG_PORT`、`KOODO_GW_VERBOSE=1`

## 为什么不用 Koodo 官方插件市场

官方插件清单（`api.koodoreader.com/api/get_plugins`）里有 37 个插件：翻译 11、词典 13、TTS 13，
**没有任何智能体 / 对话类**。Koodo 官方的 AI 能力停在「一问一答」（翻译、词典、助手），
**没有工具调用，碰不到文件系统**。

本项目补的是这一层。最接近的同类是 **KOReader 的
[koassistant.koplugin](https://github.com/zeeyado/koassistant.koplugin)**（另一个阅读器的 AI 助手插件）
和 Obsidian 的 Claudian 系插件 —— 都是「把智能体嵌进阅读/写作环境」这个方向。

## 踩过的坑

都写在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，这里挑三个最坑的：

1. **插件 JSON 缺 `icon` 会静默失败**。Koodo 写库用 SQLite 具名参数，缺字段抛
   `RangeError: Missing named parameter "icon"`；而安装代码没有 try/catch，
   界面表现是**点了确认毫无反应**。（官方字段集：`identifier / type / displayName / icon / version / config / script / scriptSHA256 / langList`）
2. **`JSON.parse` 失败同样是静默的**。把 PowerShell 命令粘进输入框，报的是
   `SyntaxError: Unexpected token 'G', "Get-Conten"...`，依旧毫无反应。所以本项目的插件 JSON
   刻意做到**纯 ASCII、零转义**，并在安装时自校验。
3. **`app.asar.unpacked` 放个同名文件不会生效**。Electron 的 asar 层是按头部 `unpacked` 标志读文件的；
   `NODE_OPTIONS=--require` 也不行 —— Electron 只放行一个白名单，`--require` 不在里面。
   最后能用的只有 CDP 的每文档注入。

**排查入口**：Koodo 把渲染进程 console 全部落盘到
`%APPDATA%\koodo-reader\logs\debug.log` —— 上面两个静默失败都是从这里读出来的。

## 安全与隐私

务必要知道的两件事：

1. **智能体默认以 `danger-full-access` 运行**。headless 场景下没有审批应答方，
   若用 `workspace-write`，需要审批的工具调用会 fail closed 直接失败 —— 所以默认关了审批。
   这意味着**它能在 `agentCwd` 之外读写文件、执行命令**。介意的话：改 `config.json` 的
   `permission` 为 `workspace-write`，并接受部分工具不可用。
2. **插件脚本是在 Koodo 渲染进程里 `eval` 的**，而渲染进程有 Node 集成 ——
   等价于**任意代码执行**。这是 Koodo 插件机制的设计，不是本项目的选择。
   所以：只粘贴你信任来源的插件 JSON。

其它：

- 网关只监听 `127.0.0.1`；调试端口同样是回环（Electron 默认），局域网访问不到
- 二者都**不做鉴权**：本机上任何进程都能调用网关、也能通过调试端口控制 Koodo 渲染进程（这也是常驻方案的代价）
- 面板脚本把对话历史存在 Koodo 的 `localStorage`；网关不落盘任何对话内容，
  但 DSH 自己会把会话持久化到 `~/.dsh/sessions/`

## 开发

```bash
node tests/check.mjs          # 离线自检：语法、插件格式、路径泄露扫描（CI 跑这个）
node tests/hook-test.mjs      # 离线：面板脚本能 eval、幂等、钩子已注册
node tests/hook-test.mjs --live   # 联网：真的打网关跑翻译/查词/流式+进度条
```

改了 `koodo-plugin/script.js` 之后，**不需要重装插件** —— 插件里的 `script` 只是一段
「从磁盘读 `panel.js` 再执行」的引导代码，面板每次用到时都会重新读盘。
只要重跑 `node install.mjs` 把新脚本复制到运行时目录即可。

## 许可

[MIT](LICENSE)
