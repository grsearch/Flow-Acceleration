#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${1:-/opt/flow-acceleration}"
SERVICE_USER="${SERVICE_USER:-ubuntu}"
SERVICE_GROUP="${SERVICE_GROUP:-$(id -gn "$SERVICE_USER" 2>/dev/null || true)}"
BACKUP_ENV_FILE="/etc/flow-acceleration/backup-cos.env"
PROJECT_ENV_FILE="$INSTALL_DIR/.env"
CANONICAL_SERVICE="flow-acceleration-backup.service"
CANONICAL_TIMER="flow-acceleration-backup.timer"
LEGACY_SERVICE="flow-daily-export.service"
LEGACY_TIMER="flow-daily-export.timer"

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo."
  exit 1
fi
[[ -d "$INSTALL_DIR" ]] || { echo "Install directory not found: $INSTALL_DIR" >&2; exit 1; }
id "$SERVICE_USER" >/dev/null 2>&1 || { echo "Service user not found: $SERVICE_USER" >&2; exit 1; }

node_is_usable() {
  local candidate="${1:-}"
  [[ -n "$candidate" && -x "$candidate" ]] || return 1
  "$candidate" -p 'process.execPath' >/dev/null 2>&1
}

detect_node_bin() {
  local candidate main_pid service_home

  # An explicit installer override always wins.
  candidate="${NODE_BIN:-}"
  if node_is_usable "$candidate"; then
    printf '%s' "$candidate"
    return 0
  fi

  # Reuse the exact Node binary already running the collector. This works even
  # when NVM is absent from the non-interactive systemd/login PATH.
  main_pid="$(systemctl show flow-acceleration.service -p MainPID --value 2>/dev/null || true)"
  if [[ "$main_pid" =~ ^[1-9][0-9]*$ ]]; then
    candidate="$(readlink -f "/proc/$main_pid/exe" 2>/dev/null || true)"
    if node_is_usable "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  fi

  candidate="$(sudo -H -u "$SERVICE_USER" bash -lc 'command -v node' 2>/dev/null || true)"
  if node_is_usable "$candidate"; then
    printf '%s' "$candidate"
    return 0
  fi

  for candidate in /usr/local/bin/node /usr/bin/node; do
    if node_is_usable "$candidate"; then
      printf '%s' "$candidate"
      return 0
    fi
  done

  # NVM is often initialized only by interactive shells. Search the service
  # user's own NVM versions as the final, bounded fallback.
  service_home="$(getent passwd "$SERVICE_USER" 2>/dev/null | cut -d: -f6)"
  if [[ -n "$service_home" && -d "$service_home/.nvm/versions/node" ]]; then
    while IFS= read -r candidate; do
      if node_is_usable "$candidate"; then
        printf '%s' "$candidate"
        return 0
      fi
    done < <(find "$service_home/.nvm/versions/node" -mindepth 3 -maxdepth 3 \
      -type f -path '*/bin/node' | sort -Vr)
  fi
  return 1
}

NODE_BIN="$(detect_node_bin || true)"
COSCLI_BIN="${COSCLI_BIN:-$(command -v coscli 2>/dev/null || true)}"
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { echo "Node.js was not found for $SERVICE_USER" >&2; exit 1; }
[[ -n "$COSCLI_BIN" && -x "$COSCLI_BIN" ]] || {
  echo "coscli is required. Install Tencent COSCLI, then rerun this installer." >&2
  exit 1
}
for required in systemctl systemd-analyze install sed grep tail flock tar gzip sha256sum timeout cmp; do
  command -v "$required" >/dev/null 2>&1 || { echo "Missing required command: $required" >&2; exit 1; }
done

mkdir -p /etc/flow-acceleration "$INSTALL_DIR/data/exports/.coscli-home"
if [[ ! -f "$BACKUP_ENV_FILE" ]]; then
  install -m 600 -o "$SERVICE_USER" -g "$SERVICE_GROUP" \
    "$INSTALL_DIR/deploy/backup-cos.env.example" \
    "$BACKUP_ENV_FILE"
  echo "Created $BACKUP_ENV_FILE."
fi
chown "$SERVICE_USER:$SERVICE_GROUP" "$BACKUP_ENV_FILE"
chmod 600 "$BACKUP_ENV_FILE"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR/data/exports"
chmod 700 "$INSTALL_DIR/data/exports"
chmod 700 "$INSTALL_DIR/data/exports/.coscli-home"
chmod 700 "$INSTALL_DIR/scripts/export-last24h-cos.sh"
chmod 700 "$INSTALL_DIR/scripts/cleanup-research-retention.js"

NODE_DIR="$(dirname "$NODE_BIN")"
COSCLI_DIR="$(dirname "$COSCLI_BIN")"

env_value() {
  local file="$1"
  local key="$2"
  local value
  [[ -f "$file" ]] || return 1
  value="$(sed -n "s/^[[:space:]]*${key}=//p" "$file" | tail -n 1)"
  value="${value%$'\r'}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

has_complete_cos_config() {
  local file="$1"
  local key value
  for key in \
    FLOW_BACKUP_COS_SECRET_ID \
    FLOW_BACKUP_COS_SECRET_KEY \
    FLOW_BACKUP_COS_BUCKET \
    FLOW_BACKUP_COS_REGION \
    FLOW_BACKUP_COS_ENDPOINT; do
    value="$(env_value "$file" "$key" || true)"
    [[ -n "$value" ]] || return 1
    case "$value" in
      your-*|cos.your-*|*'<your-'*) return 1 ;;
    esac
  done
}

# Prefer the root-owned override when it is complete. Existing servers that
# already keep the same variables in the project .env remain supported. An
# incomplete /etc template must never override working project credentials.
BACKUP_ENV_LINE="# COS settings are loaded from $PROJECT_ENV_FILE"
CONFIG_SOURCE=""
if has_complete_cos_config "$BACKUP_ENV_FILE"; then
  BACKUP_ENV_LINE="EnvironmentFile=$BACKUP_ENV_FILE"
  CONFIG_SOURCE="$BACKUP_ENV_FILE"
elif has_complete_cos_config "$PROJECT_ENV_FILE"; then
  CONFIG_SOURCE="$PROJECT_ENV_FILE"
fi

render_unit() {
  local source="$1"
  local destination="$2"
  sed \
    -e "s|@INSTALL_DIR@|$INSTALL_DIR|g" \
    -e "s|@SERVICE_USER@|$SERVICE_USER|g" \
    -e "s|@SERVICE_GROUP@|$SERVICE_GROUP|g" \
    -e "s|@NODE_BIN@|$NODE_BIN|g" \
    -e "s|@COSCLI_BIN@|$COSCLI_BIN|g" \
    -e "s|@NODE_DIR@|$NODE_DIR|g" \
    -e "s|@COSCLI_DIR@|$COSCLI_DIR|g" \
    -e "s|@BACKUP_ENV_LINE@|$BACKUP_ENV_LINE|g" \
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

# Remove only obsolete Flow Acceleration export jobs. Older deployments used a
# six-hour cron entry which either uploaded a stale archive or ran the old
# last-10h exporter. Other cron jobs remain untouched.
remove_legacy_cron() {
  local cron_user="$1"
  local before after
  before="$(mktemp)"
  after="$(mktemp)"
  if crontab -u "$cron_user" -l > "$before" 2>/dev/null; then
    grep -Ev '(cos-auto-upload-export\.sh|export-last10h\.sh|export-last24h-cos\.sh)' \
      "$before" > "$after" || true
    if ! cmp -s "$before" "$after"; then
      crontab -u "$cron_user" "$after"
      echo "Removed obsolete Flow Acceleration export cron for $cron_user."
    fi
  fi
  rm -f -- "$before" "$after"
}
if [[ -z "$CONFIG_SOURCE" ]]; then
  systemctl disable --now "$CANONICAL_TIMER" >/dev/null 2>&1 || true
  echo "Daily export units were installed but not enabled: COS configuration is incomplete."
  echo "Fill $BACKUP_ENV_FILE (preferred) or $PROJECT_ENV_FILE, then rerun this installer."
  echo "Any existing $LEGACY_TIMER was left unchanged."
  exit 0
fi

systemctl reset-failed "$CANONICAL_SERVICE" || true
systemctl enable --now "$CANONICAL_TIMER"
systemctl restart "$CANONICAL_TIMER"

# Remove obsolete cron jobs only after the canonical scheduler is valid. This
# preserves the last known-good scheduler when installation is incomplete.
if command -v crontab >/dev/null 2>&1; then
  remove_legacy_cron "$SERVICE_USER"
  [[ "$SERVICE_USER" == "root" ]] || remove_legacy_cron root
fi

# OpenClaw temporarily used flow-daily-export.* on some servers. Some copies of
# that legacy oneshot were coupled to flow-acceleration.service and configured
# to restart, so restarting the collector could repeatedly launch a new export.
# Once the canonical timer is valid, stop, disable, and mask both legacy units.
# Masking replaces stale unit files with /dev/null links, so a dependency or a
# future manual command cannot resurrect an exporter that points at an obsolete
# checkout or deleted database. The canonical exporter owns the same flock and
# can be started again explicitly.
if systemctl cat "$LEGACY_TIMER" >/dev/null 2>&1 \
  || systemctl cat "$LEGACY_SERVICE" >/dev/null 2>&1; then
  systemctl disable --now "$LEGACY_TIMER" >/dev/null 2>&1 || true
  systemctl disable --now "$LEGACY_SERVICE" >/dev/null 2>&1 || true
  systemctl stop "$LEGACY_TIMER" "$LEGACY_SERVICE" >/dev/null 2>&1 || true
  systemctl reset-failed "$LEGACY_TIMER" "$LEGACY_SERVICE" >/dev/null 2>&1 || true
  systemctl mask --now --force "$LEGACY_TIMER" "$LEGACY_SERVICE"
  [[ "$(systemctl is-enabled "$LEGACY_TIMER" 2>/dev/null || true)" == "masked" ]] \
    || { echo "Failed to mask legacy unit $LEGACY_TIMER" >&2; exit 1; }
  [[ "$(systemctl is-enabled "$LEGACY_SERVICE" 2>/dev/null || true)" == "masked" ]] \
    || { echo "Failed to mask legacy unit $LEGACY_SERVICE" >&2; exit 1; }
  echo "Stopped, disabled, and masked legacy export units $LEGACY_TIMER and $LEGACY_SERVICE."
fi

echo "Daily export timer installed."
echo "Configuration source: $CONFIG_SOURCE"
echo "1. Keep COS credentials private and mode 0600."
echo "2. Test once: systemctl start flow-acceleration-backup.service"
echo "3. Inspect: journalctl -u flow-acceleration-backup.service -n 100 --no-pager"
echo "4. Schedule: systemctl list-timers flow-acceleration-backup.timer --all"
echo "5. Last result: cat $INSTALL_DIR/data/exports/last-run.env"
