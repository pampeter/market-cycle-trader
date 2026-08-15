#!/bin/bash
# -----------------------------------------------------------------------------
# Market Cycle Trader — Google Cloud VM startup script
# -----------------------------------------------------------------------------
# Paste this into the "Startup script" field when creating your Compute Engine
# VM (or into the instance's "Custom metadata" as `startup-script`). On first
# boot it will:
#   1. Install Node.js 22 (required — the bot uses the built-in WebSocket)
#   2. Create a locked-down `mct` user
#   3. Clone this repository (arena branch) into /opt/market-cycle-trader
#   4. Write /opt/.../bot/.env (pulling API token / live flag from instance
#      metadata if you provided them)
#   5. Install & start a systemd service that keeps the bot running 24/7
#
# The bot starts in DRY-RUN by default (real Crash 500 candles, no orders).
# You switch on real trading afterwards — see deploy/gcp/README.md.
# -----------------------------------------------------------------------------
set -euo pipefail

exec > >(tee -a /var/log/market-cycle-trader-setup.log) 2>&1

APP_DIR=/opt/market-cycle-trader
BRANCH=arena/01a002ba-market-cycle-trader
REPO_URL=https://github.com/pampeter/market-cycle-trader.git
BOT_USER=mct
METADATA_URL="http://metadata.google.internal/computeMetadata/v1/instance/attributes"

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

# 4. Optional values from instance metadata ----------------------------------
API_TOKEN_ATTR="$(curl -s -H 'Metadata-Flavor: Google' "$METADATA_URL/api-token" 2>/dev/null || true)"
LIVE_ATTR="$(curl -s -H 'Metadata-Flavor: Google' "$METADATA_URL/live-trading" 2>/dev/null || true)"

# 5. Write .env (dry-run by default) ----------------------------------------
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
API_TOKEN=${API_TOKEN_ATTR}
LIVE_TRADING=${LIVE_ATTR:-false}
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
echo "[setup] watch logs with: journalctl -u market-cycle-trader -f"
