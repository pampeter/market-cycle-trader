// Run:  PYTHON=python3 node --test deriv-bot/tests/
// Needs Node 22+ (global WebSocket) and Python with `websockets` for the fake Deriv server.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { BotEngine, validateConfig, DEFAULT_CONFIG } from "../js/engine.js";
import { MLEngine, computeFeatures, fitLogistic, predictProba, WARMUP } from "../js/ml.js";
import { LLMEngine, parseDecision } from "../js/llm.js";
import { RiskManager } from "../js/risk.js";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE = join(here, "../../deriv-ai-rise-fall-bot/tests/fake_deriv_server.py");
const PY = process.env.PYTHON || "python3";

class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
}

let nextPort = 18700 + Math.floor(Math.random() * 500);
async function startServer(args = []) {
  const port = nextPort++;
  const proc = spawn(PY, [FAKE, "--host", "127.0.0.1", "--port", String(port), "--tick-interval", "0.005", ...args], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("fake server did not start")), 15000);
    proc.stdout.on("data", (d) => { if (String(d).includes("listening")) { clearTimeout(t); resolve(); } });
    proc.on("exit", (c) => reject(new Error(`fake server exited ${c}`)));
  });
  return { url: `ws://127.0.0.1:${port}`, stop: () => proc.kill() };
}

const cfg = (url, extra = {}) => ({
  ...DEFAULT_CONFIG, wsUrl: url, token: "demo", paper: false, profitTarget: 2, maxDailyLoss: 10,
  maxTrades: 30, maxConsecLosses: 0, cooldown: 0, trainWindow: 60, minMlProb: 0.5, useLlm: false,
  historyCount: 150, llmRetrySeconds: 0, ...extra,
});

function collect(engine) {
  const ev = { trades: [], logs: [], status: [] };
  engine.addEventListener("trade", (e) => ev.trades.push(e.detail.trade));
  engine.addEventListener("log", (e) => ev.logs.push(e.detail.msg));
  engine.addEventListener("status", (e) => ev.status.push(e.detail.state));
  return ev;
}

function withTimeout(p, ms, what) {
  let t;
  const timer = new Promise((_, r) => { t = setTimeout(() => r(new Error(`timeout: ${what}`)), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

// ------------------------------------------------------------------ units
describe("ml", () => {
  test("features have warmup NaNs then finite values", () => {
    const p = Array.from({ length: 100 }, (_, i) => 1000 + Math.sin(i / 3) * 5 + i * 0.1);
    const f = computeFeatures(p);
    assert.ok(f[WARMUP - 1].every(Number.isNaN));
    assert.ok(f.slice(WARMUP).every((r) => r.every(Number.isFinite)));
  });

  test("logistic regression separates a simple dataset", () => {
    const X = [], y = [];
    for (let i = 0; i < 200; i++) { const x = (i - 100) / 10; X.push([x, Math.cos(i)]); y.push(x + 0.3 * Math.sin(i * 7) > 0 ? 1 : 0); }
    const m = fitLogistic(X, y, 1.0);
    assert.ok(predictProba(m, [5, 0]) > 0.9);
    assert.ok(predictProba(m, [-5, 0]) < 0.1);
  });

  test("predict returns null until enough ticks, then valid probabilities", () => {
    const eng = new MLEngine(100, 5);
    assert.equal(eng.predict([1, 2, 3]), null);
    let p = 5000, r = 0; const prices = [];
    for (let i = 0; i < 400; i++) { r = 0.5 * r + (Math.random() - 0.5) * 0.001; p *= 1 + r; prices.push(p); }
    const s = eng.predict(prices);
    assert.ok(s && s.probRise >= 0 && s.probRise <= 1);
    assert.ok(["RISE", "FALL"].includes(s.direction));
  });
});

describe("risk + llm parsing", () => {
  test("profit target / loss limit / persistence", () => {
    const st = new MemStorage();
    const base = { stake: 1, profitTarget: 2, maxDailyLoss: 2.5, maxTradesPerDay: 10, maxConsecutiveLosses: 0, cooldownSeconds: 0, storage: st };
    const r = new RiskManager(base);
    r.record(0.95); r.record(0.95);
    assert.equal(r.stopReason(), null);
    r.record(0.95);
    assert.match(r.stopReason(), /PROFIT TARGET/);
    assert.match(new RiskManager(base).stopReason(), /PROFIT TARGET/); // survives restart
    const r2 = new RiskManager({ ...base, storageKey: "other" });
    r2.record(-1); assert.equal(r2.stopReason(), null); r2.record(-1);
    assert.match(r2.stopReason(), /LOSS/);
  });

  test("parseDecision", () => {
    assert.deepEqual(parseDecision('{"direction":"put","confidence":"91.6","reason":"x"}').direction, "FALL");
    assert.equal(parseDecision('```json\n{"direction":"RISE","confidence":150}\n```').confidence, 95);
    assert.equal(parseDecision("nope").direction, "HOLD");
  });

  test("validateConfig", () => {
    assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, paper: false, token: "" }), /token/);
    assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, stake: 20 }), /Stake/);
    validateConfig(DEFAULT_CONFIG);
  });

  test("LLMEngine sends Groq JSON request and handles HTTP errors", async () => {
    let seen;
    const ok = new LLMEngine({ apiKey: "k1", fetchImpl: async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ choices: [{ message: { content: '{"direction":"RISE","confidence":84,"reason":"ok"}' } }] }), { status: 200 }); } });
    const sig = { probRise: 0.66, probFall: 0.34, holdoutAccuracy: 0.6, nSamples: 90, direction: "RISE", probability: 0.66, features: { return: 1e-4 } };
    const d = await ok.analyze(sig, [1, 2, 3], "R_75", 5);
    assert.equal(d.confidence, 84);
    assert.equal(seen.url, "https://api.groq.com/openai/v1/chat/completions");
    assert.equal(seen.init.headers.Authorization, "Bearer k1");
    assert.equal(JSON.parse(seen.init.body).reasoning_effort, "low");
    const bad = new LLMEngine({ apiKey: "x", fetchImpl: async () => new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), { status: 401 }) });
    assert.match((await bad.analyze(sig, [1], "R_75", 5)).reason, /401/);
    const down = new LLMEngine({ apiKey: "x", fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
    assert.equal((await down.analyze(sig, [1], "R_75", 5)).direction, "HOLD");
  });
});

// ------------------------------------------------------- engine end-to-end
describe("engine vs fake Deriv server", () => {
  let srv;
  before(async () => { srv = await startServer(["--win", "0.75"]); });
  after(() => srv.stop());

  test("live mode trades until the profit target, then stops", async () => {
    const st = new MemStorage();
    const bot = new BotEngine({ storage: st });
    const ev = collect(bot);
    let stopped;
    bot.addEventListener("stop", (e) => (stopped = e.detail));
    const reason = await withTimeout(bot.start(cfg(srv.url)), 30000, "live run");
    assert.match(reason, /PROFIT TARGET/);
    assert.ok(stopped.report.day.pnl >= 2);
    assert.equal(ev.trades.length, stopped.report.day.trades);
    assert.ok(ev.trades.every((t) => t.mode === "live" && t.contractId));
    assert.equal(JSON.parse(st.getItem("dab_trades")).length, ev.trades.length);
    assert.equal(JSON.parse(st.getItem("dab_daily_live")).targetHit, true);
    // Restarting the same day refuses to trade.
    assert.match(await new BotEngine({ storage: st }).start(cfg(srv.url)), /PROFIT TARGET/);
  });

  test("paper mode works without a token and never buys", async () => {
    const bot = new BotEngine({ storage: new MemStorage() });
    const ev = collect(bot);
    const reason = await withTimeout(bot.start(cfg(srv.url, { paper: true, token: "", profitTarget: 1.5, maxDailyLoss: 20 })), 60000, "paper run");
    assert.match(reason, /PROFIT TARGET|LOSS/);
    assert.ok(ev.trades.length > 0 && ev.trades.every((t) => t.mode === "paper"));
    assert.ok(ev.trades.every((t) => t.profit === 0.95 || t.profit === -1));
    assert.ok(!ev.logs.some((l) => l.includes("LIVE BUY")));
  });

  test("user stop", async () => {
    const bot = new BotEngine({ storage: new MemStorage() });
    const p = bot.start(cfg(srv.url, { paper: true, token: "", profitTarget: 1000, maxDailyLoss: 1000, maxTrades: 1000, cooldown: 1000 }));
    await new Promise((r) => setTimeout(r, 1500));
    bot.stop();
    assert.equal(await withTimeout(p, 5000, "stop"), "Stopped by user");
  });

  test("invalid token is fatal", async () => {
    const reason = await withTimeout(new BotEngine({ storage: new MemStorage() }).start(cfg(srv.url, { token: "bad" })), 10000, "bad token");
    assert.match(reason, /FATAL.*InvalidToken/);
  });

  test("LLM gate: HOLD and low confidence are skipped", async () => {
    let n = 0;
    const llm = new LLMEngine({ apiKey: "k", fetchImpl: async (url, init) => {
      n += 1;
      const prompt = JSON.parse(init.body).messages[1].content;
      const pr = Number(prompt.match(/P\(RISE\)=([\d.]+)/)[1]);
      const dir = pr >= 0.5 ? "RISE" : "FALL";
      const c = n === 1 ? { direction: "HOLD", confidence: 0 } : n === 2 ? { direction: dir, confidence: 50 } : { direction: dir, confidence: 85, reason: "agree" };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(c) } }] }), { status: 200 });
    } });
    const bot = new BotEngine({ storage: new MemStorage(), llm });
    const ev = collect(bot);
    const reason = await withTimeout(bot.start(cfg(srv.url, { useLlm: true, groqKey: "k" })), 30000, "llm run");
    assert.match(reason, /PROFIT TARGET/);
    assert.ok(n >= ev.trades.length + 2);
    assert.ok(ev.trades.every((t) => t.aiConf === 85));
  });
});

describe("engine safety + resilience", () => {
  test("real-money account blocked unless allowed", async () => {
    const srv = await startServer(["--real"]);
    try {
      const reason = await withTimeout(new BotEngine({ storage: new MemStorage() }).start(cfg(srv.url)), 10000, "real");
      assert.match(reason, /FATAL.*REAL/);
    } finally { srv.stop(); }
  });

  test("loss limit stops trading", async () => {
    const srv = await startServer(["--win", "0"]);
    try {
      const bot = new BotEngine({ storage: new MemStorage() });
      const ev = collect(bot);
      const reason = await withTimeout(bot.start(cfg(srv.url, { maxDailyLoss: 3 })), 30000, "loss");
      assert.match(reason, /LOSS/);
      assert.equal(ev.trades.length, 3);
    } finally { srv.stop(); }
  });

  test("reconnects after the connection drops", async () => {
    const srv = await startServer(["--win", "0.75", "--drop-after", "40"]);
    try {
      const bot = new BotEngine({ storage: new MemStorage() });
      bot.backoff = () => 50;
      const ev = collect(bot);
      const reason = await withTimeout(bot.start(cfg(srv.url, { profitTarget: 6 })), 30000, "reconnect");
      assert.ok(ev.status.includes("reconnecting"));
      assert.match(reason, /PROFIT TARGET/);
    } finally { srv.stop(); }
  });

  test("checkConnection returns account and quote", async () => {
    const srv = await startServer();
    try {
      const info = await new BotEngine({ storage: new MemStorage() }).checkConnection(cfg(srv.url));
      assert.equal(info.auth.loginid, "VRTC1234567");
      assert.equal(info.payout, 1.95);
    } finally { srv.stop(); }
  });
});
