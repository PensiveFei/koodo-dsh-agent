/* ============================================================================
 * DSH 智能体 · Koodo Reader 插件脚本
 * ----------------------------------------------------------------------------
 * Koodo 会用 `eval(plugin.script)` 在渲染进程里执行这段代码，执行时机：
 *   - type="translation"：每次划词翻译时（每次都会重新 eval，必须幂等）
 *   - type="dictionary" ：每次划词查词时
 * 所以本脚本必须：
 *   1) 把自己挂到 window 上（严格模式下 eval 的声明不会外泄）
 *   2) 可重复执行而不会重复注入界面
 *
 * 它做两件事：
 *   A. 注册 window.translate / window.getDictText，把划词翻译、查词转给 DSH
 *   B. 注入一个悬浮的智能体聊天面板（Shadow DOM 隔离样式）
 *
 * 依赖：本机 DSH 网关注监听在 http://127.0.0.1:8317/v1（见 koodo-agent-gateway）
 * ========================================================================== */
(function () {
  "use strict";

  var W = window;
  var DEFAULT_ENDPOINT = "http://127.0.0.1:8317/v1/chat/completions";
  var HOST_ID = "koodo-dsh-agent-host";
  var HISTORY_KEY = "koodoDshAgentHistory";
  var PANEL_VERSION = 2; // 改动面板结构时 +1，下次 eval 会自动替换旧面板

  // 跨多次 eval 共享的状态
  var S = (W.__dshAgentState = W.__dshAgentState || {});
  // 网关地址：优先用安装器注入的 window.__dshEndpoint（换端口不用改脚本）
  if (W.__dshEndpoint) S.endpoint = W.__dshEndpoint;
  else if (!S.endpoint) S.endpoint = DEFAULT_ENDPOINT;

  function baseUrl() {
    return String(S.endpoint).replace(/\/v1\/chat\/completions\/?$/, "");
  }

  /* ------------------------------------------------------------------ */
  /* 与网关通信                                                          */
  /* ------------------------------------------------------------------ */

  /** 非流式：拿完整回答（给划词翻译/查词用，Koodo 只接受一次性字符串） */
  async function askOnce(question) {
    var res = await fetch(S.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer koodo-plugin" },
      body: JSON.stringify({ model: "dsh-agent", stream: false, messages: [{ role: "user", content: question }] }),
    });
    if (!res.ok) throw new Error("网关返回 HTTP " + res.status + "：" + (await res.text()).slice(0, 200));
    var j = await res.json();
    var c = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (typeof c !== "string") throw new Error("网关返回格式异常");
    return c;
  }

  /** 流式：边到边回调，给聊天面板用。onProgress 收网关的 dsh 进度帧 */
  async function askStream(question, onDelta, onProgress) {
    var res = await fetch(S.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer koodo-plugin" },
      body: JSON.stringify({ model: "dsh-agent", stream: true, messages: [{ role: "user", content: question }] }),
    });
    if (!res.ok) throw new Error("网关返回 HTTP " + res.status + "：" + (await res.text()).slice(0, 200));
    var reader = res.body.getReader();
    var dec = new TextDecoder();
    var buf = "";
    var full = "";
    for (;;) {
      var step = await reader.read();
      if (step.done) break;
      buf += dec.decode(step.value, { stream: true });
      var i;
      while ((i = buf.indexOf("\n")) >= 0) {
        var line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.indexOf("data:") !== 0) continue;
        var payload = line.slice(5).trim();
        if (payload === "[DONE]") return full;
        try {
          var j = JSON.parse(payload);
          if (j && j.dsh && onProgress) onProgress(j.dsh);
          var d = j && j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (d) {
            full += d;
            onDelta(d);
          }
        } catch (e) {
          /* 半个 JSON 是正常的，等下一块 */
        }
      }
    }
    return full;
  }

  /** 抓当前阅读上下文：优先选中文本，其次从 iframe（EPUB/PDF 内容都在里面）里捞 */
  function grabContext() {
    try {
      var sel = W.getSelection ? String(W.getSelection().toString()) : "";
      sel = sel.replace(/\s+/g, " ").trim();
      if (sel) return sel.slice(0, 2000);
    } catch (e) {}
    var best = "";
    try {
      var frames = document.querySelectorAll("iframe");
      for (var i = 0; i < frames.length; i++) {
        try {
          var d = frames[i].contentDocument;
          var t = d && d.body && d.body.innerText ? d.body.innerText : "";
          t = t.replace(/\s+/g, " ").trim();
          if (t.length > best.length) best = t;
        } catch (e) {
          /* 跨源 iframe，跳过 */
        }
      }
    } catch (e) {}
    return best.slice(0, 4000);
  }

  /* ------------------------------------------------------------------ */
  /* 聊天面板                                                            */
  /* ------------------------------------------------------------------ */

  function loadHistory() {
    try {
      return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    } catch (e) {
      return [];
    }
  }

  function saveHistory(list) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(-40)));
    } catch (e) {}
  }

  function ensurePanel() {
    if (S.panelReady && S.panelVersion === PANEL_VERSION && document.getElementById(HOST_ID)) return;
    var stale = document.getElementById(HOST_ID);
    if (stale) stale.remove();          // 脚本升级过，换掉旧面板
    S.panelReady = false;
    S.panelVersion = PANEL_VERSION;
    var host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement("div");
      host.id = HOST_ID;
      host.style.cssText = "position:fixed;right:22px;bottom:96px;z-index:2147483000;";
      document.body.appendChild(host);
    }
    var root = host.attachShadow ? host.attachShadow({ mode: "open" }) : host;
    root.innerHTML = [
      "<style>",
      ":host,*{box-sizing:border-box}",
      ".wrap{font:13px/1.6 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#e8e8ea}",
      ".bubble{width:52px;height:52px;border-radius:26px;background:linear-gradient(135deg,#4f7cff,#7a4fff);",
      "display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35);",
      "font-weight:700;font-size:15px;letter-spacing:.5px;user-select:none}",
      ".bubble:hover{filter:brightness(1.12)}",
      ".panel{display:none;width:380px;height:520px;flex-direction:column;background:#1c1d22;border:1px solid #33353d;",
      "border-radius:12px;box-shadow:0 14px 40px rgba(0,0,0,.5);overflow:hidden;position:absolute;right:0;bottom:64px}",
      ".panel.open{display:flex}",
      ".hd{display:flex;align-items:center;gap:8px;padding:9px 12px;background:#25262c;cursor:move;user-select:none}",
      ".hd b{font-weight:600;font-size:13px}",
      ".dot{width:7px;height:7px;border-radius:50%;background:#8a8f98;flex:none}",
      ".dot.ok{background:#3ecf8e}.dot.bad{background:#f2555a}",
      ".sp{flex:1}",
      ".hd button{background:transparent;border:0;color:#9aa0aa;cursor:pointer;font-size:12px;padding:2px 6px;border-radius:5px}",
      ".hd button:hover{background:#33353d;color:#e8e8ea}",
      ".msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:10px}",
      ".m{max-width:86%;padding:8px 11px;border-radius:10px;white-space:pre-wrap;word-break:break-word}",
      ".m.u{align-self:flex-end;background:#3a4a7a}",
      ".m.a{align-self:flex-start;background:#2a2c33}",
      ".m.s{align-self:center;background:transparent;color:#8a8f98;font-size:12px;padding:0}",
      ".ft{border-top:1px solid #33353d;padding:9px;display:flex;flex-direction:column;gap:7px;background:#202127}",
      ".row{display:flex;align-items:center;gap:8px;font-size:12px;color:#9aa0aa}",
      ".st{font-size:12px;color:#8a8f98;min-height:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
      ".st.busy{color:#8fb4ff}",
      "textarea{width:100%;height:62px;resize:none;background:#16171b;color:#e8e8ea;border:1px solid #33353d;",
      "border-radius:8px;padding:8px;font:13px/1.5 inherit;outline:none}",
      "textarea:focus{border-color:#4f7cff}",
      ".send{align-self:flex-end;background:#4f7cff;border:0;color:#fff;padding:5px 16px;border-radius:7px;cursor:pointer;font-size:13px}",
      ".send:disabled{opacity:.5;cursor:default}",
      "label{display:flex;align-items:center;gap:5px;cursor:pointer}",
      "</style>",
      '<div class="wrap">',
      '<div class="panel" id="p">',
      '<div class="hd" id="hd"><span class="dot" id="dot"></span><b>DSH 智能体</b><span class="sp"></span>',
      '<button id="clr" title="清空对话">清空</button><button id="cls" title="收起">收起</button></div>',
      '<div class="msgs" id="msgs"></div>',
      '<div class="ft">',
      '<div class="st" id="st"></div>',
      '<textarea id="q" placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"></textarea>',
      '<div class="row"><label><input type="checkbox" id="ctx" checked> 带上当前页文本</label><span class="sp"></span>',
      '<button class="send" id="send">发送</button></div>',
      "</div>",
      "</div>",
      '<div class="bubble" id="bub">DSH</div>',
      "</div>",
    ].join("");

    var $ = function (id) {
      return root.getElementById ? root.getElementById(id) : root.querySelector("#" + id);
    };
    var panel = $("p");
    var msgs = $("msgs");
    var input = $("q");
    var sendBtn = $("send");
    var dot = $("dot");
    var useCtx = $("ctx");
    var bubble = $("bub");
    var statusEl = $("st");

    var history = loadHistory();
    history.forEach(function (h) {
      addMsg(h.role === "user" ? "u" : "a", h.content);
    });

    function addMsg(kind, text) {
      var d = document.createElement("div");
      d.className = "m " + kind;
      d.textContent = text;
      msgs.appendChild(d);
      msgs.scrollTop = msgs.scrollHeight;
      return d;
    }

    function setDot(state, title) {
      dot.className = "dot" + (state ? " " + state : "");
      dot.title = title || "";
    }

    async function ping() {
      try {
        var r = await fetch(baseUrl() + "/health", { cache: "no-store" });
        setDot(r.ok ? "ok" : "bad", r.ok ? "网关正常" : "网关异常 HTTP " + r.status);
      } catch (e) {
        setDot("bad", "网关没在运行：先跑 start-gateway.cmd / koodo-dsh 启动器");
      }
    }

    async function submit() {
      var text = input.value.trim();
      if (!text) return;
      input.value = "";
      addMsg("u", text);
      history.push({ role: "user", content: text });

      var question = text;
      if (useCtx.checked) {
        var c = grabContext();
        if (c) question = "我正在读的这本书里有这样一段内容：\n\n" + c + "\n\n我的问题：" + text;
      }

      sendBtn.disabled = true;
      var target = addMsg("a", "…");
      var acc = "";
      var gotText = false;
      var startedAt = Date.now();
      var lastProgress = { phase: "start" };

      // 秒表 + 进度：智能体连跑几十个工具步骤时，正文可能很久不出一句话
      function renderStatus() {
        var secs = Math.round((Date.now() - startedAt) / 1000);
        var s;
        if (gotText) {
          s = "输出中 · " + secs + "s";
        } else if (lastProgress.phase === "tool") {
          s = "第 " + (lastProgress.step || "?") + " 步 · " + (lastProgress.tool || "");
          if (lastProgress.summary) s += "：" + lastProgress.summary;
          s += " · " + secs + "s";
        } else {
          s = "已发送，智能体启动中… · " + secs + "s";
        }
        statusEl.textContent = s;
        statusEl.title = s;
        statusEl.className = "st busy";
      }
      renderStatus();
      var tick = setInterval(renderStatus, 1000);

      try {
        await askStream(
          question,
          function (d) {
            gotText = true;
            acc += d;
            target.textContent = acc;
            msgs.scrollTop = msgs.scrollHeight;
            renderStatus();
          },
          function (p) {
            lastProgress = p || {};
            renderStatus();
          }
        );
        if (!acc) target.textContent = "（智能体没有返回内容）";
        statusEl.textContent = "完成 · 用时 " + Math.round((Date.now() - startedAt) / 1000) + "s";
        statusEl.className = "st";
        history.push({ role: "assistant", content: acc });
        saveHistory(history);
        setDot("ok", "网关正常");
      } catch (e) {
        target.textContent = "出错了：" + (e && e.message ? e.message : String(e));
        statusEl.textContent = "";
        setDot("bad", "请求失败");
      } finally {
        clearInterval(tick);
        sendBtn.disabled = false;
        input.focus();
      }
    }

    bubble.addEventListener("click", function () {
      panel.classList.toggle("open");
      if (panel.classList.contains("open")) {
        ping();
        input.focus();
      }
    });
    $("cls").addEventListener("click", function () {
      panel.classList.remove("open");
    });
    $("clr").addEventListener("click", function () {
      history = [];
      saveHistory(history);
      msgs.innerHTML = "";
    });
    sendBtn.addEventListener("click", submit);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });

    // 拖动：按住标题栏或气泡
    var drag = null;
    function startDrag(e) {
      var r = host.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, right: W.innerWidth - r.right, bottom: W.innerHeight - r.bottom };
      e.preventDefault();
    }
    ["hd", "bub"].forEach(function (id) {
      $(id).addEventListener("mousedown", startDrag);
    });
    document.addEventListener("mousemove", function (e) {
      if (!drag) return;
      host.style.right = Math.max(4, drag.right - (e.clientX - drag.x)) + "px";
      host.style.bottom = Math.max(4, drag.bottom - (e.clientY - drag.y)) + "px";
    });
    document.addEventListener("mouseup", function () {
      drag = null;
    });

    S.panelReady = true;
    ping();
  }

  /* ------------------------------------------------------------------ */
  /* 注册 Koodo 的两个钩子                                                */
  /* ------------------------------------------------------------------ */

  // 划词翻译：Koodo 调用 window.translate(text, 源语言, 目标语言, axios, config) → Promise<string>
  W.translate = async function (text, from, to, axios, config) {
    if (config && config.endpoint) S.endpoint = config.endpoint;
    ensurePanel();
    var q =
      "把下面这段文字翻译成" + (to || "中文") + (from ? "（源语言：" + from + "）" : "") +
      "。只输出译文本身，不要解释、不要加引号或前缀。\n\n" + text;
    return await askOnce(q);
  };

  // 划词查词：Koodo 调用 window.getDictText(text, 源, 目标, axios, t, config) → 释义字符串
  W.getDictText = async function (text, from, to, axios, t, config) {
    if (config && config.endpoint) S.endpoint = config.endpoint;
    ensurePanel();
    var q =
      "你是一本阅读词典。解释下面这个词或短语（目标语言：" + (to || "中文") + "），" +
      "用 Markdown 给出：读音、词义、例句、用法提示。简洁一点。\n\n" + text;
    return await askOnce(q);
  };

  // 脚本一执行就把面板准备好（这样划一次词，面板就位）
  ensurePanel();
  try {
    console.log("[DSH] Koodo 插件已加载，网关：" + baseUrl());
  } catch (e) {}
})();
