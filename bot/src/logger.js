'use strict';

/**
 * Tiny colorized logger. Falls back to plain text when stdout is not a TTY
 * (e.g. when piping to a file or a CI runner).
 */

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
};

const useColor = process.stdout.isTTY === true;

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

function createLogger({ silent = false } = {}) {
  const print = (color, label, msg) => {
    if (silent) return;
    const c = useColor ? COLORS[color] : '';
    const r = useColor ? COLORS.reset : '';
    const d = useColor ? COLORS.dim : '';
    console.log(`${d}[${ts()}]${r} ${c}${label}${r} ${msg}`);
  };

  return {
    info: (m) => print('gray', 'INFO ', m),
    ok: (m) => print('green', 'OK   ', m),
    warn: (m) => print('yellow', 'WARN ', m),
    err: (m) => print('red', 'ERROR', m),
    trade: (m) => print('cyan', 'TRADE', m),
  };
}

module.exports = { createLogger };
