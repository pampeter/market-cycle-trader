'use strict';

const { DerivClient } = require('./deriv');

/**
 * One-shot connectivity self-test:
 *   node src/index.js --selftest
 *
 * Connects to Deriv, (optionally) authorizes with the API token, prints the
 * account balance, and fetches the most recent candles for the symbol so you
 * can verify end-to-end connectivity and credentials BEFORE switching on
 * live trading. Exits 0 on success, 1 on failure.
 */
async function runSelfTest({ config, log }) {
  const client = new DerivClient({
    appId: config.APP_ID,
    endpoint: config.ENDPOINT,
    token: config.API_TOKEN,
    log,
  });

  log.info(`Connecting to Deriv (${config.SYMBOL})…`);
  await client.connect();
  log.ok('WebSocket connected.');

  let authorized = false;
  if (config.API_TOKEN) {
    const auth = await client.authorize(config.API_TOKEN);
    authorized = true;
    log.ok(`Authorized as ${auth?.email || auth?.loginid || 'authorized account'}`);
    try {
      const bal = await client.balance();
      log.info(`Account balance: ${bal} ${config.CURRENCY}`);
    } catch {
      log.warn('Could not fetch balance (token may lack the Read scope).');
    }
  } else {
    log.warn('No API_TOKEN — running unauthenticated (market data only).');
  }

  const candles = await client.getCandles(config.SYMBOL, config.GRANULARITY, 5);
  log.ok(`Fetched ${candles.length} × ${config.GRANULARITY}s candles for ${config.SYMBOL}:`);
  for (const c of candles) {
    const t = new Date(c.epoch * 1000).toISOString().slice(11, 19);
    log.info(`${t}Z  O=${c.open}  H=${c.high}  L=${c.low}  C=${c.close}`);
  }

  client.close();
  return { ok: true, authorized, candles: candles.length };
}

module.exports = { runSelfTest };
