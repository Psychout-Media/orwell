"""ORW-109: judging a game someone already played. The play daemon (scripts/rehearsal-kit/daemon.py) now logs every turn to turns.jsonl, and
scripts/live-run/judge_transcript.py turns that log into the same pass-bar report a live run writes. Proven with the live tier's own planted weeks: each stub week is
written as a daemon log, and the transcript judge must reach the live judge's verdict on it. No browser, no narrator, no network. Roles only."""
import json
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
for p in (ROOT / "scripts" / "live-run", ROOT / "scripts" / "rehearsal-kit"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import judge_transcript as jt  # noqa: E402
import live_full as lf  # noqa: E402


def _log(tmp_path, fault):
    """The stub week as the daemon would have logged it: the opening screen (a card-only line, no message), then one line per player turn."""
    steps, first = lf.stub_week(fault)
    reads = lambda st: {k: (st.get("screens") or {}).get(k) for k in ("state", "status", "whereabouts")}   # the stub's screens are the three route payloads the daemon logs
    lines = [dict({"n": 0, "msg": None, "bubbles": []}, **reads(first))]
    for i, s in enumerate(steps, start=1):
        lines.append(dict({"n": i, "msg": f"a player message {i}", "bubbles": [s["reply"]] if s["reply"] else [], "secs": 4.0}, **reads(s["state"])))
    path = tmp_path / "turns.jsonl"
    path.write_text("".join(json.dumps(x) + "\n" for x in lines) + '{"n": 999, "msg": "half a line', encoding="utf-8")   # a torn last line after a crash
    return tmp_path


def _live_verdict(tmp_path, fault):
    word, _md, _data = lf.run_stub(fault or "healthy", str(tmp_path / "live"))
    return word


def test_a_clean_played_week_passes_like_the_live_judge(tmp_path):
    run = _log(tmp_path, None)
    rc = jt.main(["--run-dir", str(run), "--build", "test", "--model", "stub"])
    assert rc == 0
    data = json.loads((run / "judge" / "report.json").read_text())
    assert data["verdict"] in ("PASS", "NOTE")
    assert _live_verdict(tmp_path, None) in ("PASS", "NOTE")


@pytest.mark.parametrize("fault,check", [("phantom", "T3"), ("stall", "S1"), ("orw10", "S1"), ("missing", "R1"), ("leak", "T6"), ("unanswered", "T5"), ("stand_in", "T1")])
def test_each_planted_fault_fails_the_played_transcript_on_its_check(tmp_path, fault, check):
    run = _log(tmp_path, fault)
    rc = jt.main(["--run-dir", str(run)])
    assert rc == 1, f"{fault}: the transcript judge should FAIL"
    data = json.loads((run / "judge" / "report.json").read_text())
    checks = {f["check"] for group in data["findings"].values() for f in group}   # the report groups only the failing findings, by category
    assert check in checks, f"{fault}: expected a failing {check}, got {sorted(checks)}"
    assert _live_verdict(tmp_path, fault) == "FAIL", f"{fault}: the live judge disagrees"


def test_a_card_answer_is_not_a_player_turn_and_a_torn_line_is_skipped(tmp_path):
    run = _log(tmp_path, None)
    entries, bad = jt.load_turns(run / "turns.jsonl")
    assert bad == 1
    rows = jt.rows_from_log(entries)
    assert len(rows) == len(entries) - 1   # the opening card-only line is not a turn
    assert rows[0]["phase_before"] is not None   # ...but it is the first turn's 'before' screen


def test_no_log_is_could_not_run_and_the_report_names_no_cast(tmp_path):
    assert jt.main(["--run-dir", str(tmp_path)]) == 2
    run = _log(tmp_path, "phantom")
    jt.main(["--run-dir", str(run)])
    md = (run / "judge" / "report.md").read_text()
    for name in ("Pa Aa", "Pb Bb", "Pc Cc"):
        assert name not in md and name.split()[0] not in md
    assert "a played transcript" in md


def test_T14_the_hud_must_read_early_morning_before_the_wake_up_and_only_then(tmp_path):
    run = _log(tmp_path, None)
    lines = [json.loads(x) for x in (run / "turns.jsonl").read_text().splitlines()[:-1]]
    # plant: two turns before the wake-up (the engine's flag on); one shows "Late night" (wrong), one "Early morning" (right); a later turn shows "Early morning" by day (wrong)
    for i, (flag, shown) in zip((1, 2, 3), ((True, "Late night, Day 2"), (True, "Early morning, Day 2"), (False, "Early morning, Day 3"))):
        lines[i]["status"] = dict(lines[i].get("status") or {}, earlyMorning=flag)
        lines[i]["hud_tod"] = shown
    (run / "turns.jsonl").write_text("".join(json.dumps(x) + "\n" for x in lines))
    assert jt.main(["--run-dir", str(run)]) == 1
    data = json.loads((run / "judge" / "report.json").read_text())
    t14 = [f for group in data["findings"].values() for f in group if f["check"] == "T14"]
    assert sorted(f["turn"] for f in t14) == ["turn-1", "turn-3"]


def test_T19_a_clear_move_must_move_the_player_before_the_reply(tmp_path):
    run = _log(tmp_path, None)
    lines = [json.loads(x) for x in (run / "turns.jsonl").read_text().splitlines()[:-1]]
    w = lambda room: {"whereabouts": {"room": room, "present": [], "roomNames": {"backyard": "The Garden"}}}
    lines[0]["whereabouts"] = w("kitchen")
    plan = [("I head over to the backyard to get some air.", "kitchen"),          # turn-1: not moved -> FAIL
            ("I go to the garden.", "backyard"),                                  # turn-2: the themed name, moved -> ok
            ("I leave the backyard.", "backyard"),                                # turn-3: did not leave -> FAIL
            ("Can I go to the kitchen?", "backyard"),                             # turn-4: a question: not judged
            ("I wander back to the bedroom.", "backyard")]                        # turn-5: 'bedroom' names three rooms: not judged
    for i, (msg, room) in enumerate(plan, start=1):
        lines[i]["msg"], lines[i]["whereabouts"] = msg, w(room)
        for k in ("state", "status"):
            if isinstance(lines[i].get(k), dict) and isinstance(lines[i][k].get("daySchedule"), dict):
                lines[i][k]["daySchedule"] = dict(lines[i][k]["daySchedule"], due=False)
    (run / "turns.jsonl").write_text("".join(json.dumps(x) + "\n" for x in lines))
    jt.main(["--run-dir", str(run)])
    data = json.loads((run / "judge" / "report.json").read_text())
    t19 = sorted(f["turn"] for group in data["findings"].values() for f in group if f["check"] == "T19")
    assert t19 == ["turn-1", "turn-3"]
