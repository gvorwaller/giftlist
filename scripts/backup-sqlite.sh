#!/usr/bin/env bash
# Produces a consistent snapshot of the SQLite database using SQLite's online
# backup API. Safe to run while the app is serving requests — the .backup
# command acquires a read transaction and copies pages without blocking writers.
#
# Intended use: Carbon Copy Cloner pre-flight script, before CCC copies the
# data/backup/ directory to the Synology NAS. Run independently any time you
# want a clean on-disk snapshot.
#
# Outputs:
#   <project>/data/backup/gifttracker.db        — local dev snapshot
#   <project>/data/backup/prod/gifttracker.db   — prod snapshot pulled via SSH
#   <project>/data/backup/prod/.env             — prod .env (secrets — 600)
#   <project>/data/backup/prod/PULL_OK_AT       — ISO-8601 timestamp on success
#
# Use --local-only to skip the prod pull (offline / dev-only scenarios).
# Prod pull failures exit 3 but the local snapshot is still produced first so
# CCC has at least the dev DB to upload.

set -euo pipefail

# Resolve the project root relative to this script so CCC can invoke it via
# any working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SRC_DB="${PROJECT_ROOT}/data/gifttracker.db"
BACKUP_DIR="${PROJECT_ROOT}/data/backup"
DEST_DB="${BACKUP_DIR}/gifttracker.db"

PROD_BACKUP_DIR="${BACKUP_DIR}/prod"
PROD_DB_DEST="${PROD_BACKUP_DIR}/gifttracker.db"
PROD_ENV_DEST="${PROD_BACKUP_DIR}/.env"
PROD_PULL_MARKER="${PROD_BACKUP_DIR}/PULL_OK_AT"

DROPLET="root@134.199.211.199"
PROD_APP_DIR="/opt/giftlist"

LOCAL_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --local-only) LOCAL_ONLY=1 ;;
    -h|--help)
      echo "Usage: $0 [--local-only]"
      exit 0
      ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# --- local snapshot ---------------------------------------------------------
if [[ ! -f "${SRC_DB}" ]]; then
  echo "[backup-sqlite] source DB not found: ${SRC_DB}" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"

# SQLite's .backup command is transactional and handles WAL checkpointing
# internally — the resulting file has no companion .db-wal / .db-shm.
# -bail causes any error (lock contention, I/O, etc.) to propagate.
/usr/bin/sqlite3 -bail "${SRC_DB}" ".backup '${DEST_DB}'"

INTEGRITY="$(/usr/bin/sqlite3 -bail "${DEST_DB}" 'PRAGMA integrity_check;')"
if [[ "${INTEGRITY}" != "ok" ]]; then
  echo "[backup-sqlite] local integrity check failed: ${INTEGRITY}" >&2
  exit 2
fi

SIZE="$(/usr/bin/stat -f%z "${DEST_DB}" 2>/dev/null || /usr/bin/wc -c < "${DEST_DB}")"
echo "[backup-sqlite] local snapshot ok: ${DEST_DB} (${SIZE} bytes)"

# --- prod pull --------------------------------------------------------------
if [[ ${LOCAL_ONLY} -eq 1 ]]; then
  echo "[backup-sqlite] --local-only: skipping prod pull"
  exit 0
fi

mkdir -p "${PROD_BACKUP_DIR}"

# We snapshot prod-side to a tmp file, scp it down, then clean up the tmp.
# Using BatchMode so SSH fails fast if no agent/key is available (e.g. CCC
# running with a stripped env) instead of hanging on a password prompt.
PROD_TMP="${PROD_APP_DIR}/data/backup/.ccc-pull-tmp.db"
SSH_OPTS="-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5"

# Disable strict error-out for the network section so we can clean up before
# exiting on partial failure.
set +e

ssh ${SSH_OPTS} "${DROPLET}" "/usr/bin/sqlite3 -bail '${PROD_APP_DIR}/data/gifttracker.db' \".backup '${PROD_TMP}'\""
if [[ $? -ne 0 ]]; then
  echo "[backup-sqlite] prod snapshot via SSH failed (droplet unreachable or sqlite3 errored)" >&2
  rm -f "${PROD_PULL_MARKER}"
  exit 3
fi

scp ${SSH_OPTS} "${DROPLET}:${PROD_TMP}" "${PROD_DB_DEST}"
SCP_DB_RC=$?
scp ${SSH_OPTS} "${DROPLET}:${PROD_APP_DIR}/.env" "${PROD_ENV_DEST}"
SCP_ENV_RC=$?

# Clean up the prod-side tmp regardless of scp outcome.
ssh ${SSH_OPTS} "${DROPLET}" "rm -f '${PROD_TMP}'" >/dev/null 2>&1

set -e

if [[ ${SCP_DB_RC} -ne 0 ]]; then
  echo "[backup-sqlite] scp of prod DB failed" >&2
  rm -f "${PROD_PULL_MARKER}"
  exit 3
fi
if [[ ${SCP_ENV_RC} -ne 0 ]]; then
  echo "[backup-sqlite] scp of prod .env failed" >&2
  rm -f "${PROD_PULL_MARKER}"
  exit 3
fi

# Tighten .env permissions — it contains AUTH_SECRET, OAuth secrets, Telegram token.
chmod 600 "${PROD_ENV_DEST}"

# Integrity check the pulled prod DB before CCC uploads it.
PROD_INTEGRITY="$(/usr/bin/sqlite3 -bail "${PROD_DB_DEST}" 'PRAGMA integrity_check;')"
if [[ "${PROD_INTEGRITY}" != "ok" ]]; then
  echo "[backup-sqlite] prod DB integrity check failed: ${PROD_INTEGRITY}" >&2
  rm -f "${PROD_PULL_MARKER}"
  exit 4
fi

PROD_SIZE="$(/usr/bin/stat -f%z "${PROD_DB_DEST}" 2>/dev/null || /usr/bin/wc -c < "${PROD_DB_DEST}")"
date -u +%Y-%m-%dT%H:%M:%SZ > "${PROD_PULL_MARKER}"
echo "[backup-sqlite] prod snapshot ok: ${PROD_DB_DEST} (${PROD_SIZE} bytes), .env captured"
