"""
AI Market Analyzer - Machine Learning powered analysis
"""

import numpy as np
from typing import Dict, List, Optional, Tuple
from dataclasses import dataclass
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


@dataclass
class TechnicalIndicators:
    """Technical indicator values"""
    rsi: float
    macd: float
    macd_signal: float
    bb_upper: float
    bb_middle: float
    bb_lower: float
    ema_fast: float
    ema_slow: float


@dataclass
class MarketAnalysis:
    """Market analysis result"""
    symbol: str
    signal: str  # BUY, SELL, HOLD
    confidence: float
    indicators: TechnicalIndicators
    trend: str = "NEUTRAL"
    volatility: str = "NORMAL"
    risk_score: float = 0.5
    reasoning: List[str] = None
    timestamp: datetime = None
    
    def __post_init__(self):
        if self.reasoning is None:
            self.reasoning = []
        if self.timestamp is None:
            self.timestamp = datetime.now()


class AIMarketAnalyzer:
    """AI-powered market analysis"""
    
    def calculate_rsi(self, prices: np.ndarray, period: int = 14) -> float:
        """Calculate RSI"""
        if len(prices) < period + 1:
            return 50.0
            
        deltas = np.diff(prices)
        gains = np.where(deltas > 0, deltas, 0)
        losses = np.where(deltas < 0, -deltas, 0)
        
        avg_gain = np.mean(gains[-period:])
        avg_loss = np.mean(losses[-period:])
        
        if avg_loss == 0:
            return 100.0
            
        rs = avg_gain / avg_loss
        rsi = 100 - (100 / (1 + rs))
        return rsi
        
    def calculate_macd(self, prices: np.ndarray) -> Tuple[float, float]:
        """Calculate MACD"""
        if len(prices) < 26:
            return 0.0, 0.0
            
        ema_fast = self._ema(prices, 12)
        ema_slow = self._ema(prices, 26)
        macd = ema_fast - ema_slow
        macd_signal = macd  # Simplified
        return macd, macd_signal
        
    def _ema(self, prices: np.ndarray, period: int) -> float:
        """Calculate EMA"""
        if len(prices) < period:
            return np.mean(prices)
            
        multiplier = 2 / (period + 1)
        ema = prices[0]
        
        for price in prices[1:]:
            ema = (price * multiplier) + (ema * (1 - multiplier))
            
        return ema
        
    def calculate_bollinger_bands(self, prices: np.ndarray) -> Tuple[float, float, float]:
        """Calculate Bollinger Bands"""
        period = 20
        if len(prices) < period:
            mean = np.mean(prices)
            return mean, mean, mean
            
        recent = prices[-period:]
        middle = np.mean(recent)
        std = np.std(recent)
        upper = middle + (2 * std)
        lower = middle - (2 * std)
        return upper, middle, lower
        
    def analyze_market(self, symbol: str, prices: np.ndarray) -> MarketAnalysis:
        """Comprehensive market analysis"""
        rsi = self.calculate_rsi(prices)
        macd, macd_signal = self.calculate_macd(prices)
        bb_upper, bb_middle, bb_lower = self.calculate_bollinger_bands(prices)
        ema_fast = self._ema(prices, 12)
        ema_slow = self._ema(prices, 26)
        
        indicators = TechnicalIndicators(
            rsi=rsi,
            macd=macd,
            macd_signal=macd_signal,
            bb_upper=bb_upper,
            bb_middle=bb_middle,
            bb_lower=bb_lower,
            ema_fast=ema_fast,
            ema_slow=ema_slow
        )
        
        # Generate signal
        signal, confidence, reasoning = self._generate_signal(prices[-1], indicators)
        trend = "BULLISH" if ema_fast > ema_slow else "BEARISH"
        
        return MarketAnalysis(
            symbol=symbol,
            signal=signal,
            confidence=confidence,
            indicators=indicators,
            trend=trend,
            reasoning=reasoning
        )
        
    def _generate_signal(self, current_price: float, ind: TechnicalIndicators) -> Tuple[str, float, List[str]]:
        """Generate trading signal"""
        buy_signals = 0
        sell_signals = 0
        reasoning = []
        
        # RSI signals
        if ind.rsi < 30:
            buy_signals += 2
            reasoning.append(f"RSI oversold ({ind.rsi:.1f})")
        elif ind.rsi > 70:
            sell_signals += 2
            reasoning.append(f"RSI overbought ({ind.rsi:.1f})")
            
        # MACD signals
        if ind.macd > ind.macd_signal:
            buy_signals += 1
            reasoning.append("MACD bullish")
        else:
            sell_signals += 1
            reasoning.append("MACD bearish")
            
        # EMA signals
        if ind.ema_fast > ind.ema_slow:
            buy_signals += 1
            reasoning.append("EMA bullish crossover")
        else:
            sell_signals += 1
            
        # Bollinger Bands
        if current_price < ind.bb_lower:
            buy_signals += 1
            reasoning.append("Price below BB lower")
        elif current_price > ind.bb_upper:
            sell_signals += 1
            reasoning.append("Price above BB upper")
            
        total = buy_signals + sell_signals
        if total == 0:
            return "HOLD", 0.5, ["No clear signals"]
            
        if buy_signals > sell_signals:
            return "BUY", buy_signals / total, reasoning
        elif sell_signals > buy_signals:
            return "SELL", sell_signals / total, reasoning
        else:
            return "HOLD", 0.5, reasoning
