# Contributing

欢迎 issue 与 PR。这个项目刻意保持**零运行时依赖**（只用 Node 内置模块），提交前请先跑测试。

## 开发环境

- Node.js 22+
- 想跑端到端测试的话：本机装有 Koodo Reader 2.4.x 桌面版与 DSH 桌面版

## 提交前

```bash
node tests/check.mjs              # 必跑：语法、插件格式、本地路径泄露扫描
node tests/hook-test.mjs          # 必跑：面板脚本能 eval、幂等、钩子已注册
node tests/hook-test.mjs --live   # 有条件就跑：真的打本机网关
```

`tests/check.mjs` 会扫描代码里是否混入了**机器相关的绝对路径或用户名** ——
提交前请确保它是绿的（这条检查是真被踩过的：早期版本把作者的工作区路径写死在插件 JSON 里）。

## 约定

- **commit message 用英文 Conventional Commits**（`fix:` / `feat:` / `docs:` / `test:` …）
- 一个 PR 只做一件事；描述里写清 **问题 + 改动 + 验证方式**
- 改 `koodo-plugin/script.js` 后不需要重装插件（插件里的 `script` 只是从磁盘读 `panel.js` 的引导代码），
  但要记得 `node install.mjs` 把新脚本同步到运行时目录再验证
- 涉及 Koodo 插件机制 / DSH SDK 的新发现，请补进 `docs/ARCHITECTURE.md` —— 那份文档就是靠踩坑攒出来的

## 修改插件格式时的注意

`koodo-plugin/plugin-format.mjs` 是格式规则的唯一实现（安装器与测试共用）。改它之前请先读
`docs/ARCHITECTURE.md`，里面记了三条会让 Koodo **静默失败**的坑：

1. 缺 `icon` → SQLite 具名参数缺失 → 安装无声无息
2. `script` 里含双引号 → JSON 需要 `\"` 转义 → 复制粘贴时极易丢反斜杠 → `JSON.parse` 无声失败
3. `JSON.parse` 抛异常时 Koodo 没有 `try/catch`，界面上什么都不会发生 ——
   排查入口是 `%APPDATA%\koodo-reader\logs\debug.log`
