#!/usr/bin/env node
/**
 * Koodo Agent Gateway —— 把 Koodo Reader 的「OpenAI 兼容」AI 调用接到 DSH 智能体。
 *
 * Koodo 2.4.x 的 AI 客户端行为（实测反编译 app.asar 得到）：
 *   - POST {endpoint}/chat/completions，头 Authorization: Bearer <apiKey>
 *   - body { model, messages, stream: true }，SSE 流式，逐块读 choices[0].delta.content
 *   - 以 "data: [DONE]" 结束；历史只截最后 5 条
 *   - 设置页的 Test 按钮走非流式，读 choices[0].message.content
 * 本网关据此实现两种响应，并把请求转给 DSH 的 stdio JSON-RPC SDK（dsh <profile>）。
 *
 * 配置来源（优先级从高到低）：
 *   1. 环境变量
 *   2. 同目录下的 config.json（由 install.mjs 生成）
 *   3. 内置默认值
 */
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadConfigFile() {
  for (const p of [path.join(HERE, "config.json"), path.join(HERE, "..", "config.json")]) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      console.error(`[koodo-gw] config.json 解析失败（${p}）：${e.message}`);
    }
  }
  return {};
}
const FILE = loadConfigFile();

const pick = (envName, fileKey, fallback) => {
  const v = process.env[envName];
  if (v !== undefined && v !== "") return v;
  if (FILE[fileKey] !== undefined && FILE[fileKey] !== "") return FILE[fileKey];
  return fallback;
};

const CFG = {
  host: pick("KOODO_GW_HOST", "gatewayHost", "127.0.0.1"),
  port: Number(pick("KOODO_GW_PORT", "gatewayPort", 8317)),
  // DSH 运行时
  dshExe: pick("DSH_EXE", "dshExe", ""),
  dshCli: pick("DSH_CLI", "dshCliJs", ""),
  profile: pick("KOODO_GW_PROFILE", "dshProfile", "koodo-gw"),
  provider: pick("KOODO_GW_PROVIDER", "provider", "deepseek-official"),
  model: pick("KOODO_GW_MODEL", "model", "deepseek-v4-flash"),
  // 智能体的工作目录（它的读写范围）
  cwd: path.resolve(pick("KOODO_GW_CWD", "agentCwd", os.homedir())),
  // headless 下没有审批应答方：workspace-write 会让需要审批的工具调用 fail closed
  permission: pick("KOODO_GW_PERMISSION", "permission", "danger-full-access"),
  publicModel: pick("KOODO_GW_MODEL_ID", "publicModelId", "dsh-agent"),
  showTools: pick("KOODO_GW_SHOW_TOOLS", "showTools", "0") === "1",
  turnTimeoutMs: Number(pick("KOODO_GW_TURN_TIMEOUT_MS", "turnTimeoutMs", 900000)),
  sessionMode: pick("KOODO_GW_SESSION_MODE", "sessionMode", "shared"),
  verbose: pick("KOODO_GW_VERBOSE", "verbose", "0") === "1",
};

const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.error(`[koodo-gw ${stamp()}]`, ...a);
const vlog = (...a) => CFG.verbose && log(...a);

/* ------------------------------------------------------------------ */
/* DSH 运行时：一个子进程 + stdio JSON-RPC                              */
/* ------------------------------------------------------------------ */

class DshRuntime {
  constructor(cfg) {
    this.cfg = cfg;
    this.child = null;
    this.buf = "";
    this.seq = 0;
    this.pending = new Map(); // id -> {resolve, reject}
    this.turnHandlers = new Set(); // (notification) => void
    this.ready = null;
    this.defaultSession = null;
  }

  sessionId(prefix = "koodo") {
    return `${prefix}-${Date.now()}-${++this.seq}`;
  }

  async ensure() {
    if (!this.ready) {
      this.ready = this.#boot().catch((e) => {
        this.ready = null;
        throw e;
      });
    }
    return this.ready;
  }

  async #boot() {
    const { dshExe, dshCli, profile, permission, cwd } = this.cfg;
    if (!dshExe || !dshCli) {
      throw new Error(
        "没配置 DSH 运行时路径。请先运行 node install.mjs，或在 config.json 里填 dshExe / dshCliJs，" +
          "也可以用环境变量 DSH_EXE / DSH_CLI 指定。"
      );
    }
    if (!fs.existsSync(dshExe)) throw new Error(`DSH 可执行文件不存在：${dshExe}`);
    // 注意：cli.js 位于 app.asar 内部，普通 Node 看不见（只有 Electron 能读 asar），
    // 所以这里**不做存在性校验** —— 交给 Electron 去解析。

    log(`启动 DSH 运行时 profile=${profile} provider=${this.cfg.provider} model=${this.cfg.model}`);
    log(`会话工作目录 cwd=${cwd}  权限=${permission}`);
    const child = spawn(dshExe, ["--expose-internals", dshCli, profile], {
      cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", DSH_PERMISSION_MODE: permission },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.buf = "";

    child.stdout.on("data", (d) => this.#onData(d));
    child.stderr.on("data", (d) => {
      const s = d.toString().trim();
      if (s) vlog("dsh stderr:", s.slice(0, 500));
    });
    child.on("exit", (code) => {
      log(`DSH 运行时退出 code=${code}`);
      this.child = null;
      this.ready = null;
      for (const { reject } of this.pending.values()) reject(new Error("DSH runtime exited"));
      this.pending.clear();
      for (const fn of this.turnHandlers) {
        try {
          fn({ kind: "runtime-exit" });
        } catch {}
      }
      this.turnHandlers.clear();
    });
    child.on("error", (e) => log("DSH 运行时启动失败:", e.message));

    const result = await this.#request("initialize", {
      provider: this.cfg.provider,
      model: this.cfg.model,
      cwd,
    });
    log(`握手完成 serverInfo=${JSON.stringify(result?.serverInfo ?? result)}`);
    return result;
  }

  #onData(d) {
    this.buf += d.toString();
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        vlog("非 JSON 帧（已忽略）:", line.slice(0, 200));
        continue;
      }
      if (msg.method) {
        for (const fn of this.turnHandlers) {
          try {
            fn({ kind: "notification", method: msg.method, params: msg.params });
          } catch {}
        }
        continue;
      }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      msg.error ? p.reject(new Error(`${msg.error.code}: ${msg.error.message}`)) : p.resolve(msg.result);
    }
  }

  #request(method, params) {
    if (!this.child) return Promise.reject(new Error("DSH runtime is not running"));
    const id = ++this.seq;
    const frame = { jsonrpc: "2.0", id, method, params };
    const promise = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.child.stdin.write(JSON.stringify(frame) + "\n");
    return promise;
  }

  /** 取一个会话 id；默认会话忙时用一次性会话，避免并发请求交织。 */
  #acquire() {
    if (this.cfg.sessionMode === "per-request") {
      return { id: this.sessionId(), release: () => {} };
    }
    if (!this.defaultSession) this.defaultSession = { id: this.sessionId(), busy: false };
    const s = this.defaultSession;
    if (s.busy) return { id: this.sessionId(), release: () => {} };
    s.busy = true;
    return { id: s.id, release: () => (s.busy = false) };
  }

  resetSession() {
    this.defaultSession = null;
    log("默认会话已重置，下一轮将开启新会话");
  }

  /**
   * 跑一轮：把 prompt 交给智能体，按 Koodo 的流式节奏回调 onDelta(text)，
   * 直到 turn/end 或 status=idle。onProgress 用于透出工具调用进度
   * （智能体连跑几十个工具步骤时，正文可能很久不出一句话）。
   */
  async runTurn(contentBlocks, onDelta, onProgress) {
    await this.ensure();
    const session = this.#acquire();
    try {
      return await this.#driveTurn(session.id, contentBlocks, onDelta, onProgress);
    } finally {
      session.release();
    }
  }

  #driveTurn(sessionId, contentBlocks, onDelta, onProgress) {
    const progress = (p) => {
      if (!onProgress) return;
      try {
        onProgress(p);
      } catch {}
    };
    return new Promise((resolve, reject) => {
      let acc = "";
      let replay = Promise.resolve();
      let settled = false;

      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.turnHandlers.delete(handler);
        replay.then(() => (err ? reject(err) : resolve(acc)));
      };

      const timer = setTimeout(() => {
        log(`会话 ${sessionId} 超时（${CFG.turnTimeoutMs}ms），结束本轮`);
        finish();
      }, CFG.turnTimeoutMs);

      const handler = (msg) => {
        if (settled) return;
        if (msg.kind === "runtime-exit") return finish(new Error("DSH runtime exited mid-turn"));
        if (msg.method !== "session.event" && msg.method !== "session.status") return;
        const params = msg.params || {};
        if (params.sessionId !== sessionId) return;

        if (msg.method === "session.status") {
          if (params.status === "idle") finish();
          return;
        }

        const event = params.event || {};
        const data = event.data || {};

        // 工具调用 → 透出进度，让面板不至于长时间只有一个省略号
        if (event.type === "tool/call") {
          const d = event.data || {};
          let summary = "";
          try {
            const a = JSON.parse(d.arguments || "{}");
            summary = a.description || a.pattern || a.file_path || a.path || a.command || "";
          } catch {}
          progress({
            phase: "tool",
            turn: d.turn,
            step: d.step,
            tool: d.name || "?",
            summary: String(summary).replace(/\s+/g, " ").slice(0, 100),
          });
          return;
        }

        if (event.type === "assistant/message" && data.message?.role === "assistant") {
          const blocks = data.message.content || [];
          const textBlocks = blocks.filter((b) => b.type === "text");
          const full = textBlocks.map((b) => b.text || "").join("");
          const pieces = replayPieces(data.stream, textBlocks.length);
          if (!full && !pieces.length) return;
          const payload = pieces.length ? pieces : [{ delay: 0, text: full }];
          acc += payload.map((p) => p.text).join("");
          replay = replay.then(() => streamOut(payload, onDelta));
          return;
        }

        if (event.type === "turn/end") finish();
      };

      this.turnHandlers.add(handler);
      progress({ phase: "start" });
      this.#request("session/prompt", { sessionId, contentBlocks }).catch(finish);
    });
  }

  shutdown() {
    try {
      this.child?.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 999999, method: "shutdown" }) + "\n");
    } catch {}
  }
}

/** 从 assistant/message 的 stream 日志里取出文本分片（含原始时间轴）。 */
function replayPieces(stream, textBlockCount) {
  if (!Array.isArray(stream) || !stream.length) return [];
  const textIndexes = new Set();
  for (const e of stream) {
    if (e?.chunk?.type === "block-start" && e.chunk.blockType === "text") textIndexes.add(e.chunk.index);
  }
  const out = [];
  for (const e of stream) {
    if (e?.type !== "text-chunks") continue;
    if (textIndexes.size && !textIndexes.has(e.index)) continue;
    const texts = Array.isArray(e.texts) ? e.texts : [];
    const dt = Array.isArray(e.dt) ? e.dt : [];
    texts.forEach((t, k) => {
      // 保留原打字节奏，但压掉过长停顿
      out.push({ delay: Math.min(Number(dt[k]) || 0, 150), text: String(t) });
    });
  }
  return textBlockCount > 0 ? out : [];
}

async function streamOut(pieces, onDelta) {
  for (const p of pieces) {
    if (p.delay > 0) await new Promise((r) => setTimeout(r, p.delay));
    if (p.text) onDelta(p.text);
  }
}

/* ------------------------------------------------------------------ */
/* OpenAI 兼容 HTTP 层                                                  */
/* ------------------------------------------------------------------ */

const runtime = new DshRuntime(CFG);

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  // 渲染进程（file:// 或不透明来源）访问本机回环时，Chromium 的
  // Private Network Access 预检需要这个头；缺了可能被拦。
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  cors(res);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** 把 OpenAI messages 收敛成 DSH 的 contentBlocks（正文取最后一条 user）。 */
function toContentBlocks(messages) {
  const sys = messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .filter(Boolean)
    .join("\n\n");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const blocks = [];
  if (sys) blocks.push({ type: "text", text: sys });
  const content = lastUser?.content;
  if (typeof content === "string") {
    blocks.push({ type: "text", text: content });
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part?.type === "text" && part.text) blocks.push({ type: "text", text: String(part.text) });
      else if (part?.type === "image_url") {
        const m = /^data:([^;]+);base64,(.*)$/s.exec(part.image_url?.url || "");
        if (m) blocks.push({ type: "image", data: m[2], mimeType: m[1] });
      }
    }
  }
  if (!blocks.length) blocks.push({ type: "text", text: "" });
  return blocks;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
    return json(res, 200, {
      ok: true,
      service: "koodo-dsh-agent-gateway",
      profile: CFG.profile,
      route: `${CFG.provider} / ${CFG.model}`,
      cwd: CFG.cwd,
      permission: CFG.permission,
      modelId: CFG.publicModel,
    });
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    return json(res, 200, {
      object: "list",
      data: [
        { id: CFG.publicModel, object: "model", owned_by: "dsh" },
        { id: CFG.model, object: "model", owned_by: CFG.provider },
      ],
    });
  }

  if (req.method === "POST" && url.pathname === "/koodo/reset") {
    runtime.resetSession();
    return json(res, 200, { ok: true, message: "已重置会话，下一轮开启新会话" });
  }

  if (req.method === "POST" && url.pathname === "/koodo/shutdown") {
    // 等响应真正写出去再拆运行时并退出，避免"接口回了 ok 但进程还活着"
    res.on("finish", () => {
      log("收到 shutdown 请求，优雅退出");
      runtime.shutdown();
      setTimeout(() => process.exit(0), 800);
    });
    return json(res, 200, { ok: true, message: "正在关闭" });
  }

  if (req.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
    return json(res, 404, {
      error: { message: `未知路径: ${req.method} ${url.pathname}`, type: "invalid_request_error" },
    });
  }

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (e) {
    return json(res, 400, {
      error: { message: `请求体不是合法 JSON: ${e.message}`, type: "invalid_request_error" },
    });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const blocks = toContentBlocks(messages);
  const preview = blocks
    .map((b) => (b.type === "text" ? b.text : "<image>"))
    .join(" ")
    .slice(0, 120);
  log(
    `收到请求 stream=${!!body.stream} model=${body.model ?? "(未指定)"} 提示长度=${JSON.stringify(blocks).length} 预览=${JSON.stringify(preview)}`
  );

  if (!preview.trim()) {
    if (body.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(`data: ${JSON.stringify(chunkFrame(""))}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    return json(res, 200, completionFrame(""));
  }

  const id = `chatcmpl-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);

  if (!body.stream) {
    try {
      const text = await runtime.runTurn(blocks, () => {});
      return json(res, 200, completionFrame(text, id, created));
    } catch (e) {
      log("非流式请求失败:", e.message);
      return json(res, 502, { error: { message: e.message, type: "upstream_error" } });
    }
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const write = (text) => res.write(`data: ${JSON.stringify(chunkFrame(text, id, created))}\n\n`);
  const writeProgress = (p) => {
    try {
      res.write(`data: ${JSON.stringify(progressFrame(p, id, created))}\n\n`);
    } catch {}
  };

  // 先给一个 role 帧，符合 OpenAI 习惯
  res.write(
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model: CFG.publicModel,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    })}\n\n`
  );

  try {
    await runtime.runTurn(blocks, write, writeProgress);
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model: CFG.publicModel,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`
    );
    res.write("data: [DONE]\n\n");
    res.end();
    log("本轮完成，已发送 [DONE]");
  } catch (e) {
    log("流式请求失败:", e.message);
    try {
      write(`\n[网关错误] ${e.message}\n`);
      res.write("data: [DONE]\n\n");
    } catch {}
    res.end();
  }
});

function chunkFrame(text, id = "chatcmpl-0", created = Math.floor(Date.now() / 1000)) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model: CFG.publicModel,
    choices: [{ index: 0, delta: text ? { content: text } : {}, finish_reason: null }],
  };
}

/**
 * 进度帧：走 OpenAI 流里一个额外的 `dsh` 字段。
 * Koodo 自带的 AI 客户端只读 choices[0].delta.content，会安全忽略；
 * 本插件的面板读它来显示「第几步 / 在调什么工具 / 已等待多久」。
 */
function progressFrame(p, id = "chatcmpl-0", created = Math.floor(Date.now() / 1000)) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model: CFG.publicModel,
    choices: [{ index: 0, delta: {}, finish_reason: null }],
    dsh: { kind: "progress", ...p },
  };
}

function completionFrame(text, id = `chatcmpl-${Date.now().toString(36)}`, created = Math.floor(Date.now() / 1000)) {
  return {
    id,
    object: "chat.completion",
    created,
    model: CFG.publicModel,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    log(`端口 ${CFG.port} 已被占用：可能已经有一个网关在跑。先关掉它，或改 KOODO_GW_PORT。`);
  } else {
    log("监听失败:", e.message);
  }
  process.exit(1);
});

server.listen(CFG.port, CFG.host, () => {
  log(`监听 http://${CFG.host}:${CFG.port}/v1  —— Koodo 里 Endpoint 填 http://${CFG.host}:${CFG.port}/v1`);
  log(`对外模型 id=${CFG.publicModel}；DSH 路由=${CFG.provider}/${CFG.model}`);
  log(`智能体工作目录=${CFG.cwd}  权限=${CFG.permission}`);
  runtime.ensure().catch((e) => log("预热失败（首个请求会重试）:", e.message));
});

process.on("SIGINT", () => {
  log("收到 SIGINT，关闭运行时");
  runtime.shutdown();
  setTimeout(() => process.exit(0), 1500);
});
process.on("SIGTERM", () => {
  runtime.shutdown();
  setTimeout(() => process.exit(0), 1500);
});
