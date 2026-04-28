#!/usr/bin/env bash
# Deploy giftlist to the shared DigitalOcean droplet.
#
# Flow:
#   1. local pre-flight (clean tree, on main, pushed)
#   2. (optional) push pending commits
#   3. SSH single-shot:
#      a. snapshot prod DB to data/backup/pre-deploy-<utc>.db
#      b. git pull --ff-only
#      c. NODE_ENV=development npm ci  (devDeps required; PM2 env contaminates shell)
#      d. npm run build
#      e. pm2 restart giftlist --update-env
#      f. /healthz must return status:ok
#   4. tail recent pm2 logs + verify public URL
#
# Why the explicit NODE_ENV=development on install: PM2 sets NODE_ENV=production
# in the inherited shell environment. A naive `npm ci` then skips
# devDependencies (vite, svelte-kit, tsx) and the subsequent `npm run build`
# fails with "vite: not found". Forcing NODE_ENV=development for the install
# scope only — runtime stays production via .env loaded by hooks.server.ts.
#
# Safe to rerun if a step fails partway. Use --skip-push to redeploy without
# any new local commits (idempotent).

set -euo pipefail

DROPLET_IP="134.199.211.199"
APP_DIR="/opt/giftlist"
PM2_APP="giftlist"
HEALTH_URL="http://127.0.0.1:3001/healthz"
PUBLIC_URL="https://gifts.gaylon.photos/healthz"

# --- argument parsing -------------------------------------------------------
SKIP_PUSH=0
for arg in "$@"; do
  case "$arg" in
    --skip-push) SKIP_PUSH=1 ;;
    -h|--help)
      echo "Usage: $0 [--skip-push]"
      echo ""
      echo "Deploys current main to ${DROPLET_IP}:${APP_DIR}."
      echo "Bails if working tree is dirty or local main is behind origin/main."
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

# --- output helpers ---------------------------------------------------------
say() { printf '\033[1;32m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!!  %s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31mxx  %s\033[0m\n' "$*" >&2; exit 1; }

# --- local pre-flight -------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.."

say "Local pre-flight"

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "${CURRENT_BRANCH}" == "main" ]] || die "Not on main (on ${CURRENT_BRANCH}). Switch first."

if ! git diff-index --quiet HEAD --; then
  die "Working tree is dirty. Commit or stash before deploying."
fi
if [[ -n "$(git ls-files --others --exclude-standard)" ]]; then
  warn "Untracked files present (not blocking)."
fi

git fetch --quiet origin main

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/main)"

if [[ "${LOCAL_SHA}" != "${REMOTE_SHA}" ]]; then
  if [[ ${SKIP_PUSH} -eq 1 ]]; then
    die "Local and origin/main differ but --skip-push was passed. Resolve or push first."
  fi
  AHEAD="$(git rev-list --count origin/main..HEAD)"
  BEHIND="$(git rev-list --count HEAD..origin/main)"
  if [[ "${BEHIND}" -gt 0 ]]; then
    die "Local main is ${BEHIND} commits behind origin/main. Pull and rebase first."
  fi
  say "Pushing ${AHEAD} commit(s) to origin/main"
  git push origin main
else
  say "Local matches origin/main (${LOCAL_SHA:0:7})"
fi

# --- remote deploy ----------------------------------------------------------
say "Connecting to root@${DROPLET_IP}"

# Single SSH session with `set -e` so any step bails the whole deploy.
# Heredoc is unquoted so we can interpolate APP_DIR/PM2_APP/HEALTH_URL.
ssh "root@${DROPLET_IP}" bash <<EOF
set -euo pipefail

cd "${APP_DIR}"

echo "==> Pre-deploy DB snapshot"
mkdir -p data/backup
SNAP_FILE="data/backup/pre-deploy-\$(date -u +%Y-%m-%dT%H%M%SZ).db"
if [[ -f data/gifttracker.db ]]; then
  # Use the sqlite3 CLI (apt install sqlite3) for the online backup API.
  # Independent of the app's node_modules state — survives interrupted
  # installs. Acquires a read txn and copies pages without blocking writers.
  /usr/bin/sqlite3 -bail data/gifttracker.db ".backup '\${SNAP_FILE}'"
  echo "    snapshot: \${SNAP_FILE} (\$(stat -c%s "\${SNAP_FILE}") bytes)"
else
  echo "    no DB yet — first deploy"
fi

echo "==> git pull --ff-only"
git pull --ff-only

echo "==> npm ci (NODE_ENV=development for devDeps)"
NODE_ENV=development npm ci 2>&1 | tail -3

echo "==> npm run build"
npm run build 2>&1 | tail -5

echo "==> pm2 restart ${PM2_APP}"
pm2 restart "${PM2_APP}" --update-env 2>&1 | tail -2

echo "==> Health check (local, retry up to 20s)"
HEALTH_RESP=""
for i in 1 2 3 4 5 6 7 8 9 10; do
  if HEALTH_RESP="\$(curl -fsS "${HEALTH_URL}" 2>/dev/null)"; then
    echo "    [\${i}/10] \${HEALTH_RESP}"
    break
  fi
  sleep 2
done
if [[ -z "\${HEALTH_RESP}" ]]; then
  echo "Health check failed after 20s"
  pm2 logs ${PM2_APP} --lines 30 --nostream
  exit 1
fi

echo "==> Recent pm2 output"
tail -10 /var/log/pm2/${PM2_APP}-out.log
EOF

say "Public URL health check"
curl -fsS "${PUBLIC_URL}" || die "Public health check failed (${PUBLIC_URL})"
echo ""

say "Deploy complete: ${LOCAL_SHA:0:7} live at ${PUBLIC_URL%/healthz}"
