// Groq LLM second-opinion filter. Any failure becomes HOLD.

export const SYSTEM_PROMPT = `You are a cautious risk filter for a short-term binary options bot on Deriv.
The instrument is a synthetic Volatility Index. Its prices come from a random number generator,
so most of the time there is NO real edge. Your job is to veto weak signals, not to find trades.

You get: a machine-learning model's probability that price will be higher/lower after N ticks,
the model's out-of-sample accuracy, engineered features and the most recent ticks.

Rules:
- Answer ONLY with a JSON object: {"direction": "RISE"|"FALL"|"HOLD", "confidence": <integer 0-100>, "reason": "<max 20 words>"}
- Say HOLD unless the ML probability, the model accuracy and the recent price action all clearly agree.
- Confidence above 85 should be rare. Never exceed 95.
- Payout is below 100% of stake, so a coin-flip signal loses money over time.`;

export const hold = (reason, source = "error") => ({ direction: "HOLD", confidence: 0, reason, source });

export function buildUserPrompt(sig, ticks, symbol, duration) {
  const acc = sig.holdoutAccuracy == null ? "n/a" : `${(sig.holdoutAccuracy * 100).toFixed(1)}%`;
  const feats = Object.entries(sig.features).map(([k, v]) => `${k}=${v.toExponential(3)}`).join(", ");
  return `Symbol: ${symbol}. Contract: ${duration}-tick Rise/Fall.
ML P(RISE)=${sig.probRise.toFixed(3)}, P(FALL)=${sig.probFall.toFixed(3)} (trained on ${sig.nSamples} samples, holdout accuracy ${acc}).
Features (price-normalised): ${feats}
Last 20 ticks (oldest -> newest): ${ticks.slice(-20).join(", ")}
Return the JSON decision.`;
}

export function parseDecision(text) {
  if (!text) return hold("empty LLM response");
  const cleaned = String(text).replace(/```(?:json)?/g, "").trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return hold("LLM did not return JSON");
  let data;
  try { data = JSON.parse(m[0]); } catch { return hold("LLM returned invalid JSON"); }
  let dir = String(data.direction ?? "HOLD").trim().toUpperCase();
  dir = { CALL: "RISE", UP: "RISE", PUT: "FALL", DOWN: "FALL" }[dir] || dir;
  if (!["RISE", "FALL", "HOLD"].includes(dir)) dir = "HOLD";
  let conf = Math.round(Number(data.confidence));
  if (!Number.isFinite(conf)) conf = 0;
  conf = Math.max(0, Math.min(95, conf));
  const reason = String(data.reason ?? "").trim().slice(0, 160) || "no reason given";
  return { direction: dir, confidence: conf, reason, source: "llm" };
}

export function mlOnlyDecision(sig) {
  return { direction: sig.direction, confidence: Math.round(sig.probability * 100), reason: "ML-only mode (no LLM key)", source: "ml-only" };
}

export class LLMEngine {
  constructor({ apiKey, model = "openai/gpt-oss-120b", baseUrl = "https://api.groq.com/openai/v1", timeoutMs = 12000, fetchImpl = globalThis.fetch.bind(globalThis) }) {
    Object.assign(this, { apiKey, model, baseUrl: baseUrl.replace(/\/$/, ""), timeoutMs, fetchImpl });
  }

  payload(userPrompt) {
    const body = {
      model: this.model,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: userPrompt }],
      temperature: 0.2,
      max_completion_tokens: 800,
      response_format: { type: "json_object" },
    };
    if (this.model.startsWith("openai/gpt-oss")) body.reasoning_effort = "low";
    return body;
  }

  async analyze(sig, ticks, symbol, duration) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let resp;
    try {
      resp = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(this.payload(buildUserPrompt(sig, ticks, symbol, duration))),
        signal: ctrl.signal,
      });
    } catch (e) {
      return hold(e.name === "AbortError" ? `LLM timeout after ${this.timeoutMs / 1000}s` : "LLM network error (check internet / key)");
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      let detail = "";
      try { detail = (await resp.json())?.error?.message || ""; } catch {}
      return hold(`LLM HTTP ${resp.status}: ${detail}`.slice(0, 160));
    }
    try {
      const data = await resp.json();
      return parseDecision(data.choices[0].message.content);
    } catch {
      return hold("unexpected LLM response shape");
    }
  }
}
