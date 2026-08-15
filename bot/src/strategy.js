'use strict';

const { ema } = require('./indicators');

/**
 * Crash 500 — "EMA 4 / EMA 10" buy-only strategy.
 *
 * Rules (from the trading plan):
 *   1. Market: CRASH500 (Deriv Crash 500 synthetic index) — BUY only.
 *   2. Timeframe: 1-minute candles.
 *   3. When price "starts trading above" the EMA 4 and EMA 10 lines
 *      (the previous candle's close was NOT above both, and the current
 *      candle's close IS above both) the market is bullish -> BUY.
 *   4. Take profit automatically after `holdBars` completed 1-minute candles
 *      (default 5). The position is closed at the close of the 5th candle.
 *
 * The bot is long-only (it never sells short) and holds at most one
 * position at a time.
 */
class EmaCrossoverStrategy {
  constructor({ fastPeriod = 4, slowPeriod = 10, holdBars = 5 } = {}) {
    this.fastPeriod = fastPeriod;
    this.slowPeriod = slowPeriod;
    this.holdBars = holdBars;
    this.reset();
  }

  reset() {
    this.closes = [];
    this.recent = [];
    this.emaFast = null;
    this.emaSlow = null;
    this.prevClose = null;
    this.lastCrossAbove = false;
    this.state = 'idle'; // 'idle' | 'in-trade'
    this.barsHeld = 0;
    this.entry = null; // active trade
    this.trades = []; // completed trades
    this.snapshot = null;
  }

  warmedUp() {
    return this.closes.length >= this.slowPeriod;
  }

  /**
   * Update indicator state only (used to warm up on history).
   * Does NOT advance the trade state machine.
   */
  update(candle) {
    const close = Number(candle.close);
    if (!Number.isFinite(close)) throw new Error('Candle must have a numeric close');

    this.closes.push(close);
    if (this.closes.length > 600) this.closes.shift();

    const prevFast = this.emaFast;
    const prevSlow = this.emaSlow;
    this.emaFast = ema(close, this.fastPeriod, prevFast);
    this.emaSlow = ema(close, this.slowPeriod, prevSlow);

    const prevClose = this.prevClose;
    this.prevClose = close;

    const nowAboveBoth = close > this.emaFast && close > this.emaSlow;
    let crossedAbove = false;
    if (this.warmedUp() && prevClose !== null && prevFast !== null && prevSlow !== null) {
      const wasAboveBoth = prevClose > prevFast && prevClose > prevSlow;
      crossedAbove = !wasAboveBoth && nowAboveBoth;
    }
    this.lastCrossAbove = crossedAbove;

    this.snapshot = {
      candle: {
        epoch: candle.epoch,
        open: Number(candle.open),
        high: Number(candle.high),
        low: Number(candle.low),
        close,
      },
      emaFast: round(this.emaFast),
      emaSlow: round(this.emaSlow),
      aboveBoth: nowAboveBoth,
      crossedAbove,
      state: this.state,
      inTrade: this.state === 'in-trade',
      barsHeld: this.barsHeld,
      signal: null,
    };

    this.recent.push({
      epoch: candle.epoch,
      close,
      emaFast: round(this.emaFast),
      emaSlow: round(this.emaSlow),
      aboveBoth: nowAboveBoth,
      signal: null,
    });
    if (this.recent.length > 240) this.recent.shift();

    return this.snapshot;
  }

  /**
   * Update indicators AND advance the trade state machine.
   * Returns the snapshot with a `signal` of 'BUY' | 'TAKE_PROFIT' | null.
   */
  onCandle(candle) {
    const snap = this.update(candle);
    let signal = null;

    if (this.state === 'idle') {
      if (snap.crossedAbove) {
        signal = 'BUY';
        this.state = 'in-trade';
        this.barsHeld = 0;
        this.entry = {
          id: `${candle.epoch}`,
          epoch: candle.epoch,
          entryPrice: snap.candle.close,
          emaFast: snap.emaFast,
          emaSlow: snap.emaSlow,
          openedAt: new Date().toISOString(),
        };
        snap.signal = signal;
        snap.state = this.state;
        snap.inTrade = true;
        snap.barsHeld = 0;
        snap.entry = this.entry;
      }
    } else {
      // in-trade: count completed candles since entry
      this.barsHeld += 1;
      snap.barsHeld = this.barsHeld;
      if (this.barsHeld >= this.holdBars) {
        signal = 'TAKE_PROFIT';
        const exitPrice = snap.candle.close;
        const pnlPoints = exitPrice - this.entry.entryPrice;
        const trade = {
          ...this.entry,
          exitPrice,
          exitEpoch: candle.epoch,
          barsHeld: this.barsHeld,
          pnlPoints: round(pnlPoints),
          pnlPct: round((pnlPoints / this.entry.entryPrice) * 100),
          closedAt: new Date().toISOString(),
        };
        this.trades.push(trade);
        this.state = 'idle';
        this.barsHeld = 0;
        snap.state = this.state;
        snap.inTrade = false;
        snap.exit = trade;
      }
    }

    snap.signal = signal;
    this.snapshot = snap;
    if (this.recent.length) {
      this.recent[this.recent.length - 1].signal = signal;
    }
    return snap;
  }
}

function round(n) {
  return Math.round(n * 1e5) / 1e5;
}

module.exports = { EmaCrossoverStrategy };
