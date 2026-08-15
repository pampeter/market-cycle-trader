# Deploy to Google Cloud (24/7 VPS)

Run the Crash 500 EMA bot on a Google Cloud VM so it keeps watching the live
market and trading around the clock, without your laptop being on.

> **You must create the Google Cloud account yourself** — it needs your email,
> your payment method, and Google's phone verification. This guide covers
> everything after that, and the VM provisions + starts the bot automatically.

---

## Part 1 — Create the account (one time, ~5 minutes)

1. Go to https://cloud.google.com → **Get started for free** (or **Console**).
2. Sign in with your Google account.
3. Enter your country and a **payment method** (a card is required for the
   free tier, but you won't be charged while you stay within free-tier limits).
4. Accept the Terms of Service.

You now have a Google Cloud project (you can rename it — e.g. `crash500-bot`).

---

## Part 2 — Create the VM with the startup script

1. In the console, search for **Compute Engine** → **VM instances** →
   **Create instance**.
2. Fill in:
   - **Name:** `crash500-bot`
   - **Region/Zone:** keep the default or pick one near you
     (e.g. `us-central1 (Iowa)`).
   - **Machine type:** **`e2-micro`** (free-tier eligible — 2 shared vCPU,
     1 GB RAM — more than enough for this bot).
   - **Boot disk:** click **Change** → Debian or Ubuntu LTS → **10 GB** (free).
   - **Firewall:** tick **Allow HTTP traffic** (optional — only needed if you
     want the dashboard reachable over the internet; otherwise use the SSH
     tunnel in Part 4, which is safer).
3. Expand **Advanced options** → **Management** → **Automation** → paste the
   contents of [`startup-script.sh`](startup-script.sh) into the
   **Startup script** box.
4. Click **Create**.

The VM boots, installs Node 22, clones this repo, and starts the bot as a
systemd service — automatically.

---

## Part 3 — Check it's running

In the VM list, find your instance and click **SSH** (opens a browser
terminal), then:

```bash
sudo journalctl -u market-cycle-trader -f
```

You should see the bot stream real Crash 500 candles and log signals like:

```
⬆ BUY signal @ ... (above EMA4=... & EMA10=...)
✓ TAKE PROFIT after 5 × 1-min candles — exit ... (+... pts)
```

First run a connectivity check from the VM:

```bash
cd /opt/market-cycle-trader/bot
sudo -u mct node src/index.js --selftest
```

---

## Part 4 — View the dashboard (optional)

The dashboard runs on port 3000 on the VM. Safest way is an SSH tunnel from
your laptop:

```bash
gcloud compute ssh crash500-bot --zone us-central1-a -- -L 3000:localhost:3000
```

Then open **http://localhost:3000** in your browser.

---

## Part 5 — Turn on REAL trading (careful!)

The bot starts in **dry-run** (real candles, no orders). To place real orders:

1. Create a Deriv API token with **Read + Trade** scopes at
   https://app.deriv.com/account/api-token — **use a Deriv DEMO account first**.
2. On the VM, edit the config:

   ```bash
   sudo -u mct nano /opt/market-cycle-trader/bot/.env
   ```

   Set:
   ```ini
   API_TOKEN=your-deriv-api-token
   LIVE_TRADING=true
   STAKE=1
   CONTRACT_TYPE=MULTUP
   ```
3. Restart the bot:

   ```bash
   sudo systemctl restart market-cycle-trader
   sudo journalctl -u market-cycle-trader -f
   ```

> ⚠️ **Risk warning.** Crash 500 is a high-risk synthetic index. From this
> point on the bot places real orders with real money. Start tiny and on a
> demo account. Not financial advice.

---

## Managing the bot

```bash
sudo systemctl status  market-cycle-trader   # status
sudo systemctl restart market-cycle-trader   # restart
sudo systemctl stop    market-cycle-trader   # stop
sudo journalctl -u market-cycle-trader -f    # follow logs
```

The bot auto-restarts on crash and on every VM reboot (it's `enabled`).

## Update to a newer version of the bot

```bash
sudo systemctl stop market-cycle-trader
cd /opt/market-cycle-trader && sudo -u mct git fetch origin arena/01a002ba-market-cycle-trader && sudo -u mct git reset --hard origin/arena/01a002ba-market-cycle-trader
sudo systemctl restart market-cycle-trader
```

## Cost

- `e2-micro` + 10 GB standard disk sits inside the **Google Cloud free tier**
  ($0/month in supported regions like `us-central1`, `us-west1`, `us-east1`).
- Check https://cloud.google.com/free for current free-tier terms.
