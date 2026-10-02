# 🤖 Deriv AI Rise & Fall Bot

An automated **Rise/Fall (CALL/PUT)** trader for [Deriv](https://deriv.com) Volatility Indices.
It connects to your Deriv account through the official WebSocket API. A machine-learning model trained on the latest ticks picks candidate trades, and an optional **Groq LLM** filters them. The bot **stops automatically once it reaches your daily profit target**, or when any risk limit is hit.

> 📱 Want it on your phone? See the installable app version in [`../deriv-bot`](../deriv-bot/README.md).

> ⚠️ **Please read the [risk warning](#-risk-warning-read-this) first.** The bot starts in **paper-trading mode** and never places a real order until you change that yourself.

---

## Features

| | |
|---|---|
| 📡 **Deriv WebSocket API** | `wss://ws.derivws.com/websockets/v3`, live tick stream, proposal → buy → contract tracking |
| 🎯 **Contract** | 5-tick Rise (CALL) / Fall (PUT), default symbol `R_75` (any Volatility Index works) |
| 🧠 **ML engine** | scikit-learn `LogisticRegression`, retrained on every tick using the last ~100 ticks. Features: return, momentum, volatility, EMA8−EMA21, SMA5−SMA10. Also reports an honest **out-of-sample (holdout) accuracy** |
| 🤖 **LLM filter (Groq)** | Receives the ML probabilities, features and last 20 ticks, and returns JSON `{direction, confidence, reason}`. A trade only happens if **ML ≥ 60 %**, **LLM confidence ≥ 78** and both **agree on the direction** |
| 🏁 **Profit target auto-stop** | When today's P/L reaches `PROFIT_TARGET`, the bot stops, prints a final report and disconnects |
| 🛡️ **Risk management** | Daily loss limit (it also refuses a trade that *could* go past the limit), max trades/day, max consecutive losses, cooldown, **no martingale** |
| 💾 **Persistent daily state** | Restarting on the same day does **not** reset the loss limit or the target (`state/daily_<mode>.json`) |
| 📝 **Paper trading** | Simulates trades on real live ticks using real Deriv payout quotes, following Deriv's rules (entry = next tick, exit = 5th tick after entry, a tie counts as a loss) |
| 🔒 **Safety locks** | Live mode asks you to type `YES`. It also **refuses real-money accounts** unless you set `ALLOW_REAL_ACCOUNT=true` |
| 🔄 **Auto-reconnect** | Exponential back-off. It reconnects to any contract that was open when the connection dropped |
| 🎨 **Rich console** | Colour panels, trade tables and a final report. Every trade is also logged to `state/trades.csv` |

---

## 1. Install

Requires **Python 3.10+**.

```bash
cd deriv-ai-rise-fall-bot
python -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # Windows: copy .env.example .env
```

## 2. Connect your Deriv account

1. Log in to Deriv and **switch to your Demo account** (recommended).
2. Open **Account Settings → API token** (<https://app.deriv.com/account/api-token>).
3. Create a token with the **Read** and **Trade** scopes. Copy it.
4. Paste it into `.env`:
   ```ini
   DERIV_API_TOKEN=abc123yourtoken
   ```
5. Test the connection:
   ```bash
   python bot.py --check
   ```
   You should see your login ID, account type (Demo/Real), balance and a live price quote.

> The token lets the bot trade on the account it belongs to. Keep it secret, never commit `.env`, and delete the token on Deriv when you no longer need it. A Demo token only has access to virtual money.

`DERIV_APP_ID=1089` is Deriv's public test app ID, and it works as-is. If you prefer, you can register your own app at <https://api.deriv.com>.

## 3. (Optional) Enable the LLM filter

Get a free API key at <https://console.groq.com/keys>:

```ini
USE_LLM=true
GROQ_API_KEY=gsk_...
GROQ_MODEL=openai/gpt-oss-120b
```

Without a key, the bot runs in **ML-only** mode and only the `MIN_ML_PROBABILITY` gate applies.
`GROQ_MODEL` accepts any Groq chat model ID. `llama-3.1-70b-versatile` has been retired, so the default is `openai/gpt-oss-120b`.

## 4. Run

```bash
python bot.py                 # paper trading (default: PAPER_TRADE=true)
```

Once paper results look reasonable over many sessions, you can switch to live trading on your **demo** account:

```ini
PAPER_TRADE=false
```

```bash
python bot.py                 # asks you to type YES
python bot.py --yes           # skip the prompt (e.g. on a server)
```

To trade **real money**, you must also set `ALLOW_REAL_ACCOUNT=true` and use a token from your real account. Don't do this lightly.

Press **Ctrl+C** at any time to stop. An open contract will still settle normally on Deriv.

---

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `DERIV_API_TOKEN` | – | Your Deriv API token (Read + Trade). Optional in paper mode |
| `DERIV_APP_ID` | `1089` | Deriv app ID |
| `SYMBOL` | `R_75` | `R_10`, `R_25`, `R_50`, `R_75`, `R_100`, `1HZ75V`, … |
| `STAKE` | `1.00` | Stake per contract (account currency) |
| `TICK_DURATION` | `5` | Contract length in ticks |
| `PAPER_TRADE` | `true` | `false` = send real orders |
| `ALLOW_REAL_ACCOUNT` | `false` | Must be `true` before live mode will trade a real-money account |
| `PROFIT_TARGET` | `25` | Stop for the day at this profit |
| `MAX_DAILY_LOSS` | `15` | Stop for the day at this loss (enter it as a positive number) |
| `MAX_TRADES_PER_DAY` | `20` | Hard cap on trades per day |
| `MAX_CONSECUTIVE_LOSSES` | `4` | Stop after this many losses in a row (`0` = off) |
| `COOLDOWN_SECONDS` | `30` | Wait between trades |
| `TRAIN_WINDOW` | `100` | Number of ticks the ML model trains on |
| `MIN_ML_PROBABILITY` | `0.60` | Minimum ML probability needed to consider a trade |
| `USE_LLM` | `true` | Use the Groq LLM filter (needs `GROQ_API_KEY`) |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Groq model ID |
| `MIN_AI_CONFIDENCE` | `78` | Minimum LLM confidence |
| `REQUIRE_AGREEMENT` | `true` | ML and LLM must pick the same direction |
| `PAPER_START_BALANCE` | `1000` | Starting balance shown in paper mode |
| `STATE_DIR` | `state` | Where daily state and the trade log are saved |

The "day" follows **UTC**. To reset today's counters manually, delete `state/daily_paper.json` or `state/daily_live.json`. Be careful, because this also resets the loss limit.

---

## How a trade is decided

```
live tick ──► ML (LogisticRegression, retrained on last 100 ticks)
                │  P(RISE) / P(FALL) + holdout accuracy
                ▼
        probability ≥ MIN_ML_PROBABILITY ? ──no──► keep scanning
                │ yes
                ▼
        Groq LLM: {"direction","confidence","reason"}
                │
   HOLD / confidence < MIN_AI_CONFIDENCE / disagrees ──► skip, retry in 10 s
                │ ok
                ▼
        risk checks (target, loss limit, trade count, streak, cooldown)
                │ ok
                ▼
   proposal (5-tick CALL/PUT, stake) ──► buy ──► track contract until sold
                │
                ▼
        update P/L ──► target reached? ──► 🏁 final report + disconnect
```

## Project layout

```
deriv-ai-rise-fall-bot/
├── bot.py                    # CLI entry point (--check, --yes, --env)
├── deriv_bot/
│   ├── config.py             # .env loading + validation
│   ├── deriv_client.py       # async Deriv WebSocket client (req_id routing)
│   ├── ml_engine.py          # features + LogisticRegression
│   ├── llm_engine.py         # Groq JSON decision filter
│   ├── risk.py               # profit target, loss limit, persistence
│   ├── trader.py             # AIDerivRiseFallBot main loop
│   └── ui.py                 # rich console output
├── tests/                    # pytest suite + fake Deriv server
├── .env.example
└── requirements.txt
```

## Tests / offline demo

The test suite runs the full bot against a **fake Deriv server** (`tests/fake_deriv_server.py`) and needs no network access:

```bash
pip install -r requirements-dev.txt
pytest -q
```

You can also watch the bot trade against the fake server:

```bash
python tests/fake_deriv_server.py --port 8765 &
DERIV_WS_URL=ws://127.0.0.1:8765 DERIV_API_TOKEN=demo PAPER_TRADE=false python bot.py --yes
```

---

## ⚠️ Risk warning (read this)

- **Volatility Indices are synthetic.** Deriv generates their prices with a random number generator that is designed to be unpredictable. No indicator, ML model or LLM can give you a reliable edge on them. A high ML probability or LLM confidence **does not** mean a high chance of winning.
- **The payout is below 2× your stake** (about +95 % profit on a win, −100 % on a loss). To break even, you need a win rate of about **51–52 %**. At a coin-flip win rate you lose money slowly over time.
- The profit target decides **when the bot stops**. It does not make reaching that target any more likely. On many days the loss limit will be hit first.
- Deriv's products are complex and carry a high risk of losing money quickly. Only trade money you can afford to lose. Deriv's products are not available in every country, so make sure you are allowed to use them where you live.
- This software is provided **as is, for educational purposes, with no warranty**. You are fully responsible for any trades it places on your account.

Start in paper mode. Then try your demo account for a long time. Pay attention to the results: `state/trades.csv` keeps every trade.
