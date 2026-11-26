"""ORW-815 (remainder of ORW-784 item 3): the eviction night is walked reveal -> result in one pre-resolve pass, but the committed result (who left, and the house's count)
was never registered for the unvoiced-ceremony belt, so a reply that skipped it went unchecked. Real path: the stub engine commits the beats, the narrator's reply omits them, the post-turn check
must queue a re-ground that names the evictee and the count. Roles only."""
import asyncio
import importlib

import pytest

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")
oe = importlib.import_module("src.orwell_engine")

USER = "u815"
EVICTEE = "Role Bravo"
START = {"phase": "eviction", "moment": "eviction", "week": 1, "started": True, "pending": None}


SIG = {"week": 1, "phase": "eviction", "pending": None, "evicted": 1, "evictedNames": [EVICTEE], "nomNames": [EVICTEE, "Role Alpha"], "ballotCounts": [10, 3], "evictionEvictee": EVICTEE}


def _run(c):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(c)
    finally:
        loop.close()
        asyncio.set_event_loop(asyncio.new_event_loop())


@pytest.fixture(autouse=True)
def _clean():
    def wipe():
        ch.clear_social_runway(USER); ch.clear_preresolve_debt(USER)
        ch._PRE_RESOLVED_ADVANCE.pop(USER, None); ch._CEREMONY_UNVOICED.pop(ch._desync_key(USER), None); ch._DESYNC_REGROUND.pop(USER, None)
        ch._LAST_BEAT_SIG.pop(USER, None)
    wipe()
    yield
    wipe()


def _wire(monkeypatch):
    beats = [
        {"event": {"beat": "eviction-reveal", "content": "the ballots are read", "participants": []}, "announcements": []},
        {"event": {"beat": "eviction-result", "content": f"{EVICTEE} leaves the house", "participants": [{"name": EVICTEE}]},
         "announcements": [{"id": "ann:ev", "kind": "eviction-result", "week": 1, "beatSeq": 9, "subjects": [],
                            "headline": f"By a vote of 10 to 3, {EVICTEE} has been evicted from the house."}]},
    ]
    calls = []

    async def status(user=None):
        return {"phase": "eviction", "pending": None}

    async def advance(expected_beat_seq=None, idempotency_key=None, user=None):
        calls.append(1)
        return beats[len(calls) - 1]

    async def state(user=None, **kw):
        return dict(START)

    async def capture(user=None):
        return dict(SIG)
    monkeypatch.setattr(oe, "game_status", status)
    monkeypatch.setattr(oe, "advance_game", advance)
    monkeypatch.setattr(oe, "get_game_state", state)
    monkeypatch.setattr(ch, "_capture_beat_signature", capture)
    return calls


def _drive(monkeypatch, reply):
    calls = _wire(monkeypatch)
    _run(ch._pre_resolve_npc_ceremony(USER, dict(START), retry=False, player_msg="go"))
    assert len(calls) == 2, "reveal and result are both walked in the one pass"
    ch._LAST_BEAT_SIG[USER] = dict(SIG)
    _run(ch.record_post_turn_desync_check(USER, reply))


def test_a_reply_that_skips_the_eviction_result_is_regrounded_with_the_evictee_and_count(monkeypatch):
    _drive(monkeypatch, "The room holds its breath while the host shuffles the cards and the lights dim over the couch.")
    d = ch._DESYNC_REGROUND.get(USER) or ""
    assert "RE-GROUND ON THE CEREMONY" in d and EVICTEE in d


def test_a_reply_that_names_the_evictee_but_never_the_count_is_regrounded_for_the_count(monkeypatch):
    _drive(monkeypatch, f"The host turns to the cameras. {EVICTEE} is evicted, and the house falls silent.")
    d = ch._DESYNC_REGROUND.get(USER) or ""
    assert "count" in d and "10 to 3" in d


def test_a_reply_with_the_result_and_count_queues_nothing(monkeypatch):
    _drive(monkeypatch, f"Ten to evict {EVICTEE}, three to keep. {EVICTEE} is evicted from the house.")
    assert USER not in ch._DESYNC_REGROUND
