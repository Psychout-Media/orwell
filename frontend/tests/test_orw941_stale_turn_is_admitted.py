"""ORW-941 (the ORW-909 root cause, dev 2026-11-25): casting turns never reached the server. They were not lost frames - the server REFUSED them, silently. A `turn` up-frame carries the 0065
CAS token (`expectedBeatSeq`), and during casting the background write-backs (cast authoring, portraits, the photo step) move the engine's beatSeq with no state edge to the page
(dev: 1 -> 27 between the opener and the second turn), so the page's token is always stale. `_handle_turn` answered `error{stale-beat}` before `noteMessage` (no log line), the page
retried once, a write burst refused the retry too, and the turn was dropped (the player's bubble stayed; on the older page a holder stayed, the Stop face with it, and every later send
queued). The HTTP turn path never had a turn CAS: a chat turn is not a closed-set write (it queues behind any live run, the narrator reads fresh state, every engine write inside it is
CAS-guarded server-side). So a stale `turn` is ADMITTED, and its ack hands the page the current beatSeq; a `decision` keeps the refusing CAS. Real engine + FE + stub narrator, the
socket driven directly. Roles only."""
from __future__ import annotations

import json
import threading
import time
import urllib.request

import pytest

from test_m0_3_midgen_join import STUB, _boot_stack
from test_p0h_day1_clock_e2e import _session
from _ws_turn_driver import _ws_url, _await_reply, _recv, WsTurnError


@pytest.fixture()
def _casting_stack():
    yield from _boot_stack(create_game=False)


def _engine(stack, name, args):
    req = urllib.request.Request(stack["engine"] + "/player/call", data=json.dumps({"name": name, "args": args}).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read() or b"{}")


def _hello(ws, sid, deadline):
    ws.send(json.dumps({"t": "hello", "cid": "h0", "d": {"perTabId": sid, "protocol": 1}}))
    return _await_reply(ws, "h0", deadline, "hello")


def _background_writes(stack, n=3):
    """What cast authoring does during casting: engine writes the page is never told about."""
    for i in range(n):
        _engine(stack, "updateCasting", {"playerName": f"Role {'AB'[i % 2]}"})


class _Churn:
    """Background engine writes for the length of a `with` block (cast authoring during casting; any off-screen write in a started game)."""
    def __init__(self, stack, name="updateCasting"):
        self.stack, self.name, self.stop, self.n = stack, name, threading.Event(), 0

    def _run(self):
        i = 0
        while not self.stop.is_set():
            try:
                _engine(self.stack, self.name, {"playerName": f"Role {'AB'[i % 2]}"} if self.name == "updateCasting" else {"messageId": f"o941-churn-{i}"})
                self.n += 1
            except Exception:
                pass
            i += 1
            time.sleep(0.05)

    def __enter__(self):
        self.t = threading.Thread(target=self._run, daemon=True)
        self.t.start()
        while self.n < 3:
            time.sleep(0.05)
        return self

    def __exit__(self, *a):
        self.stop.set()
        self.t.join(timeout=5)


def _turn(ws, cid, text, client_msg_id, expected):
    ws.send(json.dumps({"t": "turn", "ch": "chat", "cid": cid, "d": {"message": text, "clientMsgId": client_msg_id, "attachments": [], "mode": "agent", "expectedBeatSeq": expected}}))


def test_a_stale_casting_turn_is_admitted_and_reaches_the_narrator(_casting_stack):
    """The opener itself (the session's first turn), sent while cast authoring keeps writing: the page's token is stale on arrival, the turn runs."""
    from websockets.sync.client import connect
    stack = _casting_stack
    sid = _session(stack, "o941-casting")
    reply = "Welcome to casting, o941."
    STUB.script.append({"deltas": [reply], "delay": 0})
    deadline = time.time() + 120
    with connect(_ws_url(stack["fe"]), open_timeout=30, max_size=None) as ws, _Churn(stack):
        ack = _hello(ws, sid, deadline)
        seen = ack.get("beatSeq")
        assert isinstance(seen, int), "the handshake hands the page a beatSeq (setup)"
        _background_writes(stack)   # the page's token is now stale (and the churn keeps it so)
        before = len(STUB.requests)
        _turn(ws, "t0", "(Production cue - begin the casting interview now.)", f"o941_{int(time.time() * 1000)}", seen)
        try:
            d = _await_reply(ws, "t0", deadline, "turn")
        except WsTurnError as e:
            pytest.fail(f"a casting turn was refused because background writes moved the beatSeq the page was never told about: {e}")
        assert isinstance(d.get("beatSeq"), int) and d["beatSeq"] > seen, f"the ack hands the page the current beatSeq: {d}"
        ws.send(json.dumps({"t": "subscribe", "ch": "chat", "cid": "s0", "d": {"fromSeq": 0}}))
        _await_reply(ws, "s0", deadline, "subscribe")
        text = ""
        while True:
            f = _recv(ws, deadline)
            if f.get("t") != "event" or f.get("ch") != "chat":
                continue
            ev = f.get("d") or {}
            if ev.get("delta") and not ev.get("thinking"):
                text += ev["delta"]
            if ev.get("done"):
                break
        assert len(STUB.requests) > before and reply in text, "the admitted turn reached the narrator and its reply came back"


def test_the_same_turn_sent_twice_runs_once(_casting_stack):
    """Idempotent by clientMsgId: a client retry or an old client's double send of an admitted turn is acked again and never starts a second run."""
    from websockets.sync.client import connect
    stack = _casting_stack
    sid = _session(stack, "o941-dup")
    STUB.script.append({"deltas": ["Only once, o941."], "delay": 0.3})
    deadline = time.time() + 120
    cmid = f"o941dup_{int(time.time() * 1000)}"
    with connect(_ws_url(stack["fe"]), open_timeout=30, max_size=None) as ws, _Churn(stack):
        seen = _hello(ws, sid, deadline).get("beatSeq")
        before = len(STUB.requests)
        _turn(ws, "t0", "My name is the player.", cmid, seen)
        first = _await_reply(ws, "t0", deadline, "turn")
        _turn(ws, "t1", "My name is the player.", cmid, seen)
        again = _await_reply(ws, "t1", deadline, "turn")
        assert first.get("accepted") is True and not first.get("duplicate")
        assert again.get("accepted") is True and again.get("duplicate") is True, f"the repeat is acked as a duplicate: {again}"
    time.sleep(3)
    streamed = [r for r in STUB.requests[before:] if r.get("stream") and r.get("tools")]
    assert len(streamed) == 1, f"one narrator run for one clientMsgId, saw {len(streamed)}"


def _fe_log(stack):
    port = stack["fe"].rsplit(":", 1)[1].strip("/")
    try:
        return open(f"/tmp/m03-fe-{port}.log", encoding="utf-8", errors="replace").read()
    except OSError:
        return ""


@pytest.fixture()
def _game_stack():
    yield from _boot_stack()


def _await_state(ws, deadline, reason):
    while True:
        f = _recv(ws, deadline)
        if f.get("t") == "state" and (f.get("d") or {}).get("reason") == reason:
            return f.get("d") or {}


def test_a_stale_decision_is_refused_and_logged_then_recovers_with_the_refreshed_beat(_game_stack):
    """The closed-set CAS stays for decisions (0065): a decision whose token went stale under background writes is refused before any write - answered with the CON-4 reconcile
    (a `state` edge carrying the current beatSeq), now with a metadata log line - and a resend with that beatSeq is not refused as stale."""
    from websockets.sync.client import connect
    stack = _game_stack
    sid = _session(stack, "o941-decision")
    deadline = time.time() + 90
    with connect(_ws_url(stack["fe"]), open_timeout=30, max_size=None) as ws:
        seen = _hello(ws, sid, deadline).get("beatSeq")
        with _Churn(stack, "noteMessage"):
            pass
        ws.send(json.dumps({"t": "decision", "ch": "chat", "cid": "d0", "d": {"kind": "nominations", "choice": ["npc:1", "npc:2"], "expectedBeatSeq": seen}}))
        fresh = _await_state(ws, deadline, "decision-reconciled").get("beatSeq")
        assert isinstance(fresh, int) and fresh > seen, f"the stale decision was refused and the page handed the current beatSeq: {fresh} vs {seen}"
        ws.send(json.dumps({"t": "decision", "ch": "chat", "cid": "d1", "d": {"kind": "nominations", "choice": ["npc:1", "npc:2"], "expectedBeatSeq": fresh}}))
        got = None
        while got is None:
            f = _recv(ws, deadline)
            if f.get("cid") == "d1" and f.get("t") in ("ack", "error"):
                got = f
            elif f.get("t") == "state" and (f.get("d") or {}).get("reason") == "decision-reconciled":
                got = {"t": "error", "d": {"code": "stale-beat"}}
        assert (got.get("d") or {}).get("code") != "stale-beat", f"the refreshed resend is judged on its merits, not refused as stale: {got}"
    time.sleep(0.5)
    log = _fe_log(stack)
    assert "[ws] refused frame=decision cid=d0 code=stale-beat" in log and f"expectedBeatSeq={seen}" in log, "every refusal is logged once, with the frame, the id and the beats"
