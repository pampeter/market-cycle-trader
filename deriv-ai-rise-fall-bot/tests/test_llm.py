import json

import httpx

from deriv_bot.llm_engine import LLMEngine, ml_only_decision, parse_decision
from deriv_bot.ml_engine import MLSignal

SIG = MLSignal(prob_rise=0.66, prob_fall=0.34, holdout_accuracy=0.58, n_samples=90,
               features={"return": 1e-4, "momentum": 2e-4, "volatility": 3e-4, "ema8_ema21": 1e-5, "sma5_sma10": 2e-5})


def test_parse_plain_json():
    d = parse_decision('{"direction": "RISE", "confidence": 82, "reason": "trend up"}')
    assert (d.direction, d.confidence, d.reason) == ("RISE", 82, "trend up")


def test_parse_code_fence_and_aliases():
    d = parse_decision('```json\n{"direction": "put", "confidence": "91.6", "reason": "x"}\n```')
    assert d.direction == "FALL" and d.confidence == 92


def test_parse_clamps_and_rejects():
    assert parse_decision('{"direction":"RISE","confidence":150}').confidence == 95
    assert parse_decision('{"direction":"MOON","confidence":90}').direction == "HOLD"
    assert parse_decision("no json here").direction == "HOLD"
    assert parse_decision("").direction == "HOLD"


def test_ml_only():
    d = ml_only_decision(SIG)
    assert d.direction == "RISE" and d.confidence == 66 and d.source == "ml-only"


async def test_llm_engine_success():
    seen = {}

    def handler(request: httpx.Request):
        body = json.loads(request.content)
        seen["body"] = body
        seen["auth"] = request.headers["authorization"]
        content = json.dumps({"direction": "RISE", "confidence": 84, "reason": "momentum agrees"})
        return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})

    eng = LLMEngine("k123", model="openai/gpt-oss-120b", transport=httpx.MockTransport(handler))
    d = await eng.analyze(SIG, [1.0 + i for i in range(30)], "R_75", 5)
    await eng.aclose()
    assert d.direction == "RISE" and d.confidence == 84
    assert seen["auth"] == "Bearer k123"
    assert seen["body"]["response_format"] == {"type": "json_object"}
    assert seen["body"]["reasoning_effort"] == "low"
    assert "P(RISE)=0.660" in seen["body"]["messages"][1]["content"]


async def test_llm_engine_http_error_is_hold():
    eng = LLMEngine("bad", model="llama-3.3-70b-versatile",
                    transport=httpx.MockTransport(lambda r: httpx.Response(401, json={"error": {"message": "Invalid API Key"}})))
    d = await eng.analyze(SIG, [1.0] * 20, "R_75", 5)
    await eng.aclose()
    assert d.direction == "HOLD" and "401" in d.reason
