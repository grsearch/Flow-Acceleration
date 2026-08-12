#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${1:-/opt/flow-acceleration}"
SERVICE_USER="${SERVICE_USER:-ubuntu}"
SERVICE_GROUP="${SERVICE_GROUP:-$(id -gn "$SERVICE_USER" 2>/dev/null || true)}"

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo."
  exit 1
fi
[[ -d "$INSTALL_DIR" ]] || { echo "Install directory not found: $INSTALL_DIR" >&2; exit 1; }
id "$SERVICE_USER" >/dev/null 2>&1 || { echo "Service user not found: $SERVICE_USER" >&2; exit 1; }

NODE_BIN="${NODE_BIN:-$(sudo -H -u "$SERVICE_USER" bash -lc 'command -v node' 2>/dev/null || true)}"
COSCLI_BIN="${COSCLI_BIN:-$(command -v coscli 2>/dev/null || true)}"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { echo "Node.js was not found for $SERVICE_USER" >&2; exit 1; }
[[ -n "$COSCLI_BIN" && -x "$COSCLI_BIN" ]] || {
  echo "coscli is required. Install Tencent COSCLI, then rerun this installer." >&2
  exit 1
}
for required in systemctl systemd-analyze install sed flock tar gzip sha256sum; do
  command -v "$required" >/dev/null 2>&1 || { echo "Missing required command: $required" >&2; exit 1; }
done

mkdir -p /etc/flow-acceleration "$INSTALL_DIR/data/exports"
if [[ ! -f /etc/flow-acceleration/backup-cos.env ]]; then
  install -m 600 -o "$SERVICE_USER" -g "$SERVICE_GROUP" \
    "$INSTALL_DIR/deploy/backup-cos.env.example" \
    /etc/flow-acceleration/backup-cos.env
  echo "Created /etc/flow-acceleration/backup-cos.env; fill SecretId and SecretKey."
fi
chown "$SERVICE_USER:$SERVICE_GROUP" /etc/flow-acceleration/backup-cos.env
chmod 600 /etc/flow-acceleration/backup-cos.env
chown "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR/data/exports"
chmod 700 "$INSTALL_DIR/data/exports"
chmod 700 "$INSTALL_DIR/scripts/export-last24h-cos.sh"

render_unit() {
  local source="$1"
  local destination="$2"
  sed \
    -e "s|@INSTALL_DIR@|$INSTALL_DIR|g" \
    -e "s|@SERVICE_USER@|$SERVICE_USER|g" \
    -e "s|@SERVICE_GROUP@|$SERVICE_GROUP|g" \
    -e "s|@NODE_BIN@|$NODE_BIN|g" \
    -e "s|@COSCLI_BIN@|$COSCLI_BIN|g" \
    "$source" > "$destination"
}

render_unit "$INSTALL_DIR/deploy/flow-acceleration-backup.service" \
  /etc/systemd/system/flow-acceleration-backup.service
render_unit "$INSTALL_DIR/deploy/flow-acceleration-backup.timer" \
  /etc/systemd/system/flow-acceleration-backup.timer

systemctl daemon-reload
systemd-analyze verify \
  /etc/systemd/system/flow-acceleration-backup.service \
  /etc/systemd/system/flow-acceleration-backup.timer
systemctl enable --now flow-acceleration-backup.timer

echo "Daily export timer installed."
echo "1. Edit /etc/flow-acceleration/backup-cos.env and add SecretId/SecretKey."
echo "2. Test once: systemctl start flow-acceleration-backup.service"
echo "3. Inspect: journalctl -u flow-acceleration-backup.service -n 100 --no-pager"
echo "4. Schedule: systemctl list-timers flow-acceleration-backup.timer --all"
