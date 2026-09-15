#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This installer must run inside WSL/Linux." >&2
  exit 1
fi

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_ROOT="${AGENTDOCK_INSTALL_ROOT:-$HOME/.local/share/agentskai}"
CONFIG_DIR="${AGENTDOCK_CONFIG_DIR:-$HOME/.config/agentskai}"
STATE_DIR="${AGENTDOCK_DATA_DIR:-$HOME/.local/state/agentskai}"
RELEASE_ID="$(date -u +%Y%m%d%H%M%S)"
RELEASE_DIR="$APP_ROOT/releases/$RELEASE_ID"

if [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh"
fi
command -v node >/dev/null || { echo "Node.js 22+ is required inside WSL." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required inside WSL." >&2; exit 1; }
command -v tmux >/dev/null || { echo "tmux is required: sudo apt install tmux" >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker is required. Enable Docker Desktop WSL integration or install Docker Engine." >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "The Docker daemon is unavailable to this WSL user." >&2; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 22 )); then echo "Node.js 22+ is required; found $(node --version)." >&2; exit 1; fi

mkdir -p "$RELEASE_DIR" "$CONFIG_DIR" "$STATE_DIR"
cp "$SOURCE_DIR/package.json" "$SOURCE_DIR/package-lock.json" "$SOURCE_DIR/tsconfig.json" "$RELEASE_DIR/"
cp -R "$SOURCE_DIR/src" "$SOURCE_DIR/web" "$SOURCE_DIR/scripts" "$SOURCE_DIR/test" "$SOURCE_DIR/docker" "$RELEASE_DIR/"
cd "$RELEASE_DIR"
npm ci
npm run build
docker build -f "$SOURCE_DIR/docker/workspace.Dockerfile" -t agentskai/workspace:1 "$SOURCE_DIR"

TEMP_LINK="$APP_ROOT/.current-$RELEASE_ID"
ln -s "$RELEASE_DIR" "$TEMP_LINK"
mv -Tf "$TEMP_LINK" "$APP_ROOT/current"

ENV_FILE="$CONFIG_DIR/agentdock.env"
if [[ ! -f "$ENV_FILE" ]]; then
  PASSWORD="${AGENTDOCK_PASSWORD:-$(node -e 'console.log(require("node:crypto").randomBytes(18).toString("base64url"))')}"
  umask 077
  printf 'HOST=127.0.0.1\nPORT=3000\nAGENTDOCK_PASSWORD=%s\nAGENTDOCK_DATA_DIR=%s\nAGENTSKAI_ADMIN_USERNAME=admin\nAGENTSKAI_WORKSPACE_IMAGE=agentskai/workspace:1\n' "$PASSWORD" "$STATE_DIR" > "$ENV_FILE"
  echo "Created $ENV_FILE (mode 600)."
fi

NODE_BIN="$(command -v node)"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/agentdock.service" <<EOF
[Unit]
Description=AgentSkai self-hosted agent workspace manager
After=default.target

[Service]
Type=simple
WorkingDirectory=$APP_ROOT/current
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $APP_ROOT/current/dist/server.js
Restart=on-failure
RestartSec=2
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
if [[ "${AGENTDOCK_SKIP_SERVICE_START:-0}" == "1" ]]; then
  echo "AgentSkai v1 installed; service start was skipped."
else
  systemctl --user enable agentdock.service
  systemctl --user restart agentdock.service
  echo "AgentSkai v1 is running at http://127.0.0.1:3000"
  echo "Username: admin"
  echo "Password is stored in $ENV_FILE"
fi
