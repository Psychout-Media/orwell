"""ORW-771 (owner-ruled), real stack: a Continue press through the eviction VOTE gets a short narrated beat, sealed like the real show.

Real engine (dist/main.js) + the real FE (the real /api/orwell/ceremony-continue route, the real chat turn over the socket) + a scripted fake narrator. A seeded season is driven by the
engine's own advance/decision calls to an eviction BALLOT step; then the press is made exactly as the Continue button makes it. Pins, in order:
 1. the press response carries the sealed `eviction.voteBeat` and the server ARMS the hidden beat cue (the page sends it; the cue text is read out of orwellDecision.js so the two cannot drift);
 2. the cue turn is a narrated beat: the narrator is handed the VOTE BEAT facts (a walker into the Diary Room, the room), a narrated assistant message is saved, and a SECOND window subscribed
    afterwards receives the same beat (the mirror);
 3. the cue is a progress press, NOT a player message: it adds NO clock (the ORW-262 budget stays; one message-step per player message, noteMessage) and moves no engine step, while the same cue
    typed with no press armed is an ordinary 5-minute message;
 4. E12: nothing in the beat block names a ballot (no vote target, count or voter's choice).
Roles only. Needs the built engine bundle (skips cleanly without it); browser lane = serial like the other real-stack pins."""
from __future__ import annotations

import json
import os
import re
import time
import urllib.request

import pytest

from _a64_walk import _decide, _roles
from _ws_turn_driver import WsTurnError, _await_reply, _recv, _ws_url, ws_turn
from test_m0_3_midgen_join import STUB, _boot_stack, _post_json  # noqa: F401
from test_p0h_day1_clock_e2e import _engine, _send, _session

pytestmark = pytest.mark.browser

SEEDS = (1, 2, 3)
_JS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js", "orwellDecision.js")
NARRATED = "The Diary Room door swings and settles; the room breathes out and waits."


def _cue_text() -> str:
    """The exact cue the page sends, read out of orwellDecision.js (so the JS and the server cannot drift)."""
    m = re.search(r'const VOTE_BEAT_CUE = "(.*)";', open(_JS, encoding="utf-8").read())
    assert m, "VOTE_BEAT_CUE constant not found in orwellDecision.js"
    return json.loads('"' + m.group(1) + '"')


@pytest.fixture(scope="module")
def _stack():
    yield from _boot_stack()


def _press(stack):
    """The Continue button: a bare POST to the real FE route."""
    req = urllib.request.Request(stack["fe"] + "/api/orwell/ceremony-continue", data=b"", method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def _tick(stack, k):
    """One player-message tick as the page announces it (the engine's own `noteMessage`, 5 in-game minutes each)."""
    _engine(stack, "noteMessage", {"messageId": f"o771-t{k}"})


def _to_eviction_ballots(stack):
    """Drive a season with the engine's own calls (the clock ticks as the page announces messages) until an eviction BALLOT watch step is open: the page's Continue card. Returns None as soon as
    this season is ruled out: a player who votes has no Continue card after their own card (the ballots then run on their next message), so only a player on the block (or the HOH) walks the
    ballots by Continue."""
    k = 0
    for _ in range(4000):
        k += 1
        st = _engine(stack, "getGameState")
        p = _engine(stack, "gameStatus").get("pending") or st.get("pending") or {}   # the status read is what the page's Continue card follows
        cer = p.get("ceremony") or {}
        if p.get("kind") == "ceremony-step" and cer.get("kind") == "eviction" and cer.get("stepId") == "ballot":
            return p
        r = _roles(st)
        if p.get("kind") == "eviction-vote" or r["out"]:
            print("WHY-A", k, p.get("kind"), r)
            return None
        if r["nominees"] and r["me"] not in r["nominees"] and r["me"] != r["hoh"]:
            print("WHY-B", k, r)
            return None
        if p:
            _decide(stack, p)
            continue
        if (_engine(stack, "premiereIntros") or {}).get("entrance", {}).get("stage") not in (None, "done"):
            _engine(stack, "advanceGame", {})
            continue
        if st.get("timeOfDay") in ("night", "late-night"):
            _engine(stack, "turnIn")
            _tick(stack, k)   # the first message after a turn-in is the wake itself
            continue
        sched = st.get("daySchedule")
        if isinstance(sched, dict) and sched.get("due"):
            _engine(stack, "advanceGame", {})
            continue
        _tick(stack, k)
    print("WHY-C exhausted", st.get("phase"), st.get("timeOfDay"), st.get("daySchedule"), p)
    return None


def _second_window(stack, session, secs=20):
    """A second window: its own socket, hello + subscribe from seq 0; returns the text of every non-thinking delta replayed to it."""
    from websockets.sync.client import connect
    deadline = time.time() + secs
    text = ""
    with connect(_ws_url(stack["fe"]), open_timeout=30, max_size=None) as ws:
        ws.send(json.dumps({"t": "hello", "cid": "h1", "d": {"perTabId": session, "protocol": 1}}))
        _await_reply(ws, "h1", deadline, "hello")
        ws.send(json.dumps({"t": "subscribe", "ch": "chat", "cid": "s1", "d": {"fromSeq": 0}}))
        _await_reply(ws, "s1", deadline, "subscribe")
        try:
            while True:
                f = _recv(ws, deadline)
                d = f.get("d") or {}
                if f.get("t") == "event" and f.get("ch") == "chat":
                    if d.get("delta") and not d.get("thinking"):
                        text += d["delta"]
                    if d.get("done"):
                        break
        except WsTurnError:
            pass
    return text


def test_a_press_through_the_vote_gets_a_sealed_narrated_beat_that_costs_no_clock_and_mirrors(_stack):  # noqa: F811
    for seed in SEEDS:   # a restart on one stack carries earlier seasons' names (NAME-1), so a seed can land on another path: walk the list, take the first season whose ballots are Continue-pressed
        r = _post_json(_stack["fe"], "/api/orwell/new-game", {"playerName": "P", "confirm": True, "seed": seed}, timeout=120)
        assert r.get("started"), r
        sid = _session(_stack, f"orw771-{seed}")
        _send(_stack, sid, "Hello house, settling in.", f"orw771-first-{seed}")   # the first message starts the clock (through the real chat route)
        if _to_eviction_ballots(_stack):
            break
    else:
        pytest.fail(f"no pinned season opened an eviction ballot watch step for a player on the block (re-pick SEEDS {SEEDS})")
    # the page's own fetch: the real route
    res = _press(_stack)
    if not res.get("voteBeatCue"):   # the engine refused the first press as stale (this test drove the engine directly): the server armed nothing, the page re-presses
        res = _press(_stack)
    assert res.get("voteBeatCue") is True, f"the press arms the cue: {json.dumps(res)[:300]}"
    beat = (res.get("eviction") or {}).get("voteBeat")
    assert beat and beat["sealed"] is True and beat["press"] >= 1, f"the press carries the sealed vote beat fact: {json.dumps(res)[:400]}"
    assert beat.get("intoDiaryRoom"), f"a houseguest walks into the Diary Room this press: {beat}"
    # no ballot content in the fact: only the public room facts
    assert set(beat) <= {"sealed", "press", "of", "intoDiaryRoom", "backFromDiaryRoom", "tallyRead", "gathered", "timeOfDay", "nominees"}, beat

    clock_before = _engine(_stack, "getGameState").get("clockLabel")
    assert clock_before, "the clock is live"
    engine_before = _engine(_stack, "getGameState")
    with STUB.lock:
        STUB.script.append({"deltas": [NARRATED], "delay": 0})
        n_req = len(STUB.requests)
    out = ws_turn(_stack["fe"], sid, _cue_text(), timeout=120, client_msg_id="orw771-cue")
    assert NARRATED in out["text"], f"the cue turn streamed the narrated beat: {out['text'][:300]!r}"
    assert out["saved"], "the narrated beat is saved as an assistant message"
    # the narrator was handed the facts (and only facts)
    with STUB.lock:
        mine = [r for r in STUB.requests[n_req:] if r.get("stream") and r.get("tools")]
    prompt = json.dumps(mine[-1].get("messages") or [])
    assert "VOTE BEAT" in prompt, "the narrator is handed the vote beat facts"
    assert beat["intoDiaryRoom"]["name"] in prompt
    block = prompt.split("VOTE BEAT", 1)[1][:1200]
    assert not re.search(r"votedFor|voted for|the count is|\d+ (votes|ballots) to", block, re.I), f"E12: the beat block names no ballot: {block}"
    # a progress press, not a player message: no clock, no engine step
    clock_after = _engine(_stack, "getGameState").get("clockLabel")
    assert clock_after == clock_before, f"the beat turn bills no clock: {clock_before} -> {clock_after}"
    engine_after = _engine(_stack, "getGameState")
    assert (engine_after.get("pending") or {}).get("ceremony") == (engine_before.get("pending") or {}).get("ceremony"), "the beat turn moves no ceremony step"
    # the mirror: a second window replays the same beat
    assert NARRATED in _second_window(_stack, sid), "the second window receives the beat bubble"
    # control: the SAME cue typed with no press armed is an ordinary message (5 in-game minutes)
    with STUB.lock:
        STUB.script.append({"deltas": ["An ordinary reply."], "delay": 0})
    ws_turn(_stack["fe"], sid, _cue_text(), timeout=120, client_msg_id="orw771-typed")
    clock_typed = _engine(_stack, "getGameState").get("clockLabel")
    assert clock_typed != clock_after, f"an unarmed typed copy is an ordinary message and moves the clock: {clock_after} -> {clock_typed}"
