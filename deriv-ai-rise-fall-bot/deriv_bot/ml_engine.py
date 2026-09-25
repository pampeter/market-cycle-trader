"""Tick-level feature engineering + a live-retrained LogisticRegression model."""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field

import numpy as np
from sklearn.exceptions import ConvergenceWarning
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

FEATURE_NAMES = ["return", "momentum", "volatility", "ema8_ema21", "sma5_sma10"]
WARMUP = 21  # EMA21 needs this many ticks before features are meaningful


# --------------------------------------------------------------------- utils
def ema(values: np.ndarray, span: int) -> np.ndarray:
    alpha = 2.0 / (span + 1.0)
    out = np.empty_like(values, dtype=float)
    out[0] = values[0]
    for i in range(1, len(values)):
        out[i] = alpha * values[i] + (1 - alpha) * out[i - 1]
    return out


def sma(values: np.ndarray, window: int) -> np.ndarray:
    out = np.full(len(values), np.nan)
    if len(values) < window:
        return out
    csum = np.cumsum(np.insert(values.astype(float), 0, 0.0))
    out[window - 1 :] = (csum[window:] - csum[:-window]) / window
    return out


def rolling_std(values: np.ndarray, window: int) -> np.ndarray:
    out = np.full(len(values), np.nan)
    for i in range(window - 1, len(values)):
        out[i] = np.std(values[i - window + 1 : i + 1])
    return out


def compute_features(prices: np.ndarray) -> np.ndarray:
    """Return an (n, 5) feature matrix. Rows before WARMUP contain NaN.

    All price-based features are normalised by price so the model is
    scale-free across symbols.
    """
    p = np.asarray(prices, dtype=float)
    n = len(p)
    feats = np.full((n, len(FEATURE_NAMES)), np.nan)
    if n < 2:
        return feats

    log_ret = np.zeros(n)
    log_ret[1:] = np.diff(np.log(p))

    momentum = np.full(n, np.nan)
    momentum[5:] = p[5:] / p[:-5] - 1.0

    volatility = rolling_std(log_ret, 10)
    ema_diff = (ema(p, 8) - ema(p, 21)) / p
    sma_diff = (sma(p, 5) - sma(p, 10)) / p

    feats[:, 0] = log_ret
    feats[:, 1] = momentum
    feats[:, 2] = volatility
    feats[:, 3] = ema_diff
    feats[:, 4] = sma_diff
    feats[:WARMUP] = np.nan
    return feats


# --------------------------------------------------------------------- model
@dataclass
class MLSignal:
    prob_rise: float
    prob_fall: float
    holdout_accuracy: float | None
    n_samples: int
    features: dict[str, float] = field(default_factory=dict)

    @property
    def direction(self) -> str:
        return "RISE" if self.prob_rise >= self.prob_fall else "FALL"

    @property
    def probability(self) -> float:
        return max(self.prob_rise, self.prob_fall)


class MLEngine:
    """Retrains a small LogisticRegression on the most recent ticks.

    Label for tick *t*: did the price ``horizon`` ticks later close higher
    than at *t*?  (Mirrors a Rise contract with ``horizon`` ticks.)
    """

    def __init__(self, train_window: int = 100, horizon: int = 5, min_samples: int = 30):
        self.train_window = train_window
        self.horizon = horizon
        self.min_samples = min_samples

    @property
    def ticks_needed(self) -> int:
        return self.train_window + WARMUP + self.horizon

    def _build_model(self):
        return make_pipeline(StandardScaler(), LogisticRegression(C=0.5, max_iter=500))

    def predict(self, prices: np.ndarray | list[float]) -> MLSignal | None:
        p = np.asarray(prices, dtype=float)
        if len(p) < self.ticks_needed:
            return None
        p = p[-self.ticks_needed :]
        X_all = compute_features(p)
        h = self.horizon

        # Labelled rows: need features AND a price h ticks in the future.
        idx = np.arange(WARMUP, len(p) - h)
        X = X_all[idx]
        y = (p[idx + h] > p[idx]).astype(int)
        mask = ~np.isnan(X).any(axis=1)
        X, y = X[mask], y[mask]
        if len(y) < self.min_samples or len(np.unique(y)) < 2:
            return None

        x_now = X_all[-1]
        if np.isnan(x_now).any():
            return None

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", category=ConvergenceWarning)
            warnings.simplefilter("ignore", category=RuntimeWarning)

            # Honest out-of-sample check: train on first 75 %, test on the last 25 %.
            holdout_acc: float | None = None
            split = int(len(y) * 0.75)
            if len(np.unique(y[:split])) == 2 and len(y) - split >= 10:
                m = self._build_model().fit(X[:split], y[:split])
                holdout_acc = float((m.predict(X[split:]) == y[split:]).mean())

            model = self._build_model().fit(X, y)
            proba = model.predict_proba(x_now.reshape(1, -1))[0]

        classes = list(model.classes_)
        prob_rise = float(proba[classes.index(1)])
        return MLSignal(
            prob_rise=prob_rise,
            prob_fall=1.0 - prob_rise,
            holdout_accuracy=holdout_acc,
            n_samples=int(len(y)),
            features={name: float(v) for name, v in zip(FEATURE_NAMES, x_now)},
        )
