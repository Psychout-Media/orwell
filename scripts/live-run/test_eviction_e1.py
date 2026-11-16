"""ORW-506: offline tests for the forced-eviction E-1 entry point (eviction_e1.py) with fake engine/page objects. No browser, no rig, no model. Run: python3 -m pytest scripts/live-run/test_eviction_e1.py"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import eviction_e1 as ev  # noqa: E402


def test_turn_bound_is_clamped_and_never_unbounded():
    assert ev.bounded_turns(8) == 8 and ev.bounded_turns(0) == 1 and ev.bounded_turns(-5) == 1
    assert ev.bounded_turns(10**9) == ev.MAX_TURNS_CEILING
    assert ev.bounded_turns("x") == ev.DEFAULT_TURNS and ev.bounded_turns(None) == ev.DEFAULT_TURNS


def test_lines_cycle_and_name_nobody():
    assert ev.next_line(0) != ev.next_line(1)
    assert ev.next_line(len(ev.EVICTION_LINES)) == ev.next_line(0)
    assert all(l[:1].isupper() and "npc:" not in l for l in ev.EVICTION_LINES)


def test_evicted_names_reads_dicts_strings_and_junk():
    assert ev.evicted_names({"evicted": [{"name": "A B"}, "C", {"nope": 1}, None]}) == ["A B", "C"]
    assert ev.evicted_names(None) == [] and ev.evicted_names({"evicted": None}) == [] and ev.evicted_names("x") == []


def test_night_resolved_needs_engine_truth_not_prose():
    assert not ev.night_resolved({"week": 1}, [], 1, [])
    assert ev.night_resolved({"week": 1}, [], 1, ["A"])           # one more evicted
    assert ev.night_resolved({"week": 2}, [], 1, [])              # the week moved on
    assert not ev.night_resolved({"week": None}, ["A"], 1, ["A"])
    assert not ev.night_resolved({}, [], None, [])


class _Eng:
    def __init__(self, phases):
        self.phases, self.calls, self.recap = list(phases), [], []

    def hour(self): return (12, 0)

    def play_pendings_until(self, phase, tag, max_steps=40):
        self.calls.append(("until", phase, max_steps)); return True

    def call(self, name, args=None):
        self.calls.append((name,))
        if name == "getGameState":
            ph = self.phases[0] if len(self.phases) == 1 else self.phases.pop(0)
            return {"phase": ph, "week": 1, "clockLabel": "9:00pm, Day 5", "player": {"name": "P"}, "daySchedule": {"minutesUntil": 20, "due": False}}
        if name == "seasonRecap": return {"evicted": self.recap}
        return {}


class _Page:
    def evaluate(self, js, *a): return None


class _Chat:
    page, base = _Page(), "http://x"


def test_run_stops_without_playing_when_eviction_is_not_reached():
    checks, played = [], []
    eng = _Eng(["veto-ceremony"])
    ev.run(eng, lambda l, t: played.append(l), lambda cid, ok, d, sev="fail": checks.append((cid, ok, sev)), _Chat(), 3)
    assert checks == [("E1-reached-eviction-night", False, "fail")] and not played
    assert ("until", "eviction", 80) in eng.calls    # forced entry stops AT the eviction phase


def test_run_plays_only_the_bounded_turns_then_reports_unresolved():
    checks, played = [], []
    eng = _Eng(["eviction"])
    ev.run(eng, lambda l, t: played.append(l), lambda cid, ok, d, sev="fail": checks.append((cid, ok, sev)), _Chat(), 3)
    assert played == ["eviction-1", "eviction-2", "eviction-3"]
    ids = {c[0]: c[1] for c in checks}
    assert ids["E1-reached-eviction-night"] and ids["E2-eviction-resolved"] is False and ids["E3-no-stuck-card"]


def test_run_resolves_when_the_engine_records_an_evictee():
    checks, played = [], []
    eng = _Eng(["eviction"])
    def play(l, t): played.append(l); eng.recap = [{"name": "N"}]
    ev.run(eng, play, lambda cid, ok, d, sev="fail": checks.append((cid, ok, sev)), _Chat(), 5)
    assert played == ["eviction-1"] and dict((c[0], c[1]) for c in checks)["E2-eviction-resolved"] is True


def test_live_short_refuses_both_eviction_drivers_at_once():
    import subprocess
    here = os.path.dirname(os.path.abspath(__file__))
    r = subprocess.run([sys.executable, os.path.join(here, "live_short.py"), "--run-dir", "/nonexistent", "--eviction", "--crossover"], capture_output=True, text=True)
    assert r.returncode == 2 and "pick one" in r.stderr


def test_a_card_on_eviction_night_is_answered_through_the_weeks_own_card_turn(monkeypatch):
    """Live finding (ORW-506 E-1 run): the card branch crashed on a bare int; it must go through live_week's card_turn."""
    answered = []

    class _W:
        def __init__(self, *a, **k): self.name_fn = None
        def card_turn(self): answered.append(1); return {"label_extra": "pick 1"}

    cards = iter([{"kind": "vote"}, None, None, None, None, None, None, None])

    class _P:
        def evaluate(self, js, *a): return next(cards, None)

    class _C:
        page, base = _P(), "http://x"

    import sys, types
    fake = types.ModuleType("live_week"); fake.Week = _W; fake.CARD = "() => card"
    monkeypatch.setitem(sys.modules, "live_week", fake)
    checks = []
    eng = _Eng(["eviction"])
    ev.run(eng, lambda l, t: None, lambda cid, ok, d, sev="fail": checks.append((cid, ok, sev)), _C(), 2)
    assert answered == [1] and ("E3-card-answered[1]", True, "note") in checks


class _ClockEng:
    """minutesUntil falls 5 per message tick; the hour jumps to 24 at one point so the bed path runs."""
    def __init__(self, start, night_at=None):
        self.mu, self.ticks, self.slept, self.night_at, self.tomorrow = start, 0, 0, night_at, False
    hang = False
    def call(self, name, args=None):
        if name == "getGameState": return {"daySchedule": {"minutesUntil": self.mu, "due": self.mu <= 0, "tomorrow": self.tomorrow}}
        if name == "hangOut" and self.hang: self.hangs = getattr(self, "hangs", 0) + 1; self.mu -= 180; return {}
        if name == "hangOut": raise RuntimeError("refused")
        if name == "noteMessage": self.ticks += 1; self.mu -= 5
        return {}
    def hour(self): return (24, 0) if self.night_at is not None and self.ticks == self.night_at and not self.slept else (14, 0)
    def sleep_through_night(self, tag): self.slept += 1; self.mu -= 60


def test_the_clock_is_moved_by_engine_ticks_to_30_minutes_before_the_ceremony():
    e = _ClockEng(1290)
    assert ev.advance_to_due(e) is True
    assert 0 < e.mu <= 30 and e.ticks == (1290 - e.mu) // 5   # ticks only; no model call, no overshoot past the near-due mark


def test_the_night_goes_to_bed_and_the_bound_stops_a_clock_that_never_moves():
    e = _ClockEng(600, night_at=10)
    assert ev.advance_to_due(e) is True and e.slept == 1
    class _Stuck(_ClockEng):
        def call(self, name, args=None):
            if name == "noteMessage": self.ticks += 1; return {}
            return super().call(name, args)
    assert ev.advance_to_due(_Stuck(600), max_ticks=40) is False


def test_a_near_clock_does_not_count_while_the_ceremony_is_still_tomorrow():
    """ORW-548 (by design, ORW-258): the eviction waits behind the night; the E-1 clock mark needs `tomorrow` cleared."""
    e = _ClockEng(20); e.tomorrow = True
    assert ev.advance_to_due(e, max_ticks=10) is False     # 20 minutes away but still behind the night
    e.tomorrow = False
    assert ev.advance_to_due(e) is True


def test_the_clock_moves_in_big_hang_out_steps_and_falls_back_to_ticks_when_it_is_refused():
    e = _ClockEng(1290); e.hang = True
    assert ev.advance_to_due(e) is True
    assert e.hangs >= 6 and e.ticks <= 6 and 0 < e.mu <= 30      # ~3 hours a call, never 258 five-minute saves
    r = _ClockEng(120)                                           # hangOut refused: ticks still get there
    assert ev.advance_to_due(r) is True and r.ticks > 0
