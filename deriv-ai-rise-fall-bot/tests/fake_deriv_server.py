"""A tiny fake Deriv WebSocket server for offline testing / demos.

It implements just enough of the Deriv API v3 protocol for the bot:
authorize, balance, ticks_history (+subscribe), proposal, buy,
proposal_open_contract (+subscribe), forget, ping.

Run standalone:

    python tests/fake_deriv_server.py --port 8765
    DERIV_WS_URL=ws://localhost:8765 DERIV_API_TOKEN=demo PAPER_TRADE=false python bot.py --yes
"""

from __future__ import annotations

import argparse
import asyncio
import itertools
import json
import random
import time

import websockets


class FakeDerivServer:
    def __init__(
        self,
        *,
        tick_interval: float = 0.02,
        win_probability: float = 0.6,
        is_virtual: bool = True,
        drop_after_ticks: int | None = None,
        payout_rate: float = 0.95,
        autocorr: float = 0.6,
        seed: int | None = 7,
        currency: str = "USD",
    ):
        self.tick_interval = tick_interval
        self.win_probability = win_probability
        self.is_virtual = is_virtual
        self.drop_after_ticks = drop_after_ticks
        self.payout_rate = payout_rate
        self.autocorr = autocorr
        self.currency = currency
        self.rng = random.Random(seed)
        self.price = 5000.0
        self.last_ret = 0.0
        self.balance = 10000.0
        self.ids = itertools.count(1000)
        self.contracts: dict[int, dict] = {}
        self.connections = 0
        self.dropped = False
        self.buys: list[dict] = []
        self.requests: list[dict] = []
        self._server = None
        self.port: int | None = None

    # ------------------------------------------------------------- prices
    def next_price(self) -> float:
        # AR(1) returns: gives the ML model something learnable in tests.
        self.last_ret = self.autocorr * self.last_ret + self.rng.gauss(0, 0.0004)
        self.price = round(self.price * (1 + self.last_ret), 4)
        return self.price

    # ------------------------------------------------------------ lifecycle
    async def start(self, host: str = "127.0.0.1", port: int = 0) -> str:
        self._server = await websockets.serve(self._handler, host, port)
        self.port = self._server.sockets[0].getsockname()[1]
        return f"ws://{host}:{self.port}"

    async def stop(self) -> None:
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    # -------------------------------------------------------------- handler
    async def _handler(self, ws):
        self.connections += 1
        tasks: list[asyncio.Task] = []
        state = {"ticks": 0}

        async def send(obj):
            try:
                await ws.send(json.dumps(obj))
            except websockets.ConnectionClosed:
                pass

        def reply(req, msg_type, body, **extra):
            return send({"msg_type": msg_type, msg_type: body, "echo_req": req, "req_id": req.get("req_id"), **extra})

        def error(req, code, message):
            return send({"msg_type": next(iter(req)), "error": {"code": code, "message": message},
                         "echo_req": req, "req_id": req.get("req_id")})

        async def stream_ticks(req, sub_id):
            while True:
                await asyncio.sleep(self.tick_interval)
                q = self.next_price()
                state["ticks"] += 1
                for c in self.contracts.values():
                    c["ticks_seen"] += 1
                await send({"msg_type": "tick", "req_id": req.get("req_id"), "subscription": {"id": sub_id},
                            "tick": {"quote": q, "epoch": int(time.time()), "symbol": req["ticks_history"],
                                     "pip_size": 4, "id": sub_id}})
                if self.drop_after_ticks and not self.dropped and state["ticks"] >= self.drop_after_ticks:
                    self.dropped = True
                    await ws.close()
                    return

        async def stream_contract(req, cid, sub_id):
            c = self.contracts[cid]
            while not c["settled"]:
                await asyncio.sleep(self.tick_interval)
                if c["ticks_seen"] >= c["duration"] + 1:
                    self._settle(c)
            await send({"msg_type": "proposal_open_contract", "req_id": req.get("req_id"),
                        "subscription": {"id": sub_id}, "proposal_open_contract": self._poc(c)})

        try:
            async for raw in ws:
                req = json.loads(raw)
                self.requests.append(req)
                if "authorize" in req:
                    if req["authorize"] in ("bad", ""):
                        await error(req, "InvalidToken", "The token is invalid.")
                        continue
                    await reply(req, "authorize", {
                        "loginid": "VRTC1234567" if self.is_virtual else "CR1234567",
                        "is_virtual": 1 if self.is_virtual else 0, "currency": self.currency,
                        "balance": self.balance, "fullname": " Test User", "scopes": ["read", "trade"],
                    })
                elif "balance" in req:
                    await reply(req, "balance", {"balance": self.balance, "currency": self.currency},
                                subscription={"id": "bal-1"})
                elif "ticks_history" in req:
                    prices = [self.next_price() for _ in range(int(req.get("count", 100)))]
                    await reply(req, "history", {"prices": prices, "times": list(range(len(prices)))}, pip_size=4)
                    if req.get("subscribe"):
                        tasks.append(asyncio.create_task(stream_ticks(req, f"tick-{next(self.ids)}")))
                elif "proposal_open_contract" in req:
                    cid = req["contract_id"]
                    c = self.contracts.get(cid)
                    if c is None:
                        await error(req, "ContractNotFound", "Contract not found")
                        continue
                    sub_id = f"poc-{next(self.ids)}"
                    await reply(req, "proposal_open_contract", self._poc(c),
                                **({"subscription": {"id": sub_id}} if req.get("subscribe") else {}))
                    if req.get("subscribe") and not c["settled"]:
                        tasks.append(asyncio.create_task(stream_contract(req, cid, sub_id)))
                elif "proposal" in req:
                    amount = float(req["amount"])
                    await reply(req, "proposal", {
                        "id": f"prop-{next(self.ids)}", "ask_price": amount,
                        "payout": round(amount * (1 + self.payout_rate), 2), "spot": self.price,
                        "longcode": f"Win payout if {req['symbol']} after {req['duration']} ticks is "
                                    f"{'higher' if req['contract_type'] == 'CALL' else 'lower'} than entry spot.",
                        "_type": req["contract_type"], "_duration": req["duration"],
                    })
                elif "buy" in req:
                    price = float(req["price"])
                    cid = next(self.ids)
                    self.balance = round(self.balance - price, 2)
                    c = {"contract_id": cid, "buy_price": price, "payout": round(price * (1 + self.payout_rate), 2),
                         "ticks_seen": 0, "duration": 5, "settled": False, "profit": 0.0,
                         "entry": self.price, "exit": None}
                    self.contracts[cid] = c
                    self.buys.append(req)
                    await reply(req, "buy", {"contract_id": cid, "buy_price": price, "payout": c["payout"],
                                             "balance_after": self.balance, "transaction_id": cid * 10,
                                             "longcode": "fake contract"})
                elif "forget" in req:
                    await reply(req, "forget", 1)
                elif "ping" in req:
                    await reply(req, "ping", "pong")
                else:
                    await error(req, "UnrecognisedRequest", "Unrecognised request")
        except websockets.ConnectionClosed:
            pass
        finally:
            for t in tasks:
                t.cancel()

    def _settle(self, c: dict) -> None:
        won = self.rng.random() < self.win_probability
        c["settled"] = True
        c["profit"] = round(c["payout"] - c["buy_price"], 2) if won else -c["buy_price"]
        c["exit"] = self.price
        if won:
            self.balance = round(self.balance + c["payout"], 2)

    def _poc(self, c: dict) -> dict:
        body = {"contract_id": c["contract_id"], "buy_price": c["buy_price"], "payout": c["payout"],
                "entry_tick": c["entry"], "is_sold": 1 if c["settled"] else 0,
                "status": ("won" if c["profit"] > 0 else "lost") if c["settled"] else "open",
                "profit": c["profit"] if c["settled"] else 0.0}
        if c["settled"]:
            body["exit_tick"] = c["exit"]
        return body


async def _main(a):
    srv = FakeDerivServer(tick_interval=a.tick_interval, win_probability=a.win, seed=None,
                          is_virtual=not a.real, drop_after_ticks=a.drop_after)
    url = await srv.start(a.host, a.port)
    print(f"Fake Deriv server listening on {url}  (Ctrl+C to stop)", flush=True)
    await asyncio.Future()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--tick-interval", type=float, default=1.0)
    ap.add_argument("--win", type=float, default=0.55, help="win probability for live contracts")
    ap.add_argument("--real", action="store_true", help="pretend the token is a real-money account")
    ap.add_argument("--drop-after", type=int, default=None, help="drop the first connection after N ticks")
    a = ap.parse_args()
    try:
        asyncio.run(_main(a))
    except KeyboardInterrupt:
        pass
