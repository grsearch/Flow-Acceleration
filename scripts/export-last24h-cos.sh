#!/usr/bin/env bash
set -euo pipefail

umask 077

PROJECT_DIR="${FLOW_BACKUP_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
EXPORT_DIR="${FLOW_BACKUP_EXPORT_DIR:-$PROJECT_DIR/data/exports}"
DB_PATH="${FLOW_DB_PATH:-$PROJECT_DIR/data/flow-research.db}"
NODE_BIN="${FLOW_BACKUP_NODE_BIN:-$(command -v node || true)}"
COSCLI_BIN="${FLOW_BACKUP_COSCLI_BIN:-$(command -v coscli || true)}"
BUCKET="${FLOW_BACKUP_COS_BUCKET:-guigu-1403019446}"
REGION="${FLOW_BACKUP_COS_REGION:-na-siliconvalley}"
ENDPOINT="${FLOW_BACKUP_COS_ENDPOINT:-cos.na-siliconvalley.myqcloud.com}"
PREFIX="${FLOW_BACKUP_COS_PREFIX:-flow-acceleration/daily}"
RETENTION_DAYS="${FLOW_BACKUP_LOCAL_RETENTION_DAYS:-7}"
THREADS="${FLOW_BACKUP_COS_THREADS:-4}"
LOG_LINES="${FLOW_BACKUP_LOG_LINES:-20000}"
EXPORT_TIMEOUT="${FLOW_BACKUP_EXPORT_TIMEOUT:-2h}"
UPLOAD_TIMEOUT="${FLOW_BACKUP_UPLOAD_TIMEOUT:-30m}"
VERIFY_TIMEOUT="${FLOW_BACKUP_VERIFY_TIMEOUT:-5m}"
RETENTION_ENABLED="${FLOW_RETENTION_CLEANUP_ENABLED:-true}"
RETENTION_TIMEOUT="${FLOW_RETENTION_TIMEOUT:-1h}"

for required in flock tar gzip sha256sum mktemp date tail find sort xargs sed nice systemctl journalctl sleep timeout; do
  command -v "$required" >/dev/null 2>&1 || { echo "Missing required command: $required" >&2; exit 1; }
done
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { echo "Node.js executable not found" >&2; exit 1; }
[[ -n "$COSCLI_BIN" && -x "$COSCLI_BIN" ]] || { echo "coscli executable not found" >&2; exit 1; }
[[ -s "$DB_PATH" ]] || { echo "Research database not found: $DB_PATH" >&2; exit 1; }
[[ -n "${FLOW_BACKUP_COS_SECRET_ID:-}" ]] || { echo "FLOW_BACKUP_COS_SECRET_ID is missing" >&2; exit 1; }
[[ -n "${FLOW_BACKUP_COS_SECRET_KEY:-}" ]] || { echo "FLOW_BACKUP_COS_SECRET_KEY is missing" >&2; exit 1; }
case "$FLOW_BACKUP_COS_SECRET_ID$FLOW_BACKUP_COS_SECRET_KEY" in
  *$'\n'*|*$'\r'*) echo "COS credentials must not contain newlines" >&2; exit 1 ;;
esac

mkdir -p "$EXPORT_DIR"
EXPORT_DIR="$(cd "$EXPORT_DIR" && pwd)"
case "$EXPORT_DIR" in
  "$PROJECT_DIR"/data/exports|"$PROJECT_DIR"/data/exports/*) ;;
  *) echo "Refusing unsafe export directory: $EXPORT_DIR" >&2; exit 1 ;;
esac

exec 9>"$EXPORT_DIR/.daily-export.lock"
if ! flock -n 9; then
  echo "Another daily export is already running; exiting without overlap."
  exit 0
fi

STAMP="$(TZ=Asia/Shanghai date +%Y%m%d-%H%M-CST)"
DATE_PATH="$(TZ=Asia/Shanghai date +%Y/%m/%d)"
BASE_NAME="flow-acceleration-last24h-${STAMP}.tar.gz"
ARCHIVE="$EXPORT_DIR/$BASE_NAME"
SHA_FILE="$ARCHIVE.sha256"
STAGE="$(mktemp -d "$EXPORT_DIR/.stage-XXXXXXXX")"
# COSCLI rejects a custom config path without a .yaml/.yml suffix.
COS_CONFIG="$(mktemp --suffix=.yaml)"
STATE_FILE="$EXPORT_DIR/last-run.env"
SUCCESS=0

write_state() {
  local state="$1"
  local detail="${2:-}"
  local temporary="$STATE_FILE.tmp"
  {
    printf 'STATE=%q\n' "$state"
    printf 'UPDATED_AT=%q\n' "$(TZ=Asia/Shanghai date --iso-8601=seconds)"
    printf 'ARCHIVE=%q\n' "$ARCHIVE"
    printf 'REMOTE=%q\n' "${REMOTE_OBJECT:-}"
    printf 'DETAIL=%q\n' "$detail"
  } > "$temporary"
  mv -f -- "$temporary" "$STATE_FILE"
}

cleanup() {
  local exit_code=$?
  rm -f -- "$COS_CONFIG"
  case "$STAGE" in "$EXPORT_DIR"/.stage-*) rm -rf -- "$STAGE" ;; esac
  if [[ "$SUCCESS" != "1" ]]; then
    write_state FAILED "exit=$exit_code"
    echo "Export failed; any completed archive remains in $EXPORT_DIR for retry." >&2
  fi
}
trap cleanup EXIT

DB_EXPORT="$STAGE/flow-acceleration-last24h.db"
MANIFEST="$STAGE/manifest.json"
SCHEMA="$STAGE/schema.sql"

echo "Creating consistent 24-hour window export from $DB_PATH"
write_state EXPORTING
systemctl show flow-acceleration.service -p ActiveState -p MainPID -p ExecMainStartTimestamp \
  > "$STAGE/service-before.txt" 2>&1 || true
PID_BEFORE="$(systemctl show flow-acceleration.service -p MainPID --value 2>/dev/null || true)"
timeout --foreground "$EXPORT_TIMEOUT" nice -n 10 "$NODE_BIN" "$PROJECT_DIR/scripts/export-research-window.js" \
  "--db=$DB_PATH" \
  "--out=$DB_EXPORT" \
  "--hours=24" \
  "--manifest=$MANIFEST" \
  "--schema=$SCHEMA"
systemctl show flow-acceleration.service -p ActiveState -p MainPID -p ExecMainStartTimestamp \
  > "$STAGE/service-after.txt" 2>&1 || true
PID_AFTER="$(systemctl show flow-acceleration.service -p MainPID --value 2>/dev/null || true)"
if ! systemctl is-active --quiet flow-acceleration.service; then
  echo "Collector service is not active after export; refusing upload." >&2
  exit 1
fi
if [[ -n "$PID_BEFORE" && "$PID_BEFORE" != "0" && "$PID_BEFORE" != "$PID_AFTER" ]]; then
  echo "Warning: collector PID changed during export ($PID_BEFORE -> $PID_AFTER)." >&2
fi

{
  echo "git_commit=$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "git_describe=$(git -C "$PROJECT_DIR" describe --always --dirty 2>/dev/null || echo unknown)"
} > "$STAGE/version.txt"

systemctl --no-pager --full status flow-acceleration.service > "$STAGE/service-status.txt" 2>&1 || true
journalctl -u flow-acceleration.service --since '24 hours ago' --no-pager \
  > "$STAGE/service-journal-last24h.log" 2>&1 || true
[[ -f "$PROJECT_DIR/logs/out.log" ]] && tail -n "$LOG_LINES" "$PROJECT_DIR/logs/out.log" > "$STAGE/out-tail.log"
[[ -f "$PROJECT_DIR/logs/err.log" ]] && tail -n "$LOG_LINES" "$PROJECT_DIR/logs/err.log" > "$STAGE/err-tail.log"

for log_file in "$STAGE"/*.log; do
  [[ -f "$log_file" ]] || continue
  sed -E -i 's/((secret(id|key)|api[_-]?key|private[_-]?key|token)[=:][[:space:]]*)[^[:space:]]+/\1[REDACTED]/Ig' "$log_file"
done
(cd "$STAGE" && find . -type f ! -name sha256sums.txt -print0 | sort -z | xargs -0 sha256sum > sha256sums.txt)

tar -C "$STAGE" -cf - . | gzip -1 > "$ARCHIVE.tmp"
mv -f -- "$ARCHIVE.tmp" "$ARCHIVE"
sha256sum "$ARCHIVE" > "$SHA_FILE"
tar -tzf "$ARCHIVE" >/dev/null

yaml_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}
cat > "$COS_CONFIG" <<EOF
cos:
  base:
    secretid: "$(yaml_escape "$FLOW_BACKUP_COS_SECRET_ID")"
    secretkey: "$(yaml_escape "$FLOW_BACKUP_COS_SECRET_KEY")"
    sessiontoken: ""
    protocol: https
    disableencryption: true
  buckets:
  - name: "$BUCKET"
    alias: flowbackup
    region: "$REGION"
    endpoint: "$ENDPOINT"
    ofs: false
EOF
chmod 600 "$COS_CONFIG"

REMOTE_DIR="cos://flowbackup/${PREFIX#/}/$DATE_PATH"
REMOTE_OBJECT="$REMOTE_DIR/$BASE_NAME"
echo "Uploading $BASE_NAME to $REMOTE_DIR"
retry() {
  local attempt=1
  local max_attempts=3
  until "$@"; do
    if (( attempt >= max_attempts )); then return 1; fi
    echo "COS operation failed (attempt $attempt/$max_attempts); retrying in $((attempt * 10))s." >&2
    sleep "$((attempt * 10))"
    attempt=$((attempt + 1))
  done
}
write_state UPLOADING
retry timeout --foreground "$UPLOAD_TIMEOUT" "$COSCLI_BIN" -c "$COS_CONFIG" cp \
  "$ARCHIVE" "$REMOTE_OBJECT" --thread-num "$THREADS" --part-size 64 --fail-output=false
retry timeout --foreground "$VERIFY_TIMEOUT" "$COSCLI_BIN" -c "$COS_CONFIG" cp \
  "$SHA_FILE" "$REMOTE_OBJECT.sha256" --thread-num 1 --fail-output=false
write_state VERIFYING
retry timeout --foreground "$VERIFY_TIMEOUT" "$COSCLI_BIN" -c "$COS_CONFIG" ls \
  "$REMOTE_OBJECT" >/dev/null

ARCHIVE_SHA="$(cut -d' ' -f1 "$SHA_FILE")"
case "${RETENTION_ENABLED,,}" in
  1|true|yes|on)
    echo "COS object verified; starting low-priority retention cleanup"
    write_state CLEANING "sha256=$ARCHIVE_SHA"
    timeout --foreground "$RETENTION_TIMEOUT" nice -n 15 "$NODE_BIN" \
      "$PROJECT_DIR/scripts/cleanup-research-retention.js" \
      "--db=$DB_PATH" \
      "--state=$STATE_FILE" \
      "--report=$EXPORT_DIR/retention-last-run.json"
    RETENTION_RESULT=completed
    ;;
  *)
    RETENTION_RESULT=disabled
    ;;
esac

find "$EXPORT_DIR" -maxdepth 1 -type f \
  \( -name 'flow-acceleration-last24h-*.tar.gz' -o -name 'flow-acceleration-last24h-*.tar.gz.sha256' \) \
  -mtime "+$RETENTION_DAYS" -delete

SUCCESS=1
write_state DONE "sha256=$ARCHIVE_SHA retention=$RETENTION_RESULT"
echo "Daily export complete"
echo "local=$ARCHIVE"
echo "remote=$REMOTE_DIR/$BASE_NAME"
echo "sha256=$ARCHIVE_SHA"
