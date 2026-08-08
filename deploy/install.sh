#!/bin/bash
set -euo pipefail

INSTALL_DIR="${1:-/opt/flow-acceleration}"
SERVICE_USER="${SERVICE_USER:-ubuntu}"
SERVICE_GROUP="${SERVICE_GROUP:-}"
SERVICE_NAME="flow-acceleration"

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

for command_name in bash grep install rsync sudo systemctl sed; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name"
    exit 1
  fi
done

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "Service user does not exist: $SERVICE_USER"
  exit 1
fi
SERVICE_GROUP="${SERVICE_GROUP:-$(id -gn "$SERVICE_USER")}"

NODE_BIN="${NODE_BIN:-$(sudo -H -u "$SERVICE_USER" bash -lc 'command -v node' 2>/dev/null || true)}"
PNPM_BIN="${PNPM_BIN:-$(sudo -H -u "$SERVICE_USER" bash -lc 'command -v pnpm' 2>/dev/null || true)}"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Node.js was not found for $SERVICE_USER. Install Node.js 22+ or pass NODE_BIN=/absolute/path/node."
  exit 1
fi
if [[ -z "$PNPM_BIN" || ! -x "$PNPM_BIN" ]]; then
  echo "pnpm was not found for $SERVICE_USER. Install pnpm or pass PNPM_BIN=/absolute/path/pnpm."
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 22 )); then
  echo "Node.js 22+ is required; found $("$NODE_BIN" --version)."
  exit 1
fi

mkdir -p "$INSTALL_DIR"
rsync -a \
  --exclude='node_modules' \
  --exclude='data/*.db*' \
  --exclude='data/archive/*' \
  --exclude='logs/*' \
  --exclude='.env' \
  "$PROJECT_DIR/" "$INSTALL_DIR/"

mkdir -p "$INSTALL_DIR/data/archive" "$INSTALL_DIR/logs"
if [[ ! -f "$INSTALL_DIR/.env" ]]; then
  install -m 600 "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  echo "Created $INSTALL_DIR/.env; add the API key before starting the service."
fi
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR"

cd "$INSTALL_DIR"
RUNTIME_PATH="$(dirname "$NODE_BIN"):$(dirname "$PNPM_BIN"):/usr/local/bin:/usr/bin:/bin"
sudo -H -u "$SERVICE_USER" env PATH="$RUNTIME_PATH" "$PNPM_BIN" install --prod --frozen-lockfile

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
sed -e "s|/opt/flow-acceleration|$INSTALL_DIR|g" \
    -e "s|^User=ubuntu|User=$SERVICE_USER|" \
    -e "s|^Group=ubuntu|Group=$SERVICE_GROUP|" \
    -e "s|^ExecStart=/usr/bin/node |ExecStart=$NODE_BIN |" \
    "$INSTALL_DIR/deploy/flow-acceleration.service" > "$SERVICE_FILE"

sed "s|/opt/flow-acceleration|$INSTALL_DIR|g" \
  "$INSTALL_DIR/deploy/logrotate.conf" > "/etc/logrotate.d/${SERVICE_NAME}"

systemctl daemon-reload
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze verify "$SERVICE_FILE"
fi
systemctl enable "$SERVICE_NAME"

if [[ "${START_SERVICE:-0}" == "1" ]]; then
  if ! grep -Eq '^(FLOW_GRPC_TOKEN|HELIUS_LASERSTREAM_TOKEN|HELIUS_API_KEY)=.+' "$INSTALL_DIR/.env"; then
    echo "START_SERVICE=1 requested, but no Helius token is configured in $INSTALL_DIR/.env"
    exit 1
  fi
  systemctl restart "$SERVICE_NAME"
  systemctl --no-pager --full status "$SERVICE_NAME"
fi

echo "Installed at $INSTALL_DIR"
echo "1. Fill FLOW_GRPC_ENDPOINTS and FLOW_GRPC_TOKEN in $INSTALL_DIR/.env"
echo "2. systemctl restart $SERVICE_NAME"
echo "3. systemctl --no-pager --full status $SERVICE_NAME"
echo "4. Open http://<server>:3001"
