// Daily P/L, profit target, loss limit, trade throttling.
// State is persisted per mode (paper / live) so reopening the app on the same
// UTC day cannot bypass the loss limit or the profit-target stop.

export const utcToday = () => new Date().toISOString().slice(0, 10);

const freshState = () => ({
  date: utcToday(), pnl: 0, trades: 0, wins: 0, losses: 0,
  consecutiveLosses: 0, peakPnl: 0, maxDrawdown: 0, targetHit: false,
});

const round2 = (v) => Math.round(v * 100) / 100;

export class RiskManager {
  constructor({ stake, profitTarget, maxDailyLoss, maxTradesPerDay, maxConsecutiveLosses,
    cooldownSeconds, storage = null, storageKey = "dab_daily", clock = () => Date.now() }) {
    Object.assign(this, { stake, profitTarget, maxTradesPerDay, maxConsecutiveLosses, cooldownSeconds, storage, storageKey, clock });
    this.maxDailyLoss = Math.abs(maxDailyLoss);
    this.nextTradeAt = 0;
    this.sessionPnl = 0;
    this.sessionTrades = 0;
    this.sessionWins = 0;
    this.state = this._load();
  }

  _load() {
    try {
      const raw = this.storage?.getItem(this.storageKey);
      if (raw) {
        const s = { ...freshState(), ...JSON.parse(raw) };
        if (s.date === utcToday()) return s;
      }
    } catch { /* ignore corrupt state */ }
    return freshState();
  }

  _save() {
    this.storage?.setItem(this.storageKey, JSON.stringify(this.state));
  }

  _rollDay() {
    if (this.state.date !== utcToday()) {
      this.state = freshState();
      this._save();
    }
  }

  reset() {
    this.state = freshState();
    this._save();
  }

  /** @returns {string|null} why trading must stop for today */
  stopReason() {
    this._rollDay();
    const s = this.state;
    if (s.targetHit || s.pnl >= this.profitTarget)
      return `PROFIT TARGET REACHED (+${s.pnl.toFixed(2)} / target ${this.profitTarget.toFixed(2)})`;
    if (s.pnl <= -this.maxDailyLoss)
      return `DAILY LOSS LIMIT HIT (${s.pnl.toFixed(2)} / limit -${this.maxDailyLoss.toFixed(2)})`;
    if (s.pnl - this.stake < -this.maxDailyLoss - 1e-9)
      return `DAILY LOSS LIMIT: another loss (-${this.stake.toFixed(2)}) would exceed -${this.maxDailyLoss.toFixed(2)}`;
    if (s.trades >= this.maxTradesPerDay)
      return `MAX TRADES PER DAY REACHED (${s.trades}/${this.maxTradesPerDay})`;
    if (this.maxConsecutiveLosses > 0 && s.consecutiveLosses >= this.maxConsecutiveLosses)
      return `${s.consecutiveLosses} LOSSES IN A ROW - stopping to protect capital`;
    return null;
  }

  cooldownRemaining() {
    return Math.max(0, (this.nextTradeAt - this.clock()) / 1000);
  }

  startCooldown(seconds = this.cooldownSeconds) {
    this.nextTradeAt = Math.max(this.nextTradeAt, this.clock() + seconds * 1000);
  }

  record(profit) {
    this._rollDay();
    const s = this.state;
    s.pnl = round2(s.pnl + profit);
    s.trades += 1;
    if (profit > 0) { s.wins += 1; s.consecutiveLosses = 0; this.sessionWins += 1; }
    else { s.losses += 1; s.consecutiveLosses += 1; }
    s.peakPnl = Math.max(s.peakPnl, s.pnl);
    s.maxDrawdown = Math.max(s.maxDrawdown, round2(s.peakPnl - s.pnl));
    if (s.pnl >= this.profitTarget) s.targetHit = true;
    this.sessionPnl = round2(this.sessionPnl + profit);
    this.sessionTrades += 1;
    this._save();
    this.startCooldown();
  }

  get winRate() {
    return this.state.trades ? this.state.wins / this.state.trades : 0;
  }
}
