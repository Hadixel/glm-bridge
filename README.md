# glm-bridge

Use your **Z.ai GLM** subscription (from the ZCode desktop app) from **opencode, omp, claude code, or any OpenAI/Anthropic client** — locally, then optionally through [9router](https://github.com/9router) so every harness can share it.

The bridge drives ZCode's own agent CLI over its internal protocol and calls a raw completion primitive, so **tool calling works normally** — the model returns tool calls to your harness, it does not run tools itself.

## Quick start

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/Hadixel/glm-bridge/main/install.sh | bash
```

**Windows**

In **PowerShell**:

```powershell
irm https://raw.githubusercontent.com/Hadixel/glm-bridge/main/install.ps1 | iex
```

In **cmd** — or one command that works in **both** PowerShell and cmd:

```
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/Hadixel/glm-bridge/main/install.ps1 | iex"
```

There is no `curl … | bash` equivalent on Windows: there is no `bash`,
and `curl` in PowerShell is an alias for `Invoke-WebRequest`, so the
installer is a PowerShell script piped to `iex` instead.

Both install to `~/.glm-bridge`, put `glm-bridge` on your PATH, start it at
login (systemd user unit on Linux, Scheduled Task on Windows), and register it
with a local 9router if one is running.

Requirements: **Node 22+** (the ZCode CLI needs `node:sqlite`) and a **ZCode
login**. If ZCode is missing, the installer offers to download the official
build — size shown, your consent required, installed silently (the GUI never
opens) — then offers the **terminal login** (prints a URL for any browser).
Playwright Chromium is only needed if the upstream re-enables
captcha tokens on model requests (the installer sets it up anyway).

## Control

```bash
glm-bridge start      # start in background (idempotent)
glm-bridge stop       # stop, including any stale instance holding the port
glm-bridge restart
glm-bridge status     # running/stopped + readiness
glm-bridge logs 100   # last N log lines
glm-bridge claim      # claim the daily plan for every logged-in account
glm-bridge run        # run in foreground
glm-bridge quit       # stop everything (bridge + tray), no respawn
glm-bridge tray       # show the system-tray icon (Auto-start toggle + Quit)
glm-bridge autostart  # print on|off
glm-bridge autostart-toggle
glm-bridge accounts   # list accounts (* = active)
glm-bridge login [name]     # terminal OAuth login (no ZCode GUI); creates `name` if new
glm-bridge logout [name]    # drop an account's credentials
glm-bridge use <name>       # switch the active account
```

Windows uses `glm-bridge.cmd` with the same subcommands.

### zbridge — one command for everything

`zbridge` (installed alongside `glm-bridge`) opens a mini TUI: live status,
start/stop, account list/switch, **terminal login/logout**, claim, logs,
tray, auto-start. `zbridge <args>` forwards to `glm-bridge <args>`.

### Multiple accounts (multiple × 100M/day)

Each ZCode account has its own start plan. Log in as many as you like:

```bash
zbridge                  # TUI → 6) login
glm-bridge login work2    # creates account "work2", prints OAuth URL
glm-bridge accounts       # * main  work2
glm-bridge use work2      # make it active
```

When the active account hits quota (upstream code 1005), the bridge parks it
for 24 h, rotates to the next logged-in account and retries the request
automatically. Daily claims run for every account.

### System tray

On start (Linux with `yad`, Windows via `tray.ps1`) a tray icon appears with:
**Auto-start** (toggles login autostart) and **Quit** (stops the bridge and
the tray entirely). Disable with `GLM_BRIDGE_TRAY=0`.

## Use it

Direct from any client:

| Setting | Value |
|---|---|
| Base URL | `http://127.0.0.1:3010/v1` |
| API key | printed by the installer (also in `~/.glm-bridge/config.json`) |
| Model | `GLM-5.3-Flash` |

**Anthropic clients** (claude code):

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:3010
export ANTHROPIC_AUTH_TOKEN=<your-key>
claude --model GLM-5.3-Flash
```

**opencode / omp** (`opencode.json`):

```json
{
  "provider": {
    "glmz": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:3010/v1",
        "apiKey": "<your-key>"
      },
      "models": { "GLM-5.3-Flash": {} }
    }
  }
}
```

**Through 9router** (recommended — one shared endpoint for every harness):

```
base URL: http://127.0.0.1:20128/v1
model:    glmz/GLM-5.3-Flash
key:      any 9router API key
```

## Endpoints

| Endpoint | Protocol |
|---|---|
| `GET /health` | readiness, captcha pool size (no auth) |
| `GET /v1/models` | `GLM-5.3-Flash`, `glm-5.3-flash` |
| `POST /v1/chat/completions` | OpenAI, `stream:true` supported |
| `POST /v1/messages` | Anthropic, `stream:true` supported |
| `POST /v1/messages/count_tokens` | estimate |

Tool calling is supported in both formats. Requests are serialized upstream
(the upstream rejects duplicate concurrent submits).

## Speed

GLM spends most of its wall time "thinking" before any visible text, and the
harness measures tokens/second over that whole window. The bridge therefore
defaults to the **lowest reasoning level** and lets you opt into more:

```bash
GLM_BRIDGE_REASONING=high glm-bridge restart   # low | high | max
```

Per-request overrides also work: OpenAI `reasoning_effort`, Anthropic
`thinking.budget_tokens`.

Measured on a real request: `low` ≈ 3–5 s wall, versus ~10 s at `max`.

## Daily plan auto-claim

ZCode's **Start Plan** offer (100M tokens) is offered every day around 19:30
and must be claimed, otherwise the upstream answers `exceed quota limit`
(code 1005) and every completion fails.

The bridge claims it for you:

- **At the offer time** (default `19:30` local, `GLM_BRIDGE_CLAIM_AT`), using
  `--force` so it claims even if the previous day's plan is still listed.
- **Every 15 minutes** as a self-heal: if no plan is active it tries again
  (throttled to one attempt per 10 min).

Claiming needs the desktop's Aliyun captcha flow, which only runs inside a
real browser page. `claim-plan.js` replays it in headless Chromium:

1. `GET /billing/preview` (with `X-Device-Mid`) discovers the real offer ids —
   the hardcoded `zcode-v3-start-plan` id goes stale (offers like
   `zcode-v3-start-plan-trust-1002` rotate). An **empty but answered** preview
   means nothing to claim and the script exits cleanly.
2. Mints a **traceless** token: it waits for the SDK's `getInstance` callback
   before calling `startTracelessVerification()` (calling it on a timer silently
   no-ops and forces the interactive path, whose tokens upstream rejects with
   3007). The `success`-callback param is what gets sent — same as the desktop.
3. POSTs **once** as raw JSON to `/api/v1/zcode-plan/billing/claim`. The param
   is single-use: extra encodings/retries only re-verify a consumed token and
   guarantee 3007. One fresh re-mint after a 15s rate window is the only retry.

Requirements: Playwright Chromium (`npm i playwright-core` plus
`npx playwright install chromium`). Auto-claim can be turned off with
`GLM_BRIDGE_CLAIM_DISABLE=1`.

Run `glm-bridge claim` to trigger it by hand (add `--preview` to just list
offers). If a claim ever fails with `3007 captcha verify failed`, the bridge
says so explicitly — open the **ZCode desktop app and click Claim on the 100M
tokens card**; the bridge picks the plan up within a minute. `/health` also
reports `quota`/`plan`/`action` so `zbridge` shows a loud banner when tokens
are out and exactly what to do.

## How it works

1. ZCode stores credentials `enc:v1:` (AES-256-GCM) with a key derived from a
   machine-local fallback secret. The bridge decrypts `zcodejwttoken` and
   re-reads it every 60 s, so a ZCode re-login is picked up automatically.
2. Entitlements (`provider/updateAccountConfig`) are parsed from the desktop's
   own log, so plan changes propagate.
3. Captcha tokens are only sent when ZCode's own `client/configs` says the
   upstream wants them (`configs.captcha.skip_model_request`). The flag is
   cached for 5 minutes. When tokens *are* required they are minted headlessly
   (`mint-captcha.js`) and pooled in `tokens.json`; if the upstream ever starts
   rejecting requests as `3012`, the bridge flips the policy and retries once.
   While the flag is `true` no Chromium is needed at all.
4. The upstream WAF also requires ZCode's identity line as `system[0]` and its
   preamble as `system[1]`. The bridge prepends them (`sysblocks.json`), then
   your own system prompt follows.
5. Connectivity is probed on boot (and every 5 minutes). If direct egress is
   down — common when the VPN is off — the bridge picks a local proxy
   (`http://127.0.0.1:10809` and friends) and hands it to the ZCode CLI child
   via `HTTPS_PROXY` + `NODE_OPTIONS=--use-env-proxy`, respawning the child if
   the route changes. The route in use is logged as `connectivity:`.

**The ZCode desktop app does not need to stay open.** The bridge extracts its
own copy of the ZCode CLI on first run and reuses it; the temporary AppImage
mount under `/tmp` is not required afterwards.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `GLM_BRIDGE_PORT` | `3010` | listen port |
| `GLM_BRIDGE_KEY` | auto | API key (persisted in `config.json`) |
| `GLM_BRIDGE_REASONING` | `low` | default reasoning level |
| `GLM_BRIDGE_CLI` | auto | override path to `zcode.cjs` |
| `GLM_BRIDGE_PROXY` | auto | force a proxy (`http://host:port`), or `""` to force direct |
| `GLM_BRIDGE_CLAIM_AT` | `19:30` | local time for the daily plan claim |
| `GLM_BRIDGE_TRAY` | unset | `1` default; `0` disables the system-tray icon |
| `GLM_BRIDGE_CLAIM_DISABLE` | unset | `1` disables auto-claim |
| `GLM_BRIDGE_PLAN` | `zcode-v3-start-plan` | plan id to claim |
| `GLM_BRIDGE_PW` | auto | path to `playwright-core` |
| `GLM_BRIDGE_CHROMIUM` | auto | path to a Chromium binary for minting |
| `MINT_PROXY` | none | proxy for the minting browser |
| `ZCODE_CREDENTIAL_SECRET` | fallback | override the credential secret |

## Logs & troubleshooting

```bash
glm-bridge logs 50                    # portable
journalctl --user -u glm-bridge -f    # Linux
curl http://127.0.0.1:3010/health    # ready + captcha pool
```

| Symptom | Cause / fix |
|---|---|
| `zcode.cjs not found` | ZCode not installed, or set `GLM_BRIDGE_CLI` |
| requests hang 60 s, then `Model request was cancelled` | no route to `zcode.z.ai` — see `connectivity:` in the logs; the bridge falls back to a local proxy automatically (set `GLM_BRIDGE_PROXY` to pin one) |
| `All ZCode accounts exhausted or plan inactive (1005)` | every logged-in account is out of quota — check `glm-bridge accounts` (exhausted accounts show a pause time) and `glm-bridge claim`; log in another account with `glm-bridge login <name>` |
| HTTP 503 from 9router, `/health` hangs | bridge not answering — `glm-bridge status`, then `logs`; a slow first request is normal (CLI spawn) |
| `captcha token pool exhausted` | upstream re-enabled captcha and minting failed — check Chromium, `mint-captcha.js` by hand |
| `FAILED TO PRIME device module` in logs | mint could not reach the Aliyun SDK; harmless while `skip_model_request` is `true` |
| HTTP 401 from upstream | ZCode session expired — `glm-bridge login` (terminal, no GUI) |
| HTTP 405 `code 3012` | the bridge retries once with a token; if it persists, check network to `zcode.z.ai` |

## Security

The bridge binds to `127.0.0.1` only and requires an API key. It reads your
ZCode credentials from their existing encrypted store; nothing is uploaded.

## License

MIT
