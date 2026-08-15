'use strict';

const { EmaCrossoverStrategy } = require('./strategy');

/**
 * Demo mode: synthesises 1-minute CRASH500 candles so the full pipeline
 * (EMA 4/10, BUY crossover, 5-candle take profit) can be watched live in
 * the dashboard without an API token or network access.
 *
 * The feed is a random walk with injected up-legs so that bullish
 * crossovers (and the resulting trades) occur regularly.
 */
class DemoFeed {
  constructor({ startPrice = 1000, volatility = 6 } = {}) {
    this.price = startPrice;
    this.volatility = volatility;
    this.epoch = Math.floor(Date.now() / 1000) - 120 * 60;
    this.phaseIndex = 0;
    this.phaseLeft = 0;
    this.drift = 0;
    this._nextPhase();
  }

  _nextPhase() {
    const phases = [
      { drift: 0.0, len: 8 }, // chop
      { drift: 1.4, len: 6 }, // up-leg -> bullish cross
      { drift: 0.3, len: 9 }, // drift up (holds above EMAs)
      { drift: -0.5, len: 5 }, // pullback
      { drift: 0.1, len: 6 }, // chop
    ];
    const p = phases[this.phaseIndex % phases.length];
    this.phaseIndex += 1;
    this.phaseLeft = p.len;
    this.drift = p.drift;
  }

  nextCandle() {
    if (this.phaseLeft <= 0) this._nextPhase();
    this.phaseLeft -= 1;

    const open = this.price;
    const close = open + this.drift + (Math.random() - 0.5) * this.volatility;
    const high = Math.max(open, close) + Math.random() * this.volatility * 0.4;
    const low = Math.min(open, close) - Math.random() * this.volatility * 0.4;

    this.price = close;
    this.epoch += 60;
    return {
      epoch: this.epoch,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
    };
  }
}

/**
 * Runs the strategy on synthetic candles forever (until the process stops).
 * `setState` receives the current public state for the dashboard.
 */
function runDemo({ config, log, setState, intervalMs = 900 }) {
  const strategy = new EmaCrossoverStrategy({
    fastPeriod: config.EMA_FAST,
    slowPeriod: config.EMA_SLOW,
    holdBars: config.HOLD_BARS,
  });
  const feed = new DemoFeed();

  const state = () => ({
    status: 'running',
    symbol: config.SYMBOL,
    granularity: config.GRANULARITY,
    mode: 'demo',
    contractType: config.CONTRACT_TYPE,
    strategy: {
      emaFast: config.EMA_FAST,
      emaSlow: config.EMA_SLOW,
      holdBars: config.HOLD_BARS,
      stake: config.STAKE,
    },
    indicator: strategy.snapshot,
    recent: strategy.recent,
    trades: strategy.trades.slice(-30),
    paper: null,
    balance: null,
  });

  // Warm up EMAs on history so the chart is populated on load.
  for (let i = 0; i < config.SEED_CANDLES; i++) {
    strategy.update(feed.nextCandle());
  }
  setState(state());

  log.ok(`Demo feed running — synthetic ${config.SYMBOL} 1-minute candles (${intervalMs}ms ≈ 1 candle).`);
  log.info('Open the dashboard to watch the EMA 4/10 crossover and 5-candle take profit.');

  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const candle = feed.nextCandle();
      const snap = strategy.onCandle(candle);
      if (snap.signal === 'BUY') {
        log.trade(`⬆ BUY signal @ ${snap.candle.close} (above EMA4=${snap.emaFast} & EMA10=${snap.emaSlow})`);
      } else if (snap.signal === 'TAKE_PROFIT') {
        const t = snap.exit;
        log.trade(
          `✓ TAKE PROFIT after ${t.barsHeld} × 1-min candles — exit ${t.exitPrice} ` +
            `(${t.pnlPoints >= 0 ? '+' : ''}${t.pnlPoints} pts)`
        );
      }
      setState(state());
    }, intervalMs);

    process.once('SIGINT', () => {
      clearInterval(timer);
      resolve();
    });
  });
}

function round(n) {
  return Math.round(n * 1e5) / 1e5;
}

module.exports = { DemoFeed, runDemo };
