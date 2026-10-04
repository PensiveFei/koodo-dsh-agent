# Security Policy

## 报告漏洞

请通过 GitHub 的 [Security Advisories](../../security/advisories/new) 私下报告，
不要开公开 issue。会在确认后尽快回复并给出修复计划。

## 使用前必须知道的两点

1. **智能体默认以 `danger-full-access` 运行**
   headless 场景下没有审批应答方，若用 `workspace-write`，需要审批的工具调用会 fail closed。
   因此默认关闭审批 —— 这意味着**智能体可以在 `agentCwd` 之外读写文件、执行命令**。
   介意的话把 `config.json` 里的 `permission` 改成 `workspace-write`，并接受部分工具不可用。

2. **Koodo 插件脚本是 `eval` 执行的**
   Koodo 的插件机制会把 JSON 里的 `script` 字段在渲染进程里 `eval`，而该进程有 Node 集成 ——
   等价于任意代码执行。这是 Koodo 的设计，不是本项目的选择。
   **只粘贴你信任来源的插件 JSON。**

## 已知的攻击面

- 网关监听 `127.0.0.1`，**不做鉴权**：本机上任何进程都能调用它，进而驱动智能体
- 常驻模式使用 Electron 的调试端口（同样只在回环），**不做鉴权**：
  本机上任何进程都能通过它控制 Koodo 的渲染进程
- 面板把对话历史存在 Koodo 的 `localStorage`；DSH 会把会话持久化在 `~/.dsh/sessions/`

上述两点是「本机单用户工具」的取舍。如果你在多用户机器或共享环境里使用，
请关掉常驻模式（直接用 Koodo 原图标启动），并把 `permission` 收紧。

## 支持范围

只对 `main` 分支的最新版本接受安全报告。
