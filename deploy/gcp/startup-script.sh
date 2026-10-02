#!/bin/bash
# -----------------------------------------------------------------------------
# Market Cycle Trader — Google Cloud VM startup script
# -----------------------------------------------------------------------------
# Paste this into the "Startup script" field when creating your Compute Engine
# VM (or into the instance's "Custom metadata" as `startup-script`). On first
# boot it will:
#   1. Install Node.js 22 (required — the bot uses the built-in WebSocket)
#   2. Create a locked-down `mct` user
#   3. Clone this repository (main by default; override with the `bot-branch`
#      instance metadata attribute) into /opt/market-cycle-trader
#   4. Write /opt/.../bot/.env in DRY-RUN mode.
#      The Deriv API token is deliberately NOT read from instance metadata —
#      GCE metadata is plaintext: readable by any process on the box, by
#      `gcloud compute instances describe`, and by anyone with read access to
#      the project. Set the token over SSH afterwards instead.
#   5. Install & start a systemd service that keeps the bot running 24/7
#
# The bot starts in DRY-RUN by default (real Crash 500 candles, no orders).
# You switch on real trading afterwards — see deploy/gcp/README.md.
# -----------------------------------------------------------------------------
set -euo pipefail

exec > >(tee -a /var/log/market-cycle-trader-setup.log) 2>&1

APP_DIR=/opt/market-cycle-trader
REPO_URL=https://github.com/pampeter/market-cycle-trader.git
BOT_USER=mct
METADATA_URL="http://metadata.google.internal/computeMetadata/v1/instance/attributes"

# Run main by default. Do not point this at a throwaway session/feature branch:
# step 3 does `git reset --hard origin/$BRANCH` on every boot, so a deleted or
# force-pushed branch silently changes (or kills) what your bot trades.
BRANCH="$(curl -s -H 'Metadata-Flavor: Google' "$METADATA_URL/bot-branch" 2>/dev/null | tr -d '[:space:]')"
BRANCH="${BRANCH:-main}"

echo "[setup] start $(date -u)"

# 1. Node.js 22 -------------------------------------------------------------
NEED_NODE=0
if ! command -v node >/dev/null 2>&1; then
  NEED_NODE=1
else
  MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "$MAJOR" -ge 22 ] || NEED_NODE=1
fi

if [ "$NEED_NODE" = "1" ]; then
  echo "[setup] installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get update -y
  apt-get install -y nodejs git
fi
echo "[setup] node: $(node --version)"

# 2. Service user ------------------------------------------------------------
if ! id -u "$BOT_USER" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$BOT_USER"
fi

# 3. Clone / update repo -----------------------------------------------------
if [ ! -d "$APP_DIR/.git" ]; then
  echo "[setup] cloning repository (branch $BRANCH)"
  git clone -b "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  echo "[setup] updating repository"
  git -C "$APP_DIR" fetch origin "$BRANCH" || true
  git -C "$APP_DIR" checkout "$BRANCH" || true
  git -C "$APP_DIR" reset --hard "origin/$BRANCH" || true
fi

# 4. Credentials are intentionally NOT read from instance metadata.

# 5. Write .env (dry-run by default, dashboard on loopback) -----------------
cat > "$APP_DIR/bot/.env" <<EOF
APP_ID=1089
ENDPOINT=wss://ws.derivws.com/websockets/v3
SYMBOL=CRASH500
GRANULARITY=60
EMA_FAST=4
EMA_SLOW=10
HOLD_BARS=5
CONTRACT_TYPE=MULTUP
STAKE=1
MULTIPLIER=100
CURRENCY=USD
DURATION=1
DURATION_UNIT=d
SEED_CANDLES=60
PORT=3000
HOST=127.0.0.1
API_TOKEN=
LIVE_TRADING=false
EOF
chown "$BOT_USER:$BOT_USER" "$APP_DIR/bot/.env"
chmod 600 "$APP_DIR/bot/.env"

# 6. systemd service ---------------------------------------------------------
install -m 0644 "$APP_DIR/deploy/gcp/market-cycle-trader.service" \
  /etc/systemd/system/market-cycle-trader.service
systemctl daemon-reload
systemctl enable market-cycle-trader.service
systemctl restart market-cycle-trader.service

chown -R "$BOT_USER:$BOT_USER" "$APP_DIR"

echo "[setup] done $(date -u)"
echo "[setup] logs:            sudo journalctl -u market-cycle-trader -f"
echo "[setup] dashboard:       gcloud compute ssh <instance> --zone=<zone> -- -L 3000:localhost:3000"
echo "[setup]                    then open http://localhost:3000"
echo "[setup] connect Deriv:   sudo -u mct nano $APP_DIR/bot/.env"
echo "[setup]                    set API_TOKEN=... (and LIVE_TRADING=true only"
echo "[setup]                    when you mean it), then: sudo systemctl restart market-cycle-trader"
