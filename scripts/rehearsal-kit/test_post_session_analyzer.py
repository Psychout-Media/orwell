"""A82 - tests for post_session_analyzer.py (it feeds every playtest report and had none). Tiny fixtures, offline. Run: python3 -m pytest rehearsal-kit/test_post_session_analyzer.py
Mutations that must go red: flip the sign of the timezone offset in parse_fe; swap the since-window comparison (an event or turn exactly AT `since` is included). Roles only."""
import datetime as dt
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import post_session_analyzer as psa  # noqa: E402

SINCE = dt.datetime(2026, 11, 5, 10, 0, 0)


def _w(path, text):
    path.write_text(text, encoding="utf-8")
    return str(path)


# ── parse_fe ──────────────────────────────────────────────────────────────────────────────────────────────
def test_parse_fe_converts_journald_offsets_to_utc(tmp_path):
    p = _w(tmp_path / "fe.log",
           "2026-11-05T12:00:00+0200 host orwell[1]: 2026-11-05 12:00:00,123 - routes.chat - WARNING - [orwell] a plus-two line\n"
           "2026-11-05T09:30:00-0100 host orwell[1]: 2026-11-05 09:30:00,5 - routes.chat - INFO - [orwell] a minus-one line\n"
           "2026-11-05T10:00:00Z host orwell[1]: 2026-11-05 10:00:00,9 - routes.chat - ERROR - [orwell] a zulu line\n"
           "2026-11-05T10:05:00+0000 host orwell[1]: no app prefix, raw journald text\n")
    ev = psa.parse_fe(p)
    assert ev[0] == (dt.datetime(2026, 11, 5, 10, 0, 0), "WARNING", "routes.chat", "[orwell] a plus-two line"), ev[0]
    assert ev[1][0] == dt.datetime(2026, 11, 5, 10, 30, 0), "-0100 means UTC is one hour LATER than the stamp"
    assert ev[2][0] == dt.datetime(2026, 11, 5, 10, 0, 0) and ev[2][1] == "ERROR"
    assert ev[3] == (dt.datetime(2026, 11, 5, 10, 5, 0), "INFO", "raw", "no app prefix, raw journald text")


def test_parse_fe_plain_app_log_uses_the_default_offset_and_missing_file_is_empty(tmp_path):
    p = _w(tmp_path / "app.log", "2026-11-05 12:00:00,100 - routes.chat - WARNING - [orwell] plain\nnot a log line at all\n")
    assert psa.parse_fe(p, offset_hours_default=2.0)[0][0] == dt.datetime(2026, 11, 5, 10, 0, 0)
    assert psa.parse_fe(p)[0][0] == dt.datetime(2026, 11, 5, 12, 0, 0)
    assert psa.parse_fe(str(tmp_path / "missing.log")) == []


# ── load_turns ────────────────────────────────────────────────────────────────────────────────────────────
def _db(tmp_path, rows):
    db = tmp_path / "app.db"
    c = sqlite3.connect(str(db))
    c.execute("create table chat_messages (session_id text, role text, content text, metadata text, timestamp text, seq integer)")
    c.executemany("insert into chat_messages values (?,?,?,?,?,?)", rows)
    c.commit(); c.close()
    return str(db)


def test_load_turns_pairs_user_and_assistant_drops_casting_and_respects_the_window(tmp_path):
    rows = [
        ("s1", "user", "casting hello", json.dumps({"phase": "casting"}), "2026-11-05 10:00:01", 1),
        ("s1", "assistant", "casting reply", json.dumps({"phase": "casting"}), "2026-11-05 10:00:05", 2),
        ("s1", "user", "game one", "{}", "2026-11-05 10:00:00", 3),  # exactly AT `since` => kept
        ("s1", "assistant", "reply one", json.dumps({"response_time": 4.5, "model": "m", "announcements": [{"kind": "hoh-competition"}, "junk"]}), "2026-11-05 10:00:09", 4),
        ("s1", "user", "game two", "{}", "2026-11-05 09:59:59", 5),  # one second BEFORE since => dropped
        ("s1", "assistant", "reply two", "{}", "2026-11-05 10:00:03", 6),
        ("s2", "user", "orphan user with no answer", "{}", "2026-11-05 10:30:00", 1),
    ]
    db = _db(tmp_path, rows)
    turns, casting = psa.load_turns(db, SINCE, None)
    assert casting == 1
    assert [t["user"] for t in turns] == ["game one"], turns
    t = turns[0]
    assert t["text"] == "reply one" and t["latency"] == 4.5 and t["model"] == "m" and t["ann"] == ["hoh-competition"]
    assert psa.load_turns(str(tmp_path / "nope.db"), SINCE, None) == ([], 0)
    until = dt.datetime(2026, 11, 5, 9, 0, 0)
    assert psa.load_turns(db, SINCE, until)[0] == []


# ── classify ──────────────────────────────────────────────────────────────────────────────────────────────
def test_classify_picks_the_first_table_hit_and_falls_back():
    table = (("veto", "veto winner/holder"), ("HOH", "head of household"))
    assert psa.classify("the veto and the HOH", table) == "veto winner/holder"
    assert psa.classify("only the HOH here", table) == "head of household"
    assert psa.classify("nothing", table) == "other" and psa.classify("nothing", table, default="x") == "x"


# ── analyze ───────────────────────────────────────────────────────────────────────────────────────────────
def _e(sec, lvl, msg, lg="routes.chat"):
    return (SINCE + dt.timedelta(seconds=sec), lvl, lg, msg)


def test_analyze_counts_strips_cuts_holes_errors_cards_and_the_since_boundary():
    turns = [{"start": SINCE, "end": SINCE + dt.timedelta(seconds=10), "user": "u", "text": "the live feeds cut away for a moment, then more text here", "md": {}, "latency": 4.0, "ttft": None, "model": "m", "out_tokens": 5, "ann": []},
             {"start": SINCE + dt.timedelta(seconds=60), "end": SINCE + dt.timedelta(seconds=65), "user": "u2", "text": "x", "md": {}, "latency": 1.0, "ttft": None, "model": "m", "out_tokens": 1, "ann": ["nominations"]}]
    events = [
        _e(-1, "WARNING", "[orwell] role-claim guard STRIPPED 1 unit: veto winner ← Rival wins the veto"),  # BEFORE since => excluded
        _e(0, "WARNING", "[orwell] role-claim guard STRIPPED 1 unit: HOH ← Alpha is the new HOH"),           # exactly AT since => included
        _e(2, "WARNING", "[orwell] scene circuit-breaker HELD a phantom board change for user=u — cutting the whole scene (phase=nominations; a NOMINATION it never made)"),
        _e(3, "ERROR", "something broke"),
        _e(4, "INFO", "decision submitted kind=eviction-vote"),
        _e(5, "WARNING", "[orwell] beat-signature desync detected for user=u — re-grounding next turn"),
        _e(70, "INFO", "production holds the competition until due"),
    ]
    llm = [{"ts": int((SINCE - dt.timedelta(seconds=5)).replace(tzinfo=dt.timezone.utc).timestamp() * 1000), "ok": False, "failClass": "old"},
           {"ts": int(SINCE.replace(tzinfo=dt.timezone.utc).timestamp() * 1000), "ok": False, "failClass": "timeout", "model": "m", "durationMs": 2000},
           {"ts": int((SINCE + dt.timedelta(seconds=9)).replace(tzinfo=dt.timezone.utc).timestamp() * 1000), "ok": True, "model": "m", "durationMs": 4000,
            "response": {"usage": {"cost": 0.25, "input_tokens": 10, "output_tokens": 5}}}]
    R = psa.analyze(events, turns, llm, SINCE, None)
    assert R["strip_total"] == 1 and dict(R["strips"]) == {"head of household": 1}, "the event AT since is counted, the one before is not"
    assert R["cut_total"] == 1 and "nomination ahead of the engine" in R["cuts"]
    assert R["holes"] == 1 and R["desync"] == 1 and R["prod_holds"] == 1
    assert sum(R["errors"].values()) == 1
    assert len(R["cards"]) == 1 and R["cards"][0][0] == "eviction-vote"
    assert R["llm"]["calls"] == 2 and R["llm"]["failed"] == 1 and dict(R["llm"]["by_class"]) == {"timeout": 1}, "an llm row before since is excluded, AT since is included"
    assert abs(R["llm"]["cost"] - 0.25) < 1e-9 and R["llm"]["tok_in"] == 10
    assert R["turns"] == 2 and R["event_turns"] == 1 and R["social_turns"] == 1
    assert R["lat"]["n"] == 2 and R["lat"]["max"] == 4.0


# ── clock_metrics ─────────────────────────────────────────────────────────────────────────────────────────
def test_clock_metrics_counts_accepted_vs_duplicate_notes_and_reads_the_save(tmp_path):
    events = [
        _e(1, "INFO", "noteMessage id=a accepted=True beatSeq=5"),
        _e(2, "INFO", "noteMessage id=a accepted=False beatSeq=5"),
        _e(3, "INFO", "noteMessage id=b accepted=true beatSeq=6"),
        _e(4, "WARNING", "noteMessage skipped: engine unreachable"),
        _e(5, "INFO", "reconciled a stale-beat 409"),
        _e(6, "INFO", "hang-out skipped: clock off"),
    ]
    save = tmp_path / "engine-save.json"
    save.write_text(json.dumps({"beatSeq": 9, "week": 1, "phase": "hoh-competition",
                                "live": {"nightDepth": 12.5, "timeOfDay": "afternoon", "hangOutCount": 2,
                                         "hangOutLog": [{"minutes": 30, "stopReason": "event-due"}, {"minutes": 45, "stopReason": "npc-approach"}]}}), encoding="utf-8")
    C = psa.clock_metrics(events, [{}, {}, {}], str(save))
    assert (C["note_accepted"], C["note_duplicate"], C["note_failed"], C["note_lines"]) == (2, 1, 1, 3)
    assert C["stale409"] == 1 and C["hangout_skipped"] == 1 and C["turns"] == 3
    assert C["save"]["hangouts"] == 2 and C["save"]["hangout_minutes"] == 75 and C["save"]["hour"] == 12.5
    assert dict(C["save"]["stops"]) == {"event-due": 1, "npc-approach": 1}
    assert psa.clock_metrics(events, [], None)["save"] is None
