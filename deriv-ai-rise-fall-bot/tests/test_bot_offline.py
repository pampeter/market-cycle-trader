"""End-to-end tests of AIDerivRiseFallBot against the fake Deriv server."""

import asyncio
import csv
import json

import httpx
import pytest

from deriv_bot.config import Config
from deriv_bot.llm_engine import LLMEngine
from deriv_bot.trader import AIDerivRiseFallBot
from tests.fake_deriv_server import FakeDerivServer


def make_cfg(url, tmp_path, **kw):
    cfg = Config(
        ws_url=url,
        app_id="1089",
        api_token="demo-token",
        symbol="R_75",
        stake=1.0,
        paper_trade=False,
        profit_target=2.0,
        max_daily_loss=10.0,
        max_trades_per_day=30,
        max_consecutive_losses=0,
        cooldown_seconds=0.0,
        train_window=60,
        min_ml_probability=0.5,
        use_llm=False,
        state_dir=tmp_path / "state",
        history_count=150,
        llm_retry_seconds=0.0,
        scan_log_every=1000,
    )
    for k, v in kw.items():
        setattr(cfg, k, v)
    cfg.validate()
    return cfg


@pytest.fixture
async def server():
    srv = FakeDerivServer(tick_interval=0.005, win_probability=0.75)
    url = await srv.start()
    yield srv, url
    await srv.stop()


async def test_live_mode_hits_profit_target(server, tmp_path):
    srv, url = server
    cfg = make_cfg(url, tmp_path)
    bot = AIDerivRiseFallBot(cfg)
    reason = await asyncio.wait_for(bot.run(), timeout=30)
    assert "PROFIT TARGET" in reason
    assert bot.risk.state.pnl >= cfg.profit_target
    assert len(srv.buys) == bot.risk.state.trades
    # Every buy used a proposal id and a max price.
    assert all(b["buy"].startswith("prop-") and b["price"] == 1.0 for b in srv.buys)
    # Trade log + persisted state.
    rows = list(csv.DictReader((cfg.state_dir / "trades.csv").open()))
    assert len(rows) == bot.risk.state.trades and rows[0]["mode"] == "live"
    saved = json.loads((cfg.state_dir / "daily_live.json").read_text())
    assert saved["target_hit"] is True
    # Proposals were for 5-tick CALL/PUT contracts.
    props = [r for r in srv.requests if "proposal" in r and "contract_type" in r]
    assert props and all(p["duration"] == 5 and p["duration_unit"] == "t" for p in props)
    assert {p["contract_type"] for p in props} <= {"CALL", "PUT"}


async def test_restart_same_day_refuses_after_target(server, tmp_path):
    srv, url = server
    cfg = make_cfg(url, tmp_path)
    await asyncio.wait_for(AIDerivRiseFallBot(cfg).run(), timeout=30)
    buys = len(srv.buys)
    reason = await asyncio.wait_for(AIDerivRiseFallBot(cfg).run(), timeout=5)
    assert "PROFIT TARGET" in reason and len(srv.buys) == buys


async def test_loss_limit_stops(tmp_path):
    srv = FakeDerivServer(tick_interval=0.005, win_probability=0.0)
    url = await srv.start()
    try:
        cfg = make_cfg(url, tmp_path, max_daily_loss=3.0)
        bot = AIDerivRiseFallBot(cfg)
        reason = await asyncio.wait_for(bot.run(), timeout=30)
        assert "LOSS" in reason
        assert bot.risk.state.pnl == -3.0 and bot.risk.state.trades == 3
    finally:
        await srv.stop()


async def test_paper_mode_sends_no_buys(server, tmp_path):
    srv, url = server
    cfg = make_cfg(url, tmp_path, paper_trade=True, api_token="", profit_target=1.5, max_daily_loss=20.0)
    bot = AIDerivRiseFallBot(cfg)
    reason = await asyncio.wait_for(bot.run(), timeout=60)
    assert srv.buys == []
    assert not any("authorize" in r for r in srv.requests)
    assert bot.risk.state.trades > 0
    assert "PROFIT TARGET" in reason or "LOSS" in reason
    assert (cfg.state_dir / "daily_paper.json").exists()
    # Paper P/L uses the real quote's payout (0.95 profit per 1.00 stake) or -stake.
    rows = list(csv.DictReader((cfg.state_dir / "trades.csv").open()))
    assert {float(r["profit"]) for r in rows} <= {0.95, -1.0}


async def test_real_account_is_blocked_without_opt_in(tmp_path):
    srv = FakeDerivServer(tick_interval=0.005, is_virtual=False)
    url = await srv.start()
    try:
        bot = AIDerivRiseFallBot(make_cfg(url, tmp_path))
        reason = await asyncio.wait_for(bot.run(), timeout=10)
        assert reason.startswith("FATAL") and "REAL" in reason
        assert srv.buys == []
    finally:
        await srv.stop()


async def test_invalid_token_is_fatal(server, tmp_path):
    srv, url = server
    bot = AIDerivRiseFallBot(make_cfg(url, tmp_path, api_token="bad"))
    reason = await asyncio.wait_for(bot.run(), timeout=10)
    assert "InvalidToken" in reason and srv.connections == 1


async def test_reconnects_after_drop(tmp_path, monkeypatch):
    srv = FakeDerivServer(tick_interval=0.005, win_probability=0.75, drop_after_ticks=40)
    url = await srv.start()
    try:
        cfg = make_cfg(url, tmp_path)
        bot = AIDerivRiseFallBot(cfg)
        monkeypatch.setattr(bot, "_backoff", lambda attempt: 0.05)
        reason = await asyncio.wait_for(bot.run(), timeout=30)
        assert srv.dropped and srv.connections >= 2
        assert "PROFIT TARGET" in reason
    finally:
        await srv.stop()


async def test_llm_filter_blocks_and_allows(server, tmp_path):
    srv, url = server
    calls = {"n": 0}

    def handler(request):
        calls["n"] += 1
        prompt = json.loads(request.content)["messages"][1]["content"]
        direction = "RISE" if "P(RISE)=0.5" in prompt or float(prompt.split("P(RISE)=")[1][:5]) >= 0.5 else "FALL"
        # First two answers are HOLD / low confidence, then agree with ML.
        if calls["n"] == 1:
            content = {"direction": "HOLD", "confidence": 0, "reason": "unclear"}
        elif calls["n"] == 2:
            content = {"direction": direction, "confidence": 60, "reason": "weak"}
        else:
            content = {"direction": direction, "confidence": 85, "reason": "agrees"}
        return httpx.Response(200, json={"choices": [{"message": {"content": json.dumps(content)}}]})

    llm = LLMEngine("k", transport=httpx.MockTransport(handler))
    cfg = make_cfg(url, tmp_path, use_llm=True, groq_api_key="k")
    bot = AIDerivRiseFallBot(cfg, llm=llm)
    reason = await asyncio.wait_for(bot.run(), timeout=30)
    assert "PROFIT TARGET" in reason
    assert calls["n"] >= bot.risk.state.trades + 2
    rows = list(csv.DictReader((cfg.state_dir / "trades.csv").open()))
    assert all(int(r["ai_conf"]) == 85 for r in rows)


async def test_check_connection(server, tmp_path):
    srv, url = server
    ok = await AIDerivRiseFallBot(make_cfg(url, tmp_path)).check_connection()
    assert ok and any("authorize" in r for r in srv.requests)
