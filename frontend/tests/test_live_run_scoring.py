"""ORW-109: the live-run short tier scores replies against engine truth. These pin the scoring (no browser, no narrator): each reported playtest bug
has a reply that FAILS its check and a reply that passes. Roles only."""
import importlib.util
import pathlib

_p = pathlib.Path(__file__).resolve().parents[2] / "scripts" / "live-run" / "live_short.py"
_spec = importlib.util.spec_from_file_location("live_short", _p)
ls = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ls)


def _turn(label, text, **kw):
    t = {"label": label, "msg": "x", "secs": 10, "phase": "premiere", "clock": "9:00pm, Day 1", "ds": None, "text": text + " " * max(0, 220 - len(text)), "settled": True, "timed_out": False,
         "new_bubbles": 1, "nominees": [], "room_start": [], "room_end": [], "inside": None}
    t.update(kw)
    return t


def _score(turns):
    checks = []
    ls.score(turns, checks, lambda cid, ok, detail, severity="fail": checks.append({"id": cid, "ok": bool(ok), "severity": severity, "detail": detail}), 120)
    return {c["id"]: c for c in checks}


def test_a_arrivals_that_freeze_fail_and_progress_passes():
    frozen = [_turn(f"premiere-{i}", "ok", inside=9) for i in range(1, 9)]
    assert not _score(frozen)["A2-arrivals-progress"]["ok"]
    moving = [_turn(f"premiere-{i}", "ok", inside=min(16, 6 + i)) for i in range(1, 9)]
    assert _score(moving)["A2-arrivals-progress"]["ok"]


def test_c_a_ceremony_voiced_before_the_engine_ran_it_fails():
    bad = _score([_turn("early", "Keith turns a key in the lock. Selena, you have been nominated.", phase="hoh-competition")])
    assert not [c for k, c in bad.items() if k.startswith("C4-")][0]["ok"]
    ok = _score([_turn("early", "Everyone talks about who might be nominated this week.", phase="hoh-competition")])
    assert [c for k, c in ok.items() if k.startswith("C4-")][0]["ok"]
    after = _score([_turn("veto-morning-1", "Keith turns a key.", phase="veto-competition", nominees=["A B", "C D"])])
    assert not [k for k in after if k.startswith("C4-")], "after the engine committed nominees the ritual is not phantom"


def test_d_nominee_names_must_match_the_engine():
    nom = ["Ada Quill", "Bo Marsh"]
    bad = _score([_turn("veto-morning-2", "The nominees are Ada Quill and Cy Dunn, everyone knows it.", phase="veto-competition", nominees=nom)])
    assert not [c for k, c in bad.items() if k.startswith("C5-")][0]["ok"]
    good = _score([_turn("veto-morning-2", "Ada Quill and Bo Marsh are on the block this week.", phase="veto-competition", nominees=nom)])
    assert [c for k, c in good.items() if k.startswith("C5-")][0]["ok"]


def test_e_a_speaker_the_engine_has_elsewhere_fails():
    txt = "The kitchen hums.\n\nTBTerrance Boyd — \"Morning.\"\n\nMVMarisol Vance — \"Coffee?\""
    bad = _score([_turn("t1", txt, phase="hoh-competition", room_start=["Terrance Boyd"], room_end=["Terrance Boyd"])])
    assert not bad["C6-speakers-in-room[t1]"]["ok"] and "Marisol Vance" in bad["C6-speakers-in-room[t1]"]["detail"]
    good = _score([_turn("t1", txt, phase="hoh-competition", room_start=["Terrance Boyd"], room_end=["Terrance Boyd", "Marisol Vance"])])
    assert good["C6-speakers-in-room[t1]"]["ok"], "someone who walks in during the reply is fine"


def test_machinery_pattern_does_not_flag_lowercase_prose():
    assert not ls.LEAK_RE.search("that's a vault with a cardigan")
    assert ls.LEAK_RE.search("the Vault holds the secret")
    assert not ls.COMP_PLAY_RE.search("sitting on a fence rail")


def test_k1_no_skipped_time_unexplained_jump_fails_but_runner_bed_and_wake_do_not():
    a = _turn("t1", "x", clock="4:05pm, Day 1")
    skip = _turn("t2", "x", clock="8:05am, Day 2", msg="Can we start the competition?")
    r = _score([a, skip])
    assert not [c for k, c in r.items() if k.startswith("K1-no-skipped-time")][0]["ok"], "16 hours on an ordinary message is a skipped night"
    by_runner = _score([a, _turn("t2", "x", clock="8:05am, Day 2", harness_jump=1)])
    assert not [k for k in by_runner if k.startswith("K1-no-skipped-time")], "a move the runner made itself is not blamed on the game"
    bed = _score([a, _turn("t2", "x", clock="5:45am, Day 2", msg="It's late. I say goodnight and go to bed.")])
    assert not [k for k in bed if k.startswith("K1-no-skipped-time")]
    small = _score([a, _turn("t2", "x", clock="4:10pm, Day 1")])
    assert not [k for k in small if k.startswith("K1-")], "5 minutes is normal"
    beat = _score([a, _turn("t2", "x", clock="7:10pm, Day 1", phase="nominations", phase_before="premiere")])
    assert [c for k, c in beat.items() if k.startswith("K1-clock-jump-competition")][0]["severity"] == "note", "a non-competition beat inside one message is a note"
    comp = _score([a, _turn("t2", "x", clock="7:10pm, Day 1", phase="nominations", phase_before="hoh-competition")])
    assert not [c for k, c in comp.items() if k.startswith("K2-competition-in-one-message")][0]["ok"], "a competition is never one message"


def test_k3_a_due_evening_ceremony_unfired_for_more_than_two_messages_fails():
    due = {"next": "nominations", "phase": "evening", "due": True, "minutesUntil": 0}
    stuck = [_turn(f"t{i}", "x", ds=due, phase="nominations", week=1) for i in range(1, 6)]
    r = _score(stuck)
    assert [k for k in r if k.startswith("K3-")], "nominations due for 5 messages without firing"
    fired = [_turn("t1", "x", ds=due, phase="nominations", week=1), _turn("t2", "x", ds=due, phase="nominations", week=1), _turn("t3", "x", ds=None, phase="veto-competition", week=1)]
    assert not [k for k in _score(fired) if k.startswith("K3-")]
    not_due = [_turn(f"t{i}", "x", ds={**due, "due": False}, phase="nominations", week=1) for i in range(1, 8)]
    assert not [k for k in _score(not_due) if k.startswith("K3-")], "waiting for tomorrow is not an unfired due event"


def _load(name):
    import sys
    d = str(pathlib.Path(__file__).resolve().parents[2] / "scripts" / "live-run")
    p = pathlib.Path(d) / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, p)
    m = importlib.util.module_from_spec(spec)
    sys.path.insert(0, d)
    try:
        spec.loader.exec_module(m)
    finally:
        sys.path.remove(d)  # review of ORW-109: the path edit never leaks into other tests
    return m


def test_orw259_busy_selector_matches_the_apps_real_streaming_mode():
    """ORW-259: the runners decided "the reply is still streaming" from `.send-btn[data-mode=stop|cancel]`, but the app marks a running turn
    `data-mode="streaming"` (chatSubmitButton.js) - so busy was never true, a quiet stretch between the last visible delta and `message_saved`
    (scene cut + post-turn belts, ~4-10s) read as settled, and the runner scored a still-running bubble (wall-clock header, no footer) as unsettled."""
    js = (pathlib.Path(__file__).resolve().parents[1] / "static" / "js" / "chatSubmitButton.js").read_text()
    assert "dataset.mode = 'streaming'" in js
    for name in ("live_short", "live_week"):
        busy = _load(name).BUSY_JS
        assert 'data-mode=\\"streaming\\"' in busy or 'data-mode="streaming"' in busy, name
        assert "stop" not in busy and "cancel" not in busy, name


def test_t13_zero_clocks_fails_a_clock_time_and_passes_a_part_of_the_day():
    # ORW-377: the house has no clocks. The bubble's own "07:41 PM" header stamp is not the narration and is ignored.
    for bad in ("By 8:15 the kitchen is full.", "She says she'll be up at 9 am.", "Nobody sleeps before ten o'clock."):
        assert not _score([_turn("premiere-1", bad)])["T13-zero-clocks[premiere-1]"]["ok"], bad
    for ok in ("Production 07:41 PM\nLate night settles over the kitchen.", "Morning light, Day 2.", "The afternoon drags; nobody hums ten amps of anything."):
        assert _score([_turn("premiere-1", ok)])["T13-zero-clocks[premiere-1]"]["ok"], ok


def test_the_report_carries_the_pass_bar_header_and_what_was_not_covered(tmp_path):
    import json
    (tmp_path / "meta.json").write_text(json.dumps({"sha": "abc12345", "ref": "main", "cap": "0.5", "model": "m"}))
    (tmp_path / "spend.json").write_text(json.dumps({"usd_estimate": 0.12}))
    ls.write(str(tmp_path), [], [], None)
    md = (tmp_path / "report.md").read_text()
    assert "`abc12345`" in md and "UTC" in md and "Arizona" in md and "$0.12 of a $0.5 cap" in md
    assert "Checked against the Live Run Pass Bar" in md and "T13 zero clocks" in md and "Not covered by the short tier" in md


def test_the_veto_draw_ceremony_hour_is_not_skipped_time():
    # ORW-281: the veto chip draw is a mini ceremony (about 1h of felt time), so its reply may move the clock about an hour on the veto morning.
    turns = [_turn("veto-morning-1", "x", phase="veto-competition", phase_before="veto-competition", clock="8:00am, Day 4"),
             # the sanctioned hour needs a reply that actually voices the draw (review of #2777); a quiet reply with the same jump still fails (tests/test_live_run_tooling.py)
             _turn("veto-morning-2", "The veto chips are drawn and Dana pulls hers: everyone is playing for the veto.", phase="veto-competition", phase_before="veto-competition", clock="9:10am, Day 4", msg="I listen to the draw.")]
    got = _score(turns)
    assert "K1-no-skipped-time[veto-morning-2]" not in got and got["K1-clock-jump-veto-draw[veto-morning-2]"]["ok"]


def test_a_raw_tool_tag_reply_is_machinery():
    # ORW-440: a whole reply of "</tool_use>" reached the player; the short tier must flag it.
    assert not _score([_turn("cross-evening-1", "Week 2 · Eviction night · Night</tool_use>")])["T3-no-machinery[cross-evening-1]"]["ok"]


# review follow-ups (ORW-481): one case per fixed scoring bug
def test_review_followups_scoring_regexes_and_clock():
    assert ls.LEAK_RE.search("The Vault holds the secrets") and not ls.LEAK_RE.search("the vault door was open")  # a sentence-start "The Vault" is machinery too
    assert not ls.PHANTOM_CER_RE.search("The nomination ceremony is tomorrow, and the house is nervous.")  # speculation about a later ceremony is not a ceremony voiced
    assert ls.PHANTOM_CER_RE.search("The nomination ceremony begins.")
    bad = _score([_turn("c", "The nominees are Aa Bb and then everyone left.", phase="hoh-competition", nominees=["Aa Bb", "Cc Dd"])])
    assert not [k for k in bad if k.startswith("C5-")], "a lowercase word after 'and' is not a second nominee name"
    assert ls.abs_hours("2:00am, Day 1") - ls.abs_hours("11:00pm, Day 1") == 3  # a night across midnight keeps one day number


def test_orw503_alone_is_still_checked_and_the_messages_own_skip_is_not_excused_by_runner_moves():
    txt = "The kitchen hums.\n\nMVMarisol Vance — \"Coffee?\""
    alone = _score([_turn("t1", txt, phase="hoh-competition", rooms_known=True)])
    assert not alone["C6-speakers-in-room[t1]"]["ok"], "an empty room is a real answer: a speaker nobody placed there is still flagged"
    nodata = _score([_turn("t1", txt, phase="hoh-competition", rooms_known=False)])
    assert "C6-speakers-in-room[t1]" not in nodata, "no whereabouts data: the check cannot judge, so it skips"
    a = _turn("t1", "x", clock="4:05pm, Day 1")
    ran = _score([a, _turn("t2", "x", clock="8:05am, Day 2", harness_jump=1, clock_pre_send="4:10pm, Day 1", msg="Can we start the competition?")])
    assert [c for k, c in ran.items() if k.startswith("K1-no-skipped-time")][0]["ok"] is False, "the runner moved nothing between pre-send and now: the message skipped the night"


def test_review_2839_player_out_matches_whole_first_names_and_legacy_rooms_skip():
    lw = _load("live_week")
    assert lw.first_name_evicted("Al Person", ["Alan Other"]) is False and lw.first_name_evicted("Al Person", ["al Other"]) is True
    legacy = _turn("legacy", "ABSomeone Name — hello there.", room_end=[], phase="hoh-competition")
    legacy.pop("rooms_known", None)
    assert not [k for k in _score([legacy]) if k.startswith("C6-")], "an older report without rooms_known is not read as an empty room"


def test_review_k2_boundary_and_k3_eviction_allowance():
    a = _turn("t1", "x", clock="4:05pm, Day 1")
    ok = _score([a, _turn("t2", "x", clock="5:35pm, Day 1", phase="nominations", phase_before="hoh-competition")])
    assert not [k for k in ok if k.startswith("K2-")], "the crown's 1.5h share is the allowed edge"
    over = _score([a, _turn("t2", "x", clock="5:41pm, Day 1", phase="nominations", phase_before="hoh-competition")])
    assert not [c for k, c in over.items() if k.startswith("K2-")][0]["ok"], "just above 1.5h is a competition in one message"
    due = {"next": "eviction", "phase": "evening", "due": True, "minutesUntil": 0}
    eight = [_turn(f"t{i}", "x", ds=due, phase="eviction", week=1) for i in range(1, 9)]
    assert not [k for k in _score(eight) if k.startswith("K3-")], "an eviction night gets 8 replies"
    nine = [_turn(f"t{i}", "x", ds=due, phase="eviction", week=1) for i in range(1, 10)]
    assert [k for k in _score(nine) if k.startswith("K3-")], "the 9th reply of an unfired eviction night fails"
