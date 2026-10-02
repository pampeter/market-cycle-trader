// UI smoke test: loads index.html in jsdom, runs app.js against the fake Deriv server.
// Run: npm i --no-save jsdom && PYTHON=python3 node tests/ui.smoke.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const here = dirname(fileURLToPath(import.meta.url));
const port = 19400 + Math.floor(Math.random() * 400);
const srv = spawn(process.env.PYTHON || "python3", [join(here, "../../deriv-ai-rise-fall-bot/tests/fake_deriv_server.py"), "--host", "127.0.0.1", "--port", String(port), "--tick-interval", "0.05", "--win", "0.8"]);
await new Promise((r) => srv.stdout.on("data", (d) => String(d).includes("listening") && r()));

const html = readFileSync(join(here, "../index.html"), "utf8").replace(/<script type="module".*<\/script>/, "");
const dom = new JSDOM(html, { url: "https://example.test/deriv-bot/", pretendToBeVisual: true });
const { window } = dom;
for (const k of ["window", "document", "localStorage", "navigator", "requestAnimationFrame", "HTMLElement"]) {
  Object.defineProperty(globalThis, k, { value: window[k], configurable: true, writable: true });
}
globalThis.window = window;
localStorage.setItem("dab_settings", JSON.stringify({
  wsUrl: `ws://127.0.0.1:${port}`, token: "demo", paper: false, profitTarget: 2, cooldown: 0,
  minMlProb: 0.5, useLlm: false, trainWindow: 60,
}));
localStorage.setItem("dab_ack", "1");

await import("../js/app.js");
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Initial render
assert.equal($("modeBadge").textContent, "LIVE");
assert.equal($("startBtn").textContent.includes("Start"), true);
assert.equal($("allowRealWrap").classList.contains("hidden"), false);

// Start live -> confirmation sheet requires YES
$("startBtn").click();
await sleep(50);
assert.equal($("modal").classList.contains("hidden"), false);
const [cancel, go] = $("modalBtns").querySelectorAll("button");
go.click(); // without YES -> stays open
assert.equal($("modal").classList.contains("hidden"), false);
$("yesInput").value = "yes";
go.click();
await sleep(100);
console.log("after start:", $("startBtn").textContent, "|", $("modalTitle").textContent, "|", [...$("log").children].map(l=>l.textContent).join(" / "));
assert.equal($("startBtn").textContent.includes("Stop"), true, "running state");
assert.equal($("settingsFs").disabled, true);

// Wait for the profit target auto-stop
for (let i = 0; i < 300 && !$("modalTitle").textContent.includes("Profit target"); i++) await sleep(100);
console.log("modal:", $("modalTitle").textContent);
assert.match($("modalTitle").textContent, /Profit target reached/);
assert.equal($("acctLogin").textContent, "VRTC1234567");
assert.equal($("acctType").textContent, "DEMO");
assert.match($("dayPnl").textContent, /^\+/);
assert.ok(Number($("stTrades").textContent) >= 3);
assert.ok($("log").children.length > 3);
assert.equal($("startBtn").textContent.includes("Start"), true);
assert.equal($("settingsFs").disabled, false);
console.log("P/L", $("dayPnl").textContent, "trades", $("stTrades").textContent, "balance", $("acctBalance").textContent);
console.log("log sample:", [...$("log").children].slice(0, 6).map((li) => li.textContent).join("\n  "));

// History tab
document.querySelector('nav button[data-tab="trades"]').click();
assert.equal($("tab-trades").classList.contains("active"), true);
assert.equal($("histList").querySelectorAll(".trade-item").length, Number($("stTrades").textContent));

// Settings: switch to paper updates badge
document.querySelector('#modeSeg button[data-mode="paper"]').click();
assert.equal($("modeBadge").textContent, "PAPER");
assert.equal(JSON.parse(localStorage.getItem("dab_settings")).paper, true);

srv.kill();
console.log("UI SMOKE TEST PASSED");
process.exit(0);
