#!/usr/bin/env bash
# Switch only code; never restore an older database, Google snapshot or media.
set -euo pipefail
source "$(dirname "$0")/release-common.sh"
checkpoint="$(realpath "${1:?checkpoint required}")"
test "$(cat "$checkpoint/base")" = "$base"
previous="$(cat "$checkpoint/previous-release")"
image="$(cat "$checkpoint/previous-image")"
test -f "$previous/compose.yaml"
grep -q 'FinanceSheetStore' "$previous/server/index.mjs"
[[ "$previous" = "$base/releases/"* ]]
docker image inspect "$image" >/dev/null
if [[ "${2:-}" != --recovery ]]; then guard; fi
python3 "$script_dir/check-commands.py" "$shared/data" "$previous"
rollback_checkpoint="$(mktemp -d "$backup_root/releases/rollback-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
maintenance "$rollback_checkpoint"
guard
docker stop -t 90 "$container" >/dev/null
if ! guard || ! python3 "$script_dir/check-commands.py" "$shared/data" "$previous"; then
  docker start "$container" >/dev/null
  echo 'Rollback blocked after drain; current writer restarted behind maintenance.' >&2
  exit 1
fi
if [[ "${2:-}" != --recovery ]]; then
  WORKSHOP_LOCK_HELD="$base" bash "$script_dir/backup-workshop.sh" "$rollback_checkpoint/backup"
  python3 "$script_dir/check-backup.py" "$rollback_checkpoint/backup" "$(readlink -f "$base/app")" 900
fi
if test -f "$checkpoint/codex-bridge/RECOVERY_REQUIRED"; then
  node "$script_dir/codex-bridge.mjs" restore "$checkpoint"
fi
compose "$previous" "${image##*:}" up -d --no-build
health "${image##*:}"
ln -sfn "$previous" "$base/app"
restore_routes "$checkpoint"
diagnose
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$checkpoint/ROLLED_BACK"
echo 'Rollback verified; current Google records, receipts and files preserved.'
