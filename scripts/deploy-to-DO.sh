#!/usr/bin/env bash
# Deploy giftlist to the shared DigitalOcean droplet.
# Always use this script — never manual SSH + build (see cs.md "Historical Failures").
#
# Flow: push local changes -> SSH to droplet -> pull -> install -> build -> PM2 restart -> health check.
#
# Phase 0: skeleton only. Real deploy wiring comes in Phase 6.

set -euo pipefail

DROPLET_IP="134.199.211.199"
APP_DIR="/opt/giftlist"
PM2_APP="giftlist"
HEALTH_URL="http://127.0.0.1:3001/healthz"

echo "==> deploy-to-DO: Phase 0 skeleton. Full deploy logic lands in Phase 6."
echo "    Target: root@${DROPLET_IP}:${APP_DIR}"
echo "    PM2 app: ${PM2_APP}"
echo "    Health: ${HEALTH_URL}"

# --- Phase 6 will fill in:
# git push origin main
# ssh root@${DROPLET_IP} "cd ${APP_DIR} \
#   && git pull --ff-only \
#   && npm ci \
#   && npm run build \
#   && pm2 restart ecosystem.config.cjs --update-env \
#   && sleep 2 \
#   && curl -fsS ${HEALTH_URL}"

exit 0
