#!/usr/bin/env bash
# Conservative systemd-only update. Run without --apply first; see docs/safe-update.md.
set -euo pipefail
umask 077

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
NODE_BIN="${NODE_BIN:-node}"
unset NODE_OPTIONS NODE_PATH
# Do not let a caller's Git overrides redirect the checked or updated repository.
while IFS= read -r git_variable; do unset "$git_variable"; done < <(compgen -A variable GIT_ || true)
export GIT_NO_LAZY_FETCH=1 GIT_TERMINAL_PROMPT=0
APPLY=0
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --project=*|--unit=*|--expected-commit=*|--accept-timeout=*) ARGS+=("$arg") ;;
    *) echo 'Usage: safe-update.sh --project=/absolute/path --unit=name.service --expected-commit=full-hash [--accept-timeout=600] [--apply]' >&2; exit 1 ;;
  esac
done
CHECKER="$SCRIPT_DIR/safe-update-check.js"
check() { "$NODE_BIN" "$CHECKER" "$@" "${ARGS[@]}"; }

# Preflight never writes a lock, checks out files, or controls a process.
if (( APPLY == 0 )); then
  check --phase=preflight | check --phase=describe
  exit 0
fi

[[ $EUID -eq 0 ]] || { echo 'Apply requires root to inspect all processes and control the verified unit.' >&2; exit 1; }
command -v flock >/dev/null || { echo 'flock is required.' >&2; exit 1; }
# Serialize this update entry point; this does not claim to lock manual administration.
exec 9>/run/lock/flow-acceleration-safe-update.lock
flock -n 9 || { echo 'Another safe update is running.' >&2; exit 1; }
evidence="$(check --phase=preflight)"
printf '%s' "$evidence" | check --phase=describe
unit="$(printf '%s' "$evidence" | check --phase=field --field=unit)"
project="$(printf '%s' "$evidence" | check --phase=field --field=project)"
service_user="$(printf '%s' "$evidence" | check --phase=field --field=user)"
target="$(printf '%s' "$evidence" | check --phase=field --field=target)"

stage='before stop'
trap 'echo "Safe update stopped at: $stage. No automatic retry, rollback, or force kill. Inspect the unit and reported checks before proceeding." >&2' ERR
stage='graceful service stop'
systemctl --no-ask-password stop "$unit"
stage='confirming clean exit and empty service cgroup'
printf '%s' "$evidence" | check --phase=stopped

stage='fast-forwarding the stopped checkout'
runuser -u "$service_user" -- git -C "$project" \
  -c core.hooksPath=/dev/null -c merge.autoStash=false \
  merge --ff-only --no-edit --no-overwrite-ignore "$target" >/dev/null 2>&1
stage='verifying updated files before start'
printf '%s' "$evidence" | check --phase=updated

stage='starting the verified unit once'
systemctl --no-ask-password start "$unit"
stage='checking runtime identity and persisted trade progress'
printf '%s' "$evidence" | check --phase=accept
trap - ERR
echo 'Safe update accepted: expected version, target entry-enabled strategy set (including zero), three required definitions, HO500 0.1 SOL bridge, and persisted trade progress verified.'
