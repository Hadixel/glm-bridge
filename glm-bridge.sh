# glm-bridge — local OpenAI/Anthropic bridge for Z.ai GLM (ZCode start plan)
# POSIX CLI wrapper: start|stop|restart|status|logs [n]|run
#!/bin/sh
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if command -v node >/dev/null 2>&1; then
  NODE=node
elif [ -x "$HOME/.nvs/node/24.15.0/x64/bin/node" ]; then
  NODE="$HOME/.nvs/node/24.15.0/x64/bin/node"
else
  echo "Node.js 22+ not found in PATH (glm-bridge needs node:sqlite)." >&2
  exit 1
fi
exec "$NODE" "$DIR/glm-bridge.js" "$@"
