#!/usr/bin/env bash
# Deploy giftlist to the shared DigitalOcean droplet.
#
# Two instances run from the same repo (separate checkouts, own .env + SQLite):
#   giftlist     /opt/giftlist     port 3001  https://gifts.gaylon.photos
#   giftlist-cv  /opt/giftlist-cv  port 3005  https://giftlist-cv.gaylon.photos
#
# By default BOTH are deployed so they never drift. Use --target to deploy one.
#
# Flow (per instance):
#   1. local pre-flight (clean tree, on main, pushed) — once
#   2. (optional) push pending commits — once
#   3. SSH single-shot:
#      a. snapshot prod DB to data/backup/pre-deploy-<utc>.db
#      b. git pull --ff-only
#      c. NODE_ENV=development npm ci  (devDeps required; PM2 env contaminates shell)
#      d. npm run build
#      e. pm2 restart <app> --update-env
#      f. local /healthz must return status:ok
#   4. verify public URL
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

# Instance table (macOS ships bash 3.2 — no associative arrays).
# instance_field <name> dir|port|host
instance_field() {
  case "$1:$2" in
    giftlist:dir)      echo "/opt/giftlist" ;;
    giftlist:port)     echo "3001" ;;
    giftlist:host)     echo "gifts.gaylon.photos" ;;
    giftlist-cv:dir)   echo "/opt/giftlist-cv" ;;
    giftlist-cv:port)  echo "3005" ;;
    giftlist-cv:host)  echo "giftlist-cv.gaylon.photos" ;;
    *) return 1 ;;
  esac
}
ALL_TARGETS=(giftlist giftlist-cv)

# --- argument parsing -------------------------------------------------------
SKIP_PUSH=0
TARGETS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-push) SKIP_PUSH=1; shift ;;
    --target)
      [[ $# -ge 2 ]] || { echo "--target requires a value" >&2; exit 2; }
      TARGETS+=("$2"); shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--skip-push] [--target giftlist|giftlist-cv]..."
      echo ""
      echo "Deploys current main to ${DROPLET_IP}. Default: all instances (${ALL_TARGETS[*]})."
      echo "Bails if working tree is dirty or local main is behind origin/main."
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done
[[ ${#TARGETS[@]} -gt 0 ]] || TARGETS=("${ALL_TARGETS[@]}")
for t in "${TARGETS[@]}"; do
  instance_field "$t" dir >/dev/null || { echo "Unknown target: $t (valid: ${ALL_TARGETS[*]})" >&2; exit 2; }
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

# --- remote deploy (per instance) -------------------------------------------
for TARGET in "${TARGETS[@]}"; do
  APP_DIR="$(instance_field "$TARGET" dir)"
  PM2_APP="${TARGET}"
  HEALTH_URL="http://127.0.0.1:$(instance_field "$TARGET" port)/healthz"
  PUBLIC_URL="https://$(instance_field "$TARGET" host)/healthz"

  say "Deploying ${TARGET} -> root@${DROPLET_IP}:${APP_DIR}"

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

  say "Public URL health check (${TARGET})"
  if curl -fsS "${PUBLIC_URL}"; then
    echo ""
    say "${TARGET} live at ${PUBLIC_URL%/healthz}"
  else
    warn "Public health check failed (${PUBLIC_URL}) — local healthz passed; DNS/Nginx may not be set up yet."
  fi
done

say "Deploy complete: ${LOCAL_SHA:0:7} (${TARGETS[*]})"
