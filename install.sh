#!/usr/bin/env bash
# glm-bridge installer (Linux).
#
#   curl -fsSL https://raw.githubusercontent.com/Hadixel/glm-bridge/main/install.sh | bash
#
# Installs into ~/.glm-bridge, symlinks ~/.local/bin/glm-bridge, registers a
# systemd user service (auto-start), and optionally registers the bridge as an
# OpenAI-compatible node in a local 9router instance.
set -euo pipefail

REPO_URL="https://github.com/Hadixel/glm-bridge.git"
INSTALL_DIR="${GLM_BRIDGE_DIR:-$HOME/.glm-bridge}"
BIN_DIR="${GLM_BRIDGE_BIN_DIR:-$HOME/.local/bin}"
PORT="${GLM_BRIDGE_PORT:-3010}"
PREFIX="${GLM_BRIDGE_PREFIX:-glmz}"
NODE_NAME="${GLM_BRIDGE_NODE_NAME:-GLM Bridge (ZCode)}"
REGISTER_9ROUTER="${REGISTER_9ROUTER:-auto}"   # auto | yes | no
SERVICE=glm-bridge

say() { printf '\033[1;36m[glm-bridge]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[glm-bridge]\033[0m %s\n' "$*" >&2; exit 1; }

need_node() {
  local v ok=0
  for cand in "$(command -v node 2>/dev/null || true)" \
              "$HOME/.nvs/node/24.15.0/x64/bin/node" \
              "$HOME/.local/bin/node"; do
    [ -n "$cand" ] && [ -x "$cand" ] || continue
    v=$("$cand" -p 'process.versions.node' 2>/dev/null || echo 0)
    if [ "${v%%.*}" -ge 22 ]; then printf '%s' "$cand"; ok=1; break; fi
  done
  [ "$ok" = 1 ] || die "Node.js 22+ required (found: ${v:-none}). Install from https://nodejs.org"
}

command -v git >/dev/null 2>&1 || die "git is required"

NODE_BIN=$(need_node)
say "using node: $NODE_BIN ($("$NODE_BIN" -v))"

# ---------------------------------------------------------------- install ----
if [ -d "$INSTALL_DIR/.git" ]; then
  say "updating existing checkout in $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  say "cloning into $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

# runtime files live next to the checkout; keep symlink targets valid
for f in glm-bridge.js mint-captcha.js sysblocks.json zbridge.js tray.sh tray.py; do
  [ -f "$INSTALL_DIR/$f" ] || die "missing $f in repo"
done

# ------------------------------------------------------------ CLI shim -------
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/glm-bridge" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$INSTALL_DIR/glm-bridge.js" "\$@"
EOF
chmod +x "$BIN_DIR/glm-bridge"
say "installed CLI -> $BIN_DIR/glm-bridge"
cat > "$BIN_DIR/zbridge" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$INSTALL_DIR/zbridge.js" "\$@"
EOF
chmod +x "$BIN_DIR/zbridge"
say "installed TUI -> $BIN_DIR/zbridge"

# ------------------------------------------------- playwright for minting ----
if [ ! -d "$INSTALL_DIR/node_modules/playwright-core" ]; then
  if command -v npm >/dev/null 2>&1; then
    say "installing playwright-core (captcha minting dependency)"
    (cd "$INSTALL_DIR" && npm install --no-audit --no-fund --loglevel=error playwright-core@1.55.0) || \
      say "warn: npm install failed; set GLM_BRIDGE_PW or GLM_BRIDGE_CHROMIUM if minting fails"
  else
    say "warn: npm not found; install playwright-core manually or set GLM_BRIDGE_CHROMIUM"
  fi
fi

# ------------------------------------------------- zcode CLI bootstrap ------
# The bridge drives ZCode's own CLI (zcode.cjs). If it's missing, offer to
# download the official build — with size and explicit consent — and extract
# only the CLI (the GUI is never launched).
ZCODE_DL="${GLM_BRIDGE_ZCODE_URL:-https://cdn-zcode.z.ai/zcode/electron/releases/3.14.4/linux-x64/ZCode-3.14.4-linux-x64.AppImage}"
zcode_cli_found() {
  [ -n "${GLM_BRIDGE_CLI:-}" ] && [ -f "${GLM_BRIDGE_CLI:-}" ] && return 0
  [ -f "$INSTALL_DIR/squashfs-root/resources/glm/zcode.cjs" ] && return 0
  ls "$HOME"/Applications/ZCode-*.AppImage >/dev/null 2>&1 && return 0
  ls /tmp/.mount_ZCode*/resources/glm/zcode.cjs >/dev/null 2>&1 && return 0
  return 1
}
if ! zcode_cli_found; then
  ZSIZE=$(curl -fsSI --max-time 15 "$ZCODE_DL" 2>/dev/null | awk 'tolower($1)=="content-length:"{print $2}' | tr -d '\r')
  if [ -n "$ZSIZE" ]; then
    ZHUMAN=$(awk -v b="$ZSIZE" 'BEGIN{printf "%.0f MB", b/1024/1024}')
  else
    ZHUMAN="unknown size"
  fi
  printf '\033[1;33m[glm-bridge] ZCode CLI not found. Download the official build now?\n  %s\n  Size: %s (the GUI will NOT be opened — only the CLI is extracted)\033[0m\n' "$ZCODE_DL" "$ZHUMAN"
  # stdin may be the `curl | bash` pipe — always ask on the controlling tty
  if [ -r /dev/tty ]; then printf '  Download and extract? [y/N] ' </dev/tty; read -r REPLY </dev/tty || REPLY=n; else REPLY=n; fi
  case "$REPLY" in
    y|Y|yes|YES)
      say "downloading ZCode ($ZHUMAN)..."
      TMP_AI=$(mktemp /tmp/zcode-XXXXXX.AppImage)
      if curl -fL --progress-bar -o "$TMP_AI" "$ZCODE_DL"; then
        mkdir -p "$HOME/Applications" && chmod +x "$TMP_AI"
        AI_PATH="$HOME/Applications/ZCode-3.14.4-linux-x64.AppImage"
        mv "$TMP_AI" "$AI_PATH"
        say "extracting CLI (no GUI launch)..."
        (cd "$INSTALL_DIR" && "$AI_PATH" --appimage-extract >/dev/null 2>&1) || say "warn: extraction failed"
        [ -f "$INSTALL_DIR/squashfs-root/resources/glm/zcode.cjs" ] && say "zcode CLI ready"
      else
        rm -f "$TMP_AI"; say "warn: download failed — set GLM_BRIDGE_CLI or install ZCode manually"
      fi
      ;;
    *) say "skipped — the bridge will keep retrying; install ZCode manually or re-run install.sh" ;;
  esac
fi

# ------------------------------------------------- terminal login ------------
# No ZCode GUI: offer the CLI's own OAuth login right here in the terminal.
if [ -r /dev/tty ]; then
  CRED_OK=no
  [ -f "$HOME/.zcode/v2/credentials.json" ] && CRED_OK=yes
  if [ "$CRED_OK" = no ]; then
    printf '\033[1;33m[glm-bridge] No ZCode login found. Log in now? (prints a URL to open in any browser)\033[0m\n'
    printf '  Log in in this terminal? [y/N] ' </dev/tty; read -r REPLY </dev/tty || REPLY=n
    case "$REPLY" in
      y|Y|yes|YES)
        CLI_F="$INSTALL_DIR/squashfs-root/resources/glm/zcode.cjs"
        if [ -f "$CLI_F" ]; then
          "$NODE_BIN" "$INSTALL_DIR/glm-bridge.js" login main </dev/tty || say "warn: login failed (re-run: glm-bridge login)"
        else
          say "zcode CLI missing — run: glm-bridge login (after installing ZCode)"
        fi
        ;;
    esac
  fi
fi

# ------------------------------------------------------------- systemd -------
install_service() {
  local unit="$HOME/.config/systemd/user/$SERVICE.service"
  mkdir -p "$(dirname "$unit")"
  cat > "$unit" <<EOF
[Unit]
Description=GLM bridge (ZCode start-plan GLM, OpenAI+Anthropic compatible)
After=network-online.target

[Service]
ExecStart="$NODE_BIN" "$INSTALL_DIR/glm-bridge.js" run
WorkingDirectory=$INSTALL_DIR
Restart=always
RestartSec=3
Environment=GLM_BRIDGE_QUIET=1
Environment=GLM_BRIDGE_PORT=$PORT

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable "$SERVICE.service" >/dev/null
  systemctl --user restart "$SERVICE.service"
  say "systemd user service installed and started ($SERVICE.service)"
}

stop_any_running() {
  "$NODE_BIN" "$INSTALL_DIR/glm-bridge.js" stop >/dev/null 2>&1 || true
}

if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  stop_any_running
  install_service
else
  say "systemd user session unavailable; using autostart instead"
  stop_any_running
  "$NODE_BIN" "$INSTALL_DIR/glm-bridge.js" start || true
  # XDG autostart fallback
  mkdir -p "$HOME/.config/autostart"
  cat > "$HOME/.config/autostart/$SERVICE.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=GLM bridge
Exec="$NODE_BIN" "$INSTALL_DIR/glm-bridge.js" run
Terminal=false
X-GNOME-Autostart-enabled=true
EOF
  say "autostart entry created"
fi

# ------------------------------------------------------------- readiness -----
say "waiting for the bridge to become ready..."
ready=0
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" = 1 ]; then
  HEALTH=$(curl -fsS "http://127.0.0.1:$PORT/health" || true)
  say "health: $HEALTH"
else
  say "warn: not ready yet — check: $BIN_DIR/glm-bridge logs"
fi

KEY=$("$NODE_BIN" -e "
  const fs=require('fs'),p=require('path'),o=require('os');
  const f=p.join(o.homedir(),'.glm-bridge','config.json');
  process.stdout.write(JSON.parse(fs.readFileSync(f,'utf8')).key);
" 2>/dev/null || echo "see config.json")

# ------------------------------------------------------------- 9router -------
register_9router() {
  local port=20128
  say "registering with 9router on :$port ..."
  "$NODE_BIN" - "$port" "$PREFIX" "$NODE_NAME" <<'NODE9R'
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const [port, prefix, nodeName] = process.argv.slice(2);
const dir = path.join(os.homedir(), '.9router');
const read = p => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };
const machineId = read(path.join(dir, 'machine-id')) || read('/etc/machine-id') || '';
const secret = read(path.join(dir, 'auth', 'cli-secret')) || '';
const token = crypto.createHash('sha256').update(machineId + '9r-cli-auth' + secret).digest('hex').slice(0, 16);
const key = JSON.parse(read(path.join(os.homedir(), '.glm-bridge', 'config.json'))).key;

const req = (method, p, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: +port, path: p, method,
    headers: { 'x-9r-cli-token': token, 'content-type': 'application/json' } },
    res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
  r.on('error', reject);
  if (body) r.write(JSON.stringify(body));
  r.end();
});

(async () => {
  const baseUrl = `http://127.0.0.1:${port === 20128 ? 3010 : 3010}/v1`;
  const nodes = await req('GET', '/api/provider-nodes');
  if (nodes.status !== 200) throw new Error('GET /api/provider-nodes -> ' + nodes.status);
  const existing = JSON.parse(nodes.body).nodes.find(n => n.prefix === prefix);
  let nodeId = existing && existing.id;
  if (nodeId) {
    await req('PUT', `/api/provider-nodes/${nodeId}`,
      { prefix, apiType: 'chat', baseUrl, type: 'openai-compatible', name: nodeName });
    console.log('node updated:', nodeId);
  } else {
    const created = await req('POST', '/api/provider-nodes',
      { prefix, apiType: 'chat', baseUrl, type: 'openai-compatible', name: nodeName });
    if (created.status >= 300) throw new Error('POST /api/provider-nodes -> ' + created.status + ' ' + created.body);
    nodeId = JSON.parse(created.body).node.id;
    console.log('node created:', nodeId);
  }
  const cons = await req('GET', '/api/providers');
  const list = JSON.parse(cons.body).connections || [];
  const have = list.find(c => c.provider === nodeId);
  if (!have) {
    const conn = await req('POST', '/api/providers', {
      provider: nodeId, authType: 'apikey', name: prefix + '-local', apiKey: key,
      providerSpecificData: { prefix, apiType: 'chat', baseUrl, nodeName,
        connectionProxyEnabled: false, connectionProxyUrl: '', connectionNoProxy: '' },
      isActive: true, priority: 1,
    });
    if (conn.status >= 300) throw new Error('POST /api/providers -> ' + conn.status + ' ' + conn.body);
    console.log('connection created');
  } else {
    await req('POST', `/api/providers/${have.id}/test`, {});
    console.log('connection present and tested');
  }
  console.log(`done — use model "${prefix}/GLM-5.3-Flash"`);
})().catch(e => { console.error('9router registration failed:', e.message); process.exit(1); });
NODE9R
}

if [ "$REGISTER_9ROUTER" != "no" ] && curl -fsS "http://127.0.0.1:20128/api/health" >/dev/null 2>&1; then
  register_9router || say "warn: 9router registration failed (bridge still usable directly)"
else
  [ "$REGISTER_9ROUTER" = "yes" ] && say "9router not reachable on :20128 — skipped"
fi

cat <<EOF

$(say "done")

  base URL : http://127.0.0.1:$PORT/v1
  api key  : $KEY
  model    : GLM-5.3-Flash

  control  : glm-bridge start|stop|restart|status|logs
  logs     : journalctl --user -u $SERVICE -f    (or: glm-bridge logs 50)
  health   : curl http://127.0.0.1:$PORT/health

Requires a ZCode desktop login (the bridge reuses its subscription).
EOF
