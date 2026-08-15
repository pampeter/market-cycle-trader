'use strict';

const { buildConfig, validateConfig } = require('./config');
const { createLogger } = require('./logger');
const { Trader } = require('./trader');
const { runDemo } = require('./demo');
const { runSelfTest } = require('./selftest');
const { StatusServer } = require('./server');

const HELP = `
Market Cycle Trader — Crash 500 EMA bot
=======================================
Strategy: BUY (long only) when price closes above the EMA ${''}4 and EMA ${''}10
lines on a completed 1-minute candle; take profit automatically after
${''}5 completed 1-minute candles.

Usage:
  node src/index.js            # dry-run (default) — live signals, no real orders
  node src/index.js --demo     # synthetic candle demo (no API/network needed)
  node src/index.js --selftest # connect to Deriv, verify token + live candles
  node src/index.js --live     # real orders (requires API_TOKEN + LIVE_TRADING)
  node src/index.js --port 8080

Environment: see bot/.env.example (copy to bot/.env).

WARNING: This trades real money when run in --live mode. Crash 500 is a
high-risk synthetic index. Use a Deriv DEMO account first and never trade
money you cannot afford to lose.
`;

function parseArgs(argv) {
  const args = { demo: false, live: false, port: null, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--demo') args.demo = true;
    else if (a === '--live') args.live = true;
    else if (a === '--selftest') args.selftest = true;
    else if (a === '--port' && argv[i + 1]) args.port = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  const log = createLogger();
  const config = buildConfig({ demo: args.demo, live: args.live, port: args.port });

  const errors = validateConfig(config);
  if (errors.length) {
    for (const e of errors) log.err(e);
    process.exit(1);
  }

  banner(log, config);

  // One-shot connectivity self-test (verify Deriv + token + live candles).
  if (args.selftest) {
    try {
      await runSelfTest({ config, log });
      log.ok('SELF-TEST PASSED — you can now run live market data with: npm start');
      process.exit(0);
    } catch (err) {
      log.err(`SELF-TEST FAILED: ${err.message}`);
      log.warn('Check your internet connection, APP_ID, and API token, then retry.');
      process.exit(1);
    }
  }

  let state = { status: 'starting', mode: config.MODE, symbol: config.SYMBOL };
  const server = new StatusServer({ port: config.PORT, getState: () => state, log });

  try {
    await server.start();
  } catch (err) {
    log.err(`Could not start dashboard on port ${config.PORT}: ${err.message}`);
    process.exit(1);
  }

  const shutdown = async () => {
    log.info('Shutting down…');
    trader?.stop();
    await server.stop();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  let trader = null;
  if (config.MODE === 'demo') {
    await runDemo({ config, log, setState: (s) => (state = s) });
  } else {
    trader = new Trader({ config, log, onState: (s) => (state = s) });
    try {
      await trader.start();
    } catch (err) {
      log.err(err.message);
      log.warn('If this is a network error, check your internet connection / endpoint. For a demo that needs no network, run: npm run demo');
      await shutdown();
    }
  }
}

function banner(log, cfg) {
  const mode =
    cfg.MODE === 'live' ? '\x1b[31mLIVE (real orders)\x1b[0m' : cfg.MODE === 'demo' ? '\x1b[36mDEMO (synthetic candles)\x1b[0m' : '\x1b[33mDRY-RUN (no real orders)\x1b[0m';
  log.info(`Market Cycle Trader — ${cfg.SYMBOL} · ${cfg.GRANULARITY}s candles`);
  log.info(`Strategy: BUY when close > EMA${cfg.EMA_FAST} & EMA${cfg.EMA_SLOW} · take profit after ${cfg.HOLD_BARS} candles`);
  log.info(`Contract: ${cfg.CONTRACT_TYPE} · stake ${cfg.STAKE} ${cfg.CURRENCY} · mode: ${mode}`);
  if (cfg.MODE === 'live') {
    log.warn('LIVE TRADING IS ON. You are trading with real money on a Deriv account.');
  }
}

main();
