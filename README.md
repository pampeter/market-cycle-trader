# market-cycle-trader

| Project | What it is |
|---|---|
| `index.html` (CycleFX Pro) | Mobile PWA for manual market-cycle / structure analysis |
| [`deriv-bot/`](deriv-bot/README.md) | 📱 **Phone app** version of the Deriv AI Rise & Fall bot. Install from the browser: <https://pampeter.github.io/market-cycle-trader/deriv-bot/> |
| [`deriv-ai-rise-fall-bot/`](deriv-ai-rise-fall-bot/README.md) | Python auto-trader for Deriv Rise/Fall contracts (ML + optional Groq LLM filter, profit-target auto-stop, paper mode) |
| [`bot/`](bot/README.md) | Crash 500 EMA 4/10 buy-only auto-trader — Node, zero npm dependencies, auto take-profit after 5 × 1-minute candles, plus an offline `npm run demo` mode |
| [`deploy/gcp/`](deploy/gcp/README.md) | Run `bot/` **24/7** on a free-tier Google Cloud VM (startup script, systemd unit, CLI helper) |

Each project has its own README. Never commit your `.env` — it holds your Deriv API token.
