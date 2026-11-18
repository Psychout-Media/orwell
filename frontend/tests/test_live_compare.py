"""ORW-109 (formal short tier): the PURE parts of the live-run harness - the engine-vs-narration comparator, the stall and livelock rules, the in-harness budget and
the scrubbed report. No browser, no narrator, no rig. Every rule has a planted-mismatch positive control. Roles only: the names below are placeholders."""
import importlib.util
import pathlib
import sys

import pytest

_LIVE = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "live-run"
sys.path.insert(0, str(_LIVE))
_spec = importlib.util.spec_from_file_location("live_compare", _LIVE / "live_compare.py")
lc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(lc)
_bs = importlib.util.spec_from_file_location("beats", _LIVE / "beats.py")
beats = importlib.util.module_from_spec(_bs)
_bs.loader.exec_module(beats)

CAST = ["Aa Bb", "Cc Dd", "Ee Ff", "Gg Hh"]


def _t(text, **kw):
    t = {"label": "t1", "msg": "I wait.", "text": text, "phase": "veto-competition", "phase_before": "veto-competition", "ds": {"due": False, "next": "veto-ceremony"}, "cast": CAST,
         "nominees": ["Aa Bb", "Cc Dd"], "evicted": [], "veto_holder": "Ee Ff", "player": "Gg Hh", "engine_pending": False}
    t.update(kw)
    return t


def _ids(findings):
    return [c["id"].split("[")[0] for c in findings if not c["ok"]]


def test_phantom_veto_winner_is_caught_and_the_true_holder_passes():
    assert "B1-veto-holder" in _ids(lc.compare_turn(_t("Cc Dd wins the Power of Veto and the room erupts.")))
    assert "B1-veto-holder" not in _ids(lc.compare_turn(_t("Ee Ff wins the Power of Veto and the room erupts.")))
    assert "B1-veto-holder" in _ids(lc.compare_turn(_t("Ee Ff wins the Power of Veto.", veto_holder=None))), "a veto winner voiced before the engine committed one"


def test_a_houseguest_on_the_block_who_is_not_a_nominee_is_caught():
    assert "B2-nominees" in _ids(lc.compare_turn(_t("Ee Ff is now on the block.")))
    assert "B2-nominees" not in _ids(lc.compare_turn(_t("Aa Bb is on the block, as everyone knows.")))
    assert "B2-nominees" not in _ids(lc.compare_turn(_t("Some Place is on the block.")))   # not a cast name: never flagged


def test_a_phantom_evictee_is_caught_and_a_recorded_one_passes():
    assert "B3-evictee" in _ids(lc.compare_turn(_t("Cc Dd has been evicted.", phase="eviction", phase_before="eviction")))
    assert "B3-evictee" not in _ids(lc.compare_turn(_t("Cc Dd has been evicted.", phase="eviction", phase_before="eviction", evicted=["Cc Dd"])))


def test_a_sealed_ballot_attributed_to_a_voter_is_caught_in_the_eviction_phase_only():
    txt = "Ee Ff voted to evict Aa Bb, and the room gasps."
    assert "B4-sealed-ballot" in _ids(lc.compare_turn(_t(txt, phase="eviction", phase_before="eviction")))
    assert "B4-sealed-ballot" not in _ids(lc.compare_turn(_t(txt)))
    assert "B4-sealed-ballot" not in _ids(lc.compare_turn(_t("Gg Hh voted to evict Aa Bb.", phase="eviction", phase_before="eviction"))), "the player's own vote is theirs to read"


def test_a_phantom_winner_is_caught_until_the_engine_records_it():
    assert "B5-winner" in _ids(lc.compare_turn(_t("Aa Bb wins the season!", phase="finale", phase_before="finale")))
    assert "B5-winner" not in _ids(lc.compare_turn(_t("Aa Bb wins the season!", phase="finale", phase_before="finale", finished=True, winner="Aa Bb")))


@pytest.mark.parametrize("leak", ["<think>he lies</think> The room is quiet.", "Thinking: the engine state says the phase is eviction.", "[OOC: the game master pauses]", "stale-beat refused"])
def test_reasoning_and_operator_text_in_the_bubble_is_caught(leak):
    assert "B6-no-reasoning-or-operator-text" in _ids(lc.compare_turn(_t(leak)))
    assert "B6-no-reasoning-or-operator-text" not in _ids(lc.compare_turn(_t("The room is quiet and everyone waits.")))


def _due(i, **kw):
    return _t("scene " + str(i), label=f"v{i}", phase="veto-ceremony", phase_before="veto-ceremony", ds={"due": True, "next": "veto-ceremony"}, **kw)


def test_the_orw10_shape_a_due_ceremony_that_never_fires_is_a_stall():
    stall = lc.detect_stall([_due(i) for i in range(1, 8)])
    assert [c["id"].split("[")[0] for c in stall] == ["S1-stall"], "positive control: a ceremony due for 7 turns with nothing committed"
    assert "v4" in stall[0]["id"], "the rule allows 3 turns, the 4th is the stall"


def test_a_ceremony_that_fires_inside_the_window_is_not_a_stall():
    ok = [_due(1), _due(2), _t("fired", label="v3", phase="veto-ceremony", phase_before="veto-ceremony", ds={"due": False, "next": "eviction"})]
    assert not lc.detect_stall(ok)
    moved = [_due(1), _due(2), _due(3), _t("done", label="v4", phase="eviction", phase_before="veto-ceremony", ds={"due": True, "next": "eviction"})]
    assert not lc.detect_stall(moved), "a phase that moved is committed, not stalled"


def test_after_an_explicit_ask_the_window_is_one_turn():
    asked = [_due(1, msg="Let's do it now."), _due(2, msg="Let's do it now.")]
    assert lc.detect_stall(asked), "asked, due, and nothing committed after 1 turn"
    assert not lc.detect_stall([_due(1)] + [_due(2)])


def test_a_pending_decision_is_not_a_stall():
    assert not lc.detect_stall([_due(i, engine_pending=True) for i in range(1, 8)])


def test_livelock_three_identical_replies():
    same = [_t("The room waits in silence.", label=f"l{i}") for i in range(3)]
    assert _ids(lc.detect_livelock(same)) == ["L1-livelock"]
    assert not lc.detect_livelock([_t("one"), _t("two"), _t("one")])


def test_budget_turn_cap_and_spend_cap_abort_cleanly():
    b = lc.Budget(max_turns=2)
    b.check(); b.note_turn(); b.check(); b.note_turn()
    with pytest.raises(lc.BudgetExceeded) as e:
        b.check()
    assert e.value.kind == "turn"
    spent = {"v": 0.10}
    s = lc.Budget(max_spend=0.25, spend_fn=lambda: spent["v"])
    s.check()
    spent["v"] = 0.25
    with pytest.raises(lc.BudgetExceeded) as e2:
        s.check()
    assert e2.value.kind == "spend" and s.summary()["spent_usd"] == 0.25


def test_budget_refuses_a_non_positive_cap_and_survives_an_unreadable_spend_file():
    for bad in (0, -1, "3"):
        with pytest.raises(ValueError):
            lc.Budget(max_spend=bad)
    def boom():
        raise OSError("no file")
    assert lc.Budget(max_spend=1, spend_fn=boom).spent() == 0.0


def test_the_report_is_scrubbed_concise_and_a_capped_run_is_not_a_pass():
    checks = [{"id": "B1-veto-holder[v1]", "ok": False, "severity": "fail", "detail": "Aa Bb named but the holder is Ee Ff"}, {"id": "T2-x", "ok": True, "severity": "fail", "detail": "ok"}]
    md, data = lc.build_report({"sha": "abc12345", "ref": "main", "model": "m"}, checks, ["veto-ceremony"], {"spent_usd": 0.1, "max_spend_usd": 0.5, "turns": 5, "max_turns": 60}, names=CAST)
    assert data["verdict"] == "FAIL" and "Aa Bb" not in md and "Ee Ff" not in md and "[houseguest]" in md
    assert lc.verdict_of([], capped=True) == "CAPPED" and lc.verdict_of([], error="x") == "COULD NOT RUN" and lc.verdict_of([]) == "PASS"
    assert "FAIL" in lc.plane_comment_html(data) and "<script" not in lc.plane_comment_html({"verdict": "FAIL", "meta": {}, "beats": ["<script>"], "budget": {}, "failing": []})


def test_the_offline_stub_holds_its_positive_control():
    ok, lines = lc.selftest()
    assert ok, lines


def test_apply_comparison_flags_the_planted_break_and_keeps_a_clean_run_clean():
    clean, broken = lc.stub_transcripts()
    got = []
    lc.apply_comparison(clean, lambda cid, ok, d, s="fail": got.append((cid, ok, s)))
    assert not [g for g in got if not g[1] and g[2] == "fail"]
    got = []
    lc.apply_comparison(broken, lambda cid, ok, d, s="fail": got.append((cid, ok, s)))
    assert {g[0].split("[")[0] for g in got if not g[1]} >= {"S1-stall", "B1-veto-holder"}


def test_beat_helpers_are_bounded_and_read_engine_state():
    assert beats.bounded(99) == beats.MAX_BEAT_TURNS and beats.bounded("x") == 4 and beats.bounded(0) == 1
    assert len(beats.beat_lines(beats.VETO_LINES, 6)) == 6
    assert beats.veto_ceremony_fired({"phase": "eviction"}) and not beats.veto_ceremony_fired({"phase": "veto-ceremony"})
    assert beats.finale_over({"finished": True}) and beats.finale_over({"phase": "complete"}) and not beats.finale_over({"phase": "finale"})
