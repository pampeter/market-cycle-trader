# Market Cycle Trader — Crash 500 EMA Bot

An automated **buy-only** trading bot for Deriv's **Crash 500** synthetic index.

**Strategy (the exact rules):**

1. **Market** — `CRASH500` (Deriv Crash 500). **BUY only** — it never sells short.
2. **Timeframe** — 1-minute candles.
3. **Entry** — *"If price starts trading above the 10 & 4 exponential moving average it is bullish."* When a completed candle closes above **both** the **EMA 4** and **EMA 10** (and the previous candle did not close above both) → **BUY**.
4. **Exit** — **Take profit automatically after 5 completed 1-minute candles**.

Signals are evaluated only on **completed** candles (never on a candle that is still forming), and the bot holds at most one position at a time.

> ⚠️ **Risk disclaimer.** This software places real orders when you explicitly switch it to live mode. Crash 500 is a high-risk synthetic index. Past rules do not guarantee future results. Test on a Deriv **demo account** first, and never trade money you cannot afford to lose. This is not financial advice.

---

## Repo layout

```
market-cycle-trader/
├── bot/                      ← the auto-trader (this is the main deliverable)
│   ├── src/
│   │   ├── index.js          ← entry point / CLI
│   │   ├── config.js         ← env + config loading and validation
│   │   ├── indicators.js     ← EMA
│   │   ├── strategy.js       ← BUY / take-profit state machine (pure, testable)
│   │   ├── deriv.js          ← Deriv WebSocket API client (zero dependencies)
│   │   ├── trader.js         ← wires strategy ↔ Deriv (dry-run / live)
│   │   ├── demo.js           ← synthetic candle feed (no network needed)
│   │   └── server.js         ← local status dashboard
│   ├── web/index.html        ← live dashboard (price / EMA4 / EMA10 / trades)
│   ├── test/                 ← unit tests (node --test)
│   ├── .env.example
│   └── package.json
├── index.html                ← existing "CycleFX Pro" manual strategy workbook (unchanged)
└── bot/test/                 ← unit tests (node --test)
```

---

## Requirements

- **Node.js ≥ 22** (uses the built-in `WebSocket`, so there are **zero npm dependencies**).

## Quick start — demo (no API token, no network)

```bash
cd bot
npm run demo
```

Then open **http://localhost:3000** to watch a synthetic Crash 500 feed run the
strategy live: EMA 4/10 lines, BUY markers on the crossover, and automatic
take-profit markers after 5 candles.

## Dry-run (real market data, no real orders)

```bash
cd bot
npm start          # or: node src/index.js
```

Connects to Deriv, streams **real Crash 500 1-minute candles**, evaluates the
strategy, and logs every BUY / TAKE-PROFIT signal **without placing orders**.
This is the default and the safest way to validate the bot.

### Verify your Deriv connection first

```bash
cd bot
node src/index.js --selftest
```

This connects to Deriv, authorizes with your token (if set), prints your
balance, and shows the 5 most recent `CRASH500` 1-minute candles — so you can
confirm connectivity, credentials, and market data in one command before
switching anything on.

> **Note:** the bot must run on a machine with normal internet access (your
> computer, a VPS, etc.). Sandboxed/CI environments with a restricted network
> egress will not be able to reach `ws.derivws.com`.

## Live trading (real orders)

1. Create a Deriv API token with **Read** and **Trade** scopes:
   https://app.deriv.com/account/api-token
   (For your own live app, register an app id at https://developers.deriv.com.)
2. Configure the bot:

   ```bash
   cd bot
   cp .env.example .env
   # edit .env:
   #   API_TOKEN=your-token-here
   #   LIVE_TRADING=true
   #   STAKE=1            (stake per trade)
   #   CONTRACT_TYPE=MULTUP   (or CALL)
   ```

3. Run:

   ```bash
   npm start
   ```

   or force live mode on the command line:

   ```bash
   node src/index.js --live
   ```

**Start with a Deriv demo account** and a tiny stake before considering real funds.

---

## Configuration

| Variable          | Default                  | Meaning                                                        |
| ----------------- | ------------------------ | -------------------------------------------------------------- |
| `SYMBOL`          | `CRASH500`               | Crash 500 synthetic index (buy only)                           |
| `GRANULARITY`     | `60`                     | Candle timeframe in seconds (60 = 1-minute)                    |
| `EMA_FAST`        | `4`                      | Fast EMA period                                                |
| `EMA_SLOW`        | `10`                     | Slow EMA period                                                |
| `HOLD_BARS`       | `5`                      | Take profit after N completed candles                          |
| `CONTRACT_TYPE`   | `MULTUP`                 | `MULTUP` (market buy, closed at TP) or `CALL` (expires in 5m)  |
| `STAKE`           | `1`                      | Stake per trade (in `CURRENCY`)                                |
| `MULTIPLIER`      | `100`                    | Multiplier for `MULTUP` contracts                              |
| `CURRENCY`        | `USD`                    | Account currency                                               |
| `APP_ID`          | `1089`                   | Deriv app id (1089 = public test app)                          |
| `ENDPOINT`        | `wss://ws.derivws.com/…` | Deriv WebSocket endpoint                                       |
| `API_TOKEN`       | *(empty)*                | Deriv API token (Read + Trade)                                 |
| `LIVE_TRADING`    | `false`                  | `true` to enable real orders                                   |
| `PORT`            | `3000`                   | Local dashboard port                                           |

### `CONTRACT_TYPE` explained

- **`MULTUP`** (recommended) — a multiplier contract: the bot **buys at market**
  on the signal and **closes (sells) the position after 5 candles**, realising
  the profit/loss of those 5 minutes. This matches "buy market + take profit
  after 5 × 1-min candles" most directly.
- **`CALL`** — a binary up contract with a **5-minute duration** that expires
  automatically in-the-money/out-of-the-money after 5 candles. No manual close.

---

## Tests

```bash
cd bot
npm test
```

Unit tests cover the EMA math and the full strategy state machine (warm-up,
BUY crossover, exactly-5-candle take profit, no re-entry while above the EMAs,
and no short selling).

---

## How the candle handling works (important)

Deriv's candle subscription may stream the **forming** candle. To respect the
rule exactly, `trader.js` buffers the latest candle and only passes it to the
strategy once a **newer candle epoch** arrives — i.e. the buffered candle is
guaranteed to be **closed**. Decisions are therefore always made on completed
1-minute candles, never mid-candle.
