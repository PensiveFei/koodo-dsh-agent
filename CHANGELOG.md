# Changelog

本文件记录本项目的所有重要变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-10-04

首个版本。在 Koodo Reader 2.4.3 + DSH 桌面版 0.2.0-rc.2 + Node 24 上实测通过。

### Added

- **插件脚本**（`koodo-plugin/script.js`）：注册 `window.translate` 与 `window.getDictText`，
  划词翻译 / 划词查词交给智能体；注入一个可拖动的悬浮对话面板（Shadow DOM 隔离样式），
  带对话历史、流式输出与「带上当前页文本」开关
- **进度反馈**：网关在 OpenAI 流里附带 `dsh` 进度帧，面板状态栏实时显示
  「第 N 步 · 工具名：在做什么 · 已等待 Ns」；Koodo 自带客户端只读 `delta.content`，会安全忽略
- **网关**（`gateway/gateway.mjs`）：OpenAI 兼容的 `/v1/chat/completions`（流式与非流式），
  转发给 DSH 的 stdio JSON-RPC SDK（`dsh <profile>`）；含 `/health`、`/v1/models`、
  `/koodo/reset`、`/koodo/shutdown`
- **常驻启动器**（`launcher/launch.mjs`）：拉起网关 → 带回环调试端口启动 Koodo →
  用 CDP 的 `Page.addScriptToEvaluateOnNewDocument` 注入面板，因此启动即在，
  且能扛住 Koodo 回书架时的 `mainWin.reload()`
- **安装向导**（`install.mjs`）：探测 Koodo / DSH 路径，从官方 `sdk` 模板创建独立 profile，
  把所有运行时文件写进 `~/.koodo-dsh-agent/`，并生成内含现算 SHA-256 的插件 JSON
- **无本地路径**：插件 JSON 用 `os.homedir()` 在渲染进程里现算面板路径，
  因此内容保持纯 ASCII、零转义，复制粘贴最不容易被改坏
- **测试**：`tests/check.mjs` 离线自检（语法 / 插件格式 / 路径泄露扫描，CI 跑这个）、
  `tests/hook-test.mjs` 钩子端到端测试（`--live` 时真的打网关）
- **文档**：中英双语 README，`docs/ARCHITECTURE.md` 记录反编译得出的机制与踩过的坑

[1.0.0]: https://github.com/PensiveFei/koodo-dsh-agent/releases/tag/v1.0.0
