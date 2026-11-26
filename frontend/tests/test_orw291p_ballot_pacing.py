"""ORW-291 pacing, AMENDED by ORW-846 (coordinator ruling 11-23): a played eviction reads ONE anonymized ballot per engine step (13 voters => ~16 steps). A bare "next"/"continue" at a
BALLOT step now advances exactly ONE ballot, the same step the Continue press takes (play by play; every step is told; the clock budget stays). Only an explicit fast-forward ("skip to the result",
"just tell me who's out") walks all the remaining ballots in one pass, stopping at the result (which keeps its own stop); a message that carries real talk gets a normal turn and walks nothing.
The old ORW-291 tests that pinned "a bare next walks the ballots" were rewritten to the new ruling. Fakes only, no model. Roles only."""
import asyncio
import importlib

import pytest

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")
oe = importlib.import_module("src.orwell_engine")

VOTERS = 13


def _run(c):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(c)
    finally:
        loop.close()
        asyncio.set_event_loop(asyncio.new_event_loop())


class FakeEviction:
    """Engine stand-in: steps = speeches, N ballots, result. The open step is the pending `ceremony-step`; advanceGame opens the next one (None past the result)."""

    def __init__(self, n=VOTERS, at=1):
        self.steps = ["speeches"] + ["ballot"] * n + ["result"]
        self.at = at
        self.advances = 0

    def pending(self):
        if self.at >= len(self.steps):
            return None
        sid = self.steps[self.at]
        return {"kind": "ceremony-step", "text": f"line for {sid}", "binding": False,
                "ceremony": {"kind": "eviction", "step": self.at + 1, "of": len(self.steps), "stepId": sid}}

    def view(self):
        return {"phase": "eviction", "moment": "eviction", "week": 3, "started": True, "pending": self.pending(), "beatSeq": 10 + self.advances}


@pytest.fixture
def eng(monkeypatch):
    ch.clear_social_runway("u"); ch.clear_preresolve_debt("u"); ch._PRE_RESOLVED_ADVANCE.pop("u", None); ch._SCHEDULE_STEER.pop(ch._runway_key("u"), None)
    f = FakeEviction()

    async def status(user=None):
        return f.view()

    async def state(user=None, **kw):
        return f.view()

    async def advance(expected_beat_seq=None, idempotency_key=None, user=None):
        f.advances += 1
        f.at += 1
        sid = f.steps[f.at] if f.at < len(f.steps) else None
        beat = {"ballot": "eviction-reveal", "result": "eviction"}.get(sid, "ceremony-step")
        out = f.view()
        out["event"] = {"beat": beat, "content": "a vote to evict the nominee" if sid == "ballot" else "the nominee is evicted"}
        out["announcements"] = []
        return out

    monkeypatch.setattr(oe, "game_status", status)
    monkeypatch.setattr(oe, "get_game_state", state)
    monkeypatch.setattr(oe, "advance_game", advance)
    yield f
    ch.clear_social_runway("u"); ch.clear_preresolve_debt("u"); ch._PRE_RESOLVED_ADVANCE.pop("u", None); ch._SCHEDULE_STEER.pop(ch._runway_key("u"), None)


def _messages_to_result(f, msg="next", cap=60):
    n = 0
    while n < cap and f.pending() and f.pending()["ceremony"]["stepId"] != "result":
        n += 1
        _run(ch._pre_resolve_npc_ceremony("u", f.view(), retry=False, player_msg=msg))
    return n


def test_bare_next_reads_exactly_one_ballot(eng):
    _run(ch._pre_resolve_npc_ceremony("u", eng.view(), retry=False, player_msg="next"))
    assert eng.advances == 1 and eng.pending()["ceremony"]["stepId"] == "ballot" and eng.at == 2


def test_each_bare_next_is_one_ballot_all_the_way_to_the_result(eng):
    n = _messages_to_result(eng)
    assert n == VOTERS and eng.advances == VOTERS and eng.pending()["ceremony"]["stepId"] == "result"  # one message per ballot, none skipped


@pytest.mark.parametrize("msg", ["skip to the result", "just tell me who's out", "fast forward", "skip the votes"])
def test_explicit_fast_forward_walks_all_remaining_ballots(eng, msg):
    n = _messages_to_result(eng, msg=msg)
    assert n == 1 and eng.advances == VOTERS and eng.pending()["ceremony"]["stepId"] == "result"


@pytest.mark.parametrize("msg", ["next", "continue", "ok, go on", "who is going to be out?", "I want to skip to the result, but first let me whisper to Sam about it all tonight",
                                 "just tell me who's out?"])
def test_non_fast_forward_phrasings_are_not_classified_as_fast_forward(msg):
    assert not ch._is_ballot_fast_forward(msg)


def test_result_keeps_its_own_stop(eng):
    _messages_to_result(eng)
    before = eng.advances
    _run(ch._pre_resolve_npc_ceremony("u", eng.view(), retry=False, player_msg="next"))
    assert eng.advances == before + 1  # ORW-297: the result is its own stop, then ONE typed 'next' closes it (never two steps)


def test_speeches_step_is_never_walked(eng):
    eng.at = 0
    _run(ch._pre_resolve_npc_ceremony("u", eng.view(), retry=False, player_msg="next"))
    assert eng.advances == 1 and eng.pending()["ceremony"]["stepId"] == "ballot"  # ORW-297: one step only - the speeches never fold the ballots into the same message


@pytest.mark.parametrize("msg", ["I whisper to Sam that I am worried about tonight, what do you think he will do?", "hang on, let me talk to the HOH first"])
def test_talk_does_not_skip_steps(eng, msg):
    _run(ch._pre_resolve_npc_ceremony("u", eng.view(), retry=False, player_msg=msg))
    assert eng.advances == 0 and eng.pending()["ceremony"]["stepId"] == "ballot"


def test_walk_is_bounded_and_steer_is_anonymous(eng):
    eng.steps = ["speeches"] + ["ballot"] * 40 + ["result"]
    _run(ch._pre_resolve_npc_ceremony("u", eng.view(), retry=False, player_msg="skip to the result"))
    assert eng.advances == ch._EVICTION_BALLOT_HOPS  # capped, the rest waits for the next message
    steer = ch._SCHEDULE_STEER.get(ch._runway_key("u"), "")
    assert "a vote to evict the nominee" in steer
    for forbidden in ("voted by", "Voter-", "npc:"):
        assert forbidden not in steer


# ---------------- ORW-297: a typed 'next' on ANY ceremony watch step moves exactly one step ----------------
KINDS = [("nominations", "convene"), ("veto-draw", "chips"), ("veto-ceremony", "convene"), ("eviction", "speeches"), ("eviction", "result")]


class FakeCeremony:
    def __init__(self, kind, step, binding_next=False):
        self.kind, self.advances = kind, 0
        self.steps = ["convene", "chips", "speeches", "result", "tail"]
        self.at = self.steps.index(step)

    def pending(self):
        if self.at >= len(self.steps):
            return None
        return {"kind": "ceremony-step", "text": f"public line {self.steps[self.at]}", "binding": False,
                "ceremony": {"kind": self.kind, "step": self.at + 1, "of": len(self.steps), "stepId": self.steps[self.at]}}

    def view(self, phase):
        return {"phase": phase, "moment": phase, "week": 2, "started": True, "pending": self.pending(), "beatSeq": 5 + self.advances}


@pytest.fixture
def cer(monkeypatch):
    def make(kind, step):
        f = FakeCeremony(kind, step)
        phase = {"nominations": "nominations", "veto-draw": "veto-competition", "veto-ceremony": "veto-ceremony", "eviction": "eviction"}[kind]
        ch.clear_social_runway("u"); ch._PRE_RESOLVED_ADVANCE.pop("u", None); ch._SCHEDULE_STEER.pop(ch._runway_key("u"), None)

        async def status(user=None):
            return f.view(phase)

        async def advance(expected_beat_seq=None, idempotency_key=None, user=None):
            f.advances += 1; f.at += 1
            out = f.view(phase); out["event"] = {"beat": "ceremony-step", "content": "a step"}; out["announcements"] = []
            return out

        monkeypatch.setattr(oe, "game_status", status); monkeypatch.setattr(oe, "get_game_state", lambda user=None, **kw: _co(f.view(phase)))
        monkeypatch.setattr(oe, "advance_game", advance)
        return f, phase
    yield make
    ch.clear_social_runway("u"); ch._PRE_RESOLVED_ADVANCE.pop("u", None); ch._SCHEDULE_STEER.pop(ch._runway_key("u"), None)


async def _co(v):
    return v


@pytest.mark.parametrize("kind,step", KINDS)
@pytest.mark.parametrize("msg", ["next", "ok, go on"])
def test_typed_next_advances_exactly_one_step(cer, kind, step, msg):
    f, phase = cer(kind, step)
    out = _run(ch._pre_resolve_npc_ceremony("u", f.view(phase), retry=False, player_msg=msg))
    assert f.advances == 1
    steer = ch._SCHEDULE_STEER.get(ch._runway_key("u"), "")
    assert "public line" in steer or "a step" in steer
    assert isinstance(out, dict)


@pytest.mark.parametrize("kind,step", KINDS)
def test_talk_during_a_step_is_a_normal_turn_and_does_not_advance(cer, kind, step):
    f, phase = cer(kind, step)
    gs = f.view(phase)
    out = _run(ch._pre_resolve_npc_ceremony("u", gs, retry=False, player_msg="Wait, I want to ask Sam why he looked at me like that before we go on."))
    # not swallowed: pre-resolve hands the SAME board back so the turn goes on to the narrator, whose framing carries the WATCH-step directive; nothing advanced
    assert f.advances == 0 and out is gs
    assert ch._pending_barrier_directive(gs["pending"])


def test_binding_pending_is_never_advanced_by_next(monkeypatch):
    calls = []

    async def status(user=None):
        return {"phase": "nominations", "pending": {"kind": "nominations", "options": []}}

    async def advance(**kw):
        calls.append(1)
        return {}

    monkeypatch.setattr(oe, "game_status", status); monkeypatch.setattr(oe, "advance_game", advance)
    gs = {"phase": "nominations", "moment": "nominations", "week": 1, "started": True, "pending": {"kind": "nominations"}}
    out = _run(ch._pre_resolve_npc_ceremony("u", gs, retry=False, player_msg="next"))
    assert not calls and out is gs
