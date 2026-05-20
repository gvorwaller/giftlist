#!/bin/bash
# Wave 1 dev iteration helper. One command bundles the three steps you
# repeat every time you want to retest LLM-matching against the same set
# of staged Amazon emails:
#
#   1. Snapshot the live dev DB (atomic copy of WAL state).
#   2. Move every message under Giftlist/Amazon/Processed back into
#      Giftlist/Amazon/Inbox so the next scan finds them fresh.
#   3. Launch the dev server.
#
# Flags:
#   --no-snapshot   Skip step 1.
#   --no-relabel    Skip step 2.
#   --no-dev        Skip step 3 (do prep only; you launch dev separately).
#   --restore       Restore the most recent dev snapshot BEFORE step 1
#                   (rolls back yesterday's test commits). Implies
#                   --no-snapshot, since you don't need to snapshot the
#                   restored state.
#
# Typical full loop:
#   ./scripts/dev-wave1-iteration.sh --restore    # roll back + relabel + serve
#   # ...test in browser...
#   ./scripts/dev-wave1-iteration.sh --restore    # again to iterate

set -euo pipefail

export PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"

DO_SNAPSHOT=1
DO_RELABEL=1
DO_DEV=1
DO_RESTORE=0

for arg in "$@"; do
	case "${arg}" in
		--no-snapshot) DO_SNAPSHOT=0 ;;
		--no-relabel)  DO_RELABEL=0 ;;
		--no-dev)      DO_DEV=0 ;;
		--restore)     DO_RESTORE=1; DO_SNAPSHOT=0 ;;
		-h|--help)
			grep -E '^# ' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*)
			echo "Unknown flag: ${arg}" >&2
			exit 1
			;;
	esac
done

DB_PATH="${PROJECT_ROOT}/data/gifttracker.db"
BACKUP_DIR="${PROJECT_ROOT}/data/backup"
SNAPSHOT_PATH="${BACKUP_DIR}/gifttracker.db"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }

if [[ "${DO_RESTORE}" == "1" ]]; then
	bold "==> Restoring dev DB from ${SNAPSHOT_PATH}"
	if [[ ! -f "${SNAPSHOT_PATH}" ]]; then
		echo "  No snapshot found at ${SNAPSHOT_PATH}. Run with --no-restore the first time to create one." >&2
		exit 2
	fi
	# Stop any running dev server holding the WAL — best-effort, ignore if none.
	if pgrep -f "vite dev --port 5175" > /dev/null; then
		note "killing running dev server first (so SQLite WAL flushes cleanly)…"
		pkill -f "vite dev --port 5175" || true
		sleep 1
	fi
	cp "${SNAPSHOT_PATH}" "${DB_PATH}"
	# WAL/SHM sidecars from the prior session may be stale — remove so SQLite
	# reopens the restored DB without trying to replay phantom WAL pages.
	rm -f "${DB_PATH}-wal" "${DB_PATH}-shm"
	note "restored. WAL/SHM sidecars cleared."
fi

if [[ "${DO_SNAPSHOT}" == "1" ]]; then
	bold "==> Snapshotting dev DB → ${SNAPSHOT_PATH}"
	"${SCRIPT_DIR}/backup-sqlite.sh" --local-only
fi

if [[ "${DO_RELABEL}" == "1" ]]; then
	bold "==> Relabelling Gmail: Giftlist/Amazon/Processed → Giftlist/Amazon/Inbox"
	GIFTLIST_DEV_RELABEL_OK=1 npx --yes tsx "${SCRIPT_DIR}/dev-relabel-amazon.ts"
fi

if [[ "${DO_DEV}" == "1" ]]; then
	bold "==> Launching dev server (http://localhost:5175)"
	note "Sign in as admin, hit '/admin/imports/amazon', then 'Scan now'."
	note "Ctrl+C to stop. Re-run this script with --restore to roll back commits."
	exec npm run dev
fi

bold "==> Done."
