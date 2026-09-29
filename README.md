# glm-bridge

Use your **Z.ai GLM** subscription (from the ZCode desktop app) from **opencode, omp, claude code, or any OpenAI/Anthropic client** — locally, then optionally through [9router](https://github.com/9router) so every harness can share it.

The bridge drives ZCode's own agent CLI over its internal protocol and calls a raw completion primitive, so **tool calling works normally** — the model returns tool calls to your harness, it does not run tools itself.

## Quick start

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/Hadixel/glm-bridge/main/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/Hadixel/glm-bridge/main/install.ps1 | iex
```

Both install to `~/.glm-bridge`, put `glm-bridge` on your PATH, start it at
login (systemd user unit on Linux, Scheduled Task on Windows), and register it
with a local 9router if one is running.

Requirements: **Node 22+** (the ZCode CLI needs `node:sqlite`), a **ZCode
desktop login**, and Playwright Chromium for captcha minting (the installer
handles it).

## Control

```bash
glm-bridge start      # start in background (idempotent)
glm-bridge stop       # stop, including any stale instance holding the port
glm-bridge restart
glm-bridge status     # running/stopped + readiness
glm-bridge logs 100   # last N log lines
glm-bridge run        # run in foreground
```

Windows uses `glm-bridge.cmd` with the same subcommands.

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
(the upstream captcha layer rejects duplicate concurrent submits).

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

## How it works

1. ZCode stores credentials `enc:v1:` (AES-256-GCM) with a key derived from a
   machine-local fallback secret. The bridge decrypts `zcodejwttoken` and
   re-reads it every 60 s, so a ZCode re-login is picked up automatically.
2. Entitlements (`provider/updateAccountConfig`) are parsed from the desktop's
   own log, so plan changes propagate.
3. The upstream WAF requires a per-request Aliyun captcha device token. Tokens
   are minted headlessly for ZCode's captcha scene, pooled in `tokens.json`,
   and refilled automatically (see `mint-captcha.js`).
4. The upstream WAF also requires ZCode's identity line as `system[0]` and its
   preamble as `system[1]`. The bridge prepends them (`sysblocks.json`), then
   your own system prompt follows.

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
| `captcha token pool exhausted` | first mint takes ~20 s; see logs, ensure Chromium is present |
| HTTP 401 from upstream | ZCode session expired — open ZCode once to re-login |
| HTTP 405 `code 3012` | WAF rejected the request; restart the bridge to refresh the captcha pool |
| empty reply, then ok | first request after start triggers captcha minting |

## Security

The bridge binds to `127.0.0.1` only and requires an API key. It reads your
ZCode credentials from their existing encrypted store; nothing is uploaded.

## License

MIT
