"""ORW-1070 / ORW-1071 / ORW-1073: the confide, expose and trade extractors against a recorded regression set.

No live call: DeepSeek's replies were recorded (tests/fixtures/orw1070_extractor_cases.json) and are replayed
through the real belt code, so CI checks the code around the model: the prefilter (ORW-1071), the engine-fact
guards (ORW-1070) and the lever call. Refresh the recordings against dev with
`python3 frontend/scripts/orw1070_rerecord.py --yes-spend` (about 60 short calls). While a recording is older than
the prompt (prompt_sha differs) only the code-side floors apply; on a fresh recording the end-to-end floors apply too.
"""
import asyncio
import importlib
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _orw1070_replay as rp  # noqa: E402

al = importlib.import_module("src.agent_loop")
oe = importlib.import_module("src.orwell_engine")
sbg = importlib.import_module("src.secret_belt_gates")

FX = rp.load()
BELTS = ("confide", "expose", "trade")


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _replay(belt, monkeypatch, gated):
    house = rp.house_of(FX)
    got = []
    for case in FX["cases"][belt]:
        if gated and not rp.gate_pass(al, belt, case["u"], house):
            got.append(None)
            continue

        async def llm(messages, _raw=case["raw"]):
            return _raw

        levers, _ = _run(rp.run_case(al, oe, belt, case, FX, llm, monkeypatch))
        got.append(rp.outcome(belt, levers))
    return got


def _positives(belt):
    return [c for c in FX["cases"][belt] if c["expect"] is not None]


@pytest.mark.parametrize("belt", BELTS)
def test_the_widened_gate_admits_every_labelled_positive(belt):
    house = rp.house_of(FX)
    missed = [c["u"][:60] for c in _positives(belt) if not rp.gate_pass(al, belt, c["u"], house)]
    assert not missed, f"{belt}: the gate still drops true positives: {missed}"


@pytest.mark.parametrize("belt", BELTS)
def test_the_widened_gate_admits_more_than_the_regex_did(belt):
    house = rp.house_of(FX)
    old = sum(rp.gate_pass(al, belt, c["u"], house, regex_only=True) for c in _positives(belt))
    new = sum(rp.gate_pass(al, belt, c["u"], house) for c in _positives(belt))
    assert new > old and new == len(_positives(belt))


@pytest.mark.parametrize("belt", BELTS)
def test_pipeline_recall_holds_on_the_recorded_replies(belt, monkeypatch):
    got = _replay(belt, monkeypatch, gated=True)
    res = rp.score(belt, FX["cases"][belt], got)
    llm_only = FX["meta"]["a6_llm_only"][belt]["R"]
    # the pipeline may not lose positives the model alone found: recall is the model's, not the regex's
    assert res["R"] >= llm_only - 0.01, (belt, res)


def test_expose_does_not_spend_the_secret_on_a_private_line(monkeypatch):
    got = _replay("expose", monkeypatch, gated=True)
    cases = FX["cases"]["expose"]
    for case, g in zip(cases, got):
        if len(case["present"]) < 2:
            assert g is None, f"expose fired with one listener: {case['u'][:60]}"


def test_trade_is_refused_for_every_party_of_the_fact_and_for_a_listener_who_left(monkeypatch):
    got = _replay("trade", monkeypatch, gated=True)
    for case, g in zip(FX["cases"]["trade"], got):
        if "showmance" in case["n"] and "That's about me" in case["n"]:
            assert g is None  # Ruth is a party to Jonah and Ruth's secret
        if not case["present"]:
            assert g is None  # the listener walked off


@pytest.mark.parametrize("belt", BELTS)
def test_precision_does_not_regress_below_the_audit_numbers(belt, monkeypatch):
    got = _replay(belt, monkeypatch, gated=True)
    res = rp.score(belt, FX["cases"][belt], got)
    before = FX["meta"]["a6_llm_only"][belt]["P"]
    assert res["P"] >= before - 0.01, (belt, res, "audit LLM-only precision", before)


def test_prompts_name_the_not_an_act_classes(monkeypatch):
    want = {"expose": ("a threat or an ultimatum", "private aside", "an empty line", "nobody else hears"),
            "trade": ("walks away", "present and not a party", "stated ask"),
            "confide": ("interrogation", "accusation")}
    for belt, phrases in want.items():
        case = FX["cases"][belt][0]
        seen = []

        async def llm(messages, _raw=case["raw"]):
            seen.append(messages)
            return _raw

        _run(rp.run_case(al, oe, belt, case, FX, llm, monkeypatch))
        text = " ".join(seen[0][0]["content"].split())
        for ph in phrases:
            assert ph in text, (belt, ph)


def test_a_turn_neither_signal_admits_is_counted_and_sampled():
    sbg.reset_stats()
    house = rp.house_of(FX)
    assert sbg.gate("expose", False, 0, "Nice weather today, huh.", house) is False
    st = sbg.stats()
    assert st["skips"]["expose"] == 1 and st["ring"]["expose"]
    assert sbg.gate("expose", False, 0, "Everyone, Maeve is hiding a thing in her bag today.", house) is True
    assert sbg.gate("expose", True, 1, "Everyone, Maeve is hiding a thing in her bag today.", house) is False  # per-turn cap


def test_a_fresh_recording_meets_the_end_to_end_floors(monkeypatch):
    """Only on a recording made with the current prompts (prompt_sha equal): precision at least 0.85 and recall at
    least 0.9 per extractor. Skipped while the recordings predate the prompts, because a recorded reply cannot
    show what a changed prompt does."""
    house = rp.house_of(FX)
    for belt in BELTS:
        case = FX["cases"][belt][0]
        seen = []

        async def llm(messages):
            seen.append(messages)
            return case["raw"]

        _run(rp.run_case(al, oe, belt, case, FX, llm, monkeypatch))
        if FX["meta"]["prompt_sha"].get(belt) != rp.prompt_sha(seen[0]):
            pytest.skip(f"{belt}: recording predates the prompt; run scripts/orw1070_rerecord.py")
    for belt in BELTS:
        res = rp.score(belt, FX["cases"][belt], _replay(belt, monkeypatch, gated=True))
        assert res["P"] >= 0.85 and res["R"] >= 0.9, (belt, res)
