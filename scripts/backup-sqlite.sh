#!/usr/bin/env bash
# Produces a consistent snapshot of the SQLite database using SQLite's online
# backup API. Safe to run while the app is serving requests — the .backup
# command acquires a read transaction and copies pages without blocking writers.
#
# Intended use: Carbon Copy Cloner pre-flight script, before CCC copies the
# data/backup/ directory to the Synology NAS. Run independently any time you
# want a clean on-disk snapshot.
#
# Output: <project>/data/backup/gifttracker.db (single file, no WAL/-shm).

set -euo pipefail

# Resolve the project root relative to this script so CCC can invoke it via
# any working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SRC_DB="${PROJECT_ROOT}/data/gifttracker.db"
BACKUP_DIR="${PROJECT_ROOT}/data/backup"
DEST_DB="${BACKUP_DIR}/gifttracker.db"

if [[ ! -f "${SRC_DB}" ]]; then
  echo "[backup-sqlite] source DB not found: ${SRC_DB}" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"

# SQLite's .backup command is transactional and handles WAL checkpointing
# internally — the resulting file has no companion .db-wal / .db-shm.
# -bail causes any error (lock contention, I/O, etc.) to propagate.
/usr/bin/sqlite3 -bail "${SRC_DB}" ".backup '${DEST_DB}'"

# Integrity check the snapshot before CCC uploads it. If this fails, the
# previous good snapshot stays in place (CCC will re-upload it).
INTEGRITY="$(/usr/bin/sqlite3 -bail "${DEST_DB}" 'PRAGMA integrity_check;')"
if [[ "${INTEGRITY}" != "ok" ]]; then
  echo "[backup-sqlite] integrity check failed: ${INTEGRITY}" >&2
  exit 2
fi

SIZE="$(/usr/bin/stat -f%z "${DEST_DB}" 2>/dev/null || /usr/bin/wc -c < "${DEST_DB}")"
echo "[backup-sqlite] snapshot ok: ${DEST_DB} (${SIZE} bytes)"
