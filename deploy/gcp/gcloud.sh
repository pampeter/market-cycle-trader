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
# The VM comes up in DRY-RUN with no credentials, and the dashboard stays
# private (SSH tunnel). To connect Deriv later, edit bot/.env on the VM:
#   gcloud compute ssh crash500-bot --zone=us-central1-a -- -t \
#     'sudo -u mct nano /opt/market-cycle-trader/bot/.env'
# Never pass the token as a CLI argument or as GCE instance metadata — both
# are readable by others, land in shell history, and outlive the VM.
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

# Startup script from the repo (it writes bot/.env itself, in dry-run).
STARTUP="$(cat "$(dirname "$0")/startup-script.sh")"

gcloud compute instances create "$NAME" \
  --zone="$ZONE" \
  --machine-type="$MACHINE" \
  --image="$IMAGE" \
  --boot-disk-size=10GB \
  --metadata=startup-script="$STARTUP" \
  --no-service-account --no-scopes

# Two deliberate differences from the earlier version of this script:
#   1. No `--tags=http-server` and no `allow-mct-dashboard` firewall rule.
#      The dashboard has no login, so it is reachable only through an SSH
#      tunnel:  gcloud compute ssh $NAME --zone=$ZONE -- -L 3000:localhost:3000
#      bot/.env also binds it to 127.0.0.1, so a stray firewall rule alone
#      cannot expose it either.
#   2. `--no-service-account --no-scopes` (above): the bot needs no GCP APIs, so
#      the VM is given no cloud credentials at all. If this box is ever
#      compromised there is no service-account token to steal, and no
#      instance-metadata secret to read — which is also why the Deriv token is
#      written to bot/.env over SSH rather than passed in as metadata.

echo
echo "✅ VM '$NAME' created and provisioning (this can take ~2 minutes)."
echo "   Watch it start:"
echo "     gcloud compute ssh $NAME --zone=$ZONE"
echo "     sudo journalctl -u market-cycle-trader -f"
echo "   Dashboard — tunnel it, then open http://localhost:3000 :"
echo "     gcloud compute ssh $NAME --zone=$ZONE -- -L 3000:localhost:3000"
echo "   Verify it can reach Deriv (real candles, still no orders):"
echo "     gcloud compute ssh $NAME --zone=$ZONE -- -t 'cd /opt/market-cycle-trader/bot && sudo -u mct node src/index.js --selftest'"
