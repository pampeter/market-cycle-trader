"""Daily P/L tracking, profit target, loss limit and trade throttling.

State is persisted per mode (paper / live) in ``state/daily_<mode>.json`` so a
restart on the same UTC day cannot bypass the daily loss limit or the
profit-target stop.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path


def utc_today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


@dataclass
class DailyState:
    date: str = field(default_factory=utc_today)
    pnl: float = 0.0
    trades: int = 0
    wins: int = 0
    losses: int = 0
    consecutive_losses: int = 0
    peak_pnl: float = 0.0
    max_drawdown: float = 0.0
    target_hit: bool = False


class RiskManager:
    def __init__(
        self,
        *,
        stake: float,
        profit_target: float,
        max_daily_loss: float,
        max_trades_per_day: int,
        max_consecutive_losses: int,
        cooldown_seconds: float,
        state_file: Path | None = None,
        clock=time.monotonic,
    ):
        self.stake = stake
        self.profit_target = profit_target
        self.max_daily_loss = abs(max_daily_loss)
        self.max_trades_per_day = max_trades_per_day
        self.max_consecutive_losses = max_consecutive_losses
        self.cooldown_seconds = cooldown_seconds
        self.state_file = state_file
        self._clock = clock
        self._next_trade_at = 0.0

        # Session numbers (this process only)
        self.session_pnl = 0.0
        self.session_trades = 0
        self.session_wins = 0

        self.state = self._load()

    # ----------------------------------------------------------- persistence
    def _load(self) -> DailyState:
        if self.state_file and self.state_file.exists():
            try:
                data = json.loads(self.state_file.read_text())
                st = DailyState(**{k: v for k, v in data.items() if k in DailyState.__dataclass_fields__})
                if st.date == utc_today():
                    return st
            except (json.JSONDecodeError, TypeError, OSError):
                pass
        return DailyState()

    def _save(self) -> None:
        if not self.state_file:
            return
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(self.state), indent=2))
        tmp.replace(self.state_file)

    def _roll_day(self) -> None:
        if self.state.date != utc_today():
            self.state = DailyState()
            self._save()

    # ------------------------------------------------------------- decisions
    def stop_reason(self) -> str | None:
        """Return a reason string if trading must stop for the day, else None."""
        self._roll_day()
        s = self.state
        if s.target_hit or s.pnl >= self.profit_target:
            return f"PROFIT TARGET REACHED (+{s.pnl:.2f} / target {self.profit_target:.2f})"
        if s.pnl <= -self.max_daily_loss:
            return f"DAILY LOSS LIMIT HIT ({s.pnl:.2f} / limit -{self.max_daily_loss:.2f})"
        if s.pnl - self.stake < -self.max_daily_loss - 1e-9:
            return (
                f"DAILY LOSS LIMIT: another losing trade (-{self.stake:.2f}) would exceed "
                f"-{self.max_daily_loss:.2f} (P/L {s.pnl:.2f})"
            )
        if s.trades >= self.max_trades_per_day:
            return f"MAX TRADES PER DAY REACHED ({s.trades}/{self.max_trades_per_day})"
        if self.max_consecutive_losses > 0 and s.consecutive_losses >= self.max_consecutive_losses:
            return f"{s.consecutive_losses} CONSECUTIVE LOSSES - stopping to protect capital"
        return None

    def cooldown_remaining(self) -> float:
        return max(0.0, self._next_trade_at - self._clock())

    def start_cooldown(self, seconds: float | None = None) -> None:
        secs = self.cooldown_seconds if seconds is None else seconds
        self._next_trade_at = max(self._next_trade_at, self._clock() + secs)

    # --------------------------------------------------------------- results
    def record(self, profit: float) -> None:
        self._roll_day()
        s = self.state
        s.pnl = round(s.pnl + profit, 2)
        s.trades += 1
        if profit > 0:
            s.wins += 1
            s.consecutive_losses = 0
            self.session_wins += 1
        else:
            s.losses += 1
            s.consecutive_losses += 1
        s.peak_pnl = max(s.peak_pnl, s.pnl)
        s.max_drawdown = max(s.max_drawdown, round(s.peak_pnl - s.pnl, 2))
        if s.pnl >= self.profit_target:
            s.target_hit = True

        self.session_pnl = round(self.session_pnl + profit, 2)
        self.session_trades += 1
        self._save()
        self.start_cooldown()

    @property
    def win_rate(self) -> float:
        return (self.state.wins / self.state.trades) if self.state.trades else 0.0
