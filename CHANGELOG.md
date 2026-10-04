# Changelog

本文件记录本项目的所有重要变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.1] - 2026-10-04

修一个真实踩到的数据丢失问题：**智能体在任务中途重载 Koodo 页面时，那一轮对话会从面板消失。**

起因是一次图书分类任务：智能体为核验归类是否落盘，自己调了 Koodo 的 `reload-main` 重载渲染进程，
面板正在读的 HTTP 流被切断，而原来的实现只在**整轮结束时**才写历史 —— 于是提问和回答都没留下。
（任务本身在服务端跑完了，所以还能靠 DSH 会话日志捞回来。）

### Fixed

- **提问与空的回答占位立刻落盘**，不再等到整轮结束
- **流式期间增量落盘**（节流 800ms），中途被重载时至少留下已收到的部分
- **被中断的回答自动补回**：网关记住最后一次 turn（问题 / 累积回答 / 状态 / `turnId`，
  并落盘到 `last-turn.json`），新增 `GET /koodo/last`；面板下次注入时若发现最后一轮没写完，
  就用 `turnId` 向网关要回来，并标注「（该轮曾被中断，回答由网关补回）」；
  若那一轮还在跑，则显示进度并轮询到完成为止
- 每轮带 `turnId`（借用 OpenAI 请求的 `user` 字段），保证重载后能精确对上号
- 面板版本提到 3（旧面板会在下次 eval 时被自动替换）

实测：把最后一条回答在本地抹空后重载页面，**3 秒内**从网关补回，且带恢复标记。

[1.0.1]: https://github.com/PensiveFei/koodo-dsh-agent/releases/tag/v1.0.1

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
