'use strict';

const { DerivClient } = require('./deriv');
const { EmaCrossoverStrategy } = require('./strategy');

/**
 * Wires the strategy to the Deriv client.
 *
 * IMPORTANT candle handling: Deriv's candle subscription can deliver either
 * fully-closed candles or the still-forming candle. To trade only on
 * COMPLETED 1-minute candles, we buffer the latest candle and process it
 * only once a newer candle epoch arrives (i.e. the buffered candle is
 * guaranteed to be closed). This keeps the signal rule exact:
 * "price starts trading above the 4 & 10 EMA on a closed candle".
 */
class Trader {
  constructor({ config, log, onState }) {
    this.config = config;
    this.log = log;
    this.onState = onState || (() => {});
    this.strategy = new EmaCrossoverStrategy({
      fastPeriod: config.EMA_FAST,
      slowPeriod: config.EMA_SLOW,
      holdBars: config.HOLD_BARS,
    });
    this.client = null;
    this.status = 'starting';
    this.lastHistoryEpoch = null;
    this.buffered = null; // latest forming candle {epoch, open, high, low, close}
    this.paper = null; // dry-run open position
    this.balance = null;
  }

  async start() {
    const cfg = this.config;
    this.client = new DerivClient({
      appId: cfg.APP_ID,
      endpoint: cfg.ENDPOINT,
      token: cfg.API_TOKEN,
      log: this.log,
    });

    this.log.info(`Connecting to Deriv (${cfg.SYMBOL} · ${cfg.GRANULARITY}s candles)…`);
    await this.client.connect();
    this.log.ok('WebSocket connected.');

    if (cfg.API_TOKEN) {
      const auth = await this.client.authorize(cfg.API_TOKEN);
      const who = auth?.email || auth?.loginid || 'authorized account';
      this.log.ok(`Authorized as ${who}`);
      if (cfg.MODE === 'live') {
        try {
          this.balance = await this.client.balance();
          this.log.info(`Account balance: ${this.balance} ${cfg.CURRENCY}`);
        } catch {
          this.log.warn('Could not fetch account balance.');
        }
      }
    }

    // Warm up EMAs on history (no trades are taken from history).
    const history = await this.client.getCandles(cfg.SYMBOL, cfg.GRANULARITY, cfg.SEED_CANDLES);
    this.log.info(`Warmed up EMAs on ${history.length} historical candles.`);
    for (const c of history) {
      this.strategy.update(c);
      this.lastHistoryEpoch = c.epoch;
    }

    // Subscribe to live candles.
    this.client.subscribeCandles(cfg.SYMBOL, cfg.GRANULARITY, (candles, msg) => {
      if (msg && msg.close) return; // connection closing
      if (!candles) return;
      for (const raw of candles) this._onStreamCandle(raw);
    });

    if (cfg.DRY_RUN) {
      this.log.warn('DRY-RUN: signals are evaluated and logged — NO real orders are placed.');
    } else {
      this.log.warn(
        `LIVE MODE: real ${cfg.CONTRACT_TYPE} orders WILL be placed on ${cfg.SYMBOL} (stake ${cfg.STAKE} ${cfg.CURRENCY}).`
      );
    }

    this.status = 'running';
    this._emit();
  }

  /** Buffer the latest candle; process the previous one once it is closed. */
  _onStreamCandle(raw) {
    const candle = {
      epoch: Number(raw.epoch),
      open: Number(raw.open),
      high: Number(raw.high),
      low: Number(raw.low),
      close: Number(raw.close),
    };
    if (!Number.isFinite(candle.close)) return;

    // Ignore anything already covered by the history warm-up.
    if (this.lastHistoryEpoch !== null && candle.epoch <= this.lastHistoryEpoch) return;

    if (!this.buffered) {
      this.buffered = candle;
      return;
    }

    if (candle.epoch === this.buffered.epoch) {
      // Still forming — keep the latest snapshot of this candle.
      this.buffered = candle;
      return;
    }

    if (candle.epoch > this.buffered.epoch) {
      // The buffered candle is now guaranteed closed -> trade on it.
      const completed = this.buffered;
      this.buffered = candle;
      this._onClosedCandle(completed);
    }
  }

  _onClosedCandle(candle) {
    const snap = this.strategy.onCandle(candle);
    this.log.info(
      `[${fmtTime(candle.epoch)}] close=${snap.candle.close} · EMA4=${snap.emaFast} · EMA10=${snap.emaSlow} · ` +
        (snap.inTrade ? `in-trade ${snap.barsHeld}/${this.config.HOLD_BARS}` : 'idle')
    );

    if (snap.signal === 'BUY') {
      this.log.trade(`⬆ BUY signal @ ${snap.candle.close} (price above EMA4=${snap.emaFast} & EMA10=${snap.emaSlow})`);
      this._executeBuy(snap);
    } else if (snap.signal === 'TAKE_PROFIT') {
      const t = snap.exit;
      this.log.trade(
        `✓ TAKE PROFIT after ${t.barsHeld} × 1-min candles — exit ${t.exitPrice} ` +
          `(${t.pnlPoints >= 0 ? '+' : ''}${t.pnlPoints} pts / ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct}%)`
      );
      this._executeSell(t);
    }

    this._emit();
  }

  async _executeBuy(snap) {
    const cfg = this.config;
    if (cfg.DRY_RUN) {
      this.paper = {
        type: cfg.CONTRACT_TYPE,
        entry: snap.candle.close,
        epoch: snap.candle.epoch,
        contractId: `paper-${snap.candle.epoch}`,
      };
      this.log.info(`  [dry-run] would BUY ${cfg.SYMBOL} ${cfg.CONTRACT_TYPE} @ ${snap.candle.close} (stake ${cfg.STAKE} ${cfg.CURRENCY})`);
      return;
    }

    try {
      const order =
        cfg.CONTRACT_TYPE === 'CALL'
          ? await this.client.buyCall({
              symbol: cfg.SYMBOL,
              amount: cfg.STAKE,
              currency: cfg.CURRENCY,
              duration: cfg.HOLD_BARS,
              durationUnit: 'm',
            })
          : await this.client.buyMultiplier({
              symbol: cfg.SYMBOL,
              amount: cfg.STAKE,
              multiplier: cfg.MULTIPLIER,
              currency: cfg.CURRENCY,
              duration: cfg.DURATION,
              durationUnit: cfg.DURATION_UNIT,
            });
      this.paper = {
        type: cfg.CONTRACT_TYPE,
        entry: snap.candle.close,
        epoch: snap.candle.epoch,
        contractId: order.contractId,
      };
      this.log.ok(`  Opened ${cfg.CONTRACT_TYPE} contract #${order.contractId}`);
    } catch (err) {
      this.log.err(`  BUY failed: ${err.message}`);
    }
  }

  async _executeSell(trade) {
    const cfg = this.config;
    if (cfg.DRY_RUN) {
      this.log.info(`  [dry-run] would CLOSE ${this.paper?.contractId || ''} @ ${trade.exitPrice}`);
      this.paper = null;
      return;
    }
    if (!this.paper?.contractId) return;

    if (cfg.CONTRACT_TYPE === 'CALL') {
      // Binary CALL with duration = HOLD_BARS expires on its own after 5 minutes.
      this.log.info(`  CALL contract #${this.paper.contractId} expires automatically after ${cfg.HOLD_BARS}m — no manual close.`);
      this.paper = null;
      return;
    }

    try {
      await this.client.sell(this.paper.contractId);
      this.log.ok(`  Closed MULTUP contract #${this.paper.contractId}`);
    } catch (err) {
      this.log.err(`  SELL failed: ${err.message}`);
    }
    this.paper = null;
  }

  _emit() {
    this.onState(this.publicState());
  }

  publicState() {
    return {
      status: this.status,
      symbol: this.config.SYMBOL,
      granularity: this.config.GRANULARITY,
      mode: this.config.MODE,
      contractType: this.config.CONTRACT_TYPE,
      strategy: {
        emaFast: this.config.EMA_FAST,
        emaSlow: this.config.EMA_SLOW,
        holdBars: this.config.HOLD_BARS,
        stake: this.config.STAKE,
      },
      indicator: this.strategy.snapshot,
      recent: this.strategy.recent,
      trades: this.strategy.trades.slice(-30),
      paper: this.paper,
      balance: this.balance,
      lastHistoryEpoch: this.lastHistoryEpoch,
    };
  }

  stop() {
    if (this.client) this.client.close();
  }
}

function fmtTime(epoch) {
  const d = new Date(epoch * 1000);
  return d.toISOString().slice(0, 19) + 'Z';
}

module.exports = { Trader };
