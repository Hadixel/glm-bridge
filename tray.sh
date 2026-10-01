#!/bin/sh
# glm-bridge tray (Linux) — yad notification icon with:
#   Auto-start: ON/OFF  (toggles via `glm-bridge autostart-toggle`, re-renders)
#   Quit               (`glm-bridge quit` — stops the bridge and this icon)
set -u

STATE_DIR="${GLM_BRIDGE_HOME:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}"
mkdir -p "$STATE_DIR"
PID_FILE="$STATE_DIR/tray.pid"
LOG="$STATE_DIR/tray.log"

log() { printf '%s %s\n' "$(date -Is)" "$*" >>"$LOG" 2>/dev/null || true; }

# single instance
if [ -f "$PID_FILE" ]; then
  old=$(cat "$PID_FILE" 2>/dev/null || echo)
  if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then exit 0; fi
  rm -f "$PID_FILE"
fi

if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
  log "no display; tray skipped"
  exit 0
fi
if ! command -v yad >/dev/null 2>&1; then
  log "yad missing; tray skipped"
  echo "tray unavailable (yad missing)" >&2
  exit 0
fi

# Resolve the CLI: explicit override -> PATH -> sibling wrapper.
GLM="${GLM_BRIDGE_BIN:-}"
if [ -z "$GLM" ]; then GLM=$(command -v glm-bridge 2>/dev/null || true); fi
if [ -z "$GLM" ] && [ -f "$STATE_DIR/glm-bridge.sh" ]; then GLM="sh $STATE_DIR/glm-bridge.sh"; fi
if [ -z "$GLM" ]; then log "glm-bridge CLI not found; tray skipped"; exit 0; fi

trap 'rm -f "$PID_FILE"; log "tray exit"' EXIT INT TERM
echo $$ >"$PID_FILE"
log "tray start (pid $$)"

ICON="${GLM_BRIDGE_TRAY_ICON:-preferences-system}"

fast_fails=0
while :; do
  state=$($GLM autostart 2>/dev/null)
  case "$state" in on) label="Auto-start: ON" ;; *) label="Auto-start: OFF" ;; esac
  # yad runs each command through sh -c, so $PPID there is yad's pid: killing
  # yad ends the foreground call below and the loop re-renders with fresh state.
  # yad exits non-zero when killed that way — that is the normal path, hence
  # no `|| break`; only repeated instant failures (bad display etc.) stop us.
  start=$(date +%s)
  yad --notification \
      --image="$ICON" \
      --text="GLM Bridge" \
      --menu="$label!$GLM autostart-toggle && kill \$PPID|Quit!$GLM quit" \
      || true
  now=$(date +%s)
  if [ $((now - start)) -lt 2 ]; then
    fast_fails=$((fast_fails + 1))
    if [ "$fast_fails" -ge 5 ]; then log "yad exiting immediately 5x; tray stopping"; break; fi
    sleep 2
  else
    fast_fails=0
  fi
done
