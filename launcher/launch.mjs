#!/usr/bin/env node
/**
 * koodo-dsh-agent 常驻监督进程
 *
 * 由 koodo-dsh 启动器调用，做三件事：
 *   1. 确保网关在跑（不在就后台拉起来）
 *   2. 带一个回环调试端口启动 Koodo
 *   3. 通过 CDP 的 Page.addScriptToEvaluateOnNewDocument 注入智能体面板
 *
 * 为什么用 addScriptToEvaluateOnNewDocument：
 *   Koodo 从阅读器回到书架时会调 mainWin.reload()，整个渲染进程重载。
 *   这个 CDP 钩子在**每个新文档**都会执行，所以面板不会因为切界面而丢失，
 *   也不需要每次手动「划词唤醒」。
 *
 * 所有路径来自同目录的 config.json（由 install.mjs 生成）。
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const p = path.join(HERE, "config.json");
  if (!fs.existsSync(p)) {
    console.error(`[dsh] 找不到 ${p} —— 请先在仓库目录运行 node install.mjs`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

const CFG = loadConfig();
const PORT = Number(process.env.KOODO_DSH_DEBUG_PORT || CFG.debugPort || 9222);
const PANEL = CFG.panelPath || path.join(HERE, "panel.js");
const GATEWAY = path.join(HERE, "gateway.mjs");
const LOG = path.join(HERE, "supervisor.log");

const log = (s) => {
  const line = new Date().toISOString() + " " + s + "\n";
  try {
    fs.appendFileSync(LOG, line);
  } catch {}
  process.stdout.write(line);
};

/* 注入到每个新文档的代码。
   渲染进程有 node 集成，所以直接读盘加载面板脚本（改脚本免重装）。 */
const INJECT_SRC = `(function () {
  var tries = 0;
  function go() {
    try {
      var fs = require("fs");
      var p = ${JSON.stringify(PANEL)};
      if (!fs.existsSync(p)) return;
      eval(fs.readFileSync(p, "utf8"));
    } catch (e) {
      if (++tries < 20) setTimeout(go, 500);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go);
  else go();
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 1) 网关 ---------------- */
async function ensureGateway() {
  const port = CFG.gatewayPort || 8317;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) {
      log(`网关已在运行（端口 ${port}）`);
      return;
    }
  } catch {}
  log("网关没在跑，后台拉起");
  try {
    const child = spawn(process.execPath, [GATEWAY], {
      cwd: HERE,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch (e) {
    log("拉起网关失败: " + e.message);
  }
}

/* ---------------- 2) Koodo ---------------- */
async function listTargets() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(1500) });
    return await r.json();
  } catch {
    return null;
  }
}

async function ensureKoodo() {
  if (await listTargets()) return true;
  if (!CFG.koodoExe || !fs.existsSync(CFG.koodoExe)) {
    log(`Koodo 可执行文件不存在：${CFG.koodoExe}（改 config.json 里的 koodoExe）`);
    return false;
  }
  log(`启动 Koodo（带调试端口 ${PORT}）`);
  try {
    const child = spawn(CFG.koodoExe, [`--remote-debugging-port=${PORT}`], {
      cwd: path.dirname(CFG.koodoExe),
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (e) {
    log("启动 Koodo 失败: " + e.message);
    return false;
  }
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (await listTargets()) return true;
  }
  log("等不到调试端口 —— Koodo 可能已经在运行（且没带调试端口）。请关掉 Koodo 再用本启动器。");
  return false;
}

/* ---------------- 3) CDP 注入 ---------------- */
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    let id = 0;
    ws.addEventListener("open", () =>
      resolve({
        send(method, params = {}) {
          const msgId = ++id;
          return new Promise((res, rej) => {
            pending.set(msgId, { res, rej });
            ws.send(JSON.stringify({ id: msgId, method, params }));
          });
        },
        close: () => ws.close(),
        onClose: (fn) => ws.addEventListener("close", fn),
      })
    );
    ws.addEventListener("error", () => reject(new Error("CDP WebSocket 错误")));
    ws.addEventListener("close", () => {
      for (const { rej } of pending.values()) rej(new Error("CDP 断开"));
      pending.clear();
    });
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      }
    });
  });
}

let attachedId = null;
let session = null;

async function attach(target) {
  try {
    session?.close();
  } catch {}
  session = null;
  attachedId = null;

  const s = await connect(target.webSocketDebuggerUrl);
  await s.send("Page.enable");
  await s.send("Runtime.enable");
  await s.send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT_SRC });
  // 当前这个文档已经加载完了，立刻补注入一次
  await s.send("Runtime.evaluate", { expression: INJECT_SRC, awaitPromise: false });
  s.onClose(() => {
    if (attachedId === target.id) {
      attachedId = null;
      session = null;
    }
  });
  session = s;
  attachedId = target.id;
  log("已挂上 CDP 并安装注入钩子: " + String(target.url).slice(0, 70));
}

/* ---------------- 主循环 ---------------- */
await ensureGateway();
if (!(await ensureKoodo())) process.exit(1);

log(`面板脚本：${PANEL}`);
let portClosedFor = 0;
for (;;) {
  await sleep(3000);
  const list = await listTargets();
  if (!list) {
    portClosedFor += 3;
    if (portClosedFor >= 15 && attachedId === null) {
      log("调试端口已关闭 15 秒以上，Koodo 大概退出了 —— 监督进程退出");
      process.exit(0);
    }
    continue;
  }
  portClosedFor = 0;
  const page =
    list.find((t) => t.type === "page" && /index\.html/.test(t.url || "")) ||
    list.find((t) => t.type === "page");
  if (!page) continue;
  if (page.id !== attachedId) {
    try {
      await attach(page);
    } catch (e) {
      log("attach 失败: " + e.message);
      await sleep(2000);
    }
  }
}
