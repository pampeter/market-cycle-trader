#!/bin/bash
# -----------------------------------------------------------------------------
# Market Cycle Trader — Google Cloud CLI deployment (alternative to the
# point-and-click flow in deploy/gcp/README.md).
#
# Run this on YOUR machine (where you have the gcloud CLI installed and are
# logged in). It creates an e2-micro VM in the free tier and provisions the
# bot via the startup script.
#
# Prereqs:
#   gcloud auth login            # log in with your Google account
#   gcloud config set project <YOUR_PROJECT_ID>
#
# Usage:
#   ZONE=us-central1-a ./deploy/gcp/gcloud.sh
#
# Optional (to go live immediately — handle with care):
#   API_TOKEN=xxxx LIVE_TRADING=true ZONE=us-central1-a ./deploy/gcp/gcloud.sh
# -----------------------------------------------------------------------------
set -euo pipefail

PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
ZONE="${ZONE:-us-central1-a}"
NAME="${NAME:-crash500-bot}"
MACHINE="${MACHINE:-e2-micro}"
IMAGE="${IMAGE:-projects/debian-cloud/global/images/family/debian-12}"

if [ -z "$PROJECT" ]; then
  echo "No GCP project set. Run: gcloud config set project <PROJECT_ID>" >&2
  exit 1
fi

echo "Deploying '$NAME' in project '$PROJECT' zone '$ZONE'…"

# Ensure the Compute Engine API is enabled.
gcloud services enable compute.googleapis.com

# Startup script from the repo (substitute optional token/live values).
STARTUP="$(cat "$(dirname "$0")/startup-script.sh")"

gcloud compute instances create "$NAME" \
  --zone="$ZONE" \
  --machine-type="$MACHINE" \
  --image="$IMAGE" \
  --boot-disk-size=10GB \
  --metadata=startup-script="$STARTUP" \
  ${API_TOKEN:+--metadata=api-token="$API_TOKEN"} \
  ${LIVE_TRADING:+--metadata=live-trading="$LIVE_TRADING"} \
  --tags=http-server

# Allow the dashboard on port 3000 (optional — remove to keep it private and
# use an SSH tunnel instead).
gcloud compute firewall-rules create allow-mct-dashboard \
  --allow tcp:3000 --target-tags=http-server --quiet 2>/dev/null \
  || echo "Firewall rule may already exist — skipping."

EXTERNAL_IP="$(gcloud compute instances describe "$NAME" --zone="$ZONE" --format='value(networkInterfaces[0].accessConfigs[0].natIP)')"

echo
echo "✅ VM '$NAME' created and provisioning (this can take ~2 minutes)."
echo "   SSH in and watch it start:"
echo "     gcloud compute ssh $NAME --zone=$ZONE"
echo "     sudo journalctl -u market-cycle-trader -f"
echo "   Dashboard (if firewall opened): http://$EXTERNAL_IP:3000"
