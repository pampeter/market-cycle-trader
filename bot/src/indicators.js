'use strict';

/**
 * Exponential Moving Average helpers.
 *
 * The EMA is seeded with the first value of the series and then updated with
 * the standard smoothing factor alpha = 2 / (period + 1). The bot always
 * warms up with at least `period` historical candles before it may signal,
 * so the seeding bias is negligible.
 */

/** One EMA step: given a new value and the previous EMA, return the new EMA. */
function ema(value, period, prev) {
  if (typeof prev !== 'number' || Number.isNaN(prev)) return value;
  const alpha = 2 / (period + 1);
  return value * alpha + prev * (1 - alpha);
}

/** EMA of a whole series. */
function emaSeries(values, period) {
  let prev = null;
  return values.map((v) => {
    prev = ema(v, period, prev);
    return prev;
  });
}

module.exports = { ema, emaSeries };
