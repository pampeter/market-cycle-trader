// UI wiring for the Deriv AI Bot PWA.
import { BotEngine, DEFAULT_CONFIG, validateConfig } from "./engine.js";
import { RiskManager } from "./risk.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 2) => (v == null || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(d));
const signed = (v) => `${v > 0 ? "+" : ""}${fmt(v)}`;
const pnlClass = (v) => (v > 0 ? "pos-c" : v < 0 ? "neg-c" : "");

// ------------------------------------------------------------ settings
const SETTINGS_KEY = "dab_settings";
const UI_DEFAULTS = { keepAwake: true, vibrate: true };
const NUM = ["stake", "duration", "paperStartBalance", "profitTarget", "maxDailyLoss", "maxTrades", "maxConsecLosses", "cooldown", "trainWindow", "minAiConf"];
const TEXT = ["token", "groqKey", "groqModel", "appId", "wsUrl", "symbol"];
const BOOL = ["allowReal", "useLlm", "requireAgreement", "keepAwake", "vibrate"];

function loadSettings() {
  try { return { ...DEFAULT_CONFIG, ...UI_DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; }
  catch { return { ...DEFAULT_CONFIG, ...UI_DEFAULTS }; }
}
let settings = loadSettings();
const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
const mode = () => (settings.paper ? "paper" : "live");

function engineConfig() {
  const c = {};
  for (const k of Object.keys(DEFAULT_CONFIG)) c[k] = settings[k];
  c.token = (c.token || "").trim();
  c.groqKey = (c.groqKey || "").trim();
  c.appId = String(c.appId || "1089").trim();
  c.wsUrl = (c.wsUrl || DEFAULT_CONFIG.wsUrl).trim();
  c.groqModel = (c.groqModel || DEFAULT_CONFIG.groqModel).trim();
  return c;
}

function fillForm() {
  for (const k of NUM) $(k).value = settings[k];
  for (const k of TEXT) $(k).value = settings[k] ?? "";
  for (const k of BOOL) $(k).checked = !!settings[k];
  $("minMlProbPct").value = Math.round(settings.minMlProb * 100);
  document.querySelectorAll("#modeSeg button").forEach((b) => b.classList.toggle("on", (b.dataset.mode === "paper") === settings.paper));
}

function readField(el) {
  const id = el.id;
  if (NUM.includes(id)) { const v = parseFloat(el.value); if (!Number.isNaN(v)) settings[id] = v; }
  else if (TEXT.includes(id)) settings[id] = el.value;
  else if (BOOL.includes(id)) settings[id] = el.checked;
  else if (id === "minMlProbPct") { const v = parseFloat(el.value); if (!Number.isNaN(v)) settings.minMlProb = v / 100; }
  else return;
  saveSettings();
  refreshStatic();
}

// --------------------------------------------------------------- engine
const engine = new BotEngine();
let currentPosition = null;
let lastPrice = null;
let wakeLock = null;
let sparkQueued = false;

// ------------------------------------------------------------ rendering
function refreshStatic() {
  $("hdrSymbol").textContent = settings.symbol;
  $("mktTitle").textContent = settings.symbol;
  const live = !settings.paper;
  $("modeBadge").textContent = live ? "LIVE" : "PAPER";
  $("modeBadge").className = `badge ${live ? "b-live" : "b-paper"}`;
  $("setupCard").classList.toggle("hidden", !!settings.token.trim() || live);
  $("allowRealWrap").classList.toggle("hidden", !live);
  $("llmFields").classList.toggle("hidden", !settings.useLlm);
  $("mlThr").style.left = `${settings.minMlProb * 100}%`;
  if (!engine.running) renderIdleStats();
}

function renderIdleStats() {
  const r = new RiskManager({
    stake: settings.stake, profitTarget: settings.profitTarget, maxDailyLoss: settings.maxDailyLoss,
    maxTradesPerDay: settings.maxTrades, maxConsecutiveLosses: settings.maxConsecLosses, cooldownSeconds: 0,
    storage: localStorage, storageKey: `dab_daily_${mode()}`,
  });
  renderStats({ day: r.state, winRate: r.winRate, sessionPnl: 0, profitTarget: settings.profitTarget, maxDailyLoss: settings.maxDailyLoss, mode: mode() });
  if (settings.paper) { $("balLabel").textContent = "Paper balance"; $("acctBalance").textContent = fmt(settings.paperStartBalance); }
}

function renderStats(s) {
  const d = s.day;
  $("dayPnl").textContent = signed(d.pnl);
  $("dayPnl").className = `pnl ${pnlClass(d.pnl)}`;
  $("dayDate").textContent = `${d.date} UTC · ${s.mode}`;
  $("lossFill").style.width = `${Math.min(100, (Math.max(0, -d.pnl) / s.maxDailyLoss) * 100)}%`;
  $("targetFill").style.width = `${Math.min(100, (Math.max(0, d.pnl) / s.profitTarget) * 100)}%`;
  $("lossLabel").textContent = `-${fmt(s.maxDailyLoss)} limit`;
  $("targetLabel").textContent = `+${fmt(s.profitTarget)} target`;
  $("stTrades").textContent = d.trades;
  $("stWL").textContent = `${d.wins}/${d.losses}`;
  $("stWin").textContent = d.trades ? `${Math.round(s.winRate * 100)}%` : "—";
  $("stSession").textContent = signed(s.sessionPnl);
  $("stSession").className = `v ${pnlClass(s.sessionPnl)}`;
  if (s.mode === "paper" && s.balance != null) { $("balLabel").textContent = "Paper balance"; $("acctBalance").textContent = fmt(s.balance); }
}

function setRunningUI(running) {
  const btn = $("startBtn");
  btn.textContent = running ? "■ Stop bot" : "▶ Start bot";
  btn.className = `btn big ${running ? "stop" : "start"}`;
  $("settingsFs").disabled = running;
  $("runningNote").classList.toggle("hidden", !running);
}

function drawSpark(prices) {
  const cv = $("spark");
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w) return;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const ctx = cv.getContext?.("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pts = prices.slice(-120);
  if (pts.length < 2) return;
  let min = Math.min(...pts), max = Math.max(...pts);
  const entry = currentPosition?.entry;
  if (entry != null) { min = Math.min(min, entry); max = Math.max(max, entry); }
  const pad = (max - min) * 0.1 || 1;
  min -= pad; max += pad;
  const x = (i) => (i / (pts.length - 1)) * (w - 4) + 2;
  const y = (v) => h - ((v - min) / (max - min)) * h;
  const up = pts.at(-1) >= pts[0];
  const col = up ? "#26a69a" : "#ef5350";
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, up ? "#26a69a33" : "#ef535033");
  grad.addColorStop(1, "#0000");
  ctx.beginPath();
  pts.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.stroke();
  ctx.lineTo(x(pts.length - 1), h); ctx.lineTo(x(0), h); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  if (entry != null) {
    ctx.setLineDash([4, 4]); ctx.strokeStyle = "#3d8bfd"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y(entry)); ctx.lineTo(w, y(entry)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = "#3d8bfd"; ctx.font = "10px ui-monospace, monospace"; ctx.fillText(`entry ${entry}`, 4, y(entry) - 4);
  }
  ctx.beginPath(); ctx.arc(x(pts.length - 1), y(pts.at(-1)), 3, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
}

function renderPosition(pos) {
  currentPosition = pos;
  $("posCard").classList.toggle("hidden", !pos);
  if (!pos) return;
  $("posMode").textContent = pos.mode.toUpperCase();
  $("posMode").className = `badge ${pos.mode === "live" ? "b-live" : "b-paper"}`;
  $("posDir").textContent = pos.direction === "RISE" ? "RISE ▲" : "FALL ▼";
  $("posDir").className = `dir ${pos.direction === "RISE" ? "pos-c" : "neg-c"}`;
  $("posStake").textContent = `${fmt(pos.stake)} → ${fmt(pos.payout)}`;
  $("posEntry").textContent = pos.entry ?? "waiting…";
  $("posTicks").innerHTML = Array.from({ length: pos.duration }, (_, i) => `<span class="${i < pos.ticks ? "done" : ""}"></span>`).join("");
}

function renderSignal({ ml, llm, note }) {
  if (ml) {
    $("mlDir").textContent = ml.direction === "RISE" ? "RISE ▲" : "FALL ▼";
    $("mlDir").className = ml.direction === "RISE" ? "pos-c" : "neg-c";
    $("mlProb").textContent = `${(ml.probability * 100).toFixed(1)}%`;
    $("mlFill").style.width = `${ml.probability * 100}%`;
    $("mlFill").style.background = ml.probability >= settings.minMlProb ? "#26a69a" : "#3d8bfd";
    $("mlAcc").textContent = `holdout accuracy ${ml.holdoutAccuracy == null ? "n/a" : Math.round(ml.holdoutAccuracy * 100) + "%"} · ${ml.nSamples} samples`;
  }
  if (llm) {
    const c = { RISE: "pos-c", FALL: "neg-c" }[llm.direction] || "";
    $("llmDir").textContent = llm.direction;
    $("llmDir").className = c;
    $("llmConf").textContent = `${llm.confidence}/100`;
    $("llmReason").textContent = llm.reason;
  } else if (!engine.llm) {
    $("llmDir").textContent = "off";
    $("llmDir").className = "muted";
    $("llmConf").textContent = "";
    $("llmReason").textContent = settings.useLlm ? "Add a Groq API key in Settings to enable" : "LLM filter disabled (ML-only)";
  }
  if (note) $("aiNote").textContent = note;
}

function addLog({ msg, level, time }) {
  const li = document.createElement("li");
  li.className = level;
  li.innerHTML = `<time>${time.toLocaleTimeString([], { hour12: false })}</time>${esc(msg)}`;
  const ul = $("log");
  ul.prepend(li);
  while (ul.children.length > 150) ul.lastChild.remove();
}

// -------------------------------------------------------------- history
const loadTrades = () => { try { return JSON.parse(localStorage.getItem("dab_trades") || "[]"); } catch { return []; } };

function renderHistory() {
  const f = $("histFilter").value;
  const all = loadTrades().filter((t) => f === "all" || t.mode === f);
  const total = all.reduce((s, t) => s + t.profit, 0);
  const wins = all.filter((t) => t.profit > 0).length;
  $("histCount").textContent = `${all.length} trades`;
  $("histN").textContent = all.length;
  $("histPnl").textContent = signed(Math.round(total * 100) / 100);
  $("histPnl").className = `v ${pnlClass(total)}`;
  $("histWin").textContent = all.length ? `${Math.round((wins / all.length) * 100)}%` : "—";
  $("histList").innerHTML = all.length
    ? all.slice(-200).reverse().map((t) => {
        const d = new Date(t.time);
        return `<div class="trade-item"><div class="l"><div class="ic ${t.direction === "RISE" ? "rise" : "fall"}">${t.direction === "RISE" ? "▲" : "▼"}</div>
          <div><div class="t1">${esc(t.direction)} · ${esc(t.symbol)} <span class="badge ${t.mode === "live" ? "b-live" : "b-paper"}">${t.mode.toUpperCase()}</span></div>
          <div class="t2">${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour12: false })} · stake ${fmt(t.stake)} · ML ${Math.round(t.mlProb * 100)}% · AI ${t.aiConf}</div></div></div>
          <div class="pl ${pnlClass(t.profit)}">${signed(t.profit)}<div class="t2">${t.profit > 0 ? "WIN" : "LOSS"}</div></div></div>`;
      }).join("")
    : `<div class="panel muted" style="text-align:center">No trades yet</div>`;
}

function exportCsv() {
  const rows = loadTrades();
  if (!rows.length) return toast("No trades to export");
  const cols = ["time", "mode", "symbol", "direction", "stake", "payout", "entry", "exit", "profit", "dayPnl", "mlProb", "aiConf", "reason", "contractId"];
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => `"${String(r[c] ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `deriv-bot-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------------------------------------------------------- modal/toast
function modal(title, html, buttons = [{ label: "OK", cls: "primary" }]) {
  return new Promise((resolve) => {
    $("modalTitle").textContent = title;
    $("modalBody").innerHTML = html;
    const box = $("modalBtns");
    box.innerHTML = "";
    buttons.forEach((b) => {
      const el = document.createElement("button");
      el.className = `btn ${b.cls || ""}`;
      el.textContent = b.label;
      el.onclick = () => {
        if (b.validate && !b.validate()) return;
        $("modal").classList.add("hidden");
        resolve(b.value ?? b.label);
      };
      box.appendChild(el);
    });
    $("modal").classList.remove("hidden");
  });
}

let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

const RISK_HTML = `
  <p><b>Please read before using the bot.</b></p>
  <ul>
    <li>Deriv's Volatility Indices are <b>generated by a random number generator</b>. No indicator, ML model or AI can reliably predict them. A high confidence score does <b>not</b> mean a high chance of winning.</li>
    <li>A win pays about <b>+95%</b> of your stake and a loss costs <b>100%</b>. You need to win about 52% of trades just to break even, so most bots slowly lose money over time.</li>
    <li>The profit target only decides <b>when the bot stops</b>. It doesn't make reaching the target more likely, and on many days the loss limit will be hit first.</li>
    <li>Only use money you can afford to lose. Start in <b>Paper</b> mode, then use your <b>Demo</b> account.</li>
    <li>This app is for educational purposes and comes with no warranty. You are responsible for every trade it places.</li>
  </ul>`;

// --------------------------------------------------------------- actions
async function startBot() {
  const cfg = engineConfig();
  try { validateConfig(cfg); }
  catch (e) { await modal("Check your settings", `<p>${esc(e.message)}</p>`); return; }

  if (!cfg.paper) {
    const ok = await modal("⚠️ Start LIVE trading?", `
      <p>The bot will place <b>real</b> ${cfg.duration}-tick Rise/Fall contracts of <b>${fmt(cfg.stake)}</b> on <b>${esc(cfg.symbol)}</b> using your Deriv account.</p>
      <p>It stops at <b class="pos-c">+${fmt(cfg.profitTarget)}</b> profit or <b class="neg-c">-${fmt(cfg.maxDailyLoss)}</b> loss for the day.</p>
      <label for="yesInput">Type YES to confirm</label><input id="yesInput" autocapitalize="characters" autocomplete="off">`,
      [{ label: "Cancel", value: false }, { label: "Start live", cls: "danger", value: true, validate: () => $("yesInput").value.trim().toUpperCase() === "YES" || (toast("Type YES to confirm"), false) }]);
    if (!ok) return;
  }

  $("log").innerHTML = "";
  renderPosition(null);
  setRunningUI(true);
  acquireWake();
  engine.start(cfg).catch((e) => {
    addLog({ msg: e.message, level: "error", time: new Date() });
    setRunningUI(false);
  });
}

async function testConnection() {
  const cfg = engineConfig();
  $("testBtn").disabled = true;
  $("testBtn").textContent = "Testing…";
  try {
    const info = await engine.checkConnection(cfg);
    const a = info.auth;
    const acct = a ? `
      <tr><td>Login ID</td><td>${esc(a.loginid)}</td></tr>
      <tr><td>Account</td><td>${a.is_virtual ? '<span class="pos-c">Demo (virtual)</span>' : '<span class="neg-c">REAL MONEY</span>'}</td></tr>
      <tr><td>Balance</td><td>${fmt(a.balance)} ${esc(a.currency)}</td></tr>
      <tr><td>Token scopes</td><td>${esc((a.scopes || []).join(", "))}</td></tr>` : `<tr><td>Account</td><td class="muted">no token (paper only)</td></tr>`;
    await modal("✅ Connected to Deriv", `<table class="kv">${acct}
      <tr><td>${esc(cfg.symbol)} price</td><td>${esc(info.lastPrice)}</td></tr>
      <tr><td>Quote</td><td>${fmt(info.askPrice)} → ${fmt(info.payout)}</td></tr></table>
      ${a && !a.is_virtual ? '<p class="neg-c">This is a real-money token. Consider using a Demo token while testing.</p>' : ""}
      ${a && a.scopes && !a.scopes.includes("trade") ? '<p class="neg-c">The token is missing the Trade scope, so live trading won\'t work.</p>' : ""}`);
  } catch (e) {
    await modal("❌ Connection failed", `<p>${esc(e.message)}</p><p class="muted">Check the token (Read + Trade scopes) and your internet connection.</p>`);
  } finally {
    $("testBtn").disabled = false;
    $("testBtn").textContent = "Test connection";
  }
}

async function showReport(reason, r) {
  const d = r.day;
  const bal = r.balance == null ? "" : `<tr><td>${r.mode === "paper" ? "Paper balance" : "Balance"}</td><td>${fmt(r.balance)} ${esc(r.currency || "")}</td></tr>`;
  await modal(reason.includes("TARGET") ? "🏁 Profit target reached" : "📊 Bot stopped", `
    <table class="kv">
      <tr><td>Reason</td><td style="white-space:normal">${esc(reason)}</td></tr>
      <tr><td>Mode</td><td>${r.mode.toUpperCase()} · ${esc(r.symbol)}</td></tr>
      <tr><td>Session trades</td><td>${r.sessionTrades}</td></tr>
      <tr><td>Session P/L</td><td class="${pnlClass(r.sessionPnl)}">${signed(r.sessionPnl)}</td></tr>
      <tr><td>Today's trades</td><td>${d.trades} (${d.wins}W / ${d.losses}L)</td></tr>
      <tr><td>Today's win rate</td><td>${d.trades ? Math.round(r.winRate * 100) + "%" : "—"}</td></tr>
      <tr><td>Today's P/L</td><td class="${pnlClass(d.pnl)}">${signed(d.pnl)}</td></tr>
      <tr><td>Max drawdown</td><td>${fmt(d.maxDrawdown)}</td></tr>
      ${bal}
    </table>`);
}

// ------------------------------------------------------------- wake lock
async function acquireWake() {
  if (!settings.keepAwake || !("wakeLock" in navigator)) return;
  try { wakeLock = await navigator.wakeLock.request("screen"); } catch { /* not allowed */ }
}
function releaseWake() { wakeLock?.release().catch(() => {}); wakeLock = null; }

// ------------------------------------------------------------ event wiring
engine.addEventListener("log", (e) => addLog(e.detail));
engine.addEventListener("status", (e) => {
  const s = e.detail.state;
  const labels = { connecting: "Connecting", reconnecting: "Reconnecting", running: "Running", stopped: "Stopped" };
  $("statusPill").className = `pill ${s}`;
  $("statusPill").querySelector("span").textContent = labels[s] || s;
});
engine.addEventListener("account", (e) => {
  const a = e.detail.auth;
  $("acctLogin").textContent = a.loginid;
  $("acctType").textContent = a.is_virtual ? "DEMO" : "REAL";
  $("acctType").className = `badge ${a.is_virtual ? "b-demo" : "b-live"}`;
});
engine.addEventListener("balance", (e) => {
  if (!settings.paper) { $("balLabel").textContent = "Balance"; $("acctBalance").textContent = `${fmt(e.detail.balance)} ${e.detail.currency}`; }
});
engine.addEventListener("tick", (e) => {
  const { price, prices } = e.detail;
  const el = $("price");
  el.textContent = price;
  el.style.color = lastPrice == null || price === lastPrice ? "" : price > lastPrice ? "#26a69a" : "#ef5350";
  lastPrice = price;
  if (currentPosition) $("posNow").textContent = price;
  if (!sparkQueued) { sparkQueued = true; requestAnimationFrame(() => { sparkQueued = false; drawSpark(prices); }); }
});
engine.addEventListener("signal", (e) => renderSignal(e.detail));
engine.addEventListener("position", (e) => renderPosition(e.detail.position));
engine.addEventListener("stats", (e) => renderStats(e.detail));
engine.addEventListener("trade", (e) => {
  const t = e.detail.trade;
  if (settings.vibrate && navigator.vibrate) navigator.vibrate(t.profit > 0 ? 80 : [150, 80, 150]);
  toast(`${t.profit > 0 ? "✅ WIN" : "❌ LOSS"} ${signed(t.profit)} · day ${signed(t.dayPnl)}`);
  if ($("tab-trades").classList.contains("active")) renderHistory();
});
engine.addEventListener("stop", (e) => {
  setRunningUI(false);
  releaseWake();
  renderPosition(null);
  showReport(e.detail.reason || "Stopped", e.detail.report);
});

// Tabs
function showTab(id) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${id}`));
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === id));
  if (id === "trades") renderHistory();
  window.scrollTo(0, 0);
}
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]");
  if (g) { e.preventDefault(); showTab(g.dataset.goto); }
});

// Settings form
$("settingsForm").addEventListener("input", (e) => readField(e.target));
$("settingsForm").addEventListener("change", (e) => readField(e.target));
document.querySelectorAll("#modeSeg button").forEach((b) => b.addEventListener("click", () => {
  settings.paper = b.dataset.mode === "paper";
  saveSettings(); fillForm(); refreshStatic();
}));
document.querySelectorAll("[data-eye]").forEach((b) => b.addEventListener("click", () => {
  const i = $(b.dataset.eye); i.type = i.type === "password" ? "text" : "password";
}));
$("testBtn").addEventListener("click", testConnection);
$("resetDay").addEventListener("click", async () => {
  const ok = await modal("Reset today's counters?", `<p>This clears today's P/L, trade count and loss streak for <b>${mode().toUpperCase()}</b> mode. It also resets the daily loss limit, so only do this if you really mean it.</p>`,
    [{ label: "Cancel", value: false }, { label: "Reset", cls: "danger", value: true }]);
  if (ok) { localStorage.removeItem(`dab_daily_${mode()}`); renderIdleStats(); toast("Today's counters reset"); }
});
$("forgetKeys").addEventListener("click", async () => {
  const ok = await modal("Forget keys?", "<p>Removes your Deriv token and Groq key from this phone.</p>", [{ label: "Cancel", value: false }, { label: "Forget", cls: "danger", value: true }]);
  if (ok) { settings.token = ""; settings.groqKey = ""; saveSettings(); fillForm(); refreshStatic(); toast("Keys removed"); }
});
$("showRisk").addEventListener("click", () => modal("Risk warning", RISK_HTML));

// Dashboard / history buttons
$("startBtn").addEventListener("click", () => (engine.running ? engine.stop() : startBot()));
$("clearLog").addEventListener("click", () => ($("log").innerHTML = ""));
$("histFilter").addEventListener("change", renderHistory);
$("exportCsv").addEventListener("click", exportCsv);
$("clearHist").addEventListener("click", async () => {
  const ok = await modal("Clear trade history?", "<p>This deletes the trade list on this phone. Today's P/L counters are kept.</p>", [{ label: "Cancel", value: false }, { label: "Clear", cls: "danger", value: true }]);
  if (ok) { localStorage.removeItem("dab_trades"); renderHistory(); }
});

// Foreground / background
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && engine.running) {
    engine.nudge();
    acquireWake();
  }
});
window.addEventListener("beforeunload", (e) => { if (engine.running) { e.preventDefault(); e.returnValue = ""; } });
window.addEventListener("resize", () => engine.prices.length && drawSpark(engine.prices));

// Install prompt (Android Chrome)
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $("installCard").classList.remove("hidden");
});
$("installBtn").addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice.catch(() => {});
  deferredPrompt = null;
  $("installCard").classList.add("hidden");
});
window.addEventListener("appinstalled", () => { $("installCard").classList.add("hidden"); toast("App installed 🎉"); });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});

// ------------------------------------------------------------------ init
fillForm();
refreshStatic();
renderSignal({ ml: null, llm: null, note: "Press Start to begin" });
if (!localStorage.getItem("dab_ack")) {
  modal("⚠️ Risk warning", RISK_HTML, [{ label: "I understand", cls: "primary" }]).then(() => localStorage.setItem("dab_ack", "1"));
}
