"""Groq LLM second-opinion filter.

The LLM receives the ML probabilities, the engineered features and the last
20 ticks, and must answer with strict JSON:

    {"direction": "RISE" | "FALL" | "HOLD", "confidence": 0-100, "reason": "..."}

Any failure (timeout, bad JSON, HTTP error) is converted into a HOLD so the
bot never trades on a broken answer.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

import httpx

from .ml_engine import MLSignal

SYSTEM_PROMPT = """You are a cautious risk filter for a short-term binary options bot on Deriv.
The instrument is a synthetic Volatility Index. Its prices come from a random number generator,
so most of the time there is NO real edge. Your job is to veto weak signals, not to find trades.

You get: a machine-learning model's probability that price will be higher/lower after N ticks,
the model's out-of-sample accuracy, engineered features and the most recent ticks.

Rules:
- Answer ONLY with a JSON object: {"direction": "RISE"|"FALL"|"HOLD", "confidence": <integer 0-100>, "reason": "<max 20 words>"}
- Say HOLD unless the ML probability, the model accuracy and the recent price action all clearly agree.
- Confidence above 85 should be rare. Never exceed 95.
- Payout is below 100% of stake, so a coin-flip signal loses money over time."""


@dataclass
class LLMDecision:
    direction: str  # RISE / FALL / HOLD
    confidence: int
    reason: str
    source: str = "llm"  # "llm", "ml-only", or "error"

    @classmethod
    def hold(cls, reason: str, source: str = "error") -> "LLMDecision":
        return cls("HOLD", 0, reason, source)


def build_user_prompt(signal: MLSignal, ticks: list[float], symbol: str, duration: int) -> str:
    acc = "n/a" if signal.holdout_accuracy is None else f"{signal.holdout_accuracy:.1%}"
    feats = ", ".join(f"{k}={v:.3e}" for k, v in signal.features.items())
    recent = ", ".join(f"{t:g}" for t in ticks[-20:])
    return (
        f"Symbol: {symbol}. Contract: {duration}-tick Rise/Fall.\n"
        f"ML P(RISE)={signal.prob_rise:.3f}, P(FALL)={signal.prob_fall:.3f} "
        f"(trained on {signal.n_samples} samples, holdout accuracy {acc}).\n"
        f"Features (price-normalised): {feats}\n"
        f"Last 20 ticks (oldest -> newest): {recent}\n"
        "Return the JSON decision."
    )


_JSON_RE = re.compile(r"\{.*\}", re.DOTALL)


def parse_decision(text: str) -> LLMDecision:
    """Parse the model output into an :class:`LLMDecision` (HOLD on failure)."""
    if not text:
        return LLMDecision.hold("empty LLM response")
    cleaned = text.strip()
    cleaned = re.sub(r"^```(?:json)?|```$", "", cleaned, flags=re.MULTILINE).strip()
    match = _JSON_RE.search(cleaned)
    if not match:
        return LLMDecision.hold("LLM did not return JSON")
    try:
        data = json.loads(match.group(0))
    except json.JSONDecodeError:
        return LLMDecision.hold("LLM returned invalid JSON")

    direction = str(data.get("direction", "HOLD")).strip().upper()
    direction = {"CALL": "RISE", "UP": "RISE", "PUT": "FALL", "DOWN": "FALL"}.get(direction, direction)
    if direction not in {"RISE", "FALL", "HOLD"}:
        direction = "HOLD"
    try:
        confidence = int(round(float(data.get("confidence", 0))))
    except (TypeError, ValueError):
        confidence = 0
    confidence = max(0, min(95, confidence))
    reason = str(data.get("reason", "")).strip()[:160] or "no reason given"
    return LLMDecision(direction, confidence, reason, "llm")


class LLMEngine:
    def __init__(
        self,
        api_key: str,
        model: str = "openai/gpt-oss-120b",
        base_url: str = "https://api.groq.com/openai/v1",
        timeout: float = 12.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.api_key = api_key
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._client = httpx.AsyncClient(timeout=timeout, transport=transport)

    async def aclose(self) -> None:
        await self._client.aclose()

    def _payload(self, user_prompt: str) -> dict:
        payload: dict = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.2,
            "max_completion_tokens": 800,
            "response_format": {"type": "json_object"},
        }
        if self.model.startswith("openai/gpt-oss"):
            payload["reasoning_effort"] = "low"
        return payload

    async def analyze(self, signal: MLSignal, ticks: list[float], symbol: str, duration: int) -> LLMDecision:
        prompt = build_user_prompt(signal, ticks, symbol, duration)
        try:
            resp = await self._client.post(
                f"{self.base_url}/chat/completions",
                headers={"Authorization": f"Bearer {self.api_key}"},
                json=self._payload(prompt),
            )
        except httpx.TimeoutException:
            return LLMDecision.hold(f"LLM timeout after {self.timeout:.0f}s")
        except httpx.HTTPError as exc:
            return LLMDecision.hold(f"LLM network error: {exc.__class__.__name__}")

        if resp.status_code != 200:
            detail = ""
            try:
                detail = resp.json().get("error", {}).get("message", "")
            except Exception:
                detail = resp.text[:120]
            return LLMDecision.hold(f"LLM HTTP {resp.status_code}: {detail}"[:160])

        try:
            content = resp.json()["choices"][0]["message"]["content"]
        except (KeyError, IndexError, ValueError, TypeError):
            return LLMDecision.hold("unexpected LLM response shape")
        return parse_decision(content)


def ml_only_decision(signal: MLSignal) -> LLMDecision:
    """Used when no GROQ_API_KEY is configured: confidence = ML probability."""
    return LLMDecision(
        direction=signal.direction,
        confidence=int(round(signal.probability * 100)),
        reason="ML-only mode (no LLM configured)",
        source="ml-only",
    )
