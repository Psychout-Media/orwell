"""ORW-265 — the runtime overseer's two promises, proven by behaviour (features 0079/0080).

(1) "Same seed => identical state, overseer available or not." The overseer lives in the front end
    and can only change the game by pulling a deterministic lever. So the promise reduces to: a
    turn with no symptom wakes nothing and pulls nothing, and a model that is absent / errors /
    answers garbage yields exactly the deterministic heuristic verdict (the floor). A scripted
    engine whose state is a pure function of the calls it receives is driven twice (overseer
    absent vs. present) and must end byte-identical.

(2) "The overseer never overrides a refused commit." When the engine refuses (a typed
    EngineToolError, the fail-closed checkpoint), the overseer's lever reports not-applied, makes
    exactly ONE attempt (no retry, no second lever, no escalation chain), and the engine's
    persisted state is untouched.

Deterministic, no model calls, roles only.
"""
import os
import sys

_FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _FRONTEND not in sys.path:
    sys.path.insert(0, _FRONTEND)

from src.orwell_engine import EngineToolError  # noqa: E402
from src.overseer import (  # noqa: E402
    LEVERS,
    DeterministicOverseer,
    LlmOverseer,
    Signals,
    Verdict,
    dispatch_lever,
    should_assess,
)

# A scripted run of per-turn telemetry. Healthy turns carry no symptom.
_HEALTHY = [
    Signals(),
    Signals(engaged_scene=True, recorded_interaction=True),
    Signals(in_advance_phase=True, play_quiet=False, progression_tool_called=True,
            beat_seq_before=3, beat_seq_after=4),
    Signals(tool_skip_streak=2),
]
_SYMPTOMATIC = [
    Signals(engaged_scene=True, recorded_interaction=False),
    Signals(desync=True),
    Signals(io_error=True),
    Signals(in_advance_phase=True, play_quiet=True),
    Signals(tool_skip_streak=3),
]


class _ScriptedEngine:
    """State is a pure function of the ordered calls received (a stand-in for a seeded engine)."""

    def __init__(self, seed):
        self.state = seed
        self.calls = []
        self.refuse = False
        self.persisted = seed

    def call(self, name):
        self.calls.append(name)
        if self.refuse:
            raise EngineToolError("commit refused: integrity checkpoint", status=409,
                                  code="commit-refused")
        self.state = (self.state * 31 + sum(map(ord, name))) % 1_000_003
        self.persisted = self.state
        return True


def _actions(engine):
    return {lever: (lambda lever=lever: engine.call(lever)) for lever in LEVERS}


def _play(engine, turns, overseer):
    for sig in turns:
        engine.call("player-turn")
        if overseer is None:
            continue
        verdict = overseer.assess(sig)
        if verdict is not None:
            dispatch_lever(verdict, _actions(engine))
    return engine


# ── (1) same seed, overseer present vs absent ───────────────────────────────────────

def test_healthy_turns_wake_nothing_and_leave_state_identical():
    assert not any(should_assess(s) for s in _HEALTHY)
    absent = _play(_ScriptedEngine(7), _HEALTHY, None)
    present = _play(_ScriptedEngine(7), _HEALTHY, DeterministicOverseer())
    assert present.calls == absent.calls
    assert present.state == absent.state


def test_a_failing_or_garbage_model_gives_exactly_the_deterministic_verdict():
    def boom(_prompt):
        raise TimeoutError("model timed out")

    for bad_fn in (boom, lambda _p: "not json", lambda _p: '{"level":"action","lever":"rewrite-outcome",'
                   '"kind":"x","diagnosis":"y"}'):
        llm, floor = LlmOverseer(bad_fn), DeterministicOverseer()
        for sig in _SYMPTOMATIC:
            assert llm.assess(sig) == floor.assess(sig)
        for sig in _HEALTHY:
            assert llm.assess(sig) is None


def test_model_down_run_matches_deterministic_run_byte_for_byte():
    def boom(_prompt):
        raise ConnectionError("no model")

    turns = _HEALTHY + _SYMPTOMATIC
    a = _play(_ScriptedEngine(11), turns, DeterministicOverseer())
    b = _play(_ScriptedEngine(11), turns, LlmOverseer(boom))
    assert a.calls == b.calls and a.state == b.state


# ── (2) a refused commit is never overridden ───────────────────────────────────────

def test_refused_commit_is_one_attempt_not_applied_and_save_untouched():
    for lever in [l for l in LEVERS if l != "hold"]:
        engine = _ScriptedEngine(5)
        engine.call("player-turn")
        before_state, before_persisted = engine.state, engine.persisted
        engine.refuse = True
        engine.calls.clear()
        out = dispatch_lever(Verdict("action", "probe", "probe", lever), _actions(engine))
        assert out["applied"] is False, lever
        assert engine.calls == [lever], (lever, engine.calls)  # one attempt: no retry, no chain
        assert (engine.state, engine.persisted) == (before_state, before_persisted)


def test_a_declined_commit_is_not_retried():
    """The engine answering 'no' without raising (a falsy result) is also final: one attempt."""
    for lever in [l for l in LEVERS if l != "hold"]:
        calls = []
        out = dispatch_lever(Verdict("action", "probe", "probe", lever),
                             {lever: lambda: calls.append(lever) and False})
        assert out["applied"] is False and calls == [lever], lever


def test_refused_commit_on_a_symptom_turn_never_escalates_into_another_lever():
    engine = _ScriptedEngine(5)
    engine.refuse = True
    verdict = DeterministicOverseer().assess(Signals(in_advance_phase=True, play_quiet=True))
    out = dispatch_lever(verdict, _actions(engine))
    assert out["applied"] is False
    assert engine.calls == [verdict.lever]
    assert engine.persisted == 5
