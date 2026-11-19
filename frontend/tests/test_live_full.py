"""ORW-109 (full-week tier): the PURE parts of scripts/live-run/live_full.py and its judge - detector sets built from the code, per-turn findings, the stall / missing-result /
retcon / skipped-time rules, the spend and turn caps, the anonymised report, the offline replay and the ORW-10 red/green proof. No browser, no narrator, no network, no
credentials. Every finding class has a planted positive control. Roles only: the names below are placeholders."""
import json
import pathlib
import re
import subprocess
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
_LIVE = ROOT / "scripts" / "live-run"
for p in (_LIVE, ROOT / "scripts" / "rehearsal-kit"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import live_compare as lc  # noqa: E402
import live_detect as ld  # noqa: E402
import live_full as lf  # noqa: E402
import live_full_eval as ev  # noqa: E402
import live_truth as lt  # noqa: E402

FIX = pathlib.Path(__file__).parent / "fixtures"
SCENE = "The kitchen hums with low talk while the afternoon light slants across the counter, and the whole room waits for someone to say the thing nobody has said. " * 2
CAST = ["Aa Bb", "Cc Dd", "Ee Ff", "Gg Hh", "Ii Jj"]


def _t(text=SCENE, **kw):
    t = {"label": "turn-1", "msg": "I wait.", "text": text, "phase": "veto-competition", "phase_before": "veto-competition", "ds": {"due": False, "next": "veto-ceremony"},
         "cast": CAST, "nominees": ["Aa Bb", "Cc Dd"], "evicted": [], "veto_holder": "Ee Ff", "player": "Gg Hh", "engine_pending": False, "events": [], "week": 1,
         "clock": "1:00pm, Day 3", "clock_before": "12:55pm, Day 3", "hoh_name": "Ii Jj"}
    t.update(kw)
    return t


def _checks(findings):
    return sorted({f["check"] for f in findings if f["severity"] == "fail"})


def _cats(findings):
    return sorted({f["category"] for f in findings if f["severity"] == "fail"})


# --- detector sets come from the code ------------------------------------------------------------------------------------------------------------------------
def test_stand_in_table_is_read_from_the_front_end_source_and_holds_the_known_lines():
    table = ld.stand_in_table()
    for name in ("_SCENE_CUTAWAY_LINE", "_BLANK_FALLBACK_MODEL", "_BLANK_FALLBACK_UPSTREAM", "_EMPTY_PRODUCER_LINE", "_NARRATOR_AWAY_LINE"):
        assert name in table, f"{name} is gone from agent_loop.py or renamed: the stand-in net would silently narrow"
    assert any("control room" in v for v in table.values())


def test_a_new_stand_in_constant_is_detected_without_touching_the_harness(tmp_path):
    src = tmp_path / "agent_loop.py"
    src.write_text('_BRAND_NEW_LINE = ("Production regrets that the next moment could not be shown right now, please wait.")\n_UNRELATED = "x" * 3\n')
    table = ld.stand_in_table(str(src))
    assert list(table) == ["_BRAND_NEW_LINE"]
    assert ld.stand_in_hits("Production regrets that the next moment could not be shown right now, please wait.", table) == ["_BRAND_NEW_LINE"]


@pytest.mark.parametrize("name", ["_SCENE_CUTAWAY_LINE", "_BLANK_FALLBACK_MODEL", "_EMPTY_PRODUCER_LINE", "_BLANK_FALLBACK_UPSTREAM"])
def test_each_real_stand_in_line_is_a_T1_failure_when_it_is_the_reply(name):
    f = ev.judge_turn(_t(ld.stand_in_table()[name]))
    assert "T1" in _checks(f) and "T5" in _checks(f)
    assert "stand-in" in _cats(f) and "unanswered" in _cats(f)


def test_a_scene_that_carries_a_stand_in_line_inside_is_still_flagged():
    line = ld.stand_in_table()["_SCENE_CUTAWAY_LINE"]
    f = ev.judge_turn(_t(SCENE + "\n\n" + line))
    assert "T1" in _checks(f) and "T5" not in _checks(f)


def test_prompt_text_leak_is_found_from_the_narrator_prompt_itself():
    src = open(ld.MOMENT_PROMPTS, encoding="utf-8").read()
    start = src.index("BASE_GAME_MASTER_PROMPT = [")
    words = re.findall(r'"([^"\n]{40,})"', src[start:start + 4000])[0].split()
    assert ld.prompt_text_hit(" ".join(words[:10])) is not None
    assert ld.prompt_text_hit("The kitchen is quiet and nobody wants to be the first to speak about the vote.") is None


def test_wall_leaks_each_detected_and_clean_prose_is_not():
    for text, kind in ((SCENE + " npc:17 glares.", "raw-npc-id"), (SCENE + " <think>plan</think>", "reasoning")):
        got = ld.wall_leaks(text, lc.REASONING_RE, None)
        assert kind in [k for k, _ in got]
    assert "operator-aside" in [k for k, _ in ld.wall_leaks(SCENE + " Let me record this interaction.", lc.REASONING_RE, None)] or ld.degraded()
    assert ld.wall_leaks(SCENE, lc.REASONING_RE, None) == []


def test_refusal_only_reply_is_caught_and_a_real_scene_is_not():
    assert ld.refusal_only("I'm sorry, but I can't continue in this direction.") or ld.degraded()
    assert not ld.refusal_only(SCENE)
    f = ev.judge_turn(_t("I'm sorry, but I can't continue in this direction."))
    assert "T1" in _checks(f)


def test_player_voice_guard_is_the_front_ends_own():
    hits = ld.player_voice_hits('You say, "I never trusted them." The room goes quiet.', "I look around.")
    assert hits or ld.degraded()


# --- the per-turn judge: a positive control for every class ----------------------------------------------------------------------------------------------------
def test_clean_turn_has_no_findings():
    assert [f for f in ev.judge_turn(_t()) if f["severity"] == "fail"] == []


def test_phantom_board_claim_is_a_contradiction():
    f = ev.judge_turn(_t(SCENE + " Ii Jj wins the Power of Veto and the room erupts."))
    assert "T3" in _checks(f) and "contradictions" in _cats(f)


def test_phase_mismatch_is_a_contradiction():
    f = ev.judge_turn(_t(SCENE + " The platforms are slick and rounds one and two begin.", phase="nominations", phase_before="nominations"))
    assert "T2" in _checks(f)


def test_sealed_ballot_attribution_is_caught():
    f = ev.judge_turn(_t(SCENE + " Aa Bb voted to evict Cc Dd.", phase="eviction", phase_before="eviction"))
    assert "T7" in _checks(f)


def test_unanswered_message_is_caught_empty_and_errored():
    assert "T5" in _checks(ev.judge_turn(_t("")))
    assert "T5" in _checks(ev.judge_turn(_t("", error="HTTP 500")))


def test_clock_time_and_headcount_contradictions():
    assert "T13" in _checks(ev.judge_turn(_t(SCENE + " It is 9:40 and nobody has moved.")))
    f = ev.judge_turn(_t(SCENE + " All 9 of us sit in the house tonight.", counts={"house": 5, "room": 3}, counts_start={"house": 5, "room": 3}))
    assert "T16" in _checks(f)


def test_wall_leak_in_a_turn_is_categorised():
    f = ev.judge_turn(_t(SCENE + " npc:17 glares at the nominee. Let me record this interaction."))
    assert "T6" in _checks(f) and "wall-leaks" in _cats(f)


def test_thin_reply_fails_and_a_short_one_is_a_note():
    assert "T1" in _checks(ev.judge_turn(_t("Okay.")))
    notes = [f for f in ev.judge_turn(_t("A short but real reply, the room is quiet and he nods at you slowly, saying nothing more for now.")) if f["severity"] == "note"]
    assert notes and notes[0]["check"] == "T1"


# --- run-level rules -----------------------------------------------------------------------------------------------------------------------------------------
def _due_turns(n, msg="I wait."):
    return [_t(label=f"turn-{i + 1}", msg=msg, phase="veto-ceremony", phase_before="veto-ceremony", ds={"due": True, "next": "veto-ceremony"}) for i in range(n)]


def test_stall_rule_fires_after_three_turns_and_not_before():
    assert not [f for f in ev.judge_run(_due_turns(3))[0] if f["check"] == "S1"]
    assert [f for f in ev.judge_run(_due_turns(4))[0] if f["check"] == "S1"]


def test_stall_window_is_one_turn_after_an_explicit_ask():
    turns = _due_turns(2, "I'm ready. Let's go.")
    assert [f for f in ev.judge_run(turns)[0] if f["check"] == "S1"]


def test_livelock_three_identical_replies():
    turns = [_t(label=f"turn-{i}") for i in range(3)]
    assert [f for f in ev.judge_run(turns)[0] if f["check"] == "L1"]


def test_missing_result_a_committed_eviction_the_narration_never_tells():
    turns = [_t(label="turn-1", phase="eviction", phase_before="eviction"), _t(label="turn-2", events=[{"kind": "eviction", "subjects": ["Cc Dd"]}], evicted=["Cc Dd"]),
             _t(label="turn-3"), _t(label="turn-4")]
    f = [x for x in ev.judge_run(turns)[0] if x["check"] == "R1"]
    assert f and f[0]["category"] == "missing-results" and f[0]["severity"] == "fail"


def test_missing_result_is_not_flagged_when_told_by_name_or_by_word():
    for told in ("Everyone watches Cc Dd collect a bag.", "The house votes and a houseguest is evicted."):
        turns = [_t(label="turn-1", events=[{"kind": "eviction", "subjects": ["Cc Dd"]}]), _t(label="turn-2", text=SCENE + told), _t(label="turn-3"), _t(label="turn-4")]
        assert not [x for x in ev.judge_run(turns)[0] if x["check"] == "R1"]


def test_missing_result_near_the_end_is_only_a_note():
    turns = [_t(label="turn-1", events=[{"kind": "veto", "subjects": ["Ee Ff"]}], text=SCENE.replace("afternoon", "evening").replace("slants", "falls"))]
    f = [x for x in ev.judge_run(turns)[0] if x["check"] == "R1"]
    assert f and f[0]["severity"] == "note"


def test_committed_events_from_two_state_reads():
    a = {"phase": "nominations", "week": 1, "ceremony": {"hoh": {"name": "Aa Bb"}}, "house": [{"name": "Aa Bb", "status": "active"}, {"name": "Cc Dd", "status": "active"}]}
    b = {"phase": "veto-competition", "week": 1, "ceremony": {"hoh": {"name": "Aa Bb"}, "nominees": [{"name": "Cc Dd"}]}, "veto": {"holder": "Aa Bb"},
         "house": [{"name": "Aa Bb", "status": "active"}, {"name": "Cc Dd", "status": "evicted"}]}
    kinds = {e["kind"] for e in lt.committed_events(a, b)}
    assert kinds == {"nominations", "veto", "eviction"}


def test_retcon_a_different_veto_holder_later_in_the_same_week():
    turns = [_t(label="turn-1"), _t(label="turn-2", veto_holder="Gg Hh")]
    assert [f for f in ev.judge_run(turns)[0] if f["check"] == "T4"]


def test_time_skip_without_a_reason_fails_and_a_bed_message_is_allowed():
    skip = _t(clock_before="1:00pm, Day 3", clock="6:00pm, Day 3")
    assert [f for f in ev.judge_run([skip])[0] if f["check"] == "T9"]
    ok = _t(clock_before="1:00pm, Day 3", clock="6:00pm, Day 3", msg="I say goodnight and go to bed.")
    assert not [f for f in ev.judge_run([ok])[0] if f["check"] == "T9"]


def test_verdict_rules():
    stats = {"turns": 100, "t1_fail_turns": 0, "stall": False, "livelock": False, "fail_counts": {}, "longest_due_wait": 0}
    assert ev.verdict([], stats) == "PASS"
    assert ev.verdict([{"severity": "note", "check": "T1"}], stats) == "NOTE"
    assert ev.verdict([{"severity": "fail", "check": "T3"}], stats) == "FAIL"
    assert ev.verdict([], dict(stats, t1_fail_turns=3)) == "FAIL"           # more than 1 thin turn in 50
    assert ev.verdict([], dict(stats, t1_fail_turns=2)) in ("PASS", "NOTE")  # exactly 1 in 50 is allowed
    assert ev.verdict([], dict(stats, stall=True)) == "FAIL"
    assert ev.verdict([], stats, reached_end=False) == "FAIL"
    assert ev.verdict([], stats, capped=True, reached_end=False) == "CAPPED"
    assert ev.verdict([], stats, error="boom") == "COULD NOT RUN"


# --- the caps ------------------------------------------------------------------------------------------------------------------------------------------------
def test_spend_cap_aborts_cleanly_and_reports_capped(tmp_path):
    steps, first = lf.stub_week(None)
    world = lf.ReplayWorld(steps, first)
    meter = lf.SpendMeter()
    budget = lc.Budget(0.015, 100, meter)   # two estimated turns pass this cap
    turns, reached, error, capped = lf.run(world, budget, meter)
    assert capped and not reached and 1 <= len(turns) <= 3 and "spend cap" in error
    word, md, data = lf.finish(turns, reached, error, capped, budget, world, str(tmp_path), {"model": "m", "build": "b"})
    assert word == "CAPPED" and data["budget"]["max_spend_usd"] == 0.015 and (tmp_path / "report.json").exists()


def test_turn_cap_stops_at_the_cap():
    steps, first = lf.stub_week(None)
    world = lf.ReplayWorld(steps, first)
    meter = lf.SpendMeter()
    budget = lc.Budget(100, 3, meter)
    turns, reached, error, capped = lf.run(world, budget, meter)
    assert capped and len(turns) == 3 and "turn cap" in error


def test_a_run_without_a_working_cap_is_never_started():
    with pytest.raises(ValueError):
        lc.Budget(0, 10)


def test_usage_events_are_priced_and_padded_and_estimate_covers_a_silent_stream():
    m = lf.SpendMeter()
    r = lf.Reply()
    r.usage = [{"input_tokens": 1_000_000, "output_tokens": 0}]
    m.add_reply(r)
    assert m() == pytest.approx(0.30 * lf.UNSEEN_CALLS_FACTOR, rel=0.01)
    silent = lf.SpendMeter()
    silent.add_reply(lf.Reply())
    assert silent() > 0


# --- the stream readers ------------------------------------------------------------------------------------------------------------------------------------------
def test_sse_reasoning_never_reaches_the_public_text_and_usage_is_collected():
    lines = ['data: {"delta": "plan the scene", "thinking": true}', "", 'data: {"delta": "The room "}', 'data: {"delta": "falls quiet."}',
             'data: {"type": "usage", "data": {"input_tokens": 10, "output_tokens": 5}}', "data: [DONE]"]
    r = lf.parse_sse(lines)
    assert r.text == "The room falls quiet." and r.reasoning == "plan the scene" and r.usage and r.done


def test_sse_error_event_and_outage_notice_are_not_a_reply():
    r = lf.parse_sse(["event: error", 'data: {"error": "ws-only", "status": 426}', "data: [DONE]"])
    assert r.error == "ws-only" and r.text == ""
    r2 = lf.parse_sse(['data: {"type": "narrator_away", "message": "The narrator is away"}', "data: [DONE]"])
    assert r2.upstream and r2.text == ""


def test_ws_frames_split_reasoning_and_end_on_error():
    r = lf.parse_ws_frames([{"t": "event", "ch": "chat", "d": {"delta": "hmm", "thinking": True}}, {"t": "event", "ch": "chat", "d": {"delta": "A scene."}},
                            {"t": "event", "ch": "chat", "d": {"done": True}}])
    assert r.text == "A scene." and r.reasoning == "hmm" and r.done
    assert lf.parse_ws_frames([{"t": "error", "d": {"code": "stale-beat"}}]).error == "stale-beat"


# --- the player ----------------------------------------------------------------------------------------------------------------------------------------------
def _state(clock="1:00pm, Day 3", due=False, pending=None, phase="nominations"):
    return {"phase": phase, "week": 1, "clockLabel": clock, "daySchedule": {"due": due, "next": "nominations" if due else None}, "player": {"name": "Gg Hh"}, "pending": pending,
            "house": [{"name": n, "status": "active"} for n in CAST], "whereabouts": {"present": [{"name": "Aa Bb"}, {"name": "Cc Dd"}]}}


def test_player_is_deterministic_social_and_never_repeats_itself_three_times():
    def play():
        p, turns, out = lf.Player(), [], []
        for i in range(40):
            m = p.next_message(_state(), turns)
            out.append(m)
            turns.append({"msg": m, "text": SCENE})
        return out
    a, b = play(), play()
    assert a == b
    for i in range(len(a) - 2):
        assert not (a[i] == a[i + 1] == a[i + 2])
    assert sum(1 for m in a if re.search(r"ask|tell|sit|stay|help|admit", m)) >= 25   # mostly talking


def test_player_talks_to_different_houseguests():
    p, turns, named = lf.Player(), [], set()
    for _ in range(10):
        m = p.next_message(_state(), turns)
        named |= {n for n in ("Aa Bb", "Cc Dd") if n in m}
        turns.append({"msg": m, "text": SCENE})
    assert named == {"Aa Bb", "Cc Dd"}


def test_player_asks_to_start_a_due_event_then_hangs_out_and_goes_to_bed_late():
    p = lf.Player()
    assert p.next_message(_state(due=True), []) == lf.GO_NOW
    assert p.next_message(_state(due=True), []) == lf.HANG_OUT
    assert lf.Player().next_message(_state(clock="11:30pm, Day 3"), []) == lf.BED


def test_player_answers_a_question_from_the_reply():
    p = lf.Player()
    assert p.next_message(_state(), [{"msg": "x", "text": SCENE + " What do you think?"}]) == lf.ANSWER


def test_decision_body_is_the_browsers_own_shape():
    assert lf.decision_body({"kind": "nominations", "options": [{"id": "a"}, {"id": "b"}, {"id": "c"}]}, "me") == {"kind": "nominations", "choice": ["a", "b"]}
    assert lf.decision_body({"kind": "veto-decision"}, "me") == {"kind": "veto-decision", "use": False}
    assert lf.decision_body({"kind": "comp-intent"}, "me") == {"kind": "comp-intent", "intent": "compete"}


def test_decision_cards_are_answered_through_the_decision_route_not_the_chat():
    steps, first = lf.stub_week(None)
    first = dict(first, pending={"kind": "comp-intent", "options": []})
    world = lf.ReplayWorld(steps, first)
    meter = lf.SpendMeter()
    lf.run(world, lc.Budget(100, 100, meter), meter)
    assert world.decisions == 1


# --- credentials and anonymity ----------------------------------------------------------------------------------------------------------------------------
def test_credentials_are_read_in_code_and_never_printed(tmp_path, capsys):
    f = tmp_path / "acct.json"
    f.write_text(json.dumps({"server": "http://127.0.0.1:9", "username": "zzaccountname", "password": "zzpass-s3cret-value"}))
    rc = lf.main(["--creds", str(f), "--out", str(tmp_path / "o")])
    out = capsys.readouterr()
    assert rc == 2
    for secret in ("zzaccountname", "zzpass-s3cret-value"):
        assert secret not in out.out + out.err
    assert "COULD-NOT-RUN" in out.out


def test_report_scrubs_cast_names_and_secrets(tmp_path):
    t = _t(SCENE + " Ii Jj wins the Power of Veto and the room erupts. zzaccountname is watching.")
    findings, stats = ev.judge_run([t])
    md, data = ev.build_report({"build": "b zzaccountname", "model": "m"}, [t], findings, stats, {"spent_usd": 0.1, "max_spend_usd": 3, "turns": 1, "max_turns": 10},
                               "FAIL", names=CAST, secrets=("zzaccountname",))
    blob = md + json.dumps(data)
    for n in CAST + ["zzaccountname"]:
        assert n not in blob
    assert "## Findings: contradictions" in md and "What this run did not cover" in md


def test_the_report_has_every_required_section_and_group():
    findings, stats = ev.judge_run([_t()])
    md, data = ev.build_report({}, [_t()], findings, stats, {}, "PASS")
    for head in ("contradictions", "stand-in", "missing-results", "wall-leaks", "unanswered", "stalls"):
        assert f"## Findings: {head}" in md and head in data["findings"]
    assert "Longest wait for a due event" in md


# --- the offline stub: a planted fault is found by the matching detector, the healthy week is green -----------------------------------------------------
@pytest.mark.parametrize("fault,check", [("planted", "T3"), ("stall", "S1"), ("stand_in", "T1"), ("missing", "R1"), ("leak", "T6"), ("unanswered", "T5"), ("retcon", "T4"),
                                         ("timeskip", "T9")])
def test_every_planted_fault_is_detected_by_its_detector(fault, check, tmp_path):
    word, _md, data = lf.run_stub(fault, str(tmp_path), 100)
    assert word == "FAIL"
    assert check in {f["check"] for v in data["findings"].values() for f in v}, data["findings"]


def test_the_healthy_stub_week_is_green(tmp_path):
    word, md, data = lf.run_stub("healthy", str(tmp_path), 100)
    assert word == "PASS" and data["reached_end"] and not any(data["findings"].values())


# --- ORW-10: the veto-ceremony stall -----------------------------------------------------------------------------------------------------------------------
def _replay(name, tmp_path):
    rc = lf.main(["--replay", str(FIX / name), "--out", str(tmp_path), "--max-turns", "100"])
    return rc, json.load(open(tmp_path / "report.json"))


def test_orw10_recorded_stall_sequence_goes_red(tmp_path):
    """The recorded SHAPE of the ORW-10 stall (#2208/#2212): the veto ceremony due for 35 messages, nothing committed, a canned cutaway line shown as the reply. It is a
    recorded-shape fixture rebuilt from the card and its fix commits, NOT a captured transcript of the old build (an old-build real-model run was not practical here)."""
    rc, data = _replay("live_full_orw10_veto_stall.json", tmp_path)
    assert rc == 1 and data["verdict"] == "FAIL"
    checks = {f["check"] for v in data["findings"].values() for f in v}
    assert {"S1", "L1", "T5"} <= checks
    assert data["stats"]["longest_due_wait"] >= 30


def test_healthy_sequence_goes_green(tmp_path):
    rc, data = _replay("live_full_healthy_week.json", tmp_path)
    assert rc == 0 and data["verdict"] == "PASS" and data["stats"]["longest_due_wait"] <= 1


def test_the_short_tier_comparator_also_goes_red_on_the_orw10_shape():
    steps, first = lf.stub_week("orw10")
    turns, prev = [], first
    for i, step in enumerate(steps):
        turns.append(lt.turn_record(f"stub-{i}", "I wait.", prev, step["state"], step["reply"]))
        prev = step["state"]
    assert [c for c in lc.detect_stall(turns)]


# --- operator-only ----------------------------------------------------------------------------------------------------------------------------------------
def test_no_ci_job_cron_or_nightly_runs_the_full_week_tier():
    for wf in (ROOT / ".github" / "workflows").glob("*.yml"):
        assert "live_full" not in wf.read_text(), f"{wf.name} runs the operator-only full-week tier"


def test_the_full_week_scripts_compile():
    for f in ("live_full.py", "live_full_eval.py", "live_detect.py", "live_truth.py"):
        r = subprocess.run([sys.executable, "-m", "py_compile", str(_LIVE / f)], capture_output=True)
        assert r.returncode == 0, f
