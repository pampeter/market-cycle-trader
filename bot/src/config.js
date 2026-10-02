'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  APP_ID: '1089',
  ENDPOINT: 'wss://ws.derivws.com/websockets/v3',
  SYMBOL: 'CRASH500',
  GRANULARITY: 60, // 60s = 1-minute candles
  EMA_FAST: 4,
  EMA_SLOW: 10,
  HOLD_BARS: 5, // take profit after 5 completed 1-minute candles
  CONTRACT_TYPE: 'MULTUP', // 'MULTUP' | 'CALL'
  STAKE: 1,
  MULTIPLIER: 100,
  CURRENCY: 'USD',
  DURATION: 1,
  DURATION_UNIT: 'd',
  SEED_CANDLES: 60,
  PORT: 3000,
  HOST: '127.0.0.1', // loopback only — use an SSH tunnel; see deploy/gcp/README.md
  LIVE_TRADING: 'false',
  API_TOKEN: '',
};

/**
 * Minimal .env loader (no dependencies). Reads `bot/.env` if present.
 * Real environment variables always win over the file.
 */
function readEnvFile() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) return {};
  const out = {};
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function bool(v) {
  return String(v).toLowerCase() === 'true' || String(v) === '1';
}

/**
 * Build the runtime config from defaults + .env + process.env + CLI flags.
 * @param {{demo?:boolean, live?:boolean, port?:number|string}} options
 */
function buildConfig(options = {}) {
  const merged = { ...DEFAULTS, ...readEnvFile(), ...process.env };

  const liveWanted = options.live ? true : bool(merged.LIVE_TRADING);
  const mode = options.demo ? 'demo' : liveWanted && merged.API_TOKEN ? 'live' : 'dry-run';

  const cfg = {
    MODE: mode,
    APP_ID: String(merged.APP_ID || DEFAULTS.APP_ID),
    ENDPOINT: merged.ENDPOINT || DEFAULTS.ENDPOINT,
    SYMBOL: String(merged.SYMBOL || DEFAULTS.SYMBOL),
    GRANULARITY: Number(merged.GRANULARITY || DEFAULTS.GRANULARITY),
    EMA_FAST: Number(merged.EMA_FAST || DEFAULTS.EMA_FAST),
    EMA_SLOW: Number(merged.EMA_SLOW || DEFAULTS.EMA_SLOW),
    HOLD_BARS: Number(merged.HOLD_BARS || DEFAULTS.HOLD_BARS),
    CONTRACT_TYPE: String(merged.CONTRACT_TYPE || DEFAULTS.CONTRACT_TYPE).toUpperCase(),
    STAKE: Number(merged.STAKE || DEFAULTS.STAKE),
    MULTIPLIER: Number(merged.MULTIPLIER || DEFAULTS.MULTIPLIER),
    CURRENCY: String(merged.CURRENCY || DEFAULTS.CURRENCY),
    DURATION: Number(merged.DURATION || DEFAULTS.DURATION),
    DURATION_UNIT: String(merged.DURATION_UNIT || DEFAULTS.DURATION_UNIT),
    SEED_CANDLES: Number(merged.SEED_CANDLES || DEFAULTS.SEED_CANDLES),
    PORT: Number(options.port || merged.PORT || DEFAULTS.PORT),
    HOST: String(merged.HOST || DEFAULTS.HOST).trim(),
    DRY_RUN: mode !== 'live',
    API_TOKEN: String(merged.API_TOKEN || ''),
  };

  return cfg;
}

function validateConfig(cfg) {
  const errors = [];
  if (!['MULTUP', 'CALL'].includes(cfg.CONTRACT_TYPE)) {
    errors.push('CONTRACT_TYPE must be either MULTUP or CALL');
  }
  if (!Number.isFinite(cfg.EMA_FAST) || !Number.isFinite(cfg.EMA_SLOW)) {
    errors.push('EMA_FAST and EMA_SLOW must be numbers');
  } else if (cfg.EMA_FAST >= cfg.EMA_SLOW) {
    errors.push('EMA_FAST must be smaller than EMA_SLOW (e.g. 4 and 10)');
  }
  if (!Number.isFinite(cfg.HOLD_BARS) || cfg.HOLD_BARS < 1) {
    errors.push('HOLD_BARS must be >= 1');
  }
  if (!Number.isFinite(cfg.STAKE) || cfg.STAKE <= 0) {
    errors.push('STAKE must be > 0');
  }
  if (cfg.MODE === 'live' && !cfg.API_TOKEN) {
    errors.push('LIVE trading requires a DERIV_API_TOKEN');
  }
  if (cfg.GRANULARITY !== 60) {
    errors.push('This strategy is designed for GRANULARITY=60 (1-minute candles)');
  }
  return errors;
}

module.exports = { DEFAULTS, buildConfig, validateConfig };
