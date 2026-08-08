#!/bin/bash
set -euo pipefail

INSTALL_DIR="${1:-/opt/flow-acceleration}"
SERVICE_USER="${SERVICE_USER:-ubuntu}"
SERVICE_NAME="flow-acceleration"

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

mkdir -p "$INSTALL_DIR"
rsync -a \
  --exclude='node_modules' \
  --exclude='data/*.db*' \
  --exclude='data/archive/*' \
  --exclude='logs/*' \
  --exclude='.env' \
  "$PROJECT_DIR/" "$INSTALL_DIR/"

mkdir -p "$INSTALL_DIR/data/archive" "$INSTALL_DIR/logs"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

cd "$INSTALL_DIR"
sudo -u "$SERVICE_USER" pnpm install --prod --frozen-lockfile

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
sed -e "s|/opt/flow-acceleration|$INSTALL_DIR|g" \
    -e "s|^User=ubuntu|User=$SERVICE_USER|" \
    -e "s|^Group=ubuntu|Group=$SERVICE_USER|" \
    "$INSTALL_DIR/deploy/flow-acceleration.service" > "$SERVICE_FILE"

sed "s|/opt/flow-acceleration|$INSTALL_DIR|g" \
  "$INSTALL_DIR/deploy/logrotate.conf" > "/etc/logrotate.d/${SERVICE_NAME}"

systemctl daemon-reload

echo "Installed at $INSTALL_DIR"
echo "1. cp $INSTALL_DIR/.env.example $INSTALL_DIR/.env"
echo "2. Fill FLOW_GRPC_ENDPOINTS and FLOW_GRPC_TOKEN"
echo "3. systemctl enable --now $SERVICE_NAME"
echo "4. Open http://<server>:3001"
