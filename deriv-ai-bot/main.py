"""
Deriv AI Trading Bot - Main Entry Point
Interactive CLI for trading operations
"""

import asyncio
import os
from dotenv import load_dotenv
import logging

load_dotenv()

from bot_core import DerivAITradingBot, TradeConfig, TradeType, ContractDuration
from ai_trader import AITrader
from strategies import MartingaleStrategy, GridStrategy, AIStrategy

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def print_banner():
    print("""
    ╔═══════════════════════════════════════════╗
    ║   DERIV AI TRADING BOT 🤖📈              ║
    ║   Built by Klefmoney3x                    ║
    ╚═══════════════════════════════════════════╝
    """)


def print_menu():
    print("\n" + "="*50)
    print("MAIN MENU")
    print("="*50)
    print("1. 🚀 Execute Bulk Trades")
    print("2. 🤖 AI Auto Trading")
    print("3. 📊 Market Analysis")
    print("4. 📈 View Portfolio")
    print("5. 📉 Close All Positions")
    print("6. 🔍 Check Balance")
    print("7. ❌ Exit")
    print("="*50)


async def main():
    print_banner()
    
    app_id = os.getenv('DERIV_APP_ID')
    api_token = os.getenv('DERIV_API_TOKEN')
    
    if not app_id or not api_token:
        print("❌ Error: Missing credentials in .env file")
        return
    
    print("Connecting to Deriv...")
    bot = DerivAITradingBot(app_id, api_token)
    ai_trader = AITrader(app_id, api_token)
    
    try:
        await bot.connect()
        await ai_trader.connect()
        print("✅ Connected!\n")
        
        while True:
            print_menu()
            choice = input("\nSelect option: ").strip()
            
            if choice == "1":
                # Bulk trades
                symbol = input("Symbol (R_100): ").strip() or "R_100"
                trade_type = input("Type (CALL/PUT): ").upper() or "CALL"
                amount = float(input("Stake: ") or "1.0")
                count = int(input("Number of trades: ") or "5")
                
                trades = [
                    TradeConfig(
                        symbol=symbol,
                        trade_type=TradeType[trade_type],
                        amount=amount,
                        duration=5,
                        duration_unit=ContractDuration.TICKS
                    ) for _ in range(count)
                ]
                
                print(f"\n🚀 Executing {count} trades...")
                results = await bot.execute_bulk_trades(trades)
                success = sum(1 for r in results if r.success)
                print(f"✅ {success}/{count} successful")
                
            elif choice == "2":
                # AI auto trading
                symbol = input("Symbol (R_100): ").strip() or "R_100"
                duration = int(input("Duration (minutes) [60]: ") or "60")
                
                print(f"\n🤖 Starting AI trading for {duration} minutes...")
                await ai_trader.run_auto_trading(
                    symbol=symbol,
                    duration_minutes=duration
                )
                
            elif choice == "3":
                # Market analysis
                symbol = input("Symbol to analyze: ").strip() or "R_100"
                analysis = await ai_trader.analyze_market(symbol)
                
                print(f"\n📊 Analysis for {symbol}")
                print(f"Signal: {analysis.signal}")
                print(f"Confidence: {analysis.confidence:.1%}")
                print(f"Trend: {analysis.trend}")
                print(f"RSI: {analysis.indicators.rsi:.2f}")
                
            elif choice == "4":
                # Portfolio
                balance = await bot.get_balance()
                pnl, open_count = await bot.get_portfolio_pnl()
                print(f"\n📈 Portfolio")
                print(f"Balance: {balance:.2f} {bot.currency}")
                print(f"Open: {open_count}")
                print(f"P&L: {pnl:+.2f}")
                
            elif choice == "5":
                # Close all
                count = await bot.close_all_positions()
                print(f"✅ Closed {count} positions")
                
            elif choice == "6":
                # Balance
                balance = await bot.get_balance()
                print(f"💰 Balance: {balance:.2f} {bot.currency}")
                
            elif choice == "7":
                print("👋 Goodbye!")
                break
            else:
                print("❌ Invalid option")
            
            input("\nPress Enter to continue...")
    
    except KeyboardInterrupt:
        print("\n⚠️ Interrupted")
    except Exception as e:
        print(f"❌ Error: {e}")
        logger.exception("Error")
    finally:
        await bot.disconnect()
        await ai_trader.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
