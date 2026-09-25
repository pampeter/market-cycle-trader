from deriv_bot.risk import RiskManager


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def make(tmp_path=None, **kw):
    args = dict(stake=1.0, profit_target=3.0, max_daily_loss=3.0, max_trades_per_day=10,
                max_consecutive_losses=3, cooldown_seconds=30, state_file=None)
    args.update(kw)
    return RiskManager(**args)


def test_profit_target_stops():
    r = make()
    for _ in range(3):
        assert r.stop_reason() is None
        r.record(0.95)
    assert r.stop_reason() is None  # 2.85 < 3
    r.record(0.95)
    assert "PROFIT TARGET" in r.stop_reason()
    assert r.state.target_hit


def test_loss_limit_and_next_trade_budget():
    r = make(max_daily_loss=2.5, max_consecutive_losses=0)
    r.record(-1)
    assert r.stop_reason() is None  # -1 - 1 = -2 >= -2.5
    r.record(-1)
    assert "DAILY LOSS" in r.stop_reason()  # -2 - 1 = -3 < -2.5


def test_consecutive_losses():
    r = make(max_daily_loss=100)
    r.record(-1); r.record(-1)
    assert r.stop_reason() is None
    r.record(-1)
    assert "CONSECUTIVE" in r.stop_reason()


def test_consecutive_resets_on_win():
    r = make(max_daily_loss=100)
    r.record(-1); r.record(-1); r.record(0.9); r.record(-1)
    assert r.state.consecutive_losses == 1
    assert r.stop_reason() is None


def test_max_trades():
    r = make(max_trades_per_day=2, profit_target=100, max_daily_loss=100)
    r.record(0.5); r.record(-0.5)
    assert "MAX TRADES" in r.stop_reason()


def test_cooldown():
    c = Clock()
    r = make(clock=c)
    assert r.cooldown_remaining() == 0
    r.record(0.5)
    assert r.cooldown_remaining() == 30
    c.t = 31
    assert r.cooldown_remaining() == 0


def test_state_persists_across_restarts(tmp_path):
    f = tmp_path / "daily.json"
    r = make(state_file=f, max_daily_loss=100)
    r.record(-1); r.record(0.9)
    r2 = make(state_file=f, max_daily_loss=100)
    assert r2.state.trades == 2 and abs(r2.state.pnl - (-0.1)) < 1e-9
    assert r2.session_trades == 0
