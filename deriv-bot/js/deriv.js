// Minimal Deriv WebSocket API v3 client with req_id request/response routing.

export class DerivAPIError extends Error {
  constructor(code, message, msgType) {
    super(`[${code}] ${message}`);
    this.code = code;
    this.apiMessage = message;
    this.msgType = msgType;
  }
}

export class DerivClient {
  constructor(endpoint, { WebSocketImpl = globalThis.WebSocket, openTimeout = 20000 } = {}) {
    this.endpoint = endpoint;
    this.WebSocketImpl = WebSocketImpl;
    this.openTimeout = openTimeout;
    this.ws = null;
    this.pending = new Map();
    this.nextId = 1;
    this.onEvent = () => {};
    this.onClose = () => {};
    this.closed = true;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new this.WebSocketImpl(this.endpoint);
      this.ws = ws;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; try { ws.close(); } catch {} reject(new Error("Connection timed out")); }
      }, this.openTimeout);
      ws.onopen = () => {
        if (settled) return;
        settled = true; clearTimeout(timer); this.closed = false; resolve();
      };
      ws.onerror = () => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error("Could not connect to Deriv")); }
      };
      ws.onclose = () => {
        clearTimeout(timer);
        const wasOpen = !this.closed;
        this.closed = true;
        this._failPending(new Error("Connection lost"));
        if (!settled) { settled = true; reject(new Error("Connection closed")); }
        if (wasOpen) this.onClose();
      };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; }
        const p = msg.req_id != null ? this.pending.get(msg.req_id) : null;
        if (p) {
          this.pending.delete(msg.req_id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new DerivAPIError(msg.error.code || "Unknown", msg.error.message || "Unknown error", msg.msg_type));
          else p.resolve(msg);
        } else {
          this.onEvent(msg);
        }
      };
    });
  }

  get isOpen() {
    return !this.closed && this.ws && this.ws.readyState === 1;
  }

  request(payload, timeoutMs = 20000) {
    if (!this.isOpen) return Promise.reject(new Error("Not connected"));
    const reqId = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error(`Deriv did not answer '${Object.keys(payload)[0]}' in ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ ...payload, req_id: reqId }));
      } catch (e) {
        clearTimeout(timer); this.pending.delete(reqId); reject(e);
      }
    });
  }

  send(payload) {
    if (this.isOpen) try { this.ws.send(JSON.stringify(payload)); } catch {}
  }

  _failPending(err) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }

  close() {
    this._failPending(new Error("Connection closed"));
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
    const wasOpen = !this.closed;
    this.closed = true;
    if (wasOpen) this.onClose();
  }
}
