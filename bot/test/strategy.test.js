'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { EmaCrossoverStrategy } = require('../src/strategy');

/** Build a synthetic 1-minute candle. */
function candle(epoch, close, spread = 0.1) {
  const c = Number(close);
  return {
    epoch,
    open: c - spread / 2,
    high: c + spread,
    low: c - spread,
    close: c,
  };
}

test('no signal during warm-up (fewer than slow period candles)', () => {
  const s = new EmaCrossoverStrategy({ fastPeriod: 4, slowPeriod: 10, holdBars: 5 });
  for (let i = 0; i < 9; i++) {
    const snap = s.onCandle(candle(i + 1, 100 - i));
    assert.strictEqual(snap.signal, null);
  }
  assert.strictEqual(s.trades.length, 0);
});

test('BUY fires when price crosses above both EMAs, then TP after 5 candles', () => {
  const s = new EmaCrossoverStrategy({ fastPeriod: 4, slowPeriod: 10, holdBars: 5 });
  let epoch = 1;

  // Downtrend -> price well below both EMAs.
  for (let i = 0; i < 20; i++) {
    s.onCandle(candle(epoch++, 100 - i));
  }

  // Strong up-candle -> closes above both EMA4 and EMA10 for the first time.
  const buySnap = s.onCandle(candle(epoch++, 120));
  assert.strictEqual(buySnap.signal, 'BUY');
  assert.strictEqual(s.state, 'in-trade');
  assert.strictEqual(s.entry.entryPrice, 120);

  // Next four candles: still holding, no take profit yet.
  for (let i = 0; i < 4; i++) {
    const snap = s.onCandle(candle(epoch++, 121));
    assert.strictEqual(snap.signal, null);
    assert.strictEqual(s.state, 'in-trade');
    assert.strictEqual(snap.barsHeld, i + 1);
  }

  // Fifth completed candle after entry -> automatic take profit.
  const tpSnap = s.onCandle(candle(epoch++, 122));
  assert.strictEqual(tpSnap.signal, 'TAKE_PROFIT');
  assert.strictEqual(s.state, 'idle');
  assert.strictEqual(s.trades.length, 1);
  assert.strictEqual(s.trades[0].barsHeld, 5);
  assert.strictEqual(s.trades[0].entryPrice, 120);
  assert.strictEqual(s.trades[0].exitPrice, 122);
  assert.ok(Math.abs(s.trades[0].pnlPoints - 2) < 1e-9);
});

test('does NOT re-enter while price merely stays above the EMAs (no fresh cross)', () => {
  const s = new EmaCrossoverStrategy({ fastPeriod: 4, slowPeriod: 10, holdBars: 5 });
  let epoch = 1;

  for (let i = 0; i < 20; i++) s.onCandle(candle(epoch++, 100 - i));
  const buy = s.onCandle(candle(epoch++, 120));
  assert.strictEqual(buy.signal, 'BUY');

  // Complete the position to return to idle.
  for (let i = 0; i < 5; i++) s.onCandle(candle(epoch++, 121));
  assert.strictEqual(s.state, 'idle');

  // Price is now above both EMAs and stays there: no new cross -> no signal.
  const stay = s.onCandle(candle(epoch++, 122));
  assert.strictEqual(stay.signal, null);
  assert.strictEqual(s.trades.length, 1);
});

test('never sells short: a bearish cross below the EMAs produces no signal', () => {
  const s = new EmaCrossoverStrategy({ fastPeriod: 4, slowPeriod: 10, holdBars: 5 });
  let epoch = 1;

  // Uptrend so EMAs sit above the coming crash candle.
  for (let i = 0; i < 20; i++) s.onCandle(candle(epoch++, 100 + i));
  const down = s.onCandle(candle(epoch++, 80));
  assert.strictEqual(down.signal, null);
  assert.strictEqual(s.state, 'idle');
  assert.strictEqual(s.trades.length, 0);
});

test('update() warms indicators without entering trades', () => {
  const s = new EmaCrossoverStrategy({ fastPeriod: 4, slowPeriod: 10, holdBars: 5 });
  let epoch = 1;
  for (let i = 0; i < 20; i++) s.update(candle(epoch++, 100 - i));
  // Indicators are warm but no trade state was touched.
  assert.strictEqual(s.state, 'idle');
  assert.strictEqual(s.trades.length, 0);
  assert.ok(s.emaFast !== null && s.emaSlow !== null);
});
