#!/usr/bin/env node
/**
 * 离线自检 —— CI 跑这个（不依赖 Koodo、不依赖网关、不联网）。
 *
 * 检查项：
 *   1. 所有 JS/MJS 语法可编译
 *   2. 插件格式规则：哈希往返、粘贴安全（无转义）、字段齐全、默认安装产出纯 ASCII
 *   3. 面板脚本必须具备 Koodo 要调的两个钩子，且不含本地绝对路径
 *   4. 仓库里没有机器相关的路径/用户名痕迹
 *
 * 用法: node tests/check.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  bootstrapScript,
  buildPlugin,
  validatePluginJson,
  pluginWarnings,
} from "../koodo-plugin/plugin-format.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);
const SKIP_DIRS = new Set(["node_modules", ".git", "docs", "runtime"]);
const CODE_EXT = new Set([".js", ".mjs", ".cjs"]);

let failures = 0;
const pass = (s) => console.log("  \u2713 " + s);
const fail = (s) => {
  failures++;
  console.log("  \u2717 " + s);
};
const section = (s) => console.log("\n" + s);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}
const files = walk(ROOT);
const codeFiles = files.filter((f) => CODE_EXT.has(path.extname(f)));

/* 1) 语法 */
section("1) 语法检查");
for (const f of codeFiles) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  const rel = path.relative(ROOT, f);
  if (r.status === 0) pass(rel);
  else fail(`${rel}：${(r.stderr || "").split("\n").slice(0, 3).join(" ")}`);
}

/* 2) 插件格式 */
section("2) 插件格式（模拟 Koodo 的校验路径）");
const endpoint = "http://127.0.0.1:8317/v1/chat/completions";
const cases = [
  { label: "默认安装（家目录下，可能含中文用户名）", runtimeDir: path.join(os.homedir(), ".koodo-dsh-agent"), mustBeAscii: true },
  { label: "自定义目录（不在家目录下，退化为嵌入绝对路径）", runtimeDir: path.join(path.parse(ROOT).root, "koodo-dsh"), mustBeAscii: true },
];
for (const c of cases) {
  const { script, embeddedAbsolutePath } = bootstrapScript({ runtimeDir: c.runtimeDir });
  for (const type of ["translation", "dictionary"]) {
    const text = JSON.stringify(
      buildPlugin({ type, displayName: "DSH Agent", script, endpoint }),
      null,
      2
    );
    const problems = validatePluginJson(text);
    const label = `${c.label} / ${type}`;
    if (problems.length) {
      fail(`${label}：${problems.join("；")}`);
      continue;
    }
    if (c.mustBeAscii && !/^[\x20-\x7e\r\n]*$/.test(text)) {
      fail(`${label}：JSON 不是纯 ASCII（家目录含中文时应当用 os.homedir() 现算）`);
      continue;
    }
    const warns = pluginWarnings(text);
    pass(`${label}（${text.length} 字节${embeddedAbsolutePath ? "，嵌入路径" : "，homedir 现算"}）${warns.length ? " · " + warns.join("；") : ""}`);
  }
}

/* 3) 面板脚本 */
section("3) 面板脚本");
const scriptPath = path.join(ROOT, "koodo-plugin", "script.js");
if (!fs.existsSync(scriptPath)) fail("缺 koodo-plugin/script.js");
else {
  const src = fs.readFileSync(scriptPath, "utf8");
  for (const hook of ["translate", "getDictText"]) {
    const re = new RegExp(`(?:window|W)\\s*\\.\\s*${hook}\\s*=`);
    if (re.test(src)) pass(`注册了 window.${hook}`);
    else fail(`没找到 window.${hook} 的注册`);
  }
  if (src.includes("window.__dshEndpoint")) pass("支持 install.mjs 注入的 window.__dshEndpoint");
  else fail("没有读取 window.__dshEndpoint（换网关端口会失效）");
  if (/[A-Z]:\\\\|C:\\\\Users/i.test(src)) fail("面板脚本里有本地绝对路径");
  else pass("面板脚本无本地绝对路径");
  if (src.includes("onProgress") && src.includes("j.dsh")) pass("含进度帧处理（长任务可见反馈）");
  else fail("没找到进度帧处理（长任务会看不到反馈）");
}

/* 4) 泄露扫描（模式用转义拼出来，避免检查脚本自己命中自己） */
section("4) 本地路径痕迹扫描");
const HARD = [
  { re: /DSH\u5de5\u4f5c\u533a/, what: "作者的工作区名" },
  { re: /\u4efb\u5f66\u975e/, what: "作者的用户名" },
  { re: new RegExp("koodo-dsh-" + "plugin"), what: "作者工作区里的旧目录名" },
  { re: /D:\\\\DSH/, what: "作者工作区的绝对路径" },
];
let hardHits = 0;
for (const f of codeFiles) {
  if (f === SELF) continue; // 本文件的模式是拼出来的，跳过以免自己命中
  const src = fs.readFileSync(f, "utf8");
  for (const h of HARD) {
    if (h.re.test(src)) {
      hardHits++;
      fail(`${path.relative(ROOT, f)} 含${h.what}`);
    }
  }
}
if (!hardHits) pass("代码文件里没有作者相关的路径/用户名");

const generic = [];
for (const f of codeFiles) {
  const src = fs.readFileSync(f, "utf8");
  const m = src.match(/[A-Z]:\\\\[A-Za-z]/g);
  if (m) generic.push(`${path.relative(ROOT, f)} × ${m.length}`);
}
if (generic.length) {
  console.log("  · 代码里的通用盘符路径（确认只是示例/兜底即可）：\n    " + generic.join("\n    "));
} else {
  pass("代码文件里没有盘符绝对路径");
}

/* 结果 */
console.log("\n" + "=".repeat(46));
if (failures) {
  console.log(`失败 ${failures} 项`);
  process.exit(1);
}
console.log("全部通过");
