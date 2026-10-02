"""
Trading Strategies Module
"""

import asyncio
from typing import List
import logging
from bot_core import TradeConfig, TradeType, ContractDuration

logger = logging.getLogger(__name__)


class BaseStrategy:
    """Base strategy class"""
    
    def __init__(self, bot, config: dict = None):
        self.bot = bot
        self.config = config or {}
        
    async def execute(self):
        raise NotImplementedError


class MartingaleStrategy(BaseStrategy):
    """Martingale strategy - double stake after each level"""
    
    async def execute(self):
        base_stake = self.config.get('base_stake', 1.0)
        max_levels = self.config.get('max_levels', 5)
        symbol = self.config.get('symbol', 'R_100')
        
        logger.info(f"🎲 Martingale: base=${base_stake}, levels={max_levels}")
        
        trades = []
        stake = base_stake
        
        for level in range(max_levels):
            trades.append(TradeConfig(
                symbol=symbol,
                trade_type=TradeType.CALL,
                amount=stake,
                duration=5,
                duration_unit=ContractDuration.TICKS
            ))
            stake *= 2
            
        results = await self.bot.execute_bulk_trades(trades)
        success = sum(1 for r in results if r.success)
        logger.info(f"✅ Martingale complete: {success}/{len(results)}")


class GridStrategy(BaseStrategy):
    """Grid trading strategy"""
    
    async def execute(self):
        base_stake = self.config.get('base_stake', 2.0)
        grid_levels = self.config.get('grid_levels', 5)
        symbol = self.config.get('symbol', 'frxEURUSD')
        
        logger.info(f"📊 Grid: {grid_levels} levels")
        
        trades = []
        for i in range(grid_levels):
            trades.append(TradeConfig(
                symbol=symbol,
                trade_type=TradeType.CALL,
                amount=base_stake,
                duration=15,
                duration_unit=ContractDuration.MINUTES
            ))
            trades.append(TradeConfig(
                symbol=symbol,
                trade_type=TradeType.PUT,
                amount=base_stake,
                duration=15,
                duration_unit=ContractDuration.MINUTES
            ))
        
        results = await self.bot.execute_bulk_trades(trades, max_concurrent=4)
        success = sum(1 for r in results if r.success)
        logger.info(f"✅ Grid complete: {success}/{len(results)}")


class AIStrategy(BaseStrategy):
    """AI-powered strategy"""
    
    async def execute(self):
        from ai_trader import AITrader
        
        ai_trader = AITrader(
            app_id=self.bot.app_id,
            api_token=self.bot.api_token
        )
        
        await ai_trader.run_auto_trading(
            symbol=self.config.get('symbol', 'R_100'),
            max_trades=self.config.get('max_trades', 10),
            duration_minutes=self.config.get('duration', 60)
        )
