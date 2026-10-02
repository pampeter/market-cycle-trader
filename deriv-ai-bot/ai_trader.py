"""
AI Trader - Automated AI-powered trading wrapper
"""

import asyncio
import numpy as np
from typing import Dict, List
from datetime import datetime, timedelta
import logging
from bot_core import DerivAITradingBot, TradeConfig, TradeType, ContractDuration
from ai_analyzer import AIMarketAnalyzer, MarketAnalysis

logger = logging.getLogger(__name__)


class AITrader:
    """
    AI-powered automated trader
    Combines bot execution with AI analysis
    """
    
    def __init__(self, app_id: str, api_token: str, confidence_threshold: float = 0.7):
        self.bot = DerivAITradingBot(app_id, api_token)
        self.analyzer = AIMarketAnalyzer()
        self.confidence_threshold = confidence_threshold
        self.price_history: Dict[str, List[float]] = {}
        
    async def connect(self):
        """Connect to Deriv"""
        await self.bot.connect()
        
    async def disconnect(self):
        """Disconnect from Deriv"""
        await self.bot.disconnect()
        
    async def fetch_price_history(self, symbol: str, count: int = 100) -> np.ndarray:
        """Fetch historical prices for analysis"""
        # This would fetch real market data from Deriv
        # For now, simulate with stored data
        if symbol in self.price_history and len(self.price_history[symbol]) >= count:
            return np.array(self.price_history[symbol][-count:])
        
        # Initialize with sample data (replace with actual API call)
        prices = np.random.rand(count) * 100 + 1000
        self.price_history[symbol] = list(prices)
        return prices
        
    async def analyze_market(self, symbol: str) -> MarketAnalysis:
        """Perform AI analysis on market"""
        logger.info(f"🔍 Analyzing {symbol}...")
        
        # Fetch price history
        prices = await self.fetch_price_history(symbol)
        
        # Run AI analysis
        analysis = self.analyzer.analyze_market(symbol, prices)
        
        logger.info(f"📊 Analysis: {analysis.signal} (Confidence: {analysis.confidence:.2%})")
        return analysis
        
    async def execute_ai_trade(
        self,
        symbol: str,
        analysis: MarketAnalysis,
        stake: float = 1.0,
        duration: int = 5,
        duration_unit: ContractDuration = ContractDuration.TICKS
    ):
        """Execute trade based on AI analysis"""
        if analysis.signal == "HOLD":
            logger.info("⏸️ AI recommends HOLD - no trade")
            return None
            
        if analysis.confidence < self.confidence_threshold:
            logger.info(f"⚠️ Confidence {analysis.confidence:.2%} below threshold {self.confidence_threshold:.2%}")
            return None
            
        # Map signal to trade type
        trade_type = TradeType.CALL if analysis.signal == "BUY" else TradeType.PUT
        
        config = TradeConfig(
            symbol=symbol,
            trade_type=trade_type,
            amount=stake,
            duration=duration,
            duration_unit=duration_unit
        )
        
        logger.info(f"🤖 Executing AI trade: {trade_type.value}")
        result = await self.bot.buy_contract(config)
        
        return result
        
    async def run_auto_trading(
        self,
        symbol: str = "R_100",
        max_trades: int = 10,
        duration_minutes: int = 60,
        analysis_interval: int = 30
    ):
        """
        Run automated AI trading
        
        Args:
            symbol: Trading symbol
            max_trades: Maximum concurrent positions
            duration_minutes: How long to run (minutes)
            analysis_interval: Seconds between analyses
        """
        logger.info(f"🚀 Starting AI auto-trading for {duration_minutes} minutes")
        start_time = datetime.now()
        end_time = start_time + timedelta(minutes=duration_minutes)
        
        trade_count = 0
        
        while datetime.now() < end_time:
            try:
                # Check position limit
                if len(self.bot.active_contracts) >= max_trades:
                    logger.info(f"⏸️ Max positions ({max_trades}) reached, waiting...")
                    await asyncio.sleep(analysis_interval)
                    continue
                    
                # Analyze market
                analysis = await self.analyze_market(symbol)
                
                # Execute if signal is strong
                if analysis.confidence >= self.confidence_threshold:
                    result = await self.execute_ai_trade(symbol, analysis)
                    if result and result.success:
                        trade_count += 1
                        logger.info(f"✅ Trade #{trade_count} executed")
                
                # Wait before next analysis
                await asyncio.sleep(analysis_interval)
                
            except Exception as e:
                logger.error(f"❌ Auto-trading error: {e}")
                await asyncio.sleep(analysis_interval)
                
        logger.info(f"🏁 Auto-trading complete - {trade_count} trades executed")
        
        # Get final stats
        pnl, open_count = await self.bot.get_portfolio_pnl()
        balance = await self.bot.get_balance()
        
        logger.info(f"📊 Final Stats - Balance: {balance:.2f}, P&L: {pnl:+.2f}, Open: {open_count}")
