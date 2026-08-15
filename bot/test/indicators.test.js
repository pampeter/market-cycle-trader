'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ema, emaSeries } = require('../src/indicators');

test('ema seeds with the first value', () => {
  assert.strictEqual(ema(10, 4, null), 10);
  assert.strictEqual(ema(10, 4, NaN), 10);
});

test('ema applies the standard smoothing factor', () => {
  // period 4 -> alpha = 2/5 = 0.4
  // ema(2, 4, 1) = 2*0.4 + 1*0.6 = 1.4
  assert.ok(Math.abs(ema(2, 4, 1) - 1.4) < 1e-12);
});

test('emaSeries returns one value per input', () => {
  const out = emaSeries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4);
  assert.strictEqual(out.length, 10);
  assert.strictEqual(out[0], 1);
  assert.ok(Math.abs(out[1] - 1.4) < 1e-12);
});

test('ema tracks the input direction', () => {
  const rising = emaSeries([1, 2, 3, 4, 5], 4);
  assert.ok(rising[rising.length - 1] > rising[0]);
  const falling = emaSeries([5, 4, 3, 2, 1], 4);
  assert.ok(falling[falling.length - 1] < falling[0]);
});
