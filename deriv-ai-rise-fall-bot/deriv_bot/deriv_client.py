"""Minimal async client for the Deriv WebSocket API (v3).

* Every request gets a unique ``req_id`` so responses can be matched to the
  coroutine that is awaiting them.
* Streaming messages (``tick``, ``proposal_open_contract`` ...) that are not
  the first response to a request are pushed onto an ``asyncio.Queue`` that the
  bot consumes via :meth:`DerivClient.next_event`.
* When the socket drops, every pending request fails with ``ConnectionError``
  and ``next_event`` returns ``None`` so the caller can reconnect.
"""

from __future__ import annotations

import asyncio
import itertools
import json
import logging
from typing import Any

import websockets

log = logging.getLogger(__name__)


class DerivAPIError(Exception):
    """An ``error`` object returned by the Deriv API."""

    def __init__(self, code: str, message: str, msg_type: str | None = None):
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message
        self.msg_type = msg_type


class DerivClient:
    def __init__(self, endpoint: str, open_timeout: float = 20.0):
        self.endpoint = endpoint
        self.open_timeout = open_timeout
        self._ws: Any = None
        self._reader: asyncio.Task | None = None
        self._pending: dict[int, asyncio.Future] = {}
        self._events: asyncio.Queue = asyncio.Queue()
        self._ids = itertools.count(1)
        self._closed = asyncio.Event()

    # ------------------------------------------------------------------ life
    async def connect(self) -> None:
        self._closed.clear()
        self._events = asyncio.Queue()
        self._ws = await websockets.connect(
            self.endpoint,
            open_timeout=self.open_timeout,
            ping_interval=20,
            ping_timeout=20,
            max_size=2**22,
        )
        self._reader = asyncio.create_task(self._read_loop(), name="deriv-reader")

    async def close(self) -> None:
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:  # pragma: no cover - best effort
                pass
        if self._reader is not None:
            try:
                await asyncio.wait_for(self._reader, timeout=5)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                self._reader.cancel()
        self._fail_pending(ConnectionError("connection closed"))
        self._closed.set()

    @property
    def is_open(self) -> bool:
        return self._ws is not None and not self._closed.is_set()

    # --------------------------------------------------------------- reading
    async def _read_loop(self) -> None:
        try:
            async for raw in self._ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    log.warning("Ignoring non-JSON message: %r", raw[:200])
                    continue
                req_id = msg.get("req_id")
                fut = self._pending.pop(req_id, None) if req_id is not None else None
                if fut is not None and not fut.done():
                    fut.set_result(msg)
                else:
                    # Stream update (tick, proposal_open_contract, ...)
                    self._events.put_nowait(msg)
        except websockets.ConnectionClosed as exc:
            log.info("WebSocket closed: %s", exc)
        except Exception as exc:  # pragma: no cover - defensive
            log.exception("Reader crashed: %s", exc)
        finally:
            self._closed.set()
            self._fail_pending(ConnectionError("connection lost"))
            self._events.put_nowait(None)  # wake up the consumer

    def _fail_pending(self, exc: Exception) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()

    def wake(self) -> None:
        """Make a pending :meth:`next_event` return ``None`` (used to stop cleanly)."""
        self._events.put_nowait(None)

    async def next_event(self) -> dict | None:
        """Return the next stream message, or ``None`` if the socket closed."""
        return await self._events.get()

    # --------------------------------------------------------------- writing
    async def request(self, payload: dict, timeout: float = 20.0) -> dict:
        """Send ``payload`` and wait for the matching response.

        Raises :class:`DerivAPIError` if the API returns an ``error`` object.
        """
        if not self.is_open:
            raise ConnectionError("not connected")
        req_id = next(self._ids)
        payload = {**payload, "req_id": req_id}
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[req_id] = fut
        try:
            await self._ws.send(json.dumps(payload))
            msg = await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError as exc:
            self._pending.pop(req_id, None)
            first_key = next(iter(payload))
            raise TimeoutError(f"Deriv did not answer '{first_key}' within {timeout}s") from exc
        except websockets.ConnectionClosed as exc:
            self._pending.pop(req_id, None)
            raise ConnectionError("connection lost while sending") from exc
        if "error" in msg:
            err = msg["error"] or {}
            raise DerivAPIError(err.get("code", "Unknown"), err.get("message", "Unknown error"), msg.get("msg_type"))
        return msg

    async def send_nowait(self, payload: dict) -> None:
        """Fire-and-forget send (used for ping / forget)."""
        if self.is_open:
            try:
                await self._ws.send(json.dumps(payload))
            except websockets.ConnectionClosed:
                pass
