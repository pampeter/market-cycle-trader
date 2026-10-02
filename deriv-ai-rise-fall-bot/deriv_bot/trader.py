"""AIDerivRiseFallBot - the trading loop that ties everything together."""

from __future__ import annotations

import asyncio
import csv
import logging
import time
from collections import deque
from datetime import datetime, timezone

import websockets

from . import ui
from .config import Config
from .deriv_client import DerivAPIError, DerivClient
from .llm_engine import LLMDecision, LLMEngine, ml_only_decision
from .ml_engine import MLEngine, MLSignal
from .risk import RiskManager

log = logging.getLogger(__name__)

FATAL_API_CODES = {"InvalidToken", "AuthorizationRequired", "InvalidAppID", "PermissionDenied", "AccountDisabled"}


class FatalError(Exception):
    """Unrecoverable problem - the bot stops instead of reconnecting."""


class AIDerivRiseFallBot:
    def __init__(self, cfg: Config, llm: LLMEngine | None = None):
        self.cfg = cfg
        self.cfg.state_dir.mkdir(parents=True, exist_ok=True)
        self.risk = RiskManager(
            stake=cfg.stake,
            profit_target=cfg.profit_target,
            max_daily_loss=cfg.max_daily_loss,
            max_trades_per_day=cfg.max_trades_per_day,
            max_consecutive_losses=cfg.max_consecutive_losses,
            cooldown_seconds=cfg.cooldown_seconds,
            state_file=cfg.state_dir / f"daily_{cfg.mode}.json",
        )
        self.ml = MLEngine(train_window=cfg.train_window, horizon=cfg.tick_duration)
        if llm is not None:
            self.llm: LLMEngine | None = llm
        elif cfg.llm_enabled:
            self.llm = LLMEngine(cfg.groq_api_key, cfg.groq_model, cfg.groq_base_url, cfg.llm_timeout)
        else:
            self.llm = None

        self.client: DerivClient | None = None
        self.prices: deque[float] = deque(maxlen=2000)
        self.position: dict | None = None
        self.account: dict | None = None
        self.balance: float | None = None
        self.currency = cfg.currency
        self.paper_balance = cfg.paper_start_balance

        self.stop_reason: str | None = None
        self._stop = asyncio.Event()
        self._analysis_task: asyncio.Task | None = None
        self._bg_tasks: set[asyncio.Task] = set()
        self._tick_count = 0
        self._shown_account = False
        self._trade_log = cfg.state_dir / "trades.csv"

    # ================================================================ public
    async def run(self) -> str:
        ui.banner(self.cfg)
        pre = self.risk.stop_reason()
        if pre:
            ui.log(f"[yellow]Not starting: {pre} (today, {self.cfg.mode} mode).[/yellow]")
            ui.log(f"[dim]Delete {self.risk.state_file} to reset today's counters.[/dim]")
            self.stop_reason = pre
            return pre

        attempt = 0
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                await self._session()
            except FatalError as exc:
                self.request_stop(f"FATAL: {exc}")
            except DerivAPIError as exc:
                if exc.code in FATAL_API_CODES:
                    self.request_stop(f"FATAL: Deriv rejected the request {exc}")
                else:
                    ui.log(f"[red]Deriv API error: {exc}[/red]")
            except (ConnectionError, OSError, TimeoutError, asyncio.TimeoutError, websockets.WebSocketException) as exc:
                ui.log(f"[red]Connection problem: {exc.__class__.__name__}: {exc}[/red]")
            finally:
                if self.client is not None:
                    await self.client.close()

            if self._stop.is_set():
                break
            if time.monotonic() - started > 60:
                attempt = 0
            attempt += 1
            delay = self._backoff(attempt)
            ui.log(f"[yellow]🔄 Reconnecting in {delay}s (attempt {attempt})...[/yellow]")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=delay)
            except asyncio.TimeoutError:
                pass

        await self._shutdown()
        self.print_report()
        return self.stop_reason or "stopped"

    def request_stop(self, reason: str) -> None:
        if self._stop.is_set():
            return
        self.stop_reason = reason
        self._stop.set()
        style = "bold green" if "TARGET" in reason else "bold yellow"
        ui.log(f"[{style}]🛑 {reason}[/{style}]")
        if self.position is not None and self.position.get("mode") == "live":
            ui.log("[yellow]A live contract is still open - it will settle on Deriv automatically.[/yellow]")
        if self.client is not None:
            self.client.wake()  # session loop exits; run() closes the socket

    def print_report(self) -> None:
        balance = self.paper_balance if self.cfg.paper_trade else self.balance
        ui.final_report(self.cfg, self.risk, self.stop_reason or "stopped", balance, self.currency)

    async def check_connection(self) -> bool:
        """Connect, authorize and print account details (``--check``)."""
        self.client = DerivClient(self.cfg.ws_endpoint)
        try:
            await self.client.connect()
            ui.log(f"Connected to {self.cfg.ws_url} (app_id {self.cfg.app_id})")
            if self.cfg.api_token:
                auth = (await self.client.request({"authorize": self.cfg.api_token}))["authorize"]
                self.currency = auth.get("currency") or self.currency
                ui.account_panel(auth, float(auth.get("balance", 0)))
            else:
                ui.log("[yellow]No DERIV_API_TOKEN set - skipping account login (paper mode works without it).[/yellow]")
            hist = await self.client.request(
                {"ticks_history": self.cfg.symbol, "count": 5, "end": "latest", "style": "ticks"}
            )
            last = hist["history"]["prices"][-1]
            ui.log(f"Market data OK: {self.cfg.symbol} last price {last}")
            prop = await self.client.request(self._proposal_payload("CALL"))
            p = prop["proposal"]
            ui.log(
                f"Quote OK: stake {float(p['ask_price']):.2f} -> payout {float(p['payout']):.2f} {self.currency} "
                f"({float(p['payout']) / float(p['ask_price']) - 1:.1%} profit if it wins)"
            )
            return True
        except DerivAPIError as exc:
            ui.log(f"[red]Deriv API error: {exc}[/red]")
            return False
        except Exception as exc:
            ui.log(f"[red]Connection failed: {exc.__class__.__name__}: {exc}[/red]")
            return False
        finally:
            await self.client.close()
            if self.llm:
                await self.llm.aclose()

    # =============================================================== session
    async def _session(self) -> None:
        cfg = self.cfg
        self.client = DerivClient(cfg.ws_endpoint)
        await self.client.connect()
        ui.log(f"[green]🔌 Connected[/green] to Deriv ({cfg.symbol})")

        if cfg.api_token:
            auth = (await self.client.request({"authorize": cfg.api_token}))["authorize"]
            self.account = auth
            self.currency = auth.get("currency") or self.currency
            self.balance = float(auth.get("balance", 0))
            if not self._shown_account:
                ui.account_panel(auth, self.balance)
                self._shown_account = True
            if not cfg.paper_trade:
                if not auth.get("is_virtual") and not cfg.allow_real_account:
                    raise FatalError(
                        "this token belongs to a REAL-money account. Set ALLOW_REAL_ACCOUNT=true "
                        "if you really want the bot to trade real money (use a demo token first!)."
                    )
                scopes = auth.get("scopes")
                if scopes is not None and "trade" not in scopes:
                    raise FatalError("the API token is missing the 'trade' scope")
            try:
                await self.client.request({"balance": 1, "subscribe": 1}, timeout=10)
            except (DerivAPIError, TimeoutError):
                pass  # balance stream is optional

        hist = await self.client.request(
            {
                "ticks_history": cfg.symbol,
                "adjust_start_time": 1,
                "count": max(cfg.history_count, self.ml.ticks_needed + 20),
                "end": "latest",
                "style": "ticks",
                "subscribe": 1,
            }
        )
        self.prices.clear()
        self.prices.extend(float(p) for p in hist["history"]["prices"])
        ui.log(f"📈 Loaded {len(self.prices)} ticks of history, streaming live ticks...")

        if self.position is not None:
            if self.position["mode"] == "live":
                ui.log(f"Re-attaching to open contract {self.position['contract_id']}...")
                await self._subscribe_contract(self.position["contract_id"])
            else:
                ui.log("[yellow]Paper trade voided - tick stream was interrupted.[/yellow]")
                self.position = None

        ping_task = asyncio.create_task(self._ping_loop())
        try:
            while not self._stop.is_set():
                msg = await self.client.next_event()
                if msg is None:
                    if not self._stop.is_set():
                        raise ConnectionError("WebSocket connection dropped")
                    break
                await self._dispatch(msg)
            if self._stop.is_set() and self.cfg.api_token and self.client.is_open:
                try:  # refresh the balance for the final report
                    bal = await self.client.request({"balance": 1}, timeout=5)
                    self.balance = float(bal["balance"]["balance"])
                except Exception:
                    pass
        finally:
            # Note: an in-flight analysis task is NOT cancelled here - cancelling
            # it in the middle of a `buy` could lose track of a live contract.
            # Its pending request simply fails with ConnectionError.
            ping_task.cancel()

    async def _dispatch(self, msg: dict) -> None:
        if "error" in msg:
            err = msg["error"]
            ui.log(f"[red]Stream error ({msg.get('msg_type')}): {err.get('message')}[/red]")
            return
        mt = msg.get("msg_type")
        if mt == "tick":
            self._on_tick(msg["tick"])
        elif mt == "proposal_open_contract":
            self._on_contract_update(msg.get("proposal_open_contract") or {}, msg.get("subscription"))
        elif mt == "balance":
            bal = msg.get("balance") or {}
            if "balance" in bal:
                self.balance = float(bal["balance"])

    async def _ping_loop(self) -> None:
        while True:
            await asyncio.sleep(self.cfg.ping_interval)
            if self.client:
                await self.client.send_nowait({"ping": 1})

    # ================================================================= ticks
    def _on_tick(self, tick: dict) -> None:
        price = float(tick["quote"])
        self.prices.append(price)
        self._tick_count += 1

        if self.position is not None:
            if self.position["mode"] == "paper":
                self._advance_paper(price)
            else:
                self._contract_watchdog()
            return
        if self._stop.is_set():
            return
        if self._analysis_task is not None and not self._analysis_task.done():
            return
        reason = self.risk.stop_reason()
        if reason:
            self.request_stop(reason)
            return
        if self.risk.cooldown_remaining() > 0:
            return
        self._analysis_task = asyncio.create_task(self._analyze_and_trade())

    # ============================================================== analysis
    async def _analyze_and_trade(self) -> None:
        cfg = self.cfg
        try:
            prices = list(self.prices)
            signal = await asyncio.to_thread(self.ml.predict, prices)
            if signal is None:
                if self._tick_count % cfg.scan_log_every == 0:
                    ui.log(f"[dim]Collecting data... {len(prices)}/{self.ml.ticks_needed} ticks[/dim]")
                return

            if signal.probability < cfg.min_ml_probability:
                if self._tick_count % cfg.scan_log_every == 0:
                    ui.log(
                        f"[dim]🔍 Scanning {cfg.symbol} {prices[-1]:g} | ML {signal.direction} "
                        f"{signal.probability:.1%} < {cfg.min_ml_probability:.0%} | "
                        f"day P/L {self.risk.state.pnl:+.2f}[/dim]"
                    )
                return

            acc = "n/a" if signal.holdout_accuracy is None else f"{signal.holdout_accuracy:.0%}"
            ui.log(
                f"🧠 ML signal [bold]{signal.direction}[/bold] {signal.probability:.1%} "
                f"(holdout acc {acc}, {signal.n_samples} samples)"
            )

            decision, approved = await self._second_opinion(signal, prices)
            if not approved:
                self.risk.start_cooldown(cfg.llm_retry_seconds)
                return
            if self.position is not None or self._stop.is_set():
                return
            reason = self.risk.stop_reason()
            if reason:
                self.request_stop(reason)
                return
            await self._open_trade(decision.direction, signal, decision)
        except asyncio.CancelledError:
            raise
        except DerivAPIError as exc:
            ui.log(f"[red]Trade rejected by Deriv: {exc}[/red]")
            self.risk.start_cooldown()
            if exc.code in FATAL_API_CODES:
                self.request_stop(f"FATAL: {exc}")
        except (ConnectionError, TimeoutError) as exc:
            ui.log(f"[red]Could not place trade: {exc}[/red]")
            self.risk.start_cooldown(5)
        except Exception as exc:  # pragma: no cover - keep the bot alive
            log.exception("analysis failed")
            ui.log(f"[red]Analysis error: {exc.__class__.__name__}: {exc}[/red]")
            self.risk.start_cooldown()

    async def _second_opinion(self, signal: MLSignal, prices: list[float]) -> tuple[LLMDecision, bool]:
        cfg = self.cfg
        if self.llm is None:
            return ml_only_decision(signal), True

        decision = await self.llm.analyze(signal, prices[-20:], cfg.symbol, cfg.tick_duration)
        color = {"RISE": "green", "FALL": "red"}.get(decision.direction, "yellow")
        ui.log(
            f"🤖 LLM says [bold {color}]{decision.direction}[/bold {color}] "
            f"confidence {decision.confidence} - {decision.reason}"
        )
        if decision.direction == "HOLD":
            return decision, False
        if decision.confidence < cfg.min_ai_confidence:
            ui.log(f"[dim]Skip: confidence {decision.confidence} < {cfg.min_ai_confidence}[/dim]")
            return decision, False
        if cfg.require_agreement and decision.direction != signal.direction:
            ui.log("[dim]Skip: ML and LLM disagree[/dim]")
            return decision, False
        return decision, True

    # ================================================================ trades
    def _proposal_payload(self, contract_type: str) -> dict:
        return {
            "proposal": 1,
            "amount": round(self.cfg.stake, 2),
            "basis": "stake",
            "contract_type": contract_type,
            "currency": self.currency,
            "duration": self.cfg.tick_duration,
            "duration_unit": "t",
            "symbol": self.cfg.symbol,
        }

    async def _open_trade(self, direction: str, signal: MLSignal, decision: LLMDecision) -> None:
        cfg = self.cfg
        contract_type = "CALL" if direction == "RISE" else "PUT"
        base = {
            "direction": direction,
            "ml_prob": round(signal.probability, 4),
            "ai_conf": decision.confidence,
            "reason": decision.reason,
            "opened_at": time.monotonic(),
            "entry": None,
            "ticks": 0,
        }

        if cfg.paper_trade:
            try:
                quote = (await self.client.request(self._proposal_payload(contract_type), timeout=8))["proposal"]
                payout = float(quote["payout"])
            except Exception:
                payout = round(cfg.stake * (1 + cfg.paper_payout_rate), 2)
            self.position = {**base, "mode": "paper", "stake": cfg.stake, "payout": payout, "contract_id": None}
            ui.log(
                f"📝 [bold]PAPER BUY {contract_type}[/bold] ({direction}) stake {cfg.stake:.2f} "
                f"→ payout {payout:.2f} {self.currency}"
            )
            return

        quote = (await self.client.request(self._proposal_payload(contract_type)))["proposal"]
        bought = (await self.client.request({"buy": quote["id"], "price": float(quote["ask_price"])}))["buy"]
        cid = bought["contract_id"]
        self.position = {
            **base,
            "mode": "live",
            "stake": float(bought.get("buy_price", cfg.stake)),
            "payout": float(bought.get("payout", quote.get("payout", 0))),
            "contract_id": cid,
        }
        if "balance_after" in bought:
            self.balance = float(bought["balance_after"])
        ui.log(
            f"💸 [bold]LIVE BUY {contract_type}[/bold] ({direction}) contract {cid} "
            f"stake {self.position['stake']:.2f} → payout {self.position['payout']:.2f} {self.currency}"
        )
        await self._subscribe_contract(cid)

    async def _subscribe_contract(self, contract_id) -> None:
        resp = await self.client.request(
            {"proposal_open_contract": 1, "contract_id": contract_id, "subscribe": 1}
        )
        self._on_contract_update(resp.get("proposal_open_contract") or {}, resp.get("subscription"))

    def _on_contract_update(self, poc: dict, subscription: dict | None = None) -> None:
        pos = self.position
        if not pos or pos.get("mode") != "live" or poc.get("contract_id") != pos.get("contract_id"):
            return
        if not (poc.get("is_sold") or poc.get("status") in {"won", "lost", "sold"}):
            return
        if subscription and subscription.get("id") and self.client:
            self._spawn(self.client.send_nowait({"forget": subscription["id"]}))
        self._settle(
            float(poc.get("profit", 0.0)),
            poc.get("entry_tick", poc.get("entry_spot")),
            poc.get("exit_tick", poc.get("sell_spot")),
        )

    def _contract_watchdog(self) -> None:
        """If a live contract's result hasn't arrived in time, poll for it."""
        pos = self.position
        limit = 20 + self.cfg.tick_duration * 4
        if pos and not pos.get("polling") and time.monotonic() - pos["opened_at"] > limit:
            pos["polling"] = True
            self._spawn(self._poll_contract(pos["contract_id"]))

    async def _poll_contract(self, contract_id) -> None:
        try:
            resp = await self.client.request({"proposal_open_contract": 1, "contract_id": contract_id}, timeout=10)
            self._on_contract_update(resp.get("proposal_open_contract") or {})
        except Exception as exc:
            ui.log(f"[yellow]Contract status check failed: {exc}[/yellow]")
        finally:
            if self.position and self.position.get("contract_id") == contract_id:
                self.position["polling"] = False
                self.position["opened_at"] = time.monotonic()

    def _advance_paper(self, price: float) -> None:
        pos = self.position
        if pos["entry"] is None:
            pos["entry"] = price  # entry spot = first tick after purchase
            return
        pos["ticks"] += 1
        if pos["ticks"] < self.cfg.tick_duration:
            return
        entry = pos["entry"]
        won = price > entry if pos["direction"] == "RISE" else price < entry
        profit = round(pos["payout"] - pos["stake"], 2) if won else -round(pos["stake"], 2)
        self.paper_balance = round(self.paper_balance + profit, 2)
        self._settle(profit, entry, price)

    def _settle(self, profit: float, entry, exit_) -> None:
        pos = self.position
        self.position = None
        self.risk.record(profit)
        self._write_trade_log(pos, profit, entry, exit_)
        ui.trade_result(
            self.risk.state.trades,
            pos["direction"],
            pos["stake"],
            profit,
            entry,
            exit_,
            self.risk.state.pnl,
            self.cfg.profit_target,
            self.currency,
            pos["mode"],
        )
        reason = self.risk.stop_reason()
        if reason:
            self.request_stop(reason)
        else:
            ui.log(f"[dim]⏳ Cooldown {self.cfg.cooldown_seconds:.0f}s[/dim]")

    def _write_trade_log(self, pos: dict, profit: float, entry, exit_) -> None:
        new = not self._trade_log.exists()
        with self._trade_log.open("a", newline="") as fh:
            w = csv.writer(fh)
            if new:
                w.writerow(
                    ["time_utc", "mode", "symbol", "direction", "stake", "payout", "entry", "exit",
                     "profit", "day_pnl", "ml_prob", "ai_conf", "reason", "contract_id"]
                )
            w.writerow(
                [
                    datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    pos["mode"], self.cfg.symbol, pos["direction"], pos["stake"], pos["payout"],
                    entry, exit_, profit, self.risk.state.pnl, pos["ml_prob"], pos["ai_conf"],
                    pos["reason"], pos.get("contract_id") or "",
                ]
            )

    # ================================================================ helpers
    @staticmethod
    def _backoff(attempt: int) -> float:
        return min(60, 2 ** min(attempt, 6))

    def _spawn(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._bg_tasks.add(task)
        task.add_done_callback(self._bg_tasks.discard)

    async def _shutdown(self) -> None:
        if self._analysis_task and not self._analysis_task.done():
            self._analysis_task.cancel()
        for t in list(self._bg_tasks):
            try:
                await asyncio.wait_for(t, timeout=3)
            except Exception:
                pass
        if self.client is not None:
            await self.client.close()
        if self.llm is not None:
            await self.llm.aclose()
