#!/usr/bin/env node
/**
 * koodo-dsh-agent 安装向导
 *
 * 做四件事：
 *   1. 探测（或接收）Koodo Reader 可执行文件、DSH 运行时、运行时目录
 *   2. 把所有需要的东西复制/生成到运行时目录（默认 ~/.koodo-dsh-agent）
 *   3. 生成可直接粘进 Koodo 的插件 JSON（内含现算的 SHA-256）
 *   4. 打印后续步骤（可选：复制到剪贴板、创建桌面快捷方式）
 *
 * 用法：
 *   node install.mjs                        # 自动探测
 *   node install.mjs --koodo "<path>"       # 指定 Koodo 可执行文件
 *   node install.mjs --dsh  "<path>"        # 指定 DSH 安装目录（含 resources/ 的那层）
 *   node install.mjs --dir  "<path>"        # 指定运行时目录
 *   node install.mjs --clip                 # 顺带把插件 JSON 放进剪贴板
 *   node install.mjs --shortcut             # 顺带建桌面快捷方式
 *   node install.mjs --yes                  # 不问，直接用探测结果
 *
 * 设计原则：仓库里不含任何机器相关的绝对路径；所有路径在安装时确定，
 * 落到运行时目录的 config.json 里，其余脚本都从它读取。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import readline from "node:readline";
import { bootstrapScript, buildPlugin, validatePluginJson, pluginWarnings } from "./koodo-plugin/plugin-format.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";

/* ------------------------------------------------------------------ */
/* 参数                                                                */
/* ------------------------------------------------------------------ */
const argv = process.argv.slice(2);
function arg(name, fallback = undefined) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const FLAGS = {
  koodo: arg("--koodo", process.env.KOODO_EXE || null),
  dsh: arg("--dsh", process.env.DSH_HOME_DIR || null),
  dir: arg("--dir", process.env.KOODO_DSH_HOME || null),
  agentCwd: arg("--agent-cwd", null),
  profile: arg("--profile", "koodo-gw"),
  gatewayPort: Number(arg("--gateway-port", 8317)),
  debugPort: Number(arg("--debug-port", 9222)),
  clip: argv.includes("--clip"),
  shortcut: argv.includes("--shortcut"),
  yes: argv.includes("--yes"),
};

const log = (...a) => console.log(...a);
const ok = (s) => console.log("  \u2713 " + s);
const warn = (s) => console.log("  ! " + s);
const die = (s) => {
  console.error("\n\u2717 " + s);
  process.exit(1);
};

async function ask(question, fallback) {
  if (FLAGS.yes || !process.stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((r) => rl.question(question, r));
  rl.close();
  const t = answer.trim();
  return t || fallback;
}

/* ------------------------------------------------------------------ */
/* 探测                                                                */
/* ------------------------------------------------------------------ */
function exists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

/** 找出所有存在的盘符根（Windows）/ 常见挂载点（其它平台） */
function driveRoots() {
  if (IS_WIN) {
    const out = [];
    for (let c = 65; c <= 90; c++) {
      const root = String.fromCharCode(c) + ":\\";
      if (exists(root)) out.push(root);
    }
    return out;
  }
  return ["/"];
}

function detectKoodo() {
  const cands = [];
  if (IS_WIN) {
    cands.push(
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Koodo Reader", "Koodo Reader.exe"),
      path.join(
        process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
        "Koodo Reader",
        "Koodo Reader.exe"
      ),
      path.join(process.env.LOCALAPPDATA || "", "Programs", "Koodo Reader", "Koodo Reader.exe")
    );
    // 不少人装在非系统盘根目录（安装器默认如此）
    for (const root of driveRoots()) {
      cands.push(path.join(root, "Koodo Reader", "Koodo Reader.exe"));
    }
  } else if (IS_MAC) {
    cands.push("/Applications/Koodo Reader.app/Contents/MacOS/Koodo Reader");
  } else {
    cands.push("/opt/Koodo Reader/koodo-reader", "/usr/bin/koodo-reader");
  }
  return cands.find(exists) || null;
}

/** 找 DSH 桌面版安装目录：该目录下应有 resources/runtime/cli/bin/dsh.cmd */
function looksLikeDshDir(dir) {
  if (!dir) return false;
  return (
    exists(path.join(dir, "resources", "runtime", "cli", "bin", "dsh.cmd")) ||
    exists(path.join(dir, "resources", "app.asar"))
  );
}

function detectDsh() {
  const cands = [];
  if (IS_WIN) {
    cands.push(
      path.join(process.env.LOCALAPPDATA || "", "Programs", "DeepSeek Harness"),
      path.join(process.env.ProgramFiles || "", "DeepSeek Harness"),
      path.join(process.env["ProgramFiles(x86)"] || "", "DeepSeek Harness")
    );
    for (const root of driveRoots()) cands.push(path.join(root, "DSH"));
  } else if (IS_MAC) {
    cands.push("/Applications/DeepSeek Harness.app/Contents/Resources");
  }
  return cands.find(looksLikeDshDir) || null;
}

/** 从 DSH 安装目录推出「启动用 exe」和「cli.js」 */
function dshPaths(dshDir) {
  if (!dshDir) return null;
  const cliCmd = path.join(dshDir, "resources", "runtime", "cli", "bin", "dsh.cmd");
  const exe = IS_WIN
    ? path.join(dshDir, "DeepSeek Harness.exe")
    : IS_MAC
      ? path.join(dshDir, "..", "..", "MacOS", "DeepSeek Harness")
      : path.join(dshDir, "deepseek-harness");
  const cliJs = path.join(
    dshDir,
    "resources",
    "app.asar",
    "dsh",
    "node_modules",
    "@deepseek-ai",
    "dsh-desktop-host",
    "lib",
    "cli.js"
  );
  return { dshDir, exe, cliJs, cliCmd };
}

/* ------------------------------------------------------------------ */
/* 生成插件 JSON（格式规则在 koodo-plugin/plugin-format.mjs）           */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
log("\nkoodo-dsh-agent 安装向导\n" + "=".repeat(46));

/* 1. Koodo */
let koodoExe = FLAGS.koodo;
if (koodoExe && !exists(koodoExe)) die(`指定的 Koodo 可执行文件不存在：${koodoExe}`);
if (!koodoExe) {
  koodoExe = detectKoodo();
  if (koodoExe) ok(`找到 Koodo：${koodoExe}`);
  else {
    log("\n没自动找到 Koodo Reader。请提供它的可执行文件路径，例如：");
    if (IS_WIN) log('  node install.mjs --koodo "D:\\Koodo Reader\\Koodo Reader.exe"');
    else if (IS_MAC) log('  node install.mjs --koodo "/Applications/Koodo Reader.app/Contents/MacOS/Koodo Reader"');
    else log("  node install.mjs --koodo /opt/Koodo\\ Reader/koodo-reader");
    die("缺少 Koodo 路径");
  }
} else {
  ok(`Koodo：${koodoExe}`);
}

/* 2. DSH */
let dshInfo = dshPaths(FLAGS.dsh && looksLikeDshDir(FLAGS.dsh) ? FLAGS.dsh : detectDsh());
if (!dshInfo) {
  log("\n没自动找到 DeepSeek Harness。本项目需要本机装有 DSH 桌面版。");
  log('  node install.mjs --dsh "F:\\DSH"        # 指向含 resources/ 的那一层');
  die("缺少 DSH 安装目录");
}
ok(`DSH：${dshInfo.dshDir}`);
if (!exists(dshInfo.exe)) warn(`DSH 可执行文件没找到（预期在 ${dshInfo.exe}），稍后可在 config.json 里改`);
// cli.js 在 app.asar 里，普通 Node 看不见（只有 Electron 能读 asar），所以不做存在性校验
ok("cli.js 路径已记录（在 app.asar 内，由 Electron 读取，此处无法校验）");

/* 3. 运行时目录 */
const runtimeDir = path.resolve(
  FLAGS.dir && FLAGS.dir !== true ? FLAGS.dir : path.join(os.homedir(), ".koodo-dsh-agent")
);

/* 4. DSH profile */
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const profileDir = path.join(dshHome, "profiles", FLAGS.profile);
if (exists(profileDir)) {
  ok(`DSH profile 已存在：${FLAGS.profile}`);
} else if (exists(dshInfo.cliCmd)) {
  log(`\n创建 DSH profile「${FLAGS.profile}」（从官方 sdk 模板，不影响你现有的 profile）…`);
  const r = spawnSync(
    dshInfo.cliCmd,
    [FLAGS.profile, "--from-default-profile", "sdk", "--help"],
    { stdio: "inherit", shell: IS_WIN, timeout: 300000 }
  );
  if (exists(profileDir)) ok(`profile 创建成功：${profileDir}`);
  else warn(`profile 创建似乎没成功（退出码 ${r.status}）。首次使用网关时可能报 profile 不存在，请手动跑：`);
  if (!exists(profileDir)) log(`    "${dshInfo.cliCmd}" ${FLAGS.profile} --from-default-profile sdk --help`);
} else {
  warn(`找不到 dsh 启动脚本（${dshInfo.cliCmd}），跳过 profile 创建`);
}

/* 5. 落地运行时文件 */
fs.mkdirSync(runtimeDir, { recursive: true });
const copies = [
  ["koodo-plugin/script.js", "panel-src.js"],
  ["gateway/gateway.mjs", "gateway.mjs"],
  ["launcher/launch.mjs", "launch.mjs"],
];
for (const [from, to] of copies) {
  const src = path.join(HERE, from);
  if (!exists(src)) die(`仓库文件缺失：${from}（请在完整 clone 的目录里运行）`);
  fs.copyFileSync(src, path.join(runtimeDir, to));
}

const endpoint = `http://127.0.0.1:${FLAGS.gatewayPort}/v1/chat/completions`;
const panelPath = path.join(runtimeDir, "panel.js");
// 面板脚本前缀：把网关地址注入进去（面板优先读 window.__dshEndpoint）
fs.writeFileSync(
  path.join(runtimeDir, "panel.js"),
  `/* 由 install.mjs 生成，勿手改 —— 改仓库里的 koodo-plugin/script.js 后重跑安装 */\n` +
    `window.__dshEndpoint = ${JSON.stringify(endpoint)};\n` +
    fs.readFileSync(path.join(runtimeDir, "panel-src.js"), "utf8"),
  "utf8"
);

const config = {
  $comment: "由 install.mjs 生成。改完这里后重新启动启动器即可生效。",
  platform: process.platform,
  runtimeDir,
  koodoExe,
  dshExe: dshInfo.exe,
  dshCliJs: dshInfo.cliJs,
  dshProfile: FLAGS.profile,
  agentCwd: FLAGS.agentCwd && FLAGS.agentCwd !== true ? path.resolve(FLAGS.agentCwd) : path.join(runtimeDir, "workspace"),
  gatewayPort: FLAGS.gatewayPort,
  debugPort: FLAGS.debugPort,
  panelPath,
};
fs.mkdirSync(config.agentCwd, { recursive: true });
fs.writeFileSync(path.join(runtimeDir, "config.json"), JSON.stringify(config, null, 2), "utf8");

/* 6. 插件 JSON */
const boot = bootstrapScript({ runtimeDir });
log(
  boot.embeddedAbsolutePath
    ? "  提示：运行时目录不在家目录下，插件 JSON 里会嵌入绝对路径"
    : "  路径写法：插件里用 os.homedir() 现算，JSON 保持纯 ASCII（粘贴最稳）"
);
const variants = [
  ["plugin-translation.json", { type: "translation", displayName: "DSH Agent", script: boot.script, endpoint }],
  ["plugin-dictionary.json", { type: "dictionary", displayName: "DSH Agent (Dictionary)", script: boot.script, endpoint }],
];
for (const [file, spec] of variants) {
  const text = JSON.stringify(buildPlugin(spec), null, 2);
  fs.writeFileSync(path.join(runtimeDir, file), text, "utf8");
  // 自校验：完整走一遍 Koodo 的读取与校验路径
  const problems = validatePluginJson(text);
  if (problems.length) die(`${file} 自校验失败：${problems.join("；")}`);
  for (const w of pluginWarnings(text)) warn(`${file}：${w}`);
  ok(`${file} 已生成并通过自校验（${text.length} 字节）`);
}

/* 7. 启动器 */
if (IS_WIN) {
  // 内容全 ASCII：用 %~dp0 取自身目录，避免把可能含中文的路径写进 .cmd（cmd 解析不了 UTF-8 批处理）
  fs.writeFileSync(
    path.join(runtimeDir, "start-gateway.cmd"),
    ["@echo off", "title DSH gateway - closing stops the agent backend", 'node "%~dp0gateway.mjs"', ""].join("\r\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(runtimeDir, "koodo-dsh.cmd"),
    [
      "@echo off",
      "title DSH x Koodo supervisor - closing this window stops the panel injection",
      'node "%~dp0launch.mjs"',
      "",
    ].join("\r\n"),
    "utf8"
  );
} else {
  const sh = (name, target) => {
    const p = path.join(runtimeDir, name);
    fs.writeFileSync(p, `#!/bin/sh\nexec node "$(dirname "$0")/${target}" "$@"\n`, "utf8");
    fs.chmodSync(p, 0o755);
  };
  sh("start-gateway.sh", "gateway.mjs");
  sh("koodo-dsh.sh", "launch.mjs");
}

/* 8. 可选：剪贴板 / 桌面快捷方式 */
if (FLAGS.clip && IS_WIN) {
  const r = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `Set-Clipboard -Value ([System.IO.File]::ReadAllText('${path.join(runtimeDir, "plugin-translation.json")}'))`],
    { stdio: "ignore" }
  );
  if (r.status === 0) ok("插件 JSON 已放进剪贴板");
  else warn("复制到剪贴板失败，请手动打开文件复制");
}

const launcherPath = path.join(runtimeDir, IS_WIN ? "koodo-dsh.cmd" : "koodo-dsh.sh");
if (FLAGS.shortcut && IS_WIN) {
  const lnk = path.join(
    process.env.USERPROFILE || os.homedir(),
    "Desktop",
    "Koodo Reader (DSH).lnk"
  );
  const ps =
    `$ws = New-Object -ComObject WScript.Shell; ` +
    `$l = $ws.CreateShortcut(${JSON.stringify(lnk)}); ` +
    `$l.TargetPath = ${JSON.stringify(launcherPath)}; ` +
    `$l.WorkingDirectory = ${JSON.stringify(runtimeDir)}; ` +
    `$l.IconLocation = ${JSON.stringify(koodoExe + ",0")}; ` +
    `$l.Description = 'Launch Koodo Reader with the DSH agent panel'; ` +
    `$l.Save()`;
  const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
  if (r.status === 0) ok(`桌面快捷方式已创建：${lnk}`);
  else warn("创建快捷方式失败，手动双击 " + launcherPath + " 也可以");
}

/* 9. 收尾 */
log("\n" + "=".repeat(46));
ok(`安装完成，运行时目录：${runtimeDir}`);
log(`
下一步（两步）：

1) 把插件装进 Koodo
   打开 Koodo → 设置 → 插件 → 添加自定义插件
   粘贴这个文件的全部内容：
     ${path.join(runtimeDir, "plugin-translation.json")}
   （想连划词查词也接管，再粘一次 plugin-dictionary.json）

2) 用启动器启动 Koodo
   ${launcherPath}
   ${IS_WIN ? "它会：拉起网关 → 带调试端口启动 Koodo → 常驻注入智能体面板" : "它会：拉起网关 → 带调试端口启动 Koodo → 常驻注入智能体面板"}

之后：书里划一段字点翻译（第一次会激活面板），右下角出现 DSH 圆球。
智能体的工作目录默认是 ${config.agentCwd}
想改成你的笔记库，编辑 config.json 里的 agentCwd。
`);
