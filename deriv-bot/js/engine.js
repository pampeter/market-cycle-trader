// BotEngine - the trading loop. UI-agnostic: it only emits events.
//
// Events (CustomEvent.detail):
//   log {msg, level}            status {state}           account {auth}
//   balance {balance, currency} tick {price, prices}     signal {ml, llm, note}
//   position {position}         trade {trade}            stats {...}
//   stop {reason, report}

import { DerivAPIError, DerivClient } from "./deriv.js";
import { LLMEngine, mlOnlyDecision } from "./llm.js";
import { MLEngine } from "./ml.js";
import { RiskManager } from "./risk.js";

const FATAL_CODES = new Set(["InvalidToken", "AuthorizationRequired", "InvalidAppID", "PermissionDenied", "AccountDisabled"]);

export const DEFAULT_CONFIG = {
  token: "",
  appId: "1089",
  wsUrl: "wss://ws.derivws.com/websockets/v3",
  symbol: "R_75",
  stake: 1,
  duration: 5,
  paper: true,
  allowReal: false,
  paperStartBalance: 1000,
  profitTarget: 25,
  maxDailyLoss: 15,
  maxTrades: 20,
  maxConsecLosses: 4,
  cooldown: 30,
  trainWindow: 100,
  minMlProb: 0.6,
  useLlm: true,
  groqKey: "",
  groqModel: "openai/gpt-oss-120b",
  minAiConf: 78,
  requireAgreement: true,
  llmRetrySeconds: 10,
  historyCount: 300,
};

export function validateConfig(c) {
  const errs = [];
  if (!(c.stake > 0)) errs.push("Stake must be greater than 0");
  if (!(c.profitTarget > 0)) errs.push("Profit target must be greater than 0");
  if (!(c.maxDailyLoss > 0)) errs.push("Max daily loss must be greater than 0");
  if (c.stake > c.maxDailyLoss) errs.push("Stake cannot be larger than the max daily loss");
  if (!(c.duration >= 1 && c.duration <= 10)) errs.push("Duration must be 1-10 ticks");
  if (!(c.maxTrades >= 1)) errs.push("Max trades per day must be at least 1");
  if (!(c.minMlProb >= 0.5 && c.minMlProb < 1)) errs.push("ML threshold must be between 50% and 99%");
  if (!(c.minAiConf >= 0 && c.minAiConf <= 100)) errs.push("AI confidence must be 0-100");
  if (!(c.trainWindow >= 40)) errs.push("Train window must be at least 40 ticks");
  if (!c.paper && !c.token) errs.push("Live trading needs your Deriv API token (Settings → Deriv account)");
  if (errs.length) throw new Error(errs.join(". "));
}

const fatal = (msg) => Object.assign(new Error(msg), { fatal: true });
const round2 = (v) => Math.round(v * 100) / 100;

export class BotEngine extends EventTarget {
  constructor({ storage = globalThis.localStorage, WebSocketImpl = globalThis.WebSocket, fetchImpl, llm = null } = {}) {
    super();
    this.storage = storage;
    this.WebSocketImpl = WebSocketImpl;
    this.fetchImpl = fetchImpl;
    this.injectedLlm = llm;
    this.running = false;
    this.stopped = true;
    this.prices = [];
    this.position = null;
    this.client = null;
    this.backoff = (attempt) => Math.min(60, 2 ** Math.min(attempt, 6)) * 1000;
  }

  // ------------------------------------------------------------ helpers
  emit(type, detail = {}) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  log(msg, level = "info") { this.emit("log", { msg, level, time: new Date() }); }
  status(state) { this.state = state; this.emit("status", { state }); }
  endpoint(cfg = this.cfg) {
    return `${cfg.wsUrl}${cfg.wsUrl.includes("?") ? "&" : "?"}app_id=${encodeURIComponent(cfg.appId)}`;
  }

  proposalPayload(contractType) {
    return {
      proposal: 1, amount: round2(this.cfg.stake), basis: "stake", contract_type: contractType,
      currency: this.currency, duration: this.cfg.duration, duration_unit: "t", symbol: this.cfg.symbol,
    };
  }

  stats() {
    return {
      day: { ...this.risk.state }, winRate: this.risk.winRate,
      sessionPnl: this.risk.sessionPnl, sessionTrades: this.risk.sessionTrades,
      profitTarget: this.cfg.profitTarget, maxDailyLoss: this.cfg.maxDailyLoss,
      balance: this.cfg.paper ? this.paperBalance : this.balance, currency: this.currency, mode: this.cfg.paper ? "paper" : "live",
    };
  }

  report() {
    return { reason: this.stopReason || "stopped", symbol: this.cfg.symbol, ...this.stats() };
  }

  // -------------------------------------------------------------- public
  async start(cfg) {
    if (this.running) throw new Error("Bot is already running");
    this.cfg = { ...DEFAULT_CONFIG, ...cfg };
    validateConfig(this.cfg);
    const mode = this.cfg.paper ? "paper" : "live";
    this.running = true;
    this.stopped = false;
    this.stopReason = null;
    this.position = null;
    this.prices = [];
    this.tickCount = 0;
    this.analysisBusy = false;
    this.currency = "USD";
    this.balance = null;
    this.paperBalance = this.cfg.paperStartBalance;
    this.risk = new RiskManager({
      stake: this.cfg.stake, profitTarget: this.cfg.profitTarget, maxDailyLoss: this.cfg.maxDailyLoss,
      maxTradesPerDay: this.cfg.maxTrades, maxConsecutiveLosses: this.cfg.maxConsecLosses,
      cooldownSeconds: this.cfg.cooldown, storage: this.storage, storageKey: `dab_daily_${mode}`,
    });
    this.ml = new MLEngine(this.cfg.trainWindow, this.cfg.duration);
    this.llm = this.injectedLlm || (this.cfg.useLlm && this.cfg.groqKey
      ? new LLMEngine({ apiKey: this.cfg.groqKey, model: this.cfg.groqModel, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) })
      : null);
    this.emit("stats", this.stats());

    const pre = this.risk.stopReason();
    if (pre) {
      this.stopReason = pre;
      this.stopped = true;
      this.running = false;
      this.log(`Not starting: ${pre} (today, ${mode} mode). Reset today's counters in Settings if you really want to continue.`, "warn");
      this.status("stopped");
      this.emit("stop", { reason: pre, report: this.report() });
      return pre;
    }

    this.log(`Starting in ${mode.toUpperCase()} mode on ${this.cfg.symbol} · ${this.llm ? "ML + LLM" : "ML only"}`);
    let attempt = 0;
    while (!this.stopped) {
      const started = Date.now();
      this.status(attempt ? "reconnecting" : "connecting");
      try {
        await this._session();
      } catch (e) {
        if (e.fatal || (e instanceof DerivAPIError && FATAL_CODES.has(e.code))) this.stop(`FATAL: ${e.message}`);
        else if (!this.stopped) this.log(`Connection problem: ${e.message}`, "error");
      } finally {
        this._clearTimers();
        this.client?.close();
      }
      if (this.stopped) break;
      if (Date.now() - started > 60000) attempt = 0;
      attempt += 1;
      const delay = this.backoff(attempt);
      this.status("reconnecting");
      this.log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt})…`, "warn");
      await this._sleep(delay);
    }
    this.running = false;
    this.status("stopped");
    const report = this.report();
    this.emit("stop", { reason: this.stopReason, report });
    return this.stopReason;
  }

  stop(reason = "Stopped by user") {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    this.log(reason, reason.includes("TARGET") ? "success" : "warn");
    if (this.position?.mode === "live") this.log("A live contract is still open - it will settle on Deriv automatically.", "warn");
    this._endSession?.("stop");
    this._wake?.();
  }

  /** Call when the app comes back to the foreground. */
  nudge() {
    if (!this.running) return;
    this._wake?.();
    if (this.client?.isOpen && Date.now() - (this.lastTickAt || 0) > 10000) {
      this.log("App resumed - refreshing connection…", "warn");
      this.client.close();
    }
  }

  /** Connect, authorize and return account + quote info (Settings → Test). */
  async checkConnection(cfg) {
    const c = { ...DEFAULT_CONFIG, ...cfg };
    const client = new DerivClient(this.endpoint(c), { WebSocketImpl: this.WebSocketImpl });
    try {
      await client.connect();
      let auth = null;
      if (c.token) auth = (await client.request({ authorize: c.token })).authorize;
      const hist = await client.request({ ticks_history: c.symbol, count: 5, end: "latest", style: "ticks" });
      const prop = (await client.request({
        proposal: 1, amount: round2(c.stake), basis: "stake", contract_type: "CALL", currency: auth?.currency || "USD",
        duration: c.duration, duration_unit: "t", symbol: c.symbol,
      })).proposal;
      return { auth, lastPrice: hist.history.prices.at(-1), askPrice: Number(prop.ask_price), payout: Number(prop.payout) };
    } finally {
      client.close();
    }
  }

  // ------------------------------------------------------------- session
  async _session() {
    const cfg = this.cfg;
    const client = new DerivClient(this.endpoint(), { WebSocketImpl: this.WebSocketImpl });
    this.client = client;
    let resolveEnd;
    const ended = new Promise((r) => (resolveEnd = r));
    this._endSession = resolveEnd;
    client.onClose = () => resolveEnd("closed");
    client.onEvent = (m) => this._dispatch(m);

    await client.connect();
    if (this.stopped) return;
    this.log(`Connected to Deriv (${cfg.symbol})`, "success");

    if (cfg.token) {
      const auth = (await client.request({ authorize: cfg.token })).authorize;
      this.account = auth;
      this.currency = auth.currency || this.currency;
      this.balance = Number(auth.balance);
      this.emit("account", { auth });
      this.emit("balance", { balance: this.balance, currency: this.currency });
      if (!cfg.paper) {
        if (!auth.is_virtual && !cfg.allowReal)
          throw fatal("This token is for a REAL-money account. Enable 'Allow real-money account' in Settings if you really mean it (use a Demo token first!)");
        if (Array.isArray(auth.scopes) && !auth.scopes.includes("trade"))
          throw fatal("Your API token is missing the 'Trade' scope");
      }
      client.request({ balance: 1, subscribe: 1 }, 10000).catch(() => {});
    }

    const hist = await client.request({
      ticks_history: cfg.symbol, adjust_start_time: 1, count: Math.max(cfg.historyCount, this.ml.ticksNeeded + 20),
      end: "latest", style: "ticks", subscribe: 1,
    });
    this.prices = hist.history.prices.map(Number);
    this.lastTickAt = Date.now();
    this.log(`Loaded ${this.prices.length} ticks, streaming live…`);
    this.emit("tick", { price: this.prices.at(-1), prices: this.prices });
    this.status("running");

    if (this.position) {
      if (this.position.mode === "live") {
        this.log(`Re-attaching to open contract ${this.position.contractId}…`);
        await this._subscribeContract(this.position.contractId);
      } else {
        this.log("Paper trade voided - tick stream was interrupted.", "warn");
        this.position = null;
        this.emit("position", { position: null });
      }
    }

    this._pingTimer = setInterval(() => {
      client.request({ ping: 1 }, 10000).catch(() => { if (client.isOpen) client.close(); });
    }, 30000);
    this._watchdog = setInterval(() => {
      if (Date.now() - this.lastTickAt > 30000 && client.isOpen) {
        this.log("No ticks for 30s - reconnecting…", "warn");
        client.close();
      }
      if (this.position?.mode === "live") this._contractWatchdog();
    }, 5000);

    const why = await ended;
    this._clearTimers();
    if (why === "stop" && cfg.token && client.isOpen) {
      try {
        this.balance = Number((await client.request({ balance: 1 }, 5000)).balance.balance);
        this.emit("balance", { balance: this.balance, currency: this.currency });
      } catch {}
    }
    if (why === "closed" && !this.stopped) throw new Error("Connection dropped");
  }

  _clearTimers() {
    clearInterval(this._pingTimer);
    clearInterval(this._watchdog);
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() { clearTimeout(t); resolve(); }
      this._wake = done;
    });
  }

  _dispatch(msg) {
    if (msg.error) { this.log(`Stream error (${msg.msg_type}): ${msg.error.message}`, "error"); return; }
    switch (msg.msg_type) {
      case "tick": this._onTick(msg.tick); break;
      case "proposal_open_contract": this._onContract(msg.proposal_open_contract || {}, msg.subscription); break;
      case "balance":
        if (msg.balance?.balance != null) {
          this.balance = Number(msg.balance.balance);
          this.emit("balance", { balance: this.balance, currency: this.currency });
        }
        break;
      default: break;
    }
  }

  // ---------------------------------------------------------------- ticks
  _onTick(tick) {
    const price = Number(tick.quote);
    this.prices.push(price);
    if (this.prices.length > 2000) this.prices.splice(0, this.prices.length - 2000);
    this.lastTickAt = Date.now();
    this.tickCount += 1;
    this.emit("tick", { price, prices: this.prices });

    if (this.position) {
      if (this.position.mode === "paper") this._advancePaper(price);
      return;
    }
    if (this.stopped || this.analysisBusy) return;
    const reason = this.risk.stopReason();
    if (reason) { this.stop(reason); return; }
    if (this.risk.cooldownRemaining() > 0) return;
    this._analyze();
  }

  async _analyze() {
    const cfg = this.cfg;
    this.analysisBusy = true;
    try {
      const prices = this.prices.slice();
      const sig = this.ml.predict(prices);
      if (!sig) {
        this.emit("signal", { ml: null, llm: null, note: `Collecting data ${prices.length}/${this.ml.ticksNeeded}` });
        return;
      }
      if (sig.probability < cfg.minMlProb) {
        this.emit("signal", { ml: sig, llm: null, note: "Scanning - ML below threshold" });
        return;
      }
      const acc = sig.holdoutAccuracy == null ? "n/a" : `${Math.round(sig.holdoutAccuracy * 100)}%`;
      this.log(`ML signal ${sig.direction} ${(sig.probability * 100).toFixed(1)}% (holdout acc ${acc})`);
      this.emit("signal", { ml: sig, llm: null, note: this.llm ? "Asking LLM…" : "ML-only decision" });

      let decision;
      let approved = true;
      if (this.llm) {
        decision = await this.llm.analyze(sig, prices.slice(-20), cfg.symbol, cfg.duration);
        this.log(`LLM: ${decision.direction} (confidence ${decision.confidence}) - ${decision.reason}`, decision.direction === "HOLD" ? "muted" : "info");
        let note = "LLM approved";
        if (decision.direction === "HOLD") { approved = false; note = "LLM says HOLD"; }
        else if (decision.confidence < cfg.minAiConf) { approved = false; note = `Confidence ${decision.confidence} < ${cfg.minAiConf}`; }
        else if (cfg.requireAgreement && decision.direction !== sig.direction) { approved = false; note = "ML and LLM disagree"; }
        this.emit("signal", { ml: sig, llm: decision, note });
      } else {
        decision = mlOnlyDecision(sig);
      }
      if (!approved) { this.risk.startCooldown(cfg.llmRetrySeconds); return; }
      if (this.position || this.stopped) return;
      const reason = this.risk.stopReason();
      if (reason) { this.stop(reason); return; }
      await this._openTrade(decision.direction, sig, decision);
    } catch (e) {
      if (e instanceof DerivAPIError) {
        this.log(`Trade rejected by Deriv: ${e.message}`, "error");
        this.risk.startCooldown();
        if (FATAL_CODES.has(e.code)) this.stop(`FATAL: ${e.message}`);
      } else {
        this.log(`Could not place trade: ${e.message}`, "error");
        this.risk.startCooldown(5);
      }
    } finally {
      this.analysisBusy = false;
    }
  }

  // --------------------------------------------------------------- trades
  async _openTrade(direction, sig, decision) {
    const cfg = this.cfg;
    const contractType = direction === "RISE" ? "CALL" : "PUT";
    const base = {
      direction, mlProb: Math.round(sig.probability * 1000) / 1000, aiConf: decision.confidence,
      reason: decision.reason, openedAt: Date.now(), entry: null, ticks: 0, duration: cfg.duration,
    };
    if (cfg.paper) {
      let payout;
      try { payout = Number((await this.client.request(this.proposalPayload(contractType), 8000)).proposal.payout); }
      catch { payout = round2(cfg.stake * 1.95); }
      if (this.stopped) return;
      this.position = { ...base, mode: "paper", stake: cfg.stake, payout, contractId: null };
      this.log(`PAPER BUY ${contractType} (${direction}) stake ${cfg.stake.toFixed(2)} → payout ${payout.toFixed(2)}`, "trade");
      this.emit("position", { position: this.position });
      return;
    }
    const quote = (await this.client.request(this.proposalPayload(contractType))).proposal;
    if (this.stopped) return;
    const bought = (await this.client.request({ buy: quote.id, price: Number(quote.ask_price) })).buy;
    this.position = {
      ...base, mode: "live", stake: Number(bought.buy_price ?? cfg.stake),
      payout: Number(bought.payout ?? quote.payout), contractId: bought.contract_id,
    };
    if (bought.balance_after != null) {
      this.balance = Number(bought.balance_after);
      this.emit("balance", { balance: this.balance, currency: this.currency });
    }
    this.log(`LIVE BUY ${contractType} (${direction}) #${bought.contract_id} stake ${this.position.stake.toFixed(2)} → payout ${this.position.payout.toFixed(2)}`, "trade");
    this.emit("position", { position: this.position });
    await this._subscribeContract(bought.contract_id);
  }

  async _subscribeContract(contractId) {
    const resp = await this.client.request({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 });
    this._onContract(resp.proposal_open_contract || {}, resp.subscription);
  }

  _onContract(poc, subscription) {
    const pos = this.position;
    if (!pos || pos.mode !== "live" || poc.contract_id !== pos.contractId) return;
    if (poc.entry_tick != null && pos.entry == null) { pos.entry = Number(poc.entry_tick); this.emit("position", { position: pos }); }
    if (!(poc.is_sold || ["won", "lost", "sold"].includes(poc.status))) return;
    if (subscription?.id) this.client?.send({ forget: subscription.id });
    this._settle(Number(poc.profit ?? 0), poc.entry_tick ?? poc.entry_spot, poc.exit_tick ?? poc.sell_spot);
  }

  _contractWatchdog() {
    const pos = this.position;
    const limit = (20 + this.cfg.duration * 4) * 1000;
    if (!pos || pos.polling || Date.now() - pos.openedAt < limit) return;
    pos.polling = true;
    this.client.request({ proposal_open_contract: 1, contract_id: pos.contractId }, 10000)
      .then((r) => this._onContract(r.proposal_open_contract || {}))
      .catch((e) => this.log(`Contract status check failed: ${e.message}`, "warn"))
      .finally(() => { if (this.position === pos) { pos.polling = false; pos.openedAt = Date.now(); } });
  }

  _advancePaper(price) {
    const pos = this.position;
    if (pos.entry == null) { pos.entry = price; this.emit("position", { position: pos }); return; }
    pos.ticks += 1;
    this.emit("position", { position: pos });
    if (pos.ticks < this.cfg.duration) return;
    const won = pos.direction === "RISE" ? price > pos.entry : price < pos.entry;
    const profit = won ? round2(pos.payout - pos.stake) : -round2(pos.stake);
    this.paperBalance = round2(this.paperBalance + profit);
    this._settle(profit, pos.entry, price);
  }

  _settle(profit, entry, exit) {
    const pos = this.position;
    this.position = null;
    this.risk.record(profit);
    const trade = {
      time: new Date().toISOString(), mode: pos.mode, symbol: this.cfg.symbol, direction: pos.direction,
      stake: pos.stake, payout: pos.payout, entry: entry ?? null, exit: exit ?? null, profit,
      dayPnl: this.risk.state.pnl, mlProb: pos.mlProb, aiConf: pos.aiConf, reason: pos.reason, contractId: pos.contractId,
    };
    this._saveTrade(trade);
    this.emit("position", { position: null });
    this.emit("trade", { trade });
    this.emit("stats", this.stats());
    this.log(`${profit > 0 ? "WIN" : "LOSS"} ${profit > 0 ? "+" : ""}${profit.toFixed(2)} · day P/L ${this.risk.state.pnl.toFixed(2)}`, profit > 0 ? "success" : "error");
    const reason = this.risk.stopReason();
    if (reason) this.stop(reason);
  }

  _saveTrade(trade) {
    try {
      const list = JSON.parse(this.storage?.getItem("dab_trades") || "[]");
      list.push(trade);
      this.storage?.setItem("dab_trades", JSON.stringify(list.slice(-500)));
    } catch { /* storage full or unavailable */ }
  }
}
