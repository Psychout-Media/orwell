"""ORW-907: the test driver `_ws_turn_driver.ws_turn` used to fail a whole real-loop test when its WebSocket dropped under CPU load (`1011 keepalive ping timeout`, a read timeout or an EOF before the test's own checks).
It no longer pings from the client, and a connection that drops after the turn was accepted is RESUMED (hello again, subscribe from seq 0, read to `done`) without resending the turn. A typed refusal and the call's own
deadline still raise. A tiny fake server speaks just enough of the Phase-1 protocol. Roles only."""
import json
import socket
import threading

import pytest
from websockets.sync.server import serve

from _ws_turn_driver import WsTurnError, ws_turn


class FakeGame:
    """hello -> ack; turn -> ack; subscribe -> ack + the run's events + done. `drop_after_subscribe` closes the first connection abruptly once; `refuse` answers the turn with a typed error."""

    def __init__(self, drop_after_subscribe=0, refuse=False, drop_before_turn_ack=0):
        self.turns = 0
        self.hellos = 0
        self.drop_after_subscribe = drop_after_subscribe
        self.drop_before_turn_ack = drop_before_turn_ack
        self.refuse = refuse
        self.cmids = []

    @staticmethod
    def _cut(ws):
        try:
            ws.socket.shutdown(socket.SHUT_RDWR)  # a real TCP cut: the client reads EOF at once (a plain close() can linger behind the library's own reader thread)
        finally:
            ws.socket.close()

    def handler(self, ws):
        for raw in ws:
            f = json.loads(raw)
            t, cid = f.get("t"), f.get("cid")
            if t == "hello":
                self.hellos += 1
                ws.send(json.dumps({"t": "ack", "cid": cid, "d": {"canonicalId": "canon-1", "beatSeq": 7}}))
            elif t == "turn":
                self.turns += 1
                self.cmids.append((f.get("d") or {}).get("clientMsgId"))
                if self.drop_before_turn_ack > 0:
                    self.drop_before_turn_ack -= 1
                    self._cut(ws)
                    return
                if self.refuse:
                    ws.send(json.dumps({"t": "error", "cid": cid, "d": {"code": "stale-beat"}}))
                else:
                    ws.send(json.dumps({"t": "ack", "cid": cid, "d": {}}))
            elif t == "subscribe":
                ws.send(json.dumps({"t": "ack", "cid": cid, "d": {}}))
                if self.drop_after_subscribe > 0:
                    self.drop_after_subscribe -= 1
                    ws.send(json.dumps({"t": "event", "ch": "chat", "d": {"delta": "hel"}}))
                    self._cut(ws)  # an abrupt drop mid-run (no close frame)
                    return
                for d in ({"delta": "hel"}, {"delta": "lo"}, {"type": "message_saved", "id": "m1"}, {"done": True}):
                    ws.send(json.dumps({"t": "event", "ch": "chat", "d": d}))


@pytest.fixture
def server():
    started = []

    def run(game):
        srv = serve(game.handler, "127.0.0.1", 0)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        started.append(srv)
        return f"http://127.0.0.1:{srv.socket.getsockname()[1]}"
    yield run
    for s in started:
        s.shutdown()


def test_a_clean_run_is_unchanged(server):
    game = FakeGame()
    out = ws_turn(server(game), "sess", "hi", timeout=20, client_msg_id="c1")
    assert out["done"] and out["text"] == "hello" and len(out["saved"]) == 1 and out["reconnects"] == 0
    assert game.turns == 1 and game.hellos == 1


def test_a_drop_mid_run_resumes_without_resending_the_turn_and_never_doubles_the_text(server):
    game = FakeGame(drop_after_subscribe=1)
    out = ws_turn(server(game), "sess", "hi", timeout=20, client_msg_id="c2")
    assert out["done"] and out["text"] == "hello", "the resumed read rebuilds the run from seq 0, so the half-read text is not doubled"
    assert out["reconnects"] == 1 and game.hellos == 2
    assert game.turns == 1, "the accepted turn is never sent again"


def test_a_drop_before_the_turn_is_acked_resends_it_under_the_same_client_message_id(server):
    game = FakeGame(drop_before_turn_ack=1)
    out = ws_turn(server(game), "sess", "hi", timeout=20, client_msg_id="c3")
    assert out["done"] and out["reconnects"] == 1
    assert game.cmids == ["c3", "c3"]


def test_a_typed_refusal_is_never_resumed(server):
    game = FakeGame(refuse=True)
    with pytest.raises(WsTurnError, match="stale-beat"):
        ws_turn(server(game), "sess", "hi", timeout=20, client_msg_id="c4")
    assert game.turns == 1 and game.hellos == 1


def test_it_gives_up_after_a_few_reconnects(server):
    game = FakeGame(drop_after_subscribe=99)
    with pytest.raises(Exception):
        ws_turn(server(game), "sess", "hi", timeout=30, client_msg_id="c5")
    assert game.hellos == 4  # the first connection plus the 3 reconnects


def test_the_client_does_not_ping_under_load():
    import inspect
    import _ws_turn_driver as d
    assert "ping_interval=None" in inspect.getsource(d)
