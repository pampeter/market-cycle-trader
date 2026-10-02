import numpy as np

from deriv_bot.ml_engine import FEATURE_NAMES, WARMUP, MLEngine, compute_features, ema, sma


def test_sma_and_ema_basic():
    x = np.arange(1, 11, dtype=float)
    s = sma(x, 5)
    assert np.isnan(s[3]) and s[4] == 3.0 and s[-1] == 8.0
    e = ema(np.full(20, 7.0), 8)
    assert np.allclose(e, 7.0)


def test_feature_shape_and_warmup():
    p = 1000 + np.cumsum(np.random.default_rng(0).normal(0, 1, 200))
    f = compute_features(p)
    assert f.shape == (200, len(FEATURE_NAMES))
    assert np.isnan(f[:WARMUP]).all()
    assert not np.isnan(f[WARMUP:]).any()


def test_predict_needs_enough_ticks():
    eng = MLEngine(train_window=100, horizon=5)
    assert eng.predict(list(range(1, 50))) is None


def test_predict_returns_valid_probabilities():
    rng = np.random.default_rng(1)
    p = 5000 * np.exp(np.cumsum(rng.normal(0, 0.0005, 400)))
    sig = MLEngine(train_window=100, horizon=5).predict(p)
    assert sig is not None
    assert 0 <= sig.prob_rise <= 1 and abs(sig.prob_rise + sig.prob_fall - 1) < 1e-9
    assert sig.direction in {"RISE", "FALL"}
    assert set(sig.features) == set(FEATURE_NAMES)


def test_learns_up_drift():
    # Up-drift with noise (both classes present) -> model should mostly favour RISE.
    rise = 0
    for seed in range(10):
        rng = np.random.default_rng(seed)
        p = 5000 * np.exp(np.cumsum(0.0003 + rng.normal(0, 0.0006, 400)))
        sig = MLEngine(train_window=100, horizon=5).predict(p)
        assert sig is not None
        rise += sig.direction == "RISE"
    assert rise >= 8
