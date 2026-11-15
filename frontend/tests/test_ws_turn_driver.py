"""ORW-44 S4b3: unit tests for tests/_ws_turn_driver.py against a fake socket server that speaks the protocol frames (no engine, no FE)."""
import json
import threading

import pytest

from _ws_turn_driver import WsTurnError, ws_turn

server_mod = pytest.importorskip("websockets.sync.server")


def _serve(handler):
    srv = server_mod.serve(handler, "127.0.0.1", 0)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.socket.getsockname()[1]}"


def _well_behaved(ws):
    seen = []
    for raw in ws:
        f = json.loads(raw)
        seen.append(f["t"])
        if f["t"] == "hello":
            ws.send(json.dumps({"t": "ack", "cid": f["cid"], "d": {"canonicalId": "canon-1", "beatSeq": 7, "live": True}}))
        elif f["t"] == "turn":
            assert f["d"]["message"] == "hi" and f["d"]["expectedBeatSeq"] == 7 and f["ch"] == "chat"
            ws.send(json.dumps({"t": "ack", "cid": f["cid"], "d": {"accepted": True}}))
        elif f["t"] == "subscribe":
            assert f["d"]["fromSeq"] == 0
            ws.send(json.dumps({"t": "ack", "ch": "chat", "cid": f["cid"], "d": {"fromSeq": 0, "headSeq": 3}}))
            for seq, d in enumerate([{"delta": "He ", "thinking": False}, {"delta": "(hmm)", "thinking": True}, {"delta": "glances."},
                                     {"type": "message_saved", "id": "m1", "seq": 3}, {"done": True}]):
                ws.send(json.dumps({"t": "event", "ch": "chat", "seq": seq, "d": d}))
            return


def test_a_turn_is_driven_hello_turn_subscribe_and_collected_until_done():
    srv, base = _serve(_well_behaved)
    try:
        out = ws_turn(base, "sess-1", "hi", timeout=10)
    finally:
        srv.shutdown()
    assert out["canonical"] == "canon-1" and out["done"] is True
    assert out["text"] == "He glances."                 # reasoning ("thinking") deltas never reach the reply text
    assert [s["id"] for s in out["saved"]] == ["m1"] and len(out["events"]) == 5


def test_an_in_run_error_payload_is_reserialised_as_an_sse_error_event():
    def erroring(ws):
        for raw in ws:
            f = json.loads(raw)
            if f["t"] == "hello":
                ws.send(json.dumps({"t": "ack", "cid": f["cid"], "d": {"canonicalId": "c"}}))
            elif f["t"] == "turn":
                ws.send(json.dumps({"t": "ack", "cid": f["cid"], "d": {"accepted": True}}))
            elif f["t"] == "subscribe":
                ws.send(json.dumps({"t": "ack", "ch": "chat", "cid": f["cid"], "d": {}}))
                ws.send(json.dumps({"t": "event", "ch": "chat", "seq": 0, "d": {"error": "dropped", "error_type": "stream_dropped", "event": "error"}}))
                ws.send(json.dumps({"t": "event", "ch": "chat", "seq": 1, "d": {"done": True}}))
                return
    srv, base = _serve(erroring)
    try:
        out = ws_turn(base, "s", "hi", timeout=10)
    finally:
        srv.shutdown()
    assert "event: error\ndata: " in out["body"] and "stream_dropped" in out["body"]


def test_collect_false_returns_once_the_turn_is_accepted():
    srv, base = _serve(_well_behaved)
    try:
        out = ws_turn(base, "sess-1", "hi", timeout=10, collect=False)
    finally:
        srv.shutdown()
    assert out["done"] is False and out["events"] == []


def test_a_typed_refusal_raises():
    def refusing(ws):
        for raw in ws:
            f = json.loads(raw)
            if f["t"] == "hello":
                ws.send(json.dumps({"t": "ack", "cid": f["cid"], "d": {"canonicalId": "c"}}))
            elif f["t"] == "turn":
                ws.send(json.dumps({"t": "error", "cid": f["cid"], "d": {"code": "stale-beat"}}))
                return
    srv, base = _serve(refusing)
    try:
        with pytest.raises(WsTurnError, match="stale-beat"):
            ws_turn(base, "sess-1", "hi", timeout=10)
    finally:
        srv.shutdown()
