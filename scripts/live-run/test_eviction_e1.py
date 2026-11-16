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

    def play_pendings_until(self, phase, tag, max_steps=40):
        self.calls.append(("until", phase, max_steps)); return True

    def call(self, name, args=None):
        self.calls.append((name,))
        if name == "getGameState":
            ph = self.phases[0] if len(self.phases) == 1 else self.phases.pop(0)
            return {"phase": ph, "week": 1, "clockLabel": "9:00pm, Day 5", "player": {"name": "P"}}
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
