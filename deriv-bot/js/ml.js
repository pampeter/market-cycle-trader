// Tick features + L2-regularised logistic regression (Newton / IRLS).
// Mirrors deriv-ai-rise-fall-bot/deriv_bot/ml_engine.py (scikit-learn version).

export const FEATURE_NAMES = ["return", "momentum", "volatility", "ema8_ema21", "sma5_sma10"];
export const WARMUP = 21;

export function ema(values, span) {
  const a = 2 / (span + 1);
  const out = new Array(values.length);
  out[0] = values[0];
  for (let i = 1; i < values.length; i++) out[i] = a * values[i] + (1 - a) * out[i - 1];
  return out;
}

export function sma(values, window) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

function std(arr) {
  const m = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
}

/** Returns an array of n rows × 5 features. Rows before WARMUP are NaN. */
export function computeFeatures(prices) {
  const p = prices.map(Number);
  const n = p.length;
  const rows = Array.from({ length: n }, () => new Array(FEATURE_NAMES.length).fill(NaN));
  if (n < 2) return rows;
  const logRet = new Array(n).fill(0);
  for (let i = 1; i < n; i++) logRet[i] = Math.log(p[i] / p[i - 1]);
  const e8 = ema(p, 8), e21 = ema(p, 21), s5 = sma(p, 5), s10 = sma(p, 10);
  for (let i = WARMUP; i < n; i++) {
    rows[i][0] = logRet[i];
    rows[i][1] = p[i] / p[i - 5] - 1;
    rows[i][2] = std(logRet.slice(i - 9, i + 1));
    rows[i][3] = (e8[i] - e21[i]) / p[i];
    rows[i][4] = (s5[i] - s10[i]) / p[i];
  }
  return rows;
}

// ------------------------------------------------------------------ model
const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

function solve(A, b) {
  // Gaussian elimination with partial pivoting (A is small: 6×6).
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / (M[r][r] || 1e-12);
  }
  return x;
}

/** Fit standardised logistic regression with sklearn-style L2 penalty (1/C). */
export function fitLogistic(X, y, C = 0.5, maxIter = 50) {
  const n = X.length, d = X[0].length;
  const mean = new Array(d).fill(0), sd = new Array(d).fill(0);
  for (const row of X) row.forEach((v, j) => (mean[j] += v / n));
  for (const row of X) row.forEach((v, j) => (sd[j] += (v - mean[j]) ** 2 / n));
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const Z = X.map((row) => [1, ...row.map((v, j) => (v - mean[j]) / sd[j])]);
  const k = d + 1, reg = 1 / C;
  let beta = new Array(k).fill(0);
  for (let it = 0; it < maxIter; it++) {
    const g = new Array(k).fill(0);
    const H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < n; i++) {
      const z = Z[i];
      let dot = 0;
      for (let j = 0; j < k; j++) dot += z[j] * beta[j];
      const p = sigmoid(dot), w = p * (1 - p), r = p - y[i];
      for (let a = 0; a < k; a++) {
        g[a] += z[a] * r;
        for (let b = a; b < k; b++) H[a][b] += w * z[a] * z[b];
      }
    }
    for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) H[a][b] = H[b][a];
    for (let j = 1; j < k; j++) { g[j] += reg * beta[j]; H[j][j] += reg; }
    const step = solve(H, g);
    beta = beta.map((b, j) => b - step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-9) break;
  }
  return { mean, sd, beta };
}

export function predictProba(model, x) {
  let dot = model.beta[0];
  x.forEach((v, j) => (dot += model.beta[j + 1] * ((v - model.mean[j]) / model.sd[j])));
  return sigmoid(dot);
}

export class MLEngine {
  constructor(trainWindow = 100, horizon = 5, minSamples = 30) {
    this.trainWindow = trainWindow;
    this.horizon = horizon;
    this.minSamples = minSamples;
  }

  get ticksNeeded() {
    return this.trainWindow + WARMUP + this.horizon;
  }

  /** @returns {null | {probRise, probFall, direction, probability, holdoutAccuracy, nSamples, features}} */
  predict(prices) {
    if (prices.length < this.ticksNeeded) return null;
    const p = prices.slice(-this.ticksNeeded).map(Number);
    const F = computeFeatures(p);
    const h = this.horizon;
    const X = [], y = [];
    for (let i = WARMUP; i < p.length - h; i++) {
      if (F[i].some(Number.isNaN)) continue;
      X.push(F[i]);
      y.push(p[i + h] > p[i] ? 1 : 0);
    }
    const ones = y.reduce((s, v) => s + v, 0);
    if (y.length < this.minSamples || ones === 0 || ones === y.length) return null;
    const xNow = F[F.length - 1];
    if (xNow.some((v) => !Number.isFinite(v))) return null;

    // Out-of-sample check: train on first 75 %, test on last 25 %.
    let holdoutAccuracy = null;
    const split = Math.floor(y.length * 0.75);
    const trainOnes = y.slice(0, split).reduce((s, v) => s + v, 0);
    if (trainOnes > 0 && trainOnes < split && y.length - split >= 10) {
      const m = fitLogistic(X.slice(0, split), y.slice(0, split));
      let correct = 0;
      for (let i = split; i < y.length; i++) correct += (predictProba(m, X[i]) >= 0.5 ? 1 : 0) === y[i] ? 1 : 0;
      holdoutAccuracy = correct / (y.length - split);
    }
    const model = fitLogistic(X, y);
    const probRise = predictProba(model, xNow);
    const direction = probRise >= 0.5 ? "RISE" : "FALL";
    return {
      probRise,
      probFall: 1 - probRise,
      direction,
      probability: Math.max(probRise, 1 - probRise),
      holdoutAccuracy,
      nSamples: y.length,
      features: Object.fromEntries(FEATURE_NAMES.map((k, j) => [k, xNow[j]])),
    };
  }
}
