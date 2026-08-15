'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

/**
 * Tiny status server: serves the dashboard (bot/web/index.html) and a JSON
 * status endpoint (/api/status) that the dashboard polls.
 * Binds to 0.0.0.0 so it can be previewed from the browser.
 */
class StatusServer {
  constructor({ port, host = '0.0.0.0', getState, log }) {
    this.port = port;
    this.host = host;
    this.getState = getState;
    this.log = log;
    this.server = http.createServer((req, res) => this._handle(req, res));
  }

  _handle(req, res) {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/api/status') {
      const body = JSON.stringify(this.getState() || { status: 'starting' });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(body);
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const file = path.join(__dirname, '..', 'web', 'index.html');
      try {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(file));
      } catch {
        res.writeHead(500);
        res.end('dashboard not found');
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.log?.info(`Dashboard listening on http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

module.exports = { StatusServer };
