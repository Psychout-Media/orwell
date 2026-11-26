"""ORW-44 S4b3: a plain-Python client for the multiplexed game socket, so tests and ops scripts can drive a turn without the retired HTTP stream route.

`ws_turn(fbase, session_id, text)` speaks the Phase-1 protocol (docs/design/websocket-phase1-protocol.md): hello -> turn up-frame -> subscribe to the chat channel
from seq 0 (the run buffer is replayed, so subscribing after the turn is accepted loses nothing) -> collect `event` frames until the terminal `done`. It returns what
the old SSE drivers read off the response: every event payload, the reply text (non-thinking deltas), the `message_saved` events, any typed error, and `body` (the events
re-serialised as SSE text, so substring assertions like '"type": "message_saved"' carry over unchanged).
No Origin header is sent, which the server's CSWSH guard allows for a non-browser client."""
from __future__ import annotations

import json
import time
from typing import Optional


class WsTurnError(RuntimeError):
    pass


def _ws_url(fbase: str) -> str:
    return fbase.replace("http://", "ws://", 1).replace("https://", "wss://", 1).rstrip("/") + "/api/ws/session"


def _recv(ws, deadline: float) -> dict:
    left = deadline - time.time()
    if left <= 0:
        raise WsTurnError("timed out waiting for a frame")
    raw = ws.recv(timeout=left)
    return json.loads(raw)


def _await_reply(ws, cid: str, deadline: float, what: str) -> dict:
    """Read frames until the `ack` (or typed `error`) that echoes `cid`; frames for other cids / pushes are skipped."""
    while True:
        f = _recv(ws, deadline)
        if f.get("cid") != cid:
            continue
        if f.get("t") == "error":
            raise WsTurnError(f"{what} refused: {f.get('d')}")
        if f.get("t") == "ack":
            return f.get("d") or {}


# ORW-907: a CPU-starved box (a loaded dev machine or runner running the engine, the front end and Chromium together) used to drop this client with `1011 keepalive ping timeout` (the websockets client pings every 20 s and
# closes if no pong comes back in 20 s), a read `TimeoutError` or an `EOFError` before a test's own checks ran. The driver is a test tool talking to a server it started itself, so: (1) the CLIENT keepalive is off
# (`ping_interval=None`; the server keeps its own), and (2) a dropped connection after the turn was accepted is RESUMED: reconnect, hello again, subscribe from seq 0 (the run buffer replays, so nothing is lost) and read to
# `done`; a drop before the turn is acked resends the turn under the SAME client message id (the server de-duplicates it). A typed refusal or the call's own deadline still raises; the number of reconnects is returned
# (`reconnects`) so a flaky box stays visible.
_MAX_RECONNECTS = 3


def _dropped(exc: BaseException) -> bool:
    """A transport drop (resumable), as opposed to a typed refusal or the caller's own deadline (never resumed)."""
    from websockets.exceptions import ConnectionClosed
    return isinstance(exc, (ConnectionClosed, EOFError, ConnectionError, OSError))


def ws_turn(fbase: str, session_id: str, text: str, *, mode: str = "agent", timeout: float = 180.0,
            headers: Optional[dict] = None, client_msg_id: Optional[str] = None, collect: bool = True) -> dict:
    """Drive ONE turn over the socket. Returns {"canonical", "events", "text", "saved", "done", "body", "reconnects"}; raises WsTurnError on a typed refusal or a timeout.
    `collect=False` returns as soon as the turn is accepted (the run is kicked; the caller does not read the stream)."""
    from websockets.sync.client import connect
    deadline = time.time() + timeout
    cmid = client_msg_id or f"drv_{int(time.time() * 1000)}"
    out: dict = {"canonical": session_id, "events": [], "text": "", "saved": [], "done": False, "body": "", "reconnects": 0}
    accepted = False  # the server acked the turn: a later drop only re-subscribes, it never resends
    while True:
        try:
            with connect(_ws_url(fbase), additional_headers=headers or {}, open_timeout=30, max_size=None, ping_interval=None) as ws:
                ws.send(json.dumps({"t": "hello", "cid": "h0", "d": {"perTabId": session_id, "protocol": 1}}))
                ack = _await_reply(ws, "h0", deadline, "hello")
                out["canonical"] = ack.get("canonicalId") or session_id
                if not accepted:
                    turn = {"message": text, "clientMsgId": cmid, "attachments": [], "mode": mode}
                    if ack.get("beatSeq") is not None:
                        turn["expectedBeatSeq"] = ack["beatSeq"]
                    ws.send(json.dumps({"t": "turn", "ch": "chat", "cid": "t0", "d": turn}))
                    _await_reply(ws, "t0", deadline, "turn")
                    accepted = True
                if not collect:
                    return out
                # (a resumed read starts again from seq 0: the run buffer replays everything, so the collected events are rebuilt, never doubled)
                out.update({"events": [], "text": "", "saved": [], "done": False, "body": ""})
                ws.send(json.dumps({"t": "subscribe", "ch": "chat", "cid": "s0", "d": {"fromSeq": 0}}))
                _await_reply(ws, "s0", deadline, "subscribe")
                while not out["done"]:
                    f = _recv(ws, deadline)
                    if f.get("t") == "error" and f.get("ch") == "chat":   # an in-run typed error: keep it in the body the way the SSE `event: error` was
                        out["events"].append(f.get("d") or {})
                        out["body"] += "event: error\ndata: " + json.dumps(f.get("d") or {}) + "\n\n"
                        continue
                    if f.get("t") != "event" or f.get("ch") != "chat":
                        continue
                    d = f.get("d") or {}
                    out["events"].append(d)
                    # the SSE-shaped text the old HTTP drivers asserted substrings of; over the socket the SSE `event: error` line is folded into the payload as "event": "error"
                    out["body"] += ("event: error\n" if d.get("event") == "error" else "") + "data: " + json.dumps(d) + "\n\n"
                    if d.get("delta") and not d.get("thinking"):
                        out["text"] += d["delta"]
                    if d.get("type") == "message_saved":
                        out["saved"].append(d)
                    if d.get("done"):
                        out["done"] = True
                return out
        except WsTurnError:
            raise
        except Exception as exc:  # noqa: BLE001 - classified below
            if not _dropped(exc) or out["reconnects"] >= _MAX_RECONNECTS or time.time() >= deadline:
                raise
            out["reconnects"] += 1
            print(f"[ws_turn] connection dropped ({type(exc).__name__}); reconnect {out['reconnects']}/{_MAX_RECONNECTS}, turn {'accepted' if accepted else 'not yet accepted'}")
