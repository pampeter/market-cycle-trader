#!/usr/bin/env python3
"""Deriv AI Rise & Fall bot - entry point.

    python bot.py            # run (paper mode by default)
    python bot.py --check    # test your Deriv connection / token and exit
    python bot.py --env my.env
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys

from deriv_bot import ui
from deriv_bot.config import Config, ConfigError
from deriv_bot.trader import AIDerivRiseFallBot


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="AI-powered Deriv Rise/Fall auto-trader")
    ap.add_argument("--env", default=".env", help="path to the .env file (default: .env)")
    ap.add_argument("--check", action="store_true", help="test the Deriv connection + token, then exit")
    ap.add_argument("--yes", action="store_true", help="skip the live-trading confirmation prompt")
    ap.add_argument("--debug", action="store_true", help="verbose logging")
    return ap.parse_args(argv)


def confirm_live(cfg: Config, assume_yes: bool) -> bool:
    if cfg.paper_trade or assume_yes:
        return True
    ui.console.print(
        f"\n[bold red]⚠  LIVE TRADING[/bold red]: the bot will place REAL {cfg.tick_duration}-tick Rise/Fall "
        f"contracts of {cfg.stake:.2f} on {cfg.symbol} with your Deriv account.\n"
        f"   It stops at +{cfg.profit_target:.2f} profit or -{cfg.max_daily_loss:.2f} loss for the day.\n"
    )
    if not sys.stdin.isatty():
        ui.console.print("[red]No interactive terminal - re-run with --yes to confirm live trading.[/red]")
        return False
    answer = input("Type YES to start live trading: ").strip()
    return answer == "YES"


def main(argv=None) -> int:
    args = parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.debug else logging.WARNING,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        cfg = Config.from_env(args.env)
    except ConfigError as exc:
        ui.console.print(f"[bold red]Config error:[/bold red] {exc}")
        return 2

    bot = AIDerivRiseFallBot(cfg)

    if args.check:
        ok = asyncio.run(bot.check_connection())
        return 0 if ok else 1

    if not confirm_live(cfg, args.yes):
        ui.console.print("Aborted.")
        return 1

    try:
        asyncio.run(bot.run())
    except KeyboardInterrupt:
        bot.stop_reason = bot.stop_reason or "Stopped by user (Ctrl+C)"
        if bot.position is not None and bot.position.get("mode") == "live":
            ui.console.print("[yellow]A live contract was open - it will settle on Deriv automatically.[/yellow]")
        bot.print_report()
    return 0


if __name__ == "__main__":
    sys.exit(main())
