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


def ws_turn(fbase: str, session_id: str, text: str, *, mode: str = "agent", timeout: float = 180.0,
            headers: Optional[dict] = None, client_msg_id: Optional[str] = None, collect: bool = True) -> dict:
    """Drive ONE turn over the socket. Returns {"canonical", "events", "text", "saved", "done"}; raises WsTurnError on a typed refusal or a timeout.
    `collect=False` returns as soon as the turn is accepted (the run is kicked; the caller does not read the stream)."""
    from websockets.sync.client import connect
    deadline = time.time() + timeout
    with connect(_ws_url(fbase), additional_headers=headers or {}, open_timeout=30, max_size=None) as ws:
        ws.send(json.dumps({"t": "hello", "cid": "h0", "d": {"perTabId": session_id, "protocol": 1}}))
        ack = _await_reply(ws, "h0", deadline, "hello")
        canonical = ack.get("canonicalId") or session_id
        turn = {"message": text, "clientMsgId": client_msg_id or f"drv_{int(time.time() * 1000)}", "attachments": [], "mode": mode}
        if ack.get("beatSeq") is not None:
            turn["expectedBeatSeq"] = ack["beatSeq"]
        ws.send(json.dumps({"t": "turn", "ch": "chat", "cid": "t0", "d": turn}))
        _await_reply(ws, "t0", deadline, "turn")
        out = {"canonical": canonical, "events": [], "text": "", "saved": [], "done": False, "body": ""}
        if not collect:
            return out
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
