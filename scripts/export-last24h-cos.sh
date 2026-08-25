#!/usr/bin/env bash
set -euo pipefail

umask 077

PROJECT_DIR="${FLOW_BACKUP_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
EXPORT_DIR="${FLOW_BACKUP_EXPORT_DIR:-$PROJECT_DIR/data/exports}"
DB_PATH="${FLOW_DB_PATH:-$PROJECT_DIR/data/flow-research.db}"
NODE_BIN="${FLOW_BACKUP_NODE_BIN:-$(command -v node || true)}"
COSCLI_BIN="${FLOW_BACKUP_COSCLI_BIN:-$(command -v coscli || true)}"
BUCKET="${FLOW_BACKUP_COS_BUCKET:-}"
REGION="${FLOW_BACKUP_COS_REGION:-}"
ENDPOINT="${FLOW_BACKUP_COS_ENDPOINT:-}"
PREFIX="${FLOW_BACKUP_COS_PREFIX:-flow-acceleration/daily}"
RETENTION_DAYS="${FLOW_BACKUP_LOCAL_RETENTION_DAYS:-2}"
MAX_LOCAL_ARCHIVES="${FLOW_BACKUP_MAX_LOCAL_ARCHIVES:-2}"
MIN_FREE_GB="${FLOW_BACKUP_MIN_FREE_GB:-20}"
ORPHAN_MAX_AGE_MINUTES="${FLOW_BACKUP_ORPHAN_MAX_AGE_MINUTES:-360}"
THREADS="${FLOW_BACKUP_COS_THREADS:-4}"
LOG_LINES="${FLOW_BACKUP_LOG_LINES:-20000}"
EXPORT_TIMEOUT="${FLOW_BACKUP_EXPORT_TIMEOUT:-2h}"
UPLOAD_TIMEOUT="${FLOW_BACKUP_UPLOAD_TIMEOUT:-30m}"
VERIFY_TIMEOUT="${FLOW_BACKUP_VERIFY_TIMEOUT:-5m}"

for required in flock tar gzip sha256sum mktemp date tail find sort xargs sed nice systemctl journalctl sleep timeout df awk; do
  command -v "$required" >/dev/null 2>&1 || { echo "Missing required command: $required" >&2; exit 1; }
done
[[ -n "$NODE_BIN" && -x "$NODE_BIN" ]] || { echo "Node.js executable not found" >&2; exit 1; }
[[ -n "$COSCLI_BIN" && -x "$COSCLI_BIN" ]] || { echo "coscli executable not found" >&2; exit 1; }
[[ -s "$DB_PATH" ]] || { echo "Research database not found: $DB_PATH" >&2; exit 1; }
[[ -n "${FLOW_BACKUP_COS_SECRET_ID:-}" ]] || { echo "FLOW_BACKUP_COS_SECRET_ID is missing" >&2; exit 1; }
[[ -n "${FLOW_BACKUP_COS_SECRET_KEY:-}" ]] || { echo "FLOW_BACKUP_COS_SECRET_KEY is missing" >&2; exit 1; }
[[ -n "$BUCKET" ]] || { echo "FLOW_BACKUP_COS_BUCKET is missing" >&2; exit 1; }
[[ -n "$REGION" ]] || { echo "FLOW_BACKUP_COS_REGION is missing" >&2; exit 1; }
[[ -n "$ENDPOINT" ]] || { echo "FLOW_BACKUP_COS_ENDPOINT is missing" >&2; exit 1; }
case "$FLOW_BACKUP_COS_SECRET_ID$FLOW_BACKUP_COS_SECRET_KEY" in
  *$'\n'*|*$'\r'*) echo "COS credentials must not contain newlines" >&2; exit 1 ;;
esac

mkdir -p "$EXPORT_DIR"
EXPORT_DIR="$(cd "$EXPORT_DIR" && pwd)"
case "$EXPORT_DIR" in
  "$PROJECT_DIR"/data/exports|"$PROJECT_DIR"/data/exports/*) ;;
  *) echo "Refusing unsafe export directory: $EXPORT_DIR" >&2; exit 1 ;;
esac

for numeric_setting in RETENTION_DAYS MAX_LOCAL_ARCHIVES MIN_FREE_GB ORPHAN_MAX_AGE_MINUTES; do
  value="${!numeric_setting}"
  [[ "$value" =~ ^[0-9]+$ ]] || {
    echo "$numeric_setting must be a non-negative integer, received: $value" >&2
    exit 1
  }
done
(( MAX_LOCAL_ARCHIVES >= 1 )) || { echo "MAX_LOCAL_ARCHIVES must be at least 1" >&2; exit 1; }
(( MIN_FREE_GB >= 1 )) || { echo "MIN_FREE_GB must be at least 1" >&2; exit 1; }

exec 9>"$EXPORT_DIR/.daily-export.lock"
if ! flock -n 9; then
  echo "Another daily export is already running; exiting without overlap."
  exit 0
fi

cleanup_orphan_artifacts() {
  # The lock guarantees these files cannot belong to another canonical export.
  # Only stale, narrowly named artifacts inside the validated export directory
  # are eligible for removal.
  find "$EXPORT_DIR" -maxdepth 1 -type f \
    \( -name 'flow-acceleration-last24h-*.tar.gz.tmp' \
    -o -name 'flow-acceleration-last24h-*.tar.gz.uploaded.tmp' \) \
    -mmin "+$ORPHAN_MAX_AGE_MINUTES" -delete
  find "$EXPORT_DIR" -mindepth 1 -maxdepth 1 -type d \
    -name '.stage-*' -mmin "+$ORPHAN_MAX_AGE_MINUTES" \
    -exec rm -rf -- {} +
  while IFS= read -r -d '' marker; do
    [[ -f "${marker%.uploaded}" ]] || rm -f -- "$marker"
  done < <(find "$EXPORT_DIR" -maxdepth 1 -type f \
    -name 'flow-acceleration-last24h-*.tar.gz.uploaded' -print0)
}

prune_verified_archive_count() {
  local item marker archive index=0
  local -a uploaded=()
  mapfile -d '' -t uploaded < <(find "$EXPORT_DIR" -maxdepth 1 -type f \
    -name 'flow-acceleration-last24h-*.tar.gz.uploaded' \
    -printf '%T@ %p\0' | sort -z -nr)
  for item in "${uploaded[@]}"; do
    marker="${item#* }"
    archive="${marker%.uploaded}"
    index=$((index + 1))
    if (( index > MAX_LOCAL_ARCHIVES )); then
      rm -f -- "$archive" "$archive.sha256" "$marker"
    fi
  done
}

cleanup_orphan_artifacts
prune_verified_archive_count

STATE_FILE="$EXPORT_DIR/last-run.env"
RUN_DATE_CST="$(TZ=Asia/Shanghai date +%F)"
DONE_MARKER="$EXPORT_DIR/.daily-export-${RUN_DATE_CST}.done"
FORCE_RUN="${FLOW_BACKUP_FORCE_RUN:-false}"

state_completed_today() {
  [[ -f "$STATE_FILE" ]] || return 1
  grep -qx 'STATE=DONE' "$STATE_FILE" \
    && grep -qx "RUN_DATE_CST=$RUN_DATE_CST" "$STATE_FILE"
}

case "${FORCE_RUN,,}" in
  1|true|yes|on) ;;
  *)
    if [[ -f "$DONE_MARKER" ]] || state_completed_today; then
      echo "Daily export for $RUN_DATE_CST already completed; skipping duplicate trigger."
      exit 0
    fi
    ;;
esac

# A duplicate trigger that has nothing to do has already exited above. Only a
# run that would create a new multi-gigabyte archive needs the free-space gate.
AVAILABLE_KB="$(df -Pk "$EXPORT_DIR" | awk 'NR == 2 { print $4 }')"
REQUIRED_KB=$((MIN_FREE_GB * 1024 * 1024))
[[ "$AVAILABLE_KB" =~ ^[0-9]+$ ]] || {
  echo "Unable to determine free disk space for $EXPORT_DIR" >&2
  exit 1
}
if (( AVAILABLE_KB < REQUIRED_KB )); then
  echo "Refusing daily export: only $((AVAILABLE_KB / 1024 / 1024)) GiB free; FLOW_BACKUP_MIN_FREE_GB=$MIN_FREE_GB" >&2
  exit 1
fi

STAMP="$(TZ=Asia/Shanghai date +%Y%m%d-%H%M-CST)"
DATE_PATH="$(TZ=Asia/Shanghai date +%Y/%m/%d)"
BASE_NAME="flow-acceleration-last24h-${STAMP}.tar.gz"
ARCHIVE="$EXPORT_DIR/$BASE_NAME"
SHA_FILE="$ARCHIVE.sha256"
STAGE="$(mktemp -d "$EXPORT_DIR/.stage-XXXXXXXX")"
# COSCLI rejects a custom config path without a .yaml/.yml suffix.
COS_CONFIG="$(mktemp --suffix=.yaml)"
SUCCESS=0

write_state() {
  local state="$1"
  local detail="${2:-}"
  local temporary="$STATE_FILE.tmp"
  {
    printf 'STATE=%q\n' "$state"
    printf 'RUN_DATE_CST=%q\n' "$RUN_DATE_CST"
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
  rm -f -- "$ARCHIVE.tmp" "$ARCHIVE.uploaded.tmp"
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

# A per-archive marker allows count-based cleanup to delete only objects that
# passed remote verification. Failed archives remain for diagnosis until the
# normal age-based retention rule expires.
{
  printf 'REMOTE=%s\n' "$REMOTE_OBJECT"
  printf 'VERIFIED_AT=%s\n' "$(TZ=Asia/Shanghai date --iso-8601=seconds)"
} > "$ARCHIVE.uploaded.tmp"
mv -f -- "$ARCHIVE.uploaded.tmp" "$ARCHIVE.uploaded"

ARCHIVE_SHA="$(cut -d' ' -f1 "$SHA_FILE")"
# Do not run retention against the live SQLite database from this external
# process. A large DELETE can retain the writer lock long enough for a service
# restart to fail repeatedly with SQLITE_BUSY. Retention remains available as
# an explicit offline-maintenance command, outside the daily export timer.
RETENTION_RESULT=not_run_online

find "$EXPORT_DIR" -maxdepth 1 -type f \
  \( -name 'flow-acceleration-last24h-*.tar.gz' \
  -o -name 'flow-acceleration-last24h-*.tar.gz.sha256' \
  -o -name 'flow-acceleration-last24h-*.tar.gz.uploaded' \) \
  -mtime "+$RETENTION_DAYS" -delete
find "$EXPORT_DIR" -maxdepth 1 -type f -name '.daily-export-*.done' \
  -mtime "+$RETENTION_DAYS" -delete

# A successful retry supersedes any earlier same-day archive. Remove those
# local duplicates only after the current object has been verified in COS.
RUN_DATE_COMPACT="${RUN_DATE_CST//-/}"
for duplicate in "$EXPORT_DIR"/flow-acceleration-last24h-"$RUN_DATE_COMPACT"-*.tar.gz; do
  [[ -f "$duplicate" && "$duplicate" != "$ARCHIVE" ]] || continue
  rm -f -- "$duplicate" "$duplicate.sha256" "$duplicate.uploaded"
done
prune_verified_archive_count

SUCCESS=1
write_state DONE "sha256=$ARCHIVE_SHA db_retention=$RETENTION_RESULT"
{
  printf 'RUN_DATE_CST=%s\n' "$RUN_DATE_CST"
  printf 'REMOTE=%s\n' "$REMOTE_OBJECT"
  printf 'SHA256=%s\n' "$ARCHIVE_SHA"
} > "$DONE_MARKER.tmp"
mv -f -- "$DONE_MARKER.tmp" "$DONE_MARKER"
echo "Daily export complete"
echo "local=$ARCHIVE"
echo "remote=$REMOTE_DIR/$BASE_NAME"
echo "sha256=$ARCHIVE_SHA"
