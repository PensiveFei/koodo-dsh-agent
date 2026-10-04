#!/usr/bin/env node
/**
 * 钩子端到端测试：在最小 DOM 影子环境里执行面板脚本，
 * 按 Koodo 的方式调用它注册的钩子，验证契约：
 *
 *   window.translate(text, from, to, axios, config)            -> Promise<string>
 *   window.getDictText(text, from, to, axios, t, config)        -> Promise<string>
 *   panel 流式发送 + dsh 进度帧
 *
 * 分成两部分：
 *   离线部分（默认就跑）：脚本能 eval、可重复 eval、引导脚本能自证、钩子已注册
 *   联网部分（加 --live）：真的打网关，验证翻译/查词/流式与进度条
 *
 * 用法:
 *   node tests/hook-test.mjs                 # 只跑离线部分
 *   node tests/hook-test.mjs --live          # 连本机网关一起跑
 *   node tests/hook-test.mjs --live http://127.0.0.1:8317/v1/chat/completions
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { bootstrapScript } from "../koodo-plugin/plugin-format.mjs";

const nodeRequire = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = path.join(ROOT, "koodo-plugin", "script.js");
const script = fs.readFileSync(SCRIPT_PATH, "utf8");

const argv = process.argv.slice(2);
const LIVE = argv.includes("--live");
const endpoint =
  argv.find((a) => a.startsWith("http")) || "http://127.0.0.1:8317/v1/chat/completions";

let failed = false;
const ok = (s) => console.log("  \u2713 " + s);
const bad = (s) => {
  failed = true;
  console.log("  \u2717 " + s);
};

/* ---------------- 最小 DOM 影子 ---------------- */
const registry = new Map();
const hostById = new Map();

function makeEl(tag = "div") {
  const el = {
    tagName: tag,
    id: "",
    style: { cssText: "" },
    className: "",
    textContent: "",
    innerHTML: "",
    title: "",
    value: "",
    checked: true,
    disabled: false,
    children: [],
    handlers: {},
    _classes: new Set(),
    appendChild(c) {
      this.children.push(c);
    },
    addEventListener(t, h) {
      (this.handlers[t] = this.handlers[t] || []).push(h);
    },
    dispatch(t, ev = {}) {
      (this.handlers[t] || []).forEach((h) => h(ev));
    },
    querySelector(sel) {
      const id = String(sel).replace(/^#/, "");
      if (!registry.has(id)) registry.set(id, makeEl("stub:" + id));
      return registry.get(id);
    },
    focus() {},
    remove() {
      if (this.id && hostById.get(this.id) === this) hostById.delete(this.id);
    },
    getBoundingClientRect() {
      return { right: 0, bottom: 0, top: 0, left: 0, width: 0, height: 0 };
    },
  };
  el.classList = {
    add: (c) => el._classes.add(c),
    remove: (c) => el._classes.delete(c),
    contains: (c) => el._classes.has(c),
    toggle: (c) => (el._classes.has(c) ? el._classes.delete(c) : el._classes.add(c)),
  };
  return el;
}

const documentShim = {
  body: {
    appendChild(el) {
      if (el && el.id) hostById.set(el.id, el);
    },
  },
  createElement: (tag) => makeEl(tag),
  getElementById: (id) => hostById.get(id) || null,
  querySelector: (sel) => {
    const id = String(sel).replace(/^#/, "");
    if (!registry.has(id)) registry.set(id, makeEl("stub:" + id));
    return registry.get(id);
  },
  querySelectorAll: () => [],
  addEventListener() {},
};

const store = new Map();
const localStorageShim = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const windowShim = {
  innerWidth: 1440,
  innerHeight: 900,
  getSelection: () => ({ toString: () => "" }),
};

const fsShim = { readFileSync: (p) => fs.readFileSync(p, "utf8"), existsSync: (p) => fs.existsSync(p) };
const fakeRequire = (m) => (m === "fs" ? fsShim : nodeRequire(m));

const runPanel = () =>
  new Function("window", "document", "localStorage", "console", "require", script)(
    windowShim,
    documentShim,
    localStorageShim,
    console,
    fakeRequire
  );

/* ---------------- 离线部分 ---------------- */
console.log("\n离线部分");

try {
  runPanel();
  ok("面板脚本可以 eval");
} catch (e) {
  bad("面板脚本 eval 失败：" + e.message);
}
if (typeof windowShim.translate === "function") ok("window.translate 已注册");
else bad("window.translate 未注册");
if (typeof windowShim.getDictText === "function") ok("window.getDictText 已注册");
else bad("window.getDictText 未注册");

try {
  runPanel();
  ok("二次 eval 幂等（panelReady=" + windowShim.__dshAgentState.panelReady + "）");
} catch (e) {
  bad("二次 eval 失败：" + e.message);
}

const host = documentShim.getElementById("koodo-dsh-agent-host");
if (host) ok("面板已注入 DOM");
else bad("面板没注入 DOM");
if (registry.get("st")) ok("状态栏元素存在（进度条）");
else bad("状态栏元素缺失");

// 引导脚本：模拟安装器生成的内容，用影子 fs 读真正的 script.js
const { script: boot } = bootstrapScript({ runtimeDir: path.join(os.homedir(), ".koodo-dsh-agent") });
try {
  delete windowShim.translate;
  delete windowShim.getDictText;
  delete windowShim.__dshAgentState;
  const shimFs = { readFileSync: () => script, existsSync: () => true };
  new Function("window", "document", "localStorage", "console", "require", boot)(
    windowShim,
    documentShim,
    localStorageShim,
    console,
    (m) => (m === "fs" ? shimFs : m === "os" ? { homedir: () => os.homedir() } : nodeRequire(m))
  );
  if (typeof windowShim.translate === "function") ok("引导脚本能加载面板脚本并注册钩子");
  else bad("引导脚本执行后钩子未注册");
} catch (e) {
  bad("引导脚本执行失败：" + e.message);
}

/* ---------------- 联网部分 ---------------- */
if (!LIVE) {
  console.log("\n（跳过联网部分：加 --live 可连本机网关跑翻译/查词/流式+进度）");
} else {
  console.log("\n联网部分（网关：" + endpoint + "）");
  windowShim.__dshEndpoint = endpoint;
  windowShim.__dshAgentState.endpoint = endpoint;

  try {
    const out = await windowShim.translate("The book was published in 1791.", "", "中文", {}, { endpoint });
    if (typeof out === "string" && out.trim()) ok("window.translate 返回：" + JSON.stringify(out.slice(0, 60)));
    else bad("window.translate 返回空");
  } catch (e) {
    bad("window.translate 失败：" + e.message);
  }

  try {
    const out = await windowShim.getDictText("通灵", "auto", "中文", {}, (s) => s, { endpoint });
    if (typeof out === "string" && out.trim()) ok("window.getDictText 返回：" + JSON.stringify(out.slice(0, 50)));
    else bad("window.getDictText 返回空");
  } catch (e) {
    bad("window.getDictText 失败：" + e.message);
  }

  // 面板流式 + 进度：用一个必须调工具的任务
  try {
    const msgs = registry.get("msgs");
    const input = registry.get("q");
    const send = registry.get("send");
    const st = registry.get("st");
    input.value = "数一下当前工作目录根目录下有多少个文件，只回一个数字。";
    send.dispatch("click");

    const samples = [];
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      const t = st.textContent || "";
      if (samples[samples.length - 1] !== t) samples.push(t);
      if (/^完成|出错了/.test(t)) break;
    }
    const last = msgs.children.length ? msgs.children[msgs.children.length - 1].textContent : "";
    const sawStep = samples.some((s) => /^第 \d+ 步/.test(s));
    if (sawStep) ok("进度条出现工具步骤：" + JSON.stringify(samples.find((s) => /^第 \d+ 步/.test(s))));
    else bad("进度条没出现工具步骤，采样：" + JSON.stringify(samples.slice(0, 5)));
    if (last && !String(last).startsWith("出错了")) ok("面板拿到回答：" + JSON.stringify(String(last).slice(0, 60)));
    else bad("面板回答异常：" + JSON.stringify(String(last).slice(0, 120)));
  } catch (e) {
    bad("面板流式测试失败：" + e.message);
  }
}

console.log("\n" + "=".repeat(46));
console.log(failed ? "有失败项" : "全部通过");
process.exit(failed ? 1 : 0);
