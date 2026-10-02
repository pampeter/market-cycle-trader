# 🚀 Deriv AI Trading Bot - Quick Start Guide

## Setup Instructions

### 1. Get Deriv API Credentials

1. Visit [Deriv.com](https://deriv.com) and create an account
2. Go to **Settings** → **API Token**
3. Click **Create Token**
4. Select permissions: **Trading** (required)
5. Copy your **App ID** and **API Token**

### 2. Install Dependencies

```bash
cd deriv-ai-bot
pip install -r requirements.txt
```

### 3. Configure Environment

```bash
cp .env.example .env
nano .env  # or use your favorite editor
```

Add your credentials:
```env
DERIV_APP_ID=12345
DERIV_API_TOKEN=your_token_here
```

### 4. Run the Bot

```bash
python main.py
```

## Usage Examples

### Example 1: Bulk Trading
```python
from bot_core import DerivAITradingBot, TradeConfig, TradeType, ContractDuration
import asyncio

async def bulk_trade_example():
    bot = DerivAITradingBot(
        app_id="YOUR_APP_ID",
        api_token="YOUR_TOKEN"
    )
    await bot.connect()
    
    # Create 10 CALL trades
    trades = [
        TradeConfig(
            symbol="R_100",
            trade_type=TradeType.CALL,
            amount=1.0,
            duration=5,
            duration_unit=ContractDuration.TICKS
        ) for _ in range(10)
    ]
    
    results = await bot.execute_bulk_trades(trades)
    print(f"Success: {sum(1 for r in results if r.success)}")
    
    await bot.disconnect()

asyncio.run(bulk_trade_example())
```

### Example 2: AI Auto Trading
```python
from ai_trader import AITrader
import asyncio

async def ai_trading_example():
    ai_trader = AITrader(
        app_id="YOUR_APP_ID",
        api_token="YOUR_TOKEN",
        confidence_threshold=0.75
    )
    
    await ai_trader.connect()
    
    # Run for 30 minutes
    await ai_trader.run_auto_trading(
        symbol="R_100",
        max_trades=10,
        duration_minutes=30
    )
    
    await ai_trader.disconnect()

asyncio.run(ai_trading_example())
```

### Example 3: Market Analysis
```python
from ai_trader import AITrader
import asyncio

async def analysis_example():
    ai_trader = AITrader(
        app_id="YOUR_APP_ID",
        api_token="YOUR_TOKEN"
    )
    
    await ai_trader.connect()
    
    # Analyze market
    analysis = await ai_trader.analyze_market("frxEURUSD")
    
    print(f"Signal: {analysis.signal}")
    print(f"Confidence: {analysis.confidence:.2%}")
    print(f"Trend: {analysis.trend}")
    print(f"RSI: {analysis.indicators.rsi:.2f}")
    print(f"MACD: {analysis.indicators.macd:.4f}")
    
    await ai_trader.disconnect()

asyncio.run(analysis_example())
```

## Supported Symbols

### Volatility Indices
- `R_10` - Volatility 10 Index
- `R_25` - Volatility 25 Index
- `R_50` - Volatility 50 Index
- `R_75` - Volatility 75 Index
- `R_100` - Volatility 100 Index

### Forex Pairs
- `frxEURUSD` - EUR/USD
- `frxGBPUSD` - GBP/USD
- `frxUSDJPY` - USD/JPY
- `frxAUDUSD` - AUD/USD

### Commodities
- `frxXAUUSD` - Gold
- `frxXAGUSD` - Silver

## Trade Types

- `CALL` - Price will rise
- `PUT` - Price will fall
- `DIGITEVEN` - Last digit will be even
- `DIGITODD` - Last digit will be odd

## Duration Units

- `TICKS` (t) - Number of ticks
- `SECONDS` (s) - Duration in seconds
- `MINUTES` (m) - Duration in minutes
- `HOURS` (h) - Duration in hours
- `DAYS` (d) - Duration in days

## Risk Management Tips

1. **Start Small**: Begin with demo account
2. **Set Limits**: Configure MAX_DAILY_LOSS in .env
3. **Monitor Closely**: Always watch your positions
4. **Diversify**: Don't put all capital in one trade
5. **Use Stop Loss**: Close losing positions early
6. **Test Strategies**: Backtest before live trading

## AI Analysis Indicators

The bot uses these technical indicators:

| Indicator | Purpose |
|-----------|---------|
| RSI | Overbought/oversold detection |
| MACD | Trend momentum |
| Bollinger Bands | Volatility & price levels |
| EMA | Trend direction |

## Troubleshooting

### Connection Issues
```bash
# Check your credentials
python -c "import os; from dotenv import load_dotenv; load_dotenv(); print(os.getenv('DERIV_APP_ID'))"
```

### Import Errors
```bash
# Reinstall dependencies
pip install -r requirements.txt --upgrade
```

### WebSocket Errors
- Check internet connection
- Verify API token is valid
- Ensure trading permissions are enabled

## Support

For issues or questions:
- Check the [Deriv API Docs](https://api.deriv.com/)
- Open a GitHub issue
- Review logs in `logs/` directory

## ⚠️ Disclaimer

**This bot is for educational purposes. Trading involves risk of loss. Always test on demo account first.**

---

**Happy Trading! 🚀**
