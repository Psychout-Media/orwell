"""ORW-717 (bare-refusal half): a refusal-only line never reaches the player as narration.
Real `stream_agent_loop`, stubbed narrator rounds (the test_orw408 harness), roles only."""
import importlib

import pytest

pytestmark = [pytest.mark.usefixtures("non_game_text_routing"), pytest.mark.usefixtures("zero_clocks_off")]

t408 = importlib.import_module("test_orw408_sentence_rewrite")
ledger = importlib.import_module("src.orwell_sync_ledger")
rg = importlib.import_module("src.refusal_guard")

REFUSAL = "I'm sorry, but I can't continue in this direction."
SCENE = "The kitchen is quiet. Rain taps the glass. A cup is set down."
CALLS = [{"name": "advanceGame", "arguments": "{}"}]
OWNER = "orw717"


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.setenv("ORWELL_PREDISPLAY_REWRITE", "0")
    monkeypatch.delenv("ORWELL_REFUSAL_GUARD", raising=False)
    ledger._PENDING_BELTS.clear()
    yield
    ledger._PENDING_BELTS.clear()


def _run(monkeypatch, scripts, extra=None):
    return t408._drive(monkeypatch, rounds_scripts=scripts, state={"asleep": []}, owner=OWNER, extra=extra)


def test_refusal_next_to_a_tool_call_is_withheld_and_the_next_round_scene_shows(monkeypatch):
    extra = {}
    emitted, _c, stored, n = _run(monkeypatch, [{"deltas": [REFUSAL], "calls": CALLS}, {"deltas": [SCENE]}], extra)
    assert "sorry" not in emitted.lower() and "can't continue" not in emitted
    assert SCENE in emitted
    assert extra["runs"] == ["advanceGame"] and n == 2
    assert all("sorry" not in s.lower() for s in stored), stored
    assert ledger.get_belt_totals(OWNER).get("refusal-withheld") == 1


def test_a_refusal_only_final_round_is_withheld_retried_once_and_the_retry_scene_shows(monkeypatch):
    emitted, _c, _s, n = _run(monkeypatch, [{"deltas": [REFUSAL]}, {"deltas": [SCENE]}])
    assert "sorry" not in emitted.lower()
    assert SCENE in emitted and n == 2


def test_a_second_refusal_falls_back_without_showing_it(monkeypatch):
    emitted, _c, _s, n = _run(monkeypatch, [{"deltas": [REFUSAL]}, {"deltas": [REFUSAL]}])
    assert "sorry" not in emitted.lower() and "can't continue" not in emitted
    assert emitted.strip(), "the existing blank-turn fallback speaks instead"
    assert n == 2, "exactly one retry"


class _SpyMP:
    """Proxies the real `monkeypatch` fixture, wrapping the stubbed wire to record each round's messages."""

    def __init__(self, mp, seen):
        self._mp, self._seen = mp, seen

    def setattr(self, obj, name, val=None, *a, **k):
        if name == "stream_llm_with_fallback":
            inner = val

            async def wrapped(cands, messages, **kw):
                self._seen.append([str(m.get("content")) for m in messages])
                async for x in inner(cands, messages, **kw):
                    yield x
            val = wrapped
        return self._mp.setattr(obj, name, val, *a, **k)

    def __getattr__(self, n):
        return getattr(self._mp, n)


def test_the_retry_carries_one_fact_and_no_refusal_text(monkeypatch):
    seen = []
    t408._drive(_SpyMP(monkeypatch, seen), rounds_scripts=[{"deltas": [REFUSAL]}, {"deltas": [SCENE]}], state={"asleep": []}, owner=OWNER)
    assert len(seen) == 2
    retry = "\n".join(seen[1])
    assert "produced no scene" in retry
    assert "I'm sorry" not in retry


@pytest.mark.parametrize("scene", [
    '"I\'m sorry, I can\'t help you with that," she says, wiping the counter. ',
    "She says she is sorry she can't continue the argument, and walks out. ",
    "I can't help but smile as the door swings open and the whole house turns to look. ",
    "The houseguest sighs. I'm sorry, but I can't continue in this direction, he says, then drops the whole bluff and tells the room exactly what he saw last night in the yard. ",
])
def test_in_scene_apologies_and_longer_text_are_not_withheld(monkeypatch, scene):
    emitted, _c, _s, _n = _run(monkeypatch, [{"deltas": [scene], "calls": CALLS}, {"deltas": [SCENE]}])
    assert scene.strip()[:30] in emitted
    assert ledger.get_belt_totals(OWNER) == {}


def test_flag_off_shows_the_refusal_as_today(monkeypatch):
    monkeypatch.setenv("ORWELL_REFUSAL_GUARD", "0")
    emitted, _c, _s, _n = _run(monkeypatch, [{"deltas": [REFUSAL], "calls": CALLS}, {"deltas": [SCENE]}])
    assert REFUSAL in emitted
    assert ledger.get_belt_totals(OWNER) == {}


@pytest.mark.parametrize("s,expected", [
    ("I'm sorry, but I can't continue in this direction.", True),
    ("I cannot assist with this request.", True),
    ("Sorry, I won't proceed with that.", True),
    ("I am unable to continue.", True),
    ("I'm sorry about the mess.", False),
    ("I can't help but laugh.", False),
    ('"I can\'t continue," he says.', False),
    ("She cannot continue the game.", False),
    ("", False),
])
def test_detector_patterns(s, expected):
    assert rg.is_refusal_sentence(s) is expected
