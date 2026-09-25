"""Rich console output helpers."""

from __future__ import annotations

from datetime import datetime

from rich import box
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

console = Console()


def ts() -> str:
    return datetime.now().strftime("%H:%M:%S")


def log(msg: str, style: str = "") -> None:
    console.print(f"[dim]{ts()}[/dim] {msg}", style=style, highlight=False)


def money(v: float, currency: str = "") -> str:
    color = "green" if v > 0 else "red" if v < 0 else "white"
    sign = "+" if v > 0 else ""
    return f"[{color}]{sign}{v:.2f}{(' ' + currency) if currency else ''}[/{color}]"


def banner(cfg) -> None:
    mode = (
        "[bold yellow]PAPER TRADING[/bold yellow] (no real orders)"
        if cfg.paper_trade
        else "[bold red]LIVE TRADING[/bold red] (real orders on your Deriv account)"
    )
    ai = (
        f"ML + LLM ([cyan]{cfg.groq_model}[/cyan] via Groq)"
        if cfg.llm_enabled
        else "[yellow]ML only[/yellow] (set GROQ_API_KEY to enable the LLM filter)"
    )
    t = Table.grid(padding=(0, 2))
    t.add_column(style="bold")
    t.add_column()
    t.add_row("Mode", mode)
    t.add_row("Symbol", f"{cfg.symbol}  ·  {cfg.tick_duration}-tick Rise/Fall")
    t.add_row("Stake", f"{cfg.stake:.2f} {cfg.currency}")
    t.add_row("AI engine", ai)
    t.add_row(
        "Entry filter",
        f"ML ≥ {cfg.min_ml_probability:.0%}"
        + (f"  ·  LLM confidence ≥ {cfg.min_ai_confidence}" if cfg.llm_enabled else "")
        + ("  ·  ML & LLM must agree" if cfg.llm_enabled and cfg.require_agreement else ""),
    )
    t.add_row("Profit target", f"[green]+{cfg.profit_target:.2f}[/green] (auto-stop)")
    t.add_row("Max daily loss", f"[red]-{cfg.max_daily_loss:.2f}[/red]")
    t.add_row(
        "Limits",
        f"{cfg.max_trades_per_day} trades/day · {cfg.max_consecutive_losses} losses in a row · "
        f"{cfg.cooldown_seconds:.0f}s cooldown",
    )
    console.print(Panel(t, title="[bold]🤖 Deriv AI Rise & Fall Bot[/bold]", border_style="cyan", box=box.ROUNDED))


def account_panel(auth: dict, balance: float | None) -> None:
    t = Table.grid(padding=(0, 2))
    t.add_column(style="bold")
    t.add_column()
    virtual = bool(auth.get("is_virtual"))
    t.add_row("Login ID", str(auth.get("loginid", "?")))
    t.add_row("Account", "[green]Demo (virtual)[/green]" if virtual else "[bold red]REAL MONEY[/bold red]")
    t.add_row("Currency", str(auth.get("currency", "?")))
    if balance is not None:
        t.add_row("Balance", f"{balance:,.2f} {auth.get('currency', '')}")
    if auth.get("fullname"):
        t.add_row("Name", str(auth.get("fullname")).strip())
    scopes = auth.get("scopes")
    if scopes:
        ok = "trade" in scopes
        t.add_row("Token scopes", ", ".join(scopes) + ("" if ok else "  [red](missing 'trade')[/red]"))
    console.print(Panel(t, title="[bold]✅ Connected to Deriv[/bold]", border_style="green", box=box.ROUNDED))


def trade_result(n: int, direction: str, stake: float, profit: float, entry, exit_, day_pnl: float,
                 target: float, currency: str, mode: str) -> None:
    won = profit > 0
    t = Table(box=box.SIMPLE_HEAVY, show_header=True, header_style="bold")
    for col in ("#", "Mode", "Dir", "Stake", "Entry", "Exit", "Result", "P/L", "Day P/L", "To target"):
        t.add_column(col, justify="right" if col not in ("Mode", "Dir", "Result") else "left")
    t.add_row(
        str(n),
        mode.upper(),
        "[green]RISE ▲[/green]" if direction == "RISE" else "[red]FALL ▼[/red]",
        f"{stake:.2f}",
        "-" if entry is None else f"{entry}",
        "-" if exit_ is None else f"{exit_}",
        "[bold green]WIN[/bold green]" if won else "[bold red]LOSS[/bold red]",
        money(profit),
        money(day_pnl, currency),
        f"{max(0.0, target - day_pnl):.2f}",
    )
    console.print(t)


def final_report(cfg, risk, reason: str, balance: float | None, currency: str) -> None:
    s = risk.state
    t = Table(box=box.ROUNDED, show_header=False, border_style="cyan")
    t.add_column(style="bold")
    t.add_column(justify="right")
    t.add_row("Stop reason", reason)
    t.add_row("Mode", cfg.mode.upper())
    t.add_row("Symbol", cfg.symbol)
    t.add_row("Session trades", str(risk.session_trades))
    t.add_row("Session P/L", money(risk.session_pnl, currency))
    t.add_row("Today's trades", f"{s.trades}  ({s.wins} W / {s.losses} L)")
    t.add_row("Today's win rate", f"{risk.win_rate:.1%}")
    t.add_row("Today's P/L", money(s.pnl, currency))
    t.add_row("Profit target", f"{cfg.profit_target:.2f}  {'✅ reached' if s.target_hit else ''}")
    t.add_row("Max drawdown today", f"{s.max_drawdown:.2f}")
    if balance is not None:
        t.add_row("Balance", f"{balance:,.2f} {currency}")
    style = "green" if s.pnl > 0 else "red" if s.pnl < 0 else "white"
    console.print(Panel(t, title="[bold]📊 Final Report[/bold]", border_style=style))
