# J.A.R.V.I.S.

A browser voice assistant with an Iron Man holographic interface. Say
**"Hey Jarvis"**, he wakes, listens, and does real things through your tools —
searches the web, generates images, drives your phone, reads your mail. The face
is a web page (React + Vite + Three.js + custom GLSL). The brain is Claude Code,
run headless as a library.

**The only subscription you need is Claude Code.** No API keys, no OpenAI
account, no cloud bill — the brain runs on your existing Claude Code login, and
the heavy work (the model itself) runs on Anthropic's servers, so even a low-end
laptop only has to draw the interface. **ElevenLabs is an optional add-on** that
gives JARVIS a much better voice and sharper hearing; without it he speaks and
listens through the browser's own speech, and everything still works.

---

## Requirements

**In one line:** a Claude Code subscription, plus two free things every computer
can have — Node.js and Chrome. That's the whole list.

- **Claude Code, installed and logged in** — this is the only account you need.
  Install it with the official method — `npm install -g @anthropic-ai/claude-code`,
  or the platform installer at <https://docs.claude.com/en/docs/claude-code> —
  then run `claude` once and complete login. The bridge reuses that login. **No
  API key**, and usage is billed to your existing Claude account.
- **Node.js 20 or newer** — free, one installer from <https://nodejs.org>. This
  is a Node web app, so it is the one unavoidable tool.
- **Google Chrome or Microsoft Edge**, in a **real browser window** — not an
  embedded preview pane. Preview panes (including the one inside editors and
  Claude Code) block microphone access, so the page loads and looks right but
  never hears you. JARVIS also needs WebGL, which these browsers provide.
- **Optional: an ElevenLabs API key** — a good add-on, not a requirement. It
  gives a better voice and sharper transcription; the free tier is plenty for a
  demo. Without it, everything runs on the browser's own speech.

Run `npm run setup` after cloning and it checks all of this for you, in plain
language.

---

## Quick start

First, install, then start it:

```bash
npm install
npm start          # runs the brain and the face together
```

Then open the URL it prints (http://localhost:5173) in **Chrome**, click **INITIALISE**, and say **“Hey Jarvis”**.

Prefer two terminals? Run them separately instead:

```bash
npm install
```

Terminal 1 — the brain:

```bash
npm run bridge
```

Terminal 2 — the face:

```bash
npm run dev
```

Then open the app in a **real Chrome or Edge window**:

```bash
open http://localhost:5173
```

Click **INITIALISE**, allow the microphone when asked, and say **"Hey Jarvis"**.

> It has to be a real browser window. Embedded preview panes block the
> microphone, so JARVIS will look perfectly alive and simply never respond.

---

## How it works

JARVIS is two processes. The browser is the face and the voice; the bridge is
the brain and the hands.

```
  ┌─ browser (the face) ───────────────┐        ┌─ bridge (the brain) ─────────────┐
  │  "Hey Jarvis" wake word            │        │  Node · bridge/server.mjs        │
  │  local VAD  →  speech to text      │   ws   │  Claude Agent SDK                │
  │  reactor UI (Three.js + GLSL)      │◄─────► │   = Claude Code, headless        │
  │  text to speech                    │  8787  │  spawns your MCP servers         │
  │  heads-up display                  │        │  permission gate (decideTool)    │
  └────────────────────────────────────┘        └──────────────────────────────────┘
```

Everything you see and hear happens in the browser. The bridge is a single Node
process (`bridge/server.mjs`) that runs the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`) — this spawns the real `claude` CLI as a child
process, so **the brain literally is Claude Code, headless.** They talk over a
WebSocket (plus a few HTTP endpoints) on `ws://localhost:8787`.

**Why a bridge at all?** A browser tab cannot spawn the local stdio MCP servers —
`higgsfield`, `elevenlabs`, `android`, `playwright`, `exa`, `serper`, and the
rest. The bridge can. And because it is the Agent SDK, it authenticates off your
existing Claude Code login: no API key, billed to that same Claude account.

**The model.** `claude-opus-5` at effort `medium` by default. Override with the
`JARVIS_MODEL` and `JARVIS_EFFORT` environment variables. On startup the bridge
prints its choice, e.g. `[jarvis] model claude-opus-5 · effort medium`.

### The voice pipeline

The loop is designed so that nothing silently dies and barge-in feels natural.

- **Detection is local.** An energy-based voice-activity detector
  (`src/lib/vad.ts`) decides when you are speaking. It is instant, cannot quietly
  fail, and is what makes **barge-in** work — speak while JARVIS is talking and he
  stops.
- **Transcription has two tiers, chosen automatically at boot.** The browser asks
  the bridge `/health` and picks the best available:
  - **ElevenLabs key present** → ElevenLabs Scribe, via the bridge `/stt` endpoint.
  - **Nothing configured** → the browser's own `SpeechRecognition` (Chrome/Edge),
    guarded by a heartbeat so it recovers when Chrome throttles it.
- **Speaking** uses the **ElevenLabs voice when a key is present**, and the
  browser's `speechSynthesis` otherwise. If a cloud call fails it falls back to
  the browser voice, and if the OS voice itself is broken it latches over to the
  cloud voice.

So it works with no keys and auto-upgrades when a key appears — there is no flag
to set. Capability detection lives in `src/lib/capabilities.ts`, which probes the
bridge's `GET /health` (returning `{ ok, tts, stt }`, both tracking the
ElevenLabs key) once at boot and picks the engines.

---

## What JARVIS can do

Beyond answering, JARVIS reaches every MCP server in your Claude Code
configuration, and can drive his own interface.

### Your tools

Every server in your `~/.claude.json` is handed to the SDK explicitly, or only the
ones you name in `JARVIS_MCP_SERVERS`. Depending on what you have installed, that
is roughly:

- **Web & search** — `exa`, `serper`, `serpapi`
- **Images & video** — `higgsfield`, `openrouter-image`, `palmier-pro`
- **Voice** — `elevenlabs`
- **Your phone** — `android`
- **The browser** — `playwright`

A few things you can say:

- *"What's happening in AI this week?"*
- *"Generate an image of the Mark VII suit."*
- *"Take a screenshot of my phone."*
- *"Open my GitHub notifications."*

> **Note on account connectors.** Servers you added through your **claude.ai
> account** (mail, drive, calendar and other account connectors) are not in `~/.claude.json`,
> but the CLI fetches them on its own and they join the session from the second
> turn. The bridge keeps them out by default; set `JARVIS_ACCOUNT_CONNECTORS=1`
> to let them in, and `JARVIS_MCP_SERVERS` to choose which `~/.claude.json`
> servers JARVIS gets.

### JARVIS controls the interface

He drives the UI through MCP tools the bridge exposes:

- `ui_theme` — accent, background, per-phase colours
- `ui_reactor` — colour, scale, intensity, spin, and style (`ring` | `sphere` | `wire`), visibility
- `ui_orbit` — put images in orbit around the reactor
- `ui_chrome` — show or hide rails, transcript, badges
- `ui_effect` — `glitch` | `pulse` | `scan` | `shake` | `flash`
- `ui_screen` — clear
- `ui_reset` — back to defaults

So *"make it red, hide the systems list, put that render in orbit"* is a spoken
command.

### The heads-up display

JARVIS authors panels with a `display` tool against a fixed `.hud-*` design
system. The browser sanitises the markup (DOMPurify, a class allowlist and a
strict CSP) before rendering. Rich media works — images, `<video>`, and
YouTube/Vimeo embeds. Remote images and video are fetched **server-side** through
the bridge (`/img` and `/media`, both SSRF-guarded), so hotlink-blocked news
thumbnails still appear and the page never beacons your IP to a host the model
chose.

---

## Controls

| Key / phrase | Does |
|---|---|
| **"Hey Jarvis"** | Wake him |
| **Space** | Talk without the wake word |
| Just speak | Interrupt him mid-sentence (barge-in) |
| **V** | Cycle the browser voice |
| **Escape** | Stand down |
| **D** | Live diagnostics panel |
| **T** | One-line audio self-test |

---

## The boot sequence

Power-up plays a four-beat Iron Man start-up (`src/ui/Boot.tsx`): an
"INITIATING SYSTEM" status bar with a segmented progress bar and boot log; then
concentric reticle rings resolving into "J.A.R.V.I.S"; then a suit schematic;
then the triangular arc reactor lighting up — with a start-up sound under it
(`public/audio/boot-music.mp3`).

---

## Configuration

Everything is optional in bridge mode. Frontend settings live in `.env.local`
(copy `.env.example`); bridge settings are environment variables.

> Building for GitHub Pages? It needs two settings the local flow does not:
> `VITE_BASE=/<repo>/` and a decision about the key. See
> [Deploying to GitHub Pages](#deploying-to-github-pages).

### Bridge

| Variable | Default | Effect |
|---|---|---|
| `JARVIS_BRIDGE_PORT` | `8787` | Port for the WebSocket + HTTP endpoints |
| `JARVIS_BRIDGE_HOST` | `127.0.0.1` | Interface to listen on. Any other address puts the agent on your network |
| `JARVIS_ALLOWED_HOSTS` | none | Extra hostnames the bridge answers to; a request for any other name gets a 403 |
| `JARVIS_MODEL` | `claude-opus-5` | Model to run |
| `JARVIS_EFFORT` | `medium` | Reasoning effort |
| `JARVIS_ALLOW_WRITES` | off | `1` allows effectful tools (see below) |
| `JARVIS_MCP_SERVERS` | all configured | Comma-separated `~/.claude.json` servers to pass on; empty passes none |
| `JARVIS_ACCOUNT_CONNECTORS` | off | `1` lets your claude.ai account's connectors join the session |
| `JARVIS_DISABLE` | none | Comma-separated capabilities to leave out: `browser`, `camera`, `interface` |
| `JARVIS_ALLOWED_ORIGINS` | local dev | Extra WebSocket origins to accept |
| `JARVIS_ALLOW_NO_ORIGIN` | off | Accept connections with no `Origin` header |
| `JARVIS_WORKSPACE` | `~/.jarvis/workspace` | The agent's working directory; file tools are confined to it and the temp directory |
| `JARVIS_FILE_ROOTS` | none | Extra folders the file tools and the `/file` endpoint may use |
| `JARVIS_KEEP_TRANSCRIPTS` | off | `1` keeps the SDK's session transcripts in `~/.claude/projects` |
| `JARVIS_CLAUDE_EXECUTABLE` | bundled CLI | Run the agent through this executable instead, e.g. a sandbox wrapper that execs the real CLI |
| `JARVIS_CHROME_PIPE` | none | WSL only: the Windows pipe name the browser relay connects to |
| `JARVIS_DEBUG` | off | `1` logs every agent message to the bridge terminal, answer text and tool calls included |
| `JARVIS_VOICE_ID` | none | ElevenLabs voice id |
| `ELEVENLABS_API_KEY` | none | Optional; enables the ElevenLabs voice + Scribe |

### Frontend (`.env.local`)

| Variable | Effect |
|---|---|
| `VITE_BACKEND` | `bridge` (default) or `direct` |
| `VITE_BRIDGE_URL` | Where to reach the bridge |
| `VITE_TTS_ENGINE` | `system` or `kokoro` |
| `VITE_KOKORO_VOICE` | Voice for the Kokoro engine |
| `VITE_USE_ELEVENLABS` | Force the ElevenLabs voice on |
| `VITE_ANTHROPIC_API_KEY` | Direct mode only |

### Adding an ElevenLabs key

You do not have to touch a flag. Either:

- Set `ELEVENLABS_API_KEY` on the bridge before starting it, **or**
- Add the key to your `elevenlabs` MCP server's env in `~/.claude.json` — the
  bridge reads it from there too.

Either way, `/health` starts reporting the capability, the browser picks it up on
the next boot, and both the voice and transcription upgrade automatically.

---

## Enabling actions

The tool gate starts **read-only**. Search, generation and lookups run freely;
anything effectful — send, tap, delete, install, pay — is denied. Voice is a poor
interface for a confirmation dialog, so the decision is made ahead of time, in
`decideTool()` in `bridge/policy.mjs`. The bridge sets
`settingSources: []`, which makes its own gate the only authority — filesystem
settings and any global `bypassPermissions` cannot override it.

A `PreToolUse` hook applies that policy to every call, including the reads the
Claude Code CLI would otherwise approve by itself. In read-only mode the agent
has no shell, and its file tools reach only its workspace (`~/.jarvis/workspace`),
the temp directory and any folders in `JARVIS_FILE_ROOTS`. Paths that hold
credentials, such as `~/.ssh`, `~/.claude` and `.env` files, stay refused even
inside those folders.

To allow effectful tools (phone, browser driving, sending), run the bridge this
way instead:

```bash
npm run bridge:writes
```

The script passes `--writes` to the bridge, so it works in Windows `cmd` and
PowerShell too. With `npm start`, use `npm start -- --writes`. Writes add `Bash`,
`Write`, `Edit` and `NotebookEdit` to the agent's tools. The file tools stay
inside the same folders; the shell can reach anything your user account can.

> Read `decideTool()` before you do. *"Hey Jarvis, clean up my downloads folder"*
> means something rather different with writes enabled.

---

## Troubleshooting

**I can't hear him, or he can't hear me.** Press **D** for the diagnostics panel
— it states plainly whether he is hearing you and whether he is producing sound.
Press **T** for a one-line audio self-test.

**No voice at all.** You must be in **Chrome or Edge**, in a **real browser
window** (not an embedded preview), and you must have **allowed the microphone**.

**Bridge not reachable.** Check that `npm run bridge` is still running in its
terminal, and that nothing else is holding port `8787`. If the port is taken,
the bridge says so in one line at startup and exits. It listens on `127.0.0.1`
only. Reaching it from another machine takes `JARVIS_BRIDGE_HOST` and
`JARVIS_ALLOWED_HOSTS`, and your own authentication in front of it first.

**Browser control on Windows.** The bridge finds the Claude extension's named
pipe, `\\.\pipe\claude-mcp-browser-bridge-<user>`, by itself. If the boot log
says the extension is not running, open Chrome with the extension signed in.
Each browser request looks for the pipe again, so the bridge does not need a
restart.

**Running the bridge in WSL, with Chrome on Windows.** Browser control works:
the Windows native host exposes a named pipe rather than a Unix socket, and the
bridge reaches it through a short PowerShell relay (WSL interop must be on,
which it is by default). Open the app at `http://127.0.0.1:5173` if
`localhost` is slow to load — Windows tries IPv6 loopback first, and WSL does
not forward it.

---

## Deploying to GitHub Pages

The repository ships two workflows in `.github/workflows/`:

- `deploy.yml` — on every push to `main`, builds the app and publishes `dist/`
  to Pages at `https://<owner>.github.io/<repo>/`.
- `ci.yml` — lint, tests and a build on every pull request, and on `main`.

### One-time setup

1. **Settings → Pages → Source: GitHub Actions.** Nothing deploys until this is
   set; the deploy step fails with a 404 from the Pages API otherwise.
2. **Settings → Secrets and variables → Actions.** Add what you want the
   deployed page to have. Everything is optional except the key for `direct`
   mode.

| Kind | Name | Effect |
|---|---|---|
| Variable | `VITE_BACKEND` | `direct` (default in CI) or `bridge` |
| Secret | `VITE_ANTHROPIC_API_KEY` | Required for `direct` mode |
| Variable | `VITE_BRIDGE_URL` | Where the bridge is, in `bridge` mode |
| Variable | `VITE_TTS_ENGINE` / `VITE_KOKORO_VOICE` | Neural voice in the browser |
| Secret | `VITE_ELEVENLABS_API_KEY` | Better voice, costs a round trip per sentence |
| Secret | `VITE_PICOVOICE_ACCESS_KEY` | Offline wake word instead of the browser's |

A blank value is treated as unset, so an empty variable behaves exactly like a
missing one — src/config.ts is written for that.

### Read this before you use `direct` mode publicly

In `direct` mode the browser calls the Claude API itself, which is what makes a
static deploy able to answer at all. The price is that
`VITE_ANTHROPIC_API_KEY` is compiled into the public JavaScript: anyone who
opens devtools on the deployed site can read it and spend against it. Vite
inlines `VITE_*` at build time; there is no runtime secret in a static site.

If that matters, use a key made for the deploy alone, with a spend limit, and
keep the rest of your life on a different key. The MCP tokens in
`src/config.ts` are the same story and are worse — some of those URLs *are* the
credential. Leave them empty on a public deploy.

`bridge` mode has the opposite shape: no key in the bundle, but the page is only
an interface until a bridge is running. A visitor without your bridge sees the
reactor, the HUD and the boot sequence, and gets no answers. Note also that the
bridge serves `ws://localhost:8787` and only trusts local dev origins, so a
Pages page cannot reach a bridge on your machine as-is — `bridge` mode is for
local use, not for a public demo.

### What the workflow handles for you

- **The subpath.** A Pages project site is served from `/<repo>/`, so the build
  is given `VITE_BASE=/<repo>/`, taken from the repository name. Every asset URL,
  audio file and the hand-tracking WASM are resolved against it — hardcoded
  leading slashes were the thing that would otherwise have produced a blank page
  with a console full of 404s.
- **The hand-tracking runtime.** `npm run build` has a `prebuild` step that
  copies MediaPipe's WASM out of `node_modules` into the artifact. It is not in
  git (34 MB, and `.gitignore`d), so anything that builds without `npm ci`
  first will deploy a version where gesture control silently never starts.
- **`.nojekyll`** so Pages serves the `_`-prefixed and dotted files untouched,
  and `404.html` so a future route does not hard-404.
- **The CUDA download.** `onnxruntime-node`'s postinstall pulls several hundred
  megabytes of CUDA binaries on Linux/x64. The workflow sets
  `ONNXRUNTIME_NODE_INSTALL_CUDA=skip`; the browser uses the wasm build from
  `onnxruntime-web` and never loads the CUDA one.

### Checking a Pages build locally

```bash
VITE_BASE=/jarvis/ npm run build
npx vite preview          # serves dist/ — paths resolve as they will on Pages
```

Try hand control specifically. It is the one feature whose assets live outside
`assets/`, and a mistake there is silent.

---

## Free tiers, and what the models can actually do

The deploy needs *some* credential, because a static site cannot hold a secret
and a model needs a key on the server. There are three ways to pay nothing:

| Route | Cost | Tools | Trade-off |
|---|---|---|---|
| **Bridge** (`npm run bridge`) | included in Claude Code | everything, incl. local stdio | must run on your own machine; cannot be a public URL |
| **Gemini free tier** (`VITE_PROVIDER=gemini`) | $0, no card | remote MCP only, per turn | ~10–15 req/min, ~1,500/day, Flash only |
| **Anthropic** (default) | per token | everything, server-side | the bill |

### Gemini: what works, and what does not

`VITE_PROVIDER=gemini` swaps the brain to Google's Flash models through
`api/gemini`. The key stays server-side, exactly like the Anthropic proxy, and
comes free from <https://aistudio.google.com/apikey>.

The interesting part is the tool loop, because Google's API has no equivalent of
Anthropic's `mcp_servers` parameter. Anthropic dials your MCP servers from its
own infrastructure; nothing does that for Gemini. So `api/gemini` does it
itself — `api/gemini/mcp.mts` is a small MCP client (Streamable HTTP transport,
JSON-RPC handshake, `tools/list`, `tools/call`) and `api/gemini/chat.mts` runs
the call loop until the model stops asking for tools.

That has consequences worth knowing before you switch:

- **Remote HTTP servers only.** A stdio server needs a machine to run on, and a
  function is not one.
- **Tool calls happen inside the request.** Anthropic can pause a turn
  (`pause_turn`) and resume it; this cannot, so a long chain is bounded by
  `maxDuration` in vercel.json (120s) and by five rounds.
- **No hosted web search.** Anthropic's `web_search` is theirs. On Gemini, search
  arrives only if you connect a server that offers it.
- **The quota is real.** 10–15 requests a minute is comfortable for a
  conversation and thin for a demo with an audience. Hitting it produces one
  plain sentence rather than a stack trace.

### What Gemini Nano cannot do

Chrome ships Gemini Nano behind the Prompt API, and it is genuinely free and
on-device — no key, no bill. It is also not a candidate for this app, and the
reason is arithmetic rather than taste:

- **Context.** Nano takes ~4K input / 1K output. JARVIS's system prompt alone is
  250 words (~340 tokens); the last 16 turns of conversation run to 1,500–2,500;
  and the tool schemas of eight MCP servers do not fit at all. It overflows
  within a few turns.
- **Tool calling.** Not on the stable channel: it needs
  `chrome://flags/#prompt-api-tool-use`, desktop only. Without it JARVIS is a
  chatbot — no search, no phone, no `ui_*` commands.
- **Coverage.** Chrome only, capable hardware only, English only, ~2–4 GB
  download on first use.

Nano is a fine engine for summarising a page. It is not an agent, and JARVIS is
an agent.

---

## Deploying to Vercel

Vercel is the deploy that can answer, because it can hold a secret. GitHub Pages
serves files and nothing else; Vercel runs a function.

### What is different here

The app talks to Claude through `api/anthropic/[...path].ts`, a same-origin
serverless proxy. The browser posts to `/api/anthropic/v1/messages`; the function
adds the key from its environment and forwards the streaming response back.

That is the whole point: **the key never enters the JavaScript bundle.** Vite
inlines every `VITE_*` variable at build time, so a deploy using
`VITE_ANTHROPIC_API_KEY` hands the key to anyone who opens devtools. Here there
is no such variable — the bundle contains the string `/api/anthropic` and
nothing else worth stealing.

The mode is chosen by `VITE_API_ROUTE`:

| `VITE_API_ROUTE` | Key lives in | Safe to make public |
|---|---|---|
| `proxy` (default) | `ANTHROPIC_API_KEY`, server-side | yes |
| `direct` | `VITE_ANTHROPIC_API_KEY`, in the bundle | no |

With neither set, the default is `proxy` — the mode that works when someone
deploys this without reading the code first.

### Setup

1. Import `xuankhanh1612/jarvis` in Vercel. It detects Vite, `vercel.json` sets
   the build command and output directory, and nothing needs changing.
2. **Settings → Environment Variables** — add the key for **Production and
   Preview**:

   | Key | Value | Notes |
   |---|---|---|
   | `ANTHROPIC_API_KEY` | `sk-ant-…` | The only required one. Server-side only. |
   | `VITE_API_ROUTE` | `proxy` | Set for clarity; it is the default. |
   | `GEMINI_API_KEY` | `…` | Only for `VITE_PROVIDER=gemini`. Free, no card. |
   | `VITE_PROVIDER` | `anthropic` | Or `gemini`, for the free tier. |
   | `VITE_TTS_ENGINE` | `system` | Or `kokoro` for the neural voice. |
   | `VITE_ELEVENLABS_API_KEY` | `…` | Optional, better voice. |
   | `VITE_PICOVOICE_ACCESS_KEY` | `…` | Optional, offline wake word. |

3. Redeploy. Environment variables only apply to builds made after they are
   added, so an existing deployment will keep answering 500 until then.

### The proxy is deliberately narrow

It is not an open relay, and the differences matter if you are deciding whether
to trust it with a key:

- **Path allowlist.** Only `/v1/messages`, `/v1/messages/count_tokens`,
  `/v1/messages/batches` and `/v1/models` are forwarded. There is no way to use
  it to reach another part of the API.
- **Methods.** `GET`, `POST` and `DELETE` only.
- **Size.** Bodies over 1 MB are refused.
- **No CORS headers.** Same-origin by construction. Granting
  `Access-Control-Allow-Origin` would make it an open relay for anyone's bill,
  which is the problem it was built to fix.
- **Inbound credentials are dropped.** A caller-supplied `x-api-key` or
  `authorization` is discarded and the server's key is set last, so nothing
  inbound can override it.
- **No key in any response.** Upstream errors are relayed as their own bodies,
  which describe the problem without the credential.

Responses are streamed, not buffered — the app starts speaking on the first
sentence rather than the last.

### GitHub Pages, for contrast

`deploy.yml` pins `VITE_API_ROUTE=direct`, because Pages cannot serve
`/api/anthropic`. It also fails the build if a Pages artifact ever references
that path. If you deploy there, the key *is* in the bundle; use a key made for
it alone, with a spend limit.

---

## Tests

`npm test` runs the bridge's tests with Node's built-in runner. They cover the
network binding, the tool policy, the MCP server allowlist and the WSL browser
relay, which runs only under WSL. The network and allowlist tests start the
bridge on a random loopback port, and none of the tests opens an agent session.

---

## Security

The bridge's defences live in `bridge/server.mjs` and `bridge/policy.mjs`:

- It listens on `127.0.0.1` and answers only requests addressed to `localhost`,
  `127.0.0.1` or `[::1]`, which blocks DNS rebinding.
- The WebSocket accepts only local dev origins (add more with
  `JARVIS_ALLOWED_ORIGINS`).
- `/file`, `/img` and `/media` validate the scheme, confine to allowed roots,
  resolve the real path, and refuse private and loopback addresses (SSRF guard).
- The tool gate (`decideTool`) is default-deny for effectful MCP tools.
- A `PreToolUse` hook enforces the tool policy on every call. File tools stay
  inside the workspace, the temp directory and `JARVIS_FILE_ROOTS`, and
  `WebFetch` cannot reach loopback, LAN or cloud metadata addresses.
- claude.ai account connectors stay out of the session unless
  `JARVIS_ACCOUNT_CONNECTORS=1`, and `JARVIS_MCP_SERVERS` narrows which
  `~/.claude.json` servers the agent gets.
- Session transcripts are written to `~/.claude/projects` only when
  `JARVIS_KEEP_TRANSCRIPTS=1`.
- `JARVIS_DISABLE` removes browser control, the camera or the interface tools
  entirely, and `JARVIS_CLAUDE_EXECUTABLE` can run the agent inside a sandbox
  wrapper.
- A strict CSP in `index.html`; model-authored panel HTML is sanitised.

---

## Credits & licence

MIT.

The boot sound and any tracks in `public/audio/` ship with the project for the
demo. If you go on to monetise something built on this, clearing the rights to
that audio is your responsibility.
