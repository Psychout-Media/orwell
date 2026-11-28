"""ORW-1156 part 3: every intent gate logs its decision; the labelled corpus (codes only) measures each gate's misses. Synthetic role messages only."""
import json
import logging

import pytest

from src import gate_corpus as gc
from src import gate_log


@pytest.fixture(autouse=True)
def _clean():
    gate_log.reset()
    yield
    gate_log.reset()


def test_decorated_gates_log_and_keep_their_answers(caplog):
    from src import act_first as af
    with caplog.at_level(logging.INFO, logger="src.gate_log"):
        assert af.prefilter("I walk to the kitchen.") is None
        assert af.prefilter("") == "empty"
        assert af.bed_vetoed("Should I take a bed?") is True
    by = gate_log.stats()["byGate"]
    assert by["act-first-prefilter"] == {"fired": 1, "skipped": 1}
    assert by["bed-veto"] == {"fired": 0, "skipped": 1}
    assert any("[gate] gate=act-first-prefilter decision=skip reason=empty" in r.message for r in caplog.records)


def test_a_message_counts_once_per_gate_and_is_never_stored():
    from src import act_first as af
    for _ in range(3):
        af.prefilter("a secret sentence the log must not keep")
    s = json.dumps(gate_log.stats())
    assert gate_log.stats()["byGate"]["act-first-prefilter"]["fired"] == 1
    assert "secret sentence" not in s and gate_log.code_of("a secret sentence the log must not keep") in s


def test_search_cue_is_its_own_logged_gate():
    from src import act_first as af
    assert af.search_cue("Where is Rowan?", ["Rowan Role"]) is True
    assert af.search_cue('She says "Rowan" is here.', ["Rowan Role"]) is False
    assert gate_log.stats()["byGate"]["search-cue"] == {"fired": 1, "skipped": 1}


def test_every_measured_gate_is_a_logged_gate():
    assert set(gc.GATE_ACTS) <= set(gate_log.GATES)
    assert set(gc.gate_decisions("I go to the kitchen.")) == set(gc.GATE_ACTS)


def test_belt_gates_log_without_a_message():
    from src import agent_gates as ag
    assert ag.want_move(moved=False, turn_move_nudges=0, max_move_nudges=1, signal_in_user_message=True, signal_in_narration=False) is True
    assert gate_log.stats()["byGate"]["belt-want-move"] == {"fired": 1, "skipped": 0}


# ── the corpus ────────────────────────────────────────────────────────────────────────────────────────────────────
def test_acts_come_from_commits_and_from_narrated_claims():
    assert gc.acts_of_turn(["turnIn"], "") == ["sleep"]
    assert gc.acts_of_turn([], "You finally drift off to sleep.") == ["sleep"]
    assert gc.acts_of_turn(["claimBed", "moveTo"], "") == ["bed", "move"]
    assert gc.acts_of_turn([], "", moved=True) == ["move"]
    assert gc.acts_of_turn(["recordInteraction"], "Rowan nods.") == []


def test_miss_rate_counts_only_rows_with_the_gates_act():
    rows = [
        {"code": "a", "acts": ["sleep"], "gates": {"bed-intent": True}},
        {"code": "b", "acts": ["sleep"], "gates": {"bed-intent": False}},
        {"code": "c", "acts": ["move"], "gates": {"bed-intent": False, "move-veto": True}},
        {"code": "d", "acts": [], "gates": {"bed-intent": False}},
    ]
    r = gc.miss_rates(rows)
    assert r["bed-intent"] == {"acts": ["sleep"], "positives": 2, "misses": 1, "missRate": 0.5}
    assert r["move-veto"]["missRate"] == 0.0 and r["search-cue"]["missRate"] is None


def test_row_for_holds_a_code_and_no_text():
    row = gc.row_for("I go to bed, said the quiet sentence.", ["sleep"])
    assert set(row) == {"code", "acts", "gates"} and "quiet sentence" not in json.dumps(row)


def test_builder_end_to_end_from_an_export(tmp_path):
    import subprocess
    import sys
    from pathlib import Path
    exp = tmp_path / "exp"
    exp.mkdir()
    doc = {"is_game_session": True, "messages": [
        {"role": "user", "content": "I go to bed."}, {"role": "assistant", "content": "You finally drift off to sleep.", "metadata": {"tool_events": [{"tool": "turnIn"}]}},
        {"role": "user", "content": "Hello Rowan."}, {"role": "assistant", "content": "Rowan waves."}]}
    (exp / "s.json").write_text(json.dumps(doc))
    out = tmp_path / "corpus.json"
    root = Path(__file__).resolve().parents[1]
    r = subprocess.run([sys.executable, str(root / "scripts" / "build_gate_corpus.py"), str(exp), "--out", str(out)], capture_output=True, text=True, cwd=root)
    assert r.returncode == 0, r.stderr
    rows = json.loads(out.read_text())["rows"]
    assert len(rows) == 2 and rows[0]["acts"] == ["sleep"] and rows[1]["acts"] == []
    assert "go to bed" not in out.read_text()
    rep = gc.miss_report(out)
    assert rep["rows"] == 2 and rep["gates"]["bed-intent"]["positives"] == 1


def test_admin_health_carries_the_gates_section(monkeypatch, tmp_path):
    from routes import admin_health_routes as ah
    monkeypatch.setenv("ORWELL_GATE_CORPUS", str(tmp_path / "none.json"))
    s = ah._gates_section()
    assert s is not None and "byGate" in s and s["corpus"] is None
