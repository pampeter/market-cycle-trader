'use strict';

/**
 * Minimal Deriv WebSocket API client (zero dependencies — uses Node's
 * built-in WebSocket, Node >= 22).
 *
 * Reference: https://api.deriv.com / https://developers.deriv.com
 */

class DerivClient {
  constructor({ appId, endpoint, token = '', log } = {}) {
    this.appId = appId;
    this.endpoint = endpoint;
    this.token = token;
    this.log = log;
    this.ws = null;
    this.reqId = 0;
    this.pending = new Map(); // req_id -> {resolve, reject}
    this.candleHandlers = new Set();
    this.keepAlive = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = `${this.endpoint}?app_id=${this.appId}&l=EN&brand=deriv`;
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        this.keepAlive = setInterval(() => this._sendRaw({ ping: 1 }), 30000);
        resolve(this);
      };
      ws.onerror = (ev) => {
        // Reject only if we haven't opened yet; afterwards errors surface via close.
        if (this.pending.size === 0 && this._opened !== true) {
          reject(new Error(`WebSocket error: ${ev.message || 'connection failed'}`));
        }
      };
      ws.onclose = () => {
        this._opened = false;
        if (this.keepAlive) clearInterval(this.keepAlive);
        this._rejectAll('Connection closed');
        for (const h of this.candleHandlers) h(null, { close: true });
      };
      ws.onmessage = (ev) => this._onMessage(ev.data);
    }).then(() => {
      this._opened = true;
      return this;
    });
  }

  _sendRaw(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  /** Send a request and await the response with the same req_id. */
  _request(payload) {
    return new Promise((resolve, reject) => {
      const reqId = ++this.reqId;
      this.pending.set(reqId, { resolve, reject });
      this._sendRaw({ ...payload, req_id: reqId });
    });
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.error) {
      const err = new Error(`${msg.error.message || 'Deriv error'} (${msg.error.code || 'unknown'})`);
      if (msg.req_id && this.pending.has(msg.req_id)) {
        const p = this.pending.get(msg.req_id);
        this.pending.delete(msg.req_id);
        p.reject(err);
      } else {
        this.log?.warn(`Deriv error: ${err.message}`);
      }
      return;
    }

    // Resolve the matching request (candles stream messages also carry req_id
    // of the subscribe call, so only resolve when it is actually pending).
    if (msg.req_id && this.pending.has(msg.req_id)) {
      const p = this.pending.get(msg.req_id);
      this.pending.delete(msg.req_id);
      p.resolve(msg);
    }

    // Route candle streams (subscription updates, and also one-shot history).
    const candles = extractCandles(msg);
    if (candles && candles.length) {
      for (const h of this.candleHandlers) h(candles, msg);
    }
  }

  _rejectAll(reason) {
    for (const [, p] of this.pending) p.reject(new Error(reason));
    this.pending.clear();
  }

  async authorize(token = this.token) {
    if (!token) throw new Error('DERIV_API_TOKEN is required to authorize');
    const res = await this._request({ authorize: token });
    return res?.authorize || res;
  }

  /** One-shot candle history (style=candles). Returns normalized candles, oldest first. */
  async getCandles(symbol, granularity, count) {
    const res = await this._request({
      ticks_history: symbol,
      style: 'candles',
      granularity,
      count,
      end: 'latest',
      adjust_start_time: 1,
    });
    const candles = extractCandles(res);
    if (!candles || !candles.length) throw new Error('No candle history returned');
    return candles.map(normalizeCandle).sort((a, b) => a.epoch - b.epoch);
  }

  /**
   * Subscribe to live candles. `handler(candles, msg)` is called for every
   * candle message. Returns an unsubscribe function.
   */
  subscribeCandles(symbol, granularity, handler) {
    this.candleHandlers.add(handler);
    this._sendRaw({
      ticks_history: symbol,
      style: 'candles',
      granularity,
      subscribe: 1,
      end: 'latest',
      req_id: ++this.reqId,
    });
    return () => this.candleHandlers.delete(handler);
  }

  /** Get a proposal for a contract. */
  async proposal(params) {
    const res = await this._request({ proposal: 1, ...params });
    if (!res?.proposal?.id) throw new Error(`No proposal returned: ${JSON.stringify(res).slice(0, 200)}`);
    return res.proposal;
  }

  /** Buy a contract from a proposal id at the proposal's ask price. */
  async buyFromProposal(proposalId, price) {
    const res = await this._request({ buy: proposalId, price });
    const buy = res?.buy;
    if (!buy?.contract_id) throw new Error(`Buy failed: ${JSON.stringify(res).slice(0, 200)}`);
    return buy;
  }

  /** Buy a MULTUP (multiplier "buy market") contract. */
  async buyMultiplier({ symbol, amount, multiplier, currency, duration, durationUnit }) {
    const p = await this.proposal({
      amount,
      basis: 'stake',
      contract_type: 'MULTUP',
      currency,
      duration,
      duration_unit: durationUnit,
      multiplier,
      symbol,
    });
    const buy = await this.buyFromProposal(p.id, p.ask_price ?? 0);
    return { contractId: buy.contract_id, buyPrice: buy.buy_price, longcode: buy.longcode, proposalId: p.id, buy };
  }

  /** Buy a binary CALL contract that expires after `duration` minutes. */
  async buyCall({ symbol, amount, currency, duration, durationUnit }) {
    const p = await this.proposal({
      amount,
      basis: 'stake',
      contract_type: 'CALL',
      currency,
      duration,
      duration_unit: durationUnit,
      symbol,
    });
    const buy = await this.buyFromProposal(p.id, p.ask_price ?? 0);
    return { contractId: buy.contract_id, buyPrice: buy.buy_price, longcode: buy.longcode, proposalId: p.id, buy };
  }

  /** Sell (close) a contract at market. */
  async sell(contractId) {
    const res = await this._request({ sell: contractId, price: 0 });
    return res?.sell || res;
  }

  async balance() {
    const res = await this._request({ balance: 1, account: 'current' });
    return res?.balance?.balance;
  }

  close() {
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Pull a candle array out of the various response shapes Deriv uses. */
function extractCandles(msg) {
  if (!msg) return null;
  if (Array.isArray(msg.candles)) return msg.candles;
  if (Array.isArray(msg.history?.candles)) return msg.history.candles;
  if (Array.isArray(msg.ohlc?.candles)) return msg.ohlc.candles;
  return null;
}

/** Deriv returns OHLC as strings in some shapes; normalise to numbers. */
function normalizeCandle(c) {
  return {
    epoch: Number(c.epoch),
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
  };
}

module.exports = { DerivClient, extractCandles, normalizeCandle };
