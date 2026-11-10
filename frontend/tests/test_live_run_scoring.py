"""ORW-109: the live-run short tier scores replies against engine truth. These pin the scoring (no browser, no narrator): each of Ryne's playtest bugs
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
    comp = _score([a, _turn("t2", "x", clock="7:10pm, Day 1", phase="nominations", phase_before="hoh-competition")])
    assert [c for k, c in comp.items() if k.startswith("K1-clock-jump-competition")][0]["severity"] == "note"
