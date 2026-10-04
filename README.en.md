# koodo-dsh-agent

[![MIT license](https://img.shields.io/github/license/PensiveFei/koodo-dsh-agent)](https://github.com/PensiveFei/koodo-dsh-agent/blob/main/LICENSE)
[![release](https://img.shields.io/github/v/release/PensiveFei/koodo-dsh-agent)](https://github.com/PensiveFei/koodo-dsh-agent/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/PensiveFei/koodo-dsh-agent/ci.yml)](https://github.com/PensiveFei/koodo-dsh-agent/actions/workflows/ci.yml)

Bring the [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (DSH) **agent**
into [Koodo Reader](https://github.com/koodo-reader/koodo-reader).

Not another translation plugin — an agent that can **read and write files, run commands, and use tools**,
living inside your e-reader.

```
select text / open the panel in Koodo
        │
        ▼
  floating agent panel  ──HTTP──▶  local gateway  ──stdio JSON-RPC──▶  DSH agent
  (injected by the plugin)         (Node)                            (tools / files / subagents)
```

## Showcase

| ![real-machine screenshot 1](https://raw.githubusercontent.com/PensiveFei/koodo-dsh-agent/main/docs/showcase/showcase-1.png) | ![real-machine screenshot 2](https://raw.githubusercontent.com/PensiveFei/koodo-dsh-agent/main/docs/showcase/showcase-2.png) |
| --- | --- |
| Real-machine screenshot ① | Real-machine screenshot ② |

## What it does

- **Floating agent panel** — streaming replies, draggable, chat history kept locally; the current page text is attached to your question by default, so "what does this passage mean?" just works
- **Selection translate / dictionary handled by the agent** — you get the agent's answer, not machine translation
- **Visible progress** — while the agent runs tools the panel shows `step N · tool: what it is doing · elapsed`
- **Always on** — after starting through the launcher the panel is there from launch, and it survives Koodo's renderer reload when you go back to the bookshelf
- **Interrupted turns are recovered** — questions and answers are persisted as they happen; if the page is
  reloaded mid-turn (the agent does that itself to verify writes), the panel asks the gateway for that
  turn's answer on its next injection and marks it as recovered
- **Non-invasive** — no file inside Koodo is modified; remove the launcher and you are back to stock Koodo

## How it works

### 1. Koodo's AI seam is an OpenAI-compatible endpoint

Reversed from Koodo 2.4.3's `app.asar`:

- `POST {endpoint}/chat/completions`, header `Authorization: Bearer {apiKey}`
- body `{ model, messages, stream: true }`, **SSE**, reading `choices[0].delta.content`, terminated by `data: [DONE]`
- the settings **Test** button uses the **non-streaming** shape (`choices[0].message.content`)
- history is sliced to the **last 5 messages**; built-in providers include `ollama` / `lmstudio` / `vllm` pointing at localhost with no API key — pointing Koodo at a local endpoint is an officially supported path

The gateway in this repo attaches to that seam.

### 2. Koodo plugins execute code

"Add custom plugin" accepts a **JSON object**; its `script` field is run with
`eval(plugin.script)` **in the renderer**. Installation validates exactly one thing:

```
SHA256(UTF-8(script)) === scriptSHA256      // lowercase hex; no signature, no allowlist
```

Only three plugin types execute scripts, each calling one global function:

| type | script registers | Koodo calls |
| --- | --- | --- |
| `translation` | `window.translate` | `(text, from, to, axios, config) => Promise<string>` |
| `dictionary` | `window.getDictText` | `(text, from, to, axios, t, config) => Promise<string>` |
| `voice` | `window.getTTSVoice` | `(config) => voice list` |

This project registers both `translation` and `dictionary`.

### 3. Staying resident uses a per-document CDP hook

Plugin scripts only run **when the plugin is used** — there is no startup hook. Worse, when Koodo
returns from the reader to the bookshelf it calls `mainWin.reload()` (the `reload-main` IPC in the
main process), **reloading the whole renderer**, which wipes any injected DOM or script.

So the launcher starts Koodo with a **loopback debug port**, and a supervisor injects the panel via
CDP's `Page.addScriptToEvaluateOnNewDocument`. That hook runs on **every new document**, including the
one caused by `reload-main` — the panel is present at launch and survives navigation.

## Layout

```
├── install.mjs              installer: detect paths, build runtime, emit plugin JSON
├── koodo-plugin/
│   ├── script.js            the panel script (UI + the two hooks)
│   └── plugin-format.mjs    plugin format rules and validation (shared with tests)
├── gateway/
│   └── gateway.mjs          OpenAI-compatible gateway ⇄ DSH stdio JSON-RPC SDK
├── launcher/
│   └── launch.mjs           supervisor: gateway + Koodo with debug port + CDP injection
├── tests/
│   ├── check.mjs            offline checks (what CI runs)
│   └── hook-test.mjs        hook end-to-end test (hits the gateway with --live)
└── docs/
    ├── ARCHITECTURE.md      mechanics and the dead ends
    └── showcase/            screenshots used by the README
```

Everything generated at install time lands in the **runtime directory** (default `~/.koodo-dsh-agent/`):

```
~/.koodo-dsh-agent/
├── config.json             all paths and ports
├── panel.js                panel script (generated with your gateway URL)
├── gateway.mjs
├── launch.mjs
├── plugin-translation.json  ★ paste this into Koodo
├── plugin-dictionary.json   optional
├── koodo-dsh.cmd            launcher (Windows)
├── start-gateway.cmd        gateway only
├── workspace/               default agent working directory
└── supervisor.log
```

## Platforms

| Platform | Status |
| --- | --- |
| Windows | **Verified** (Koodo 2.4.3 + DSH desktop 0.2.0-rc.2 + Node 24) |
| macOS / Linux | The installer branches for these platforms, but they are **untested**. Resident injection relies on Electron's debug port and should work; without it you can still use "wake by selecting text" |

## Requirements

- **Koodo Reader 2.4.x desktop** (verified on 2.4.3)
- **DSH desktop** as the agent backend. The installer creates a separate profile from the official
  `sdk` template (default name `koodo-gw`) and **leaves your existing profiles alone**
- **Node.js 22+** (the gateway and the supervisor; resident injection uses the global `WebSocket`,
  which only became stable in Node 22)

## Install

```bash
git clone https://github.com/PensiveFei/koodo-dsh-agent.git
cd koodo-dsh-agent
node install.mjs
```

The installer detects Koodo and DSH, creates the DSH profile, writes the runtime files into
`~/.koodo-dsh-agent/`, and generates both plugin JSONs with freshly computed SHA-256 hashes —
validating them along Koodo's own check path.

```bash
node install.mjs --koodo "D:\Koodo Reader\Koodo Reader.exe"
node install.mjs --dsh    "F:\DSH"
node install.mjs --agent-cwd "D:\MyNotes"
node install.mjs --dir    "D:\koodo-dsh"
node install.mjs --clip              # also copy the plugin JSON to the clipboard
node install.mjs --shortcut          # also create a desktop shortcut
```

## Quick start (~5 minutes)

1. **Install the plugin**: Koodo → Settings → Plugins → Add new plugin → paste the **entire contents**
   of `~/.koodo-dsh-agent/plugin-translation.json` → Confirm
2. **Launch**: run `~/.koodo-dsh-agent/koodo-dsh.cmd` (or the desktop shortcut). It starts the gateway,
   launches Koodo with the debug port, and injects the panel
3. **Use it**: a `DSH` bubble appears bottom-right; select text and hit translate to get the agent's answer

> Without the launcher, Koodo stays stock: the plugin is still installed, but the panel only appears
> after the first selection-translate (plugin scripts run on use), and again after returning to the bookshelf.

## Usage

- The bubble is draggable; the dot in its header is **green when the gateway is reachable, red otherwise**
- Enter sends, Shift+Enter inserts a newline
- "Attach current page text" is on by default — it sends your selection, or the visible page text
  pulled from the EPUB/PDF iframe
- The status line shows live progress: `step 21 · pwsh: Apply author fills · 34s`

Set `agentCwd` in `config.json` to control what the agent can reach (default `~/.koodo-dsh-agent/workspace`).
Point it at your Obsidian vault to have the agent work on your notes.

### Gateway endpoints

`GET /health`, `GET /v1/models`, `POST /v1/chat/completions` (streaming and non-streaming),
`POST /koodo/reset`, `POST /koodo/shutdown`.

### Environment overrides (take precedence over config.json)

`KOODO_GW_PORT`, `KOODO_GW_CWD`, `KOODO_GW_MODEL`, `KOODO_GW_PROVIDER`, `KOODO_GW_PERMISSION`,
`DSH_EXE`, `DSH_CLI`, `KOODO_DSH_DEBUG_PORT`, `KOODO_GW_VERBOSE=1`

## Why not the official plugin market

The official plugin list (`api.koodoreader.com/api/get_plugins`) has 37 plugins — 11 translation,
13 dictionary, 13 TTS — and **no agent or chat plugin**. Koodo's own AI stops at one-shot Q&A
(translation, dictionary, assistant) with **no tool calling and no filesystem access**.

The closest prior art is Obsidian's [Claudian](https://github.com/YishenTu/claudian) — embedding an
agent into a writing environment.

## Gotchas

Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). The three that cost the most time:

1. **A plugin JSON without `icon` fails silently.** Koodo writes plugins through SQLite named
   parameters; a missing field raises `RangeError: Missing named parameter "icon"`, and the install
   handler has no `try/catch` — the UI simply does nothing.
2. **A `JSON.parse` failure is silent too.** Pasting a PowerShell command instead of JSON yields
   `SyntaxError: Unexpected token 'G', "Get-Conten"...` and still no visible reaction. The generated
   plugin JSON is therefore deliberately **pure ASCII with zero escapes**, and is validated at install time.
3. **Dropping a patched `main.js` into `app.asar.unpacked` does nothing.** Electron's asar layer reads
   files according to the header's `unpacked` flag. `NODE_OPTIONS=--require` does not work either —
   Electron only allows a whitelist and `--require` is not on it. The per-document CDP injection is what
   actually works.

**Where to look when Koodo does nothing**: it writes renderer console output to
`%APPDATA%\koodo-reader\logs\debug.log`. Both silent failures above were found there.

## Security and privacy

Two things you must know:

1. **The agent runs with `danger-full-access` by default.** In a headless turn there is nobody to answer
   approval prompts, so with `workspace-write` every approval-gated tool call would fail closed. This
   means it **can read and write outside `agentCwd` and execute commands**. If that is not acceptable,
   set `permission` to `workspace-write` in `config.json` and accept that some tools will not work.
2. **Plugin scripts are `eval`ed in Koodo's renderer**, which has Node integration — equivalent to
   arbitrary code execution. That is Koodo's plugin design, not this project's choice. Only paste JSON
   from sources you trust.

Also: the gateway binds to `127.0.0.1`, the debug port is loopback-only (Electron's default), and
**neither authenticates** — any local process can call the gateway or drive Koodo's renderer through the
debug port. That is the price of the resident mode. Chat history lives in Koodo's `localStorage`; the
gateway stores nothing, but DSH persists its own sessions under `~/.dsh/sessions/`.

## Development

```bash
node tests/check.mjs               # offline: syntax, plugin format, path-leak scan (CI)
node tests/hook-test.mjs           # offline: script evaluates, is idempotent, hooks registered
node tests/hook-test.mjs --live    # live: real translate / dictionary / streaming + progress
```

After editing `koodo-plugin/script.js` you do **not** need to reinstall the plugin: the pasted `script`
is only a bootstrap that reads `panel.js` from disk on each use. Just re-run `node install.mjs` to copy
the updated script into the runtime directory.

## License

[MIT](LICENSE)
