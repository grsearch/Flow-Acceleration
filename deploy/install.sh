#!/bin/bash
set -euo pipefail

INSTALL_DIR="${1:-/opt/flow-acceleration}"
SERVICE_USER="${SERVICE_USER:-ubuntu}"
SERVICE_GROUP="${SERVICE_GROUP:-}"
SERVICE_NAME="flow-acceleration"
INSTALL_DAILY_EXPORT="${INSTALL_DAILY_EXPORT:-auto}"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

for command_name in bash find grep install readlink rsync sudo systemctl sed; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name"
    exit 1
  fi
done

# This entry point bootstraps a separate, empty destination only. Running it
# inside an existing checkout/deployment is deliberately rejected: updates must
# preserve its Git history, local changes, environment, and collected data.
refuse_install() {
  echo "Initial installation refused: $1" >&2
  echo "For an existing deployment, use deploy/safe-update.sh (preflight first; --apply after review)." >&2
  exit 1
}

[[ "$INSTALL_DIR" == /* ]] || refuse_install "INSTALL_DIR must be an absolute path."
[[ ! -L "$INSTALL_DIR" ]] || refuse_install "The destination is a symbolic link."
INSTALL_DIR="$(readlink -m -- "$INSTALL_DIR")"
[[ "$INSTALL_DIR" != / ]] || refuse_install "The filesystem root cannot be an installation target."
if [[ "$PROJECT_DIR/" == "$INSTALL_DIR/"* || "$INSTALL_DIR/" == "$PROJECT_DIR/"* ]]; then
  refuse_install "The destination overlaps the source checkout; choose a separate empty directory."
fi

assert_fresh_install_target() {
  local unit_state load_state="" active_state="" main_pid="" key value contents
  if [[ -e "$SERVICE_FILE" || -L "$SERVICE_FILE" ]]; then
    refuse_install "A service definition already exists at $SERVICE_FILE."
  fi
  if ! unit_state="$(systemctl show "${SERVICE_NAME}.service" \
      --property=LoadState --property=ActiveState --property=MainPID 2>/dev/null)"; then
    refuse_install "Unable to verify the existing service state."
  fi
  while IFS='=' read -r key value; do
    case "$key" in
      LoadState) load_state="$value" ;;
      ActiveState) active_state="$value" ;;
      MainPID) main_pid="$value" ;;
    esac
  done <<< "$unit_state"
  if [[ "$load_state" != not-found || "$active_state" != inactive || "$main_pid" != 0 ]]; then
    refuse_install "The service is already installed, running, or has an unverified state."
  fi
  if [[ -L "$INSTALL_DIR" || ( -e "$INSTALL_DIR" && ! -d "$INSTALL_DIR" ) ]]; then
    refuse_install "The destination is not a regular directory."
  fi
  if [[ -d "$INSTALL_DIR" ]]; then
    contents="$(find "$INSTALL_DIR" -mindepth 1 -maxdepth 1 -print -quit)" \
      || refuse_install "Unable to inspect the destination."
    [[ -z "$contents" ]] || refuse_install "The destination is not empty (including hidden files or data)."
  fi
}

assert_fresh_install_target

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

# Repeat immediately before the first filesystem mutation in case state changed
# while checking the runtime. This script never updates a populated target.
assert_fresh_install_target
mkdir -p "$INSTALL_DIR"
rsync -a \
  --ignore-existing \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='/data/' \
  --exclude='/logs/' \
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

case "${INSTALL_DAILY_EXPORT,,}" in
  1|true|yes|on)
    SERVICE_USER="$SERVICE_USER" SERVICE_GROUP="$SERVICE_GROUP" \
      NODE_BIN="$NODE_BIN" bash "$INSTALL_DIR/deploy/install-daily-export.sh" "$INSTALL_DIR"
    ;;
  auto)
    if command -v coscli >/dev/null 2>&1; then
      SERVICE_USER="$SERVICE_USER" SERVICE_GROUP="$SERVICE_GROUP" \
        NODE_BIN="$NODE_BIN" bash "$INSTALL_DIR/deploy/install-daily-export.sh" "$INSTALL_DIR"
    else
      echo "Daily COS export not installed automatically: coscli is not available."
      echo "Install Tencent COSCLI, then run deploy/install-daily-export.sh."
    fi
    ;;
  0|false|no|off) ;;
  *)
    echo "Invalid INSTALL_DAILY_EXPORT value: $INSTALL_DAILY_EXPORT (use auto, 1, or 0)." >&2
    exit 1
    ;;
esac

if [[ "${START_SERVICE:-0}" == "1" ]]; then
  if ! grep -Eq '^(FLOW_GRPC_TOKEN|HELIUS_LASERSTREAM_TOKEN|HELIUS_API_KEY)=.+' "$INSTALL_DIR/.env"; then
    echo "START_SERVICE=1 requested, but no Helius token is configured in $INSTALL_DIR/.env"
    exit 1
  fi
  systemctl start "$SERVICE_NAME"
  systemctl --no-pager --full status "$SERVICE_NAME"
fi

echo "Installed at $INSTALL_DIR"
echo "1. Fill FLOW_GRPC_ENDPOINTS and FLOW_GRPC_TOKEN in $INSTALL_DIR/.env"
echo "2. systemctl start $SERVICE_NAME"
echo "3. systemctl --no-pager --full status $SERVICE_NAME"
echo "4. Open http://<server>:3001"
echo "For future updates, use deploy/safe-update.sh; do not rerun this installer."
echo "This initial copy excludes .git. Before its first update, manually migrate it to a reviewed managed Git checkout."
echo "Preserve its .env, data, and local changes during that migration; do not copy .git from another deployment."
if [[ "${INSTALL_DAILY_EXPORT,,}" == "0" || "${INSTALL_DAILY_EXPORT,,}" == "false" || "${INSTALL_DAILY_EXPORT,,}" == "no" || "${INSTALL_DAILY_EXPORT,,}" == "off" ]]; then
  echo "5. Daily COS export was explicitly disabled (INSTALL_DAILY_EXPORT=$INSTALL_DAILY_EXPORT)."
else
  echo "5. Daily COS export: systemctl list-timers flow-acceleration-backup.timer --all"
fi
