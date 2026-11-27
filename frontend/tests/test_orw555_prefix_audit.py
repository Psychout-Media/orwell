"""ORW-555 — the prompt-prefix audit and the cheap fix it found (recall placement). Fake games only; no model, no network."""
import datetime as dt
import importlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
audit = importlib.import_module("orwell_prefix_audit")

from src import agent_loop as al  # noqa: E402


def _turn(clock: str, where: str = "the kitchen") -> dict:
    """A synthetic engine system prompt with the markers the volatile-tail reorder keys on (stable part, then the per-turn lines)."""
    sp = ("You are the narrator. " + "Static rule text. " * 400 + "\n\nGAME CONTEXT:\n- You are playing as: P.\n- roster line one\n- roster line two"
          f"\n- Week: 1\n- Phase: premiere\n- Clock: {clock}\nLOCATION: the player is in {where}.")
    return {"systemPrompt": sp, "showBrief": f"SHOW BRIEF. at {clock}", "hardConstraints": f"HARD CONSTRAINTS at {where}"}


NOW = dt.datetime(2026, 11, 16, 19, 4, tzinfo=dt.timezone.utc)


def test_common_prefix_and_measure():
    assert audit.common_prefix_len("abcdef", "abcxyz") == 3
    assert audit.common_prefix_len("abc", "abc") == 3
    assert audit.common_prefix_len("", "abc") == 0
    m = audit.measure([{"role": "user", "content": "aaaa" * 50 + "X"}], [{"role": "user", "content": "aaaa" * 50 + "Y"}])
    assert 0.9 < m["share"] < 1 and m["prefixChars"] < m["chars"]


def test_the_volatile_tail_widens_the_narrator_prefix_to_the_history():
    hist = audit._history(6)
    a = audit.narrator_wire(_turn("8:10am"), hist[:9], now=NOW)
    b = audit.narrator_wire(_turn("8:15am", "the yard"), hist[:11], now=NOW + dt.timedelta(minutes=5))
    shipped = audit.measure(a, b)
    a0 = audit.narrator_wire(_turn("8:10am"), hist[:9], now=NOW, tail=False)
    b0 = audit.narrator_wire(_turn("8:15am", "the yard"), hist[:11], now=NOW + dt.timedelta(minutes=5), tail=False)
    legacy = audit.measure(a0, b0)
    assert shipped["share"] > legacy["share"] + 0.05
    assert "Clock" in legacy["firstDiff"] or "Week" in legacy["firstDiff"] or "8:1" in legacy["firstDiff"]


def test_audit_narrator_and_brief_run_on_a_fixture():
    turns = [dict(_turn(f"8:{10 + 5 * k}am"), briefSections=["header", "now", "used"]) for k in range(4)]
    for t in turns:
        t["showBrief"] = "SHOW BRIEF.\n\n1. NOW\nx\n\n7. ALREADY USED (vary it)\n- a"
    r = audit.audit_narrator(turns)
    assert len(r["rows"]) == 3 and 0.5 < r["meanShare"] < 1
    b = audit.audit_brief(turns)
    assert all(t["section7IsLast"] and t["section7At"] > 0 for t in b["turns"])


def test_the_recall_no_longer_sits_ahead_of_the_transcript():
    r = audit.audit_recall()
    # before: the turn the recall fires, and the one after, re-bill nearly the whole history; after: they keep it
    assert max(x["share"] for x in r["before"]) < 0.2
    assert min(x["share"] for x in r["after"]) > 0.6


def test_the_shipped_trim_now_holds_its_cut_like_the_simulated_policy():
    # ORW-555 follow-up: the shipped game-turn trim holds its cut (context_compactor TRIM_TARGET_SHARE), so past the budget consecutive turns share the
    # history prefix; it used to slide one turn a turn (under 60%). Off (ORWELL_TRIM_HYSTERESIS=0) is the old sliding trim (tests/test_orw555_trim_hysteresis.py).
    t = audit.audit_trim(steps=4)
    assert min(x["share"] for x in t["shipped"]) > 0.9
    assert min(x["share"] for x in t["proposedHysteresis"]) > 0.9


def test_every_other_site_builds_and_reports_a_share():
    rows = audit.audit_sites()
    assert rows and all("note" not in r for r in rows), [r for r in rows if "note" in r]
    assert all(0 <= r["share"] <= 1 for r in rows)
    names = {r["site"] for r in rows}
    assert {"competitions", "cast-genesis", "day-condense (one call)", "scene+moves (merged)"} <= names


def test_the_report_renders_without_the_fixture_numbers_leaking_paths(capsys):
    turns = [_turn(f"8:{10 + 5 * k}am") for k in range(3)]
    rep = audit.build_report(turns)
    text = audit.render(rep)
    assert "stable-prefix share" in text and "Other call sites" in text
    assert "/home/" not in text
