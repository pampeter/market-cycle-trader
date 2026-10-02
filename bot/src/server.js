'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

/**
 * Tiny status server: serves the dashboard (bot/web/index.html) and a JSON
 * status endpoint (/api/status) that the dashboard polls.
 *
 * Bind defaults to loopback (127.0.0.1): the dashboard has **no login**, so on a
 * server you reach it through an SSH tunnel rather than exposing the port.
 * Override with `HOST` only if you have firewalled the port to trusted IPs.
 */
class StatusServer {
  constructor({ port, host = '127.0.0.1', getState, log }) {
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
        if (this.host === '0.0.0.0' || this.host === '::') {
          this.log?.warn(
            'Dashboard is bound to ALL interfaces and has no login. ' +
            'Anyone who can reach this port can read your bot state. ' +
            'Prefer HOST=127.0.0.1 with an SSH tunnel (-L 3000:localhost:3000).'
          );
        }
        resolve();
      });
    });
  }

  stop() {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

module.exports = { StatusServer };
