"""ORW-437 (review of #2777, the ORW-109 live-run short tier): the pure parts of the live-run and rehearsal-kit tooling. No browser, no narrator, no rig:
every shell helper is sourced into a throwaway bash and the Python scoring is called with fabricated turns. Roles only."""
import importlib.util
import json
import os
import pathlib
import subprocess

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
LIVE = ROOT / "scripts" / "live-run"
KIT = ROOT / "scripts" / "rehearsal-kit"
_spec = importlib.util.spec_from_file_location("live_short", LIVE / "live_short.py")
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


def _sh(script, env=None):
    r = subprocess.run(["bash", "-c", script], capture_output=True, text=True, timeout=30, env={**os.environ, **(env or {})})
    return r


# ── scripts/live-run/live_short.py ─────────────────────────────────────────────────────────────────────────────────────
def test_only_the_schedule_hold_waits_for_the_event_a_night_hold_is_a_bed():
    assert ls.is_schedule_hold({"next": "nominations", "minutesUntil": 40, "reason": "schedule"})
    # the night hold carries `next` and a positive minutesUntil too (GameSessionAdapter's night hold), but no reason
    assert not ls.is_schedule_hold({"next": "nominations", "minutesUntil": 300})
    assert not ls.is_schedule_hold({"next": "nominations", "minutesUntil": 40, "reason": "ceremony"})
    assert not ls.is_schedule_hold({"next": "bedtime", "minutesUntil": 40, "reason": "schedule"})
    assert not ls.is_schedule_hold({"next": "nominations", "minutesUntil": 0, "reason": "schedule"})
    assert not ls.is_schedule_hold(None) and not ls.is_schedule_hold("held")


def test_a_bare_mention_of_a_nap_does_not_excuse_a_clock_jump():
    assert ls.NAP_MSG_RE.search("I take a nap in my room") and ls.NAP_MSG_RE.search("grab a nap")
    assert not ls.NAP_MSG_RE.search("The NPC says her nap was great, what is everyone doing?")
    a = _turn("t1", "x", clock="4:05pm, Day 1")
    r = _score([a, _turn("t2", "x", clock="8:05am, Day 2", msg="The NPC mentioned a nap. What is the plan?")])
    assert not [c for k, c in r.items() if k.startswith("K1-no-skipped-time")][0]["ok"]


def test_the_veto_draw_allowance_needs_a_reply_that_voices_the_draw():
    a = _turn("t1", "x", clock="9:00am, Day 3", phase="veto-competition", phase_before="veto-competition")
    drawn = _turn("t2", "The veto chips are drawn: the HOH pulls the chip and everyone is playing for the veto.", clock="10:10am, Day 3", phase="veto-competition", phase_before="veto-competition")
    quiet = _turn("t2", "The house chats about breakfast and the weather.", clock="10:10am, Day 3", phase="veto-competition", phase_before="veto-competition")
    assert [c for k, c in _score([a, drawn]).items() if k.startswith("K1-clock-jump-veto-draw")][0]["severity"] == "note"
    r = _score([a, quiet])
    assert not [k for k in r if k.startswith("K1-clock-jump-veto-draw")]
    assert not [c for k, c in r.items() if k.startswith("K1-no-skipped-time")][0]["ok"], "an hour of unexplained time still fails"


@pytest.mark.parametrize("bad", ["By noon the kitchen is loud.", "At midnight the house goes quiet.", "It's noon and nobody has eaten.", "It is almost midnight.", "Lunch at noon sharp.",
                                 "Nobody stays up past midnight.", "By 8:15 the kitchen is full."])
def test_a_noon_or_midnight_time_phrase_is_a_clock_time(bad):
    assert not _score([_turn("premiere-1", bad)])["T13-zero-clocks[premiere-1]"]["ok"], bad


@pytest.mark.parametrize("fine", ["Noon sun hits the kitchen.", "Midnight snack, anyone?", "She wears the midnight-blue dress.", "A high noon standoff at the pool table.",
                                  "The noon-day heat is heavy.", "Morning light, Day 2."])
def test_noon_and_midnight_as_plain_words_are_not_clock_times(fine):
    assert _score([_turn("premiere-1", fine)])["T13-zero-clocks[premiere-1]"]["ok"], fine


class _Page:
    def __init__(self, cards): self.cards = cards
    def evaluate(self, js): return next((v for k, v in self.cards.items() if k in js), "")


class _Eng:
    def call(self, name): return {"awake": [{"name": "NPC-A Role"}], "asleep": [], "whereabouts": {"present": []}}


class _Chat:
    def __init__(self, cards): self.page = _Page(cards)


def _widget_checks(cards):
    out = []
    ls.widgets(_Eng(), lambda cid, ok, detail, severity="fail": out.append((cid, ok, severity)), _Chat(cards), "morning")
    return out


def test_a_missing_widget_is_recorded_not_skipped_silently():
    ids = {c[0].split("[")[0]: c for c in _widget_checks({})}
    assert ids["N7-widget-missing"][1] is False and ids["N8-widget-missing"][1] is False
    present = {c[0].split("[")[0] for c in _widget_checks({"orwell-night": "Awake: NPC-A", "orwell-presence": "With you: nobody"})}
    assert "N7-widget-missing" not in present and "N8-widget-missing" not in present and "N7-widget-lists-the-awake" in present


def test_the_coverage_list_follows_whether_the_crossover_ran():
    plain = ls.not_covered([{"id": "G1-x"}])
    cross = ls.not_covered([{"id": "G1-x"}, {"id": "X0-reached-eviction-night", "ok": True}])
    assert any("stops at the Week 1 veto morning" in x for x in plain)
    assert not any("stops at the Week 1 veto morning" in x for x in cross) and any("Week 2" in x for x in cross)
    # a --rescore keeps only the turns (the live X0 check is gone): the crossover turns still say the run went past the veto morning (review of #2795)
    assert ls.not_covered([{"id": "G1-x"}], [{"label": "veto-morning-1"}, {"label": "cross-bed", "x0_ok": True}]) == cross
    assert ls.not_covered([{"id": "G1-x"}], [{"label": "veto-morning-1"}]) == plain
    # review of #2854: the crossover turns are played even when X0 failed; a failed X0 (live, or saved with the turns) or a turn without the flag is not Week 2
    assert ls.not_covered([{"id": "G1-x"}, {"id": "X0-reached-eviction-night", "ok": False}], [{"label": "cross-bed", "x0_ok": False}]) == plain
    assert ls.not_covered([{"id": "G1-x"}], [{"label": "cross-bed", "x0_ok": False}]) == plain
    assert ls.not_covered([{"id": "G1-x"}], [{"label": "cross-bed"}]) == plain


def test_a_rescore_restores_the_saved_x0_verdict():
    checks = []
    rec = lambda cid, ok, detail, severity="fail": checks.append({"id": cid, "ok": bool(ok), "severity": severity})
    ls.rescore_x0([{"label": "veto-morning-1"}, {"label": "cross-bed", "x0_ok": False}], rec)
    assert checks == [{"id": "X0-reached-eviction-night", "ok": False, "severity": "fail"}]
    checks.clear(); ls.rescore_x0([{"label": "veto-morning-1"}], rec)
    assert checks == []


# ── scripts/rehearsal-kit/stage2.sh ────────────────────────────────────────────────────────────────────────────────────
def test_an_env_override_value_is_never_glob_expanded(tmp_path):
    (tmp_path / "ORWELL_A=from-a-file").write_text("")   # a file the pattern would match
    r = _sh(f'cd "{tmp_path}"; . "{KIT}/env_override.sh"; rig_apply_env_override "ORWELL_A=* ORWELL_B=1"; echo "[$ORWELL_A][$ORWELL_B]"')
    assert r.returncode == 0 and r.stdout.strip() == "[*][1]", (r.stdout, r.stderr)


def test_a_bad_env_override_entry_fails_loudly():
    ok = _sh(f'. "{KIT}/env_override.sh"; rig_apply_env_override "ORWELL_A=0 ORWELL_B=1"; echo "$ORWELL_A$ORWELL_B"')
    assert ok.returncode == 0 and ok.stdout.strip() == "01"
    for bad in ("ORWELL_A=0 ORWEL_B=1", "ORWELL_A", "orwell_a=1", "ORWELL_=1x ORWELL A=1", "ORWELL_A=0,ORWELL_B=1", "ORWELL_A=0;ORWELL_B=1", "ORWELL_A=x_ORWELL_B=1"):
        for fn in ("rig_validate_env_override", "rig_apply_env_override"):
            r = _sh(f'. "{KIT}/env_override.sh"; {fn} "{bad}"')
            assert r.returncode == 1 and "FATAL" in r.stderr, (fn, bad)
    assert _sh(f'. "{KIT}/env_override.sh"; rig_validate_env_override "ORWELL_A=a,b ORWELL_B=0"').returncode == 0, "a comma that is not followed by another ORWELL_ assignment is a value"
    # review of #2854: a multiline override is checked on every line, and every line is applied
    for fn in ("rig_validate_env_override", "rig_apply_env_override"):
        r = _sh(f'. "{KIT}/env_override.sh"; {fn} "ORWELL_A=1' + "\n" + 'BAD"')
        assert r.returncode == 1 and "FATAL" in r.stderr and "BAD" in r.stderr, (fn, r.stdout, r.stderr)
    two = _sh(f'. "{KIT}/env_override.sh"; rig_apply_env_override "ORWELL_A=1' + "\n" + 'ORWELL_B=2"; echo "[$ORWELL_A][$ORWELL_B]"')
    assert two.returncode == 0 and two.stdout.strip() == "[1][2]", (two.stdout, two.stderr)
    src = (KIT / "stage2.sh").read_text()
    # the validation runs before anything is checked out or built
    assert src.index('rig_validate_env_override "${RIG_ENV_OVERRIDE:-}" || exit 1') < src.index('git -C "$RIG_HOME/orwell" fetch') < src.index("npm run build")
    assert 'rig_apply_env_override "${RIG_ENV_OVERRIDE:-}" || exit 1' in src


# ── scripts/live-run/run_short.sh helpers ──────────────────────────────────────────────────────────────────────────────
@pytest.mark.parametrize("cap,valid", [("0.5", True), ("3", True), (".25", True), ("0", False), ("abc", False), ("", False), ("-1", False), ("nan", False), ("inf", False), ("1e3", False), ("0.5.1", False)])
def test_the_spend_cap_must_be_a_finite_positive_number(cap, valid):
    r = _sh(f'. "{LIVE}/short_lib.sh"; short_valid_cap "{cap}"')
    assert (r.returncode == 0) is valid, (cap, r.stderr)


def test_the_report_spend_line_is_brought_up_to_date_after_the_final_recount(tmp_path):
    (tmp_path / "report.md").write_text("# x\n\n- Build: `abc`\n- Spend: $0.01 of a $0.5 cap\n\nrest\n")
    (tmp_path / "spend.json").write_text(json.dumps({"usd_estimate": 0.2345}))
    assert _sh(f'. "{LIVE}/short_lib.sh"; short_patch_spend "{tmp_path}"').returncode == 0
    t = (tmp_path / "report.md").read_text()
    assert "- Spend: $0.2345 of a $0.5 cap" in t and "rest" in t


def test_a_capped_run_leaves_a_report_that_says_nothing_was_scored(tmp_path):
    (tmp_path / "spend.json").write_text(json.dumps({"usd_estimate": 0.51}))
    (tmp_path / "live_short.out").write_text("turn 3 played\n")
    assert _sh(f'. "{LIVE}/short_lib.sh"; short_partial_report "{tmp_path}" abc12345 0.5').returncode == 0
    t = (tmp_path / "report.md").read_text()
    assert "CAPPED" in t and "NO checks were scored" in t and "$0.51" in t and "turn 3 played" in t
    # the driver finished and scored, then the final recount passed the cap: its checks are kept, but the title no longer says PASS (review of #2795)
    (tmp_path / "report.md").write_text("# Live run (short tier) - PASS\n\nthe driver's own checks\n")
    for _ in range(2):   # idempotent
        assert _sh(f'. "{LIVE}/short_lib.sh"; short_partial_report "{tmp_path}" abc12345 0.5').returncode == 0
    t = (tmp_path / "report.md").read_text()
    assert t.startswith("# Live run (short tier) - CAPPED (") and "$0.5 cap" in t.splitlines()[0] and "PASS" not in t and "the driver's own checks" in t, t


def test_run_short_turns_the_crossover_on_only_for_the_value_one():
    src = (LIVE / "run_short.sh").read_text()
    assert 'CROSS=(); [ "${RIG_CROSSOVER:-}" = 1 ] && CROSS=(--crossover)' in src and "${RIG_CROSSOVER:+--crossover}" not in src
    assert 'short_valid_cap "$CAP"' in src and src.index('short_valid_cap "$CAP"') < src.index("stage2.sh")
    assert src.index("short_patch_spend") < src.index('cp "$RUN/report.md"')


def test_dev_watch_records_an_in_flight_verdict_and_keeps_its_period():
    src = (LIVE / "dev_watch.sh").read_text()
    assert "trap 'STOP=1' TERM INT" in src and 'wait "$child"' in src and "left=$(( POLL - (" in src
    assert "watch.log" in src and "watch-<slot>.log" in src
    assert _sh(f'bash -n "{LIVE}/dev_watch.sh" && bash -n "{LIVE}/run_short.sh" && bash -n "{LIVE}/short_lib.sh"').returncode == 0


# ── review follow-ups (PR #2852): cancellation, the capped-run record, and the scoring regexes ───────────────────────────────────────────────
import signal
import time


def _stub_rig(tmp_path, driver_body="exec sleep 30"):
    """A throwaway rig: a stub kit (slot.sh, stage2.sh, stop.sh, spend_guard.py), a stub git and a stub driver python. Returns (env, paths)."""
    home = tmp_path / "home"; kit = tmp_path / "kit"; bindir = tmp_path / "bin"; state = tmp_path / "state"; wt = tmp_path / "wt"; run = tmp_path / "run"
    for d in (home / "orwell" / "frontend" / ".venv" / "bin", kit, bindir, state, wt / "frontend" / "data"):
        d.mkdir(parents=True)
    (wt / "frontend" / "data" / "settings.json").write_text("{}")
    (kit / "slot.sh").write_text(f"RIG_HOME={home}; RIG_SLOT=1; RIG_SUFFIX=''; RIG_STATE_DIR={state}; RIG_LOCK={state}/rig.lock; RIG_RUN_PTR={tmp_path}/ptr; WT={wt}; RIG_BASE=http://127.0.0.1:1; RIG_ENGINE_URL=http://127.0.0.1:2\n")
    (kit / "stage2.sh").write_text(f"#!/usr/bin/env bash\nmkdir -p {run}; echo {run} > {tmp_path}/ptr\n")
    (kit / "stop.sh").write_text(f"#!/usr/bin/env bash\necho stopped >> {tmp_path}/stop.log\n")
    (kit / "spend_guard.py").write_text("import sys, time\nif '--once' not in sys.argv: time.sleep(30)\n")
    (bindir / "git").write_text("#!/usr/bin/env bash\ncase \"$*\" in *rev-parse*) echo abcd1234;; esac\nexit 0\n")
    driver = bindir / "driver"
    driver.write_text(f"#!/usr/bin/env bash\necho $$ > {tmp_path}/driver.pid\n{driver_body}\n")
    for f in (kit / "stage2.sh", kit / "stop.sh", bindir / "git", driver):
        f.chmod(0o755)
    (home / "orwell" / "frontend" / ".venv" / "bin" / "python3").symlink_to(driver)
    env = {**os.environ, "ORWELL_KIT": str(kit), "ORWELL_PY": str(driver), "PATH": f"{bindir}:{os.environ['PATH']}", "RIG_ZERO_CLOCKS": "1"}
    return env, {"run": run, "state": state, "stop": tmp_path / "stop.log", "driver_pid": tmp_path / "driver.pid"}


def _alive(pid):
    try: os.kill(pid, 0)
    except ProcessLookupError: return False
    return True


@pytest.mark.skipif(not __import__("shutil").which("flock"), reason="needs flock")
@pytest.mark.parametrize("script,args,sig,rc", [("run_short.sh", [], signal.SIGTERM, 143), ("run_short.sh", [], signal.SIGINT, 130), ("season.sh", [], signal.SIGTERM, 143), ("season_resume.sh", [], signal.SIGTERM, 143)])
def test_a_cancelled_run_kills_its_children_and_stops_the_rig(tmp_path, script, args, sig, rc):
    env, p = _stub_rig(tmp_path)
    if script == "season_resume.sh": (p["run"]).mkdir(); (tmp_path / "ptr").write_text(str(p["run"]) + "\n")
    proc = subprocess.Popen(["bash", str(LIVE / script), *args], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, start_new_session=True)
    try:
        for _ in range(100):
            if p["driver_pid"].exists() and p["driver_pid"].read_text().strip() and (script != "run_short.sh" or (p["run"] / "spend.pid").exists()): break
            time.sleep(0.1)
        kids = [int(p["driver_pid"].read_text())] + ([int((p["run"] / "spend.pid").read_text())] if script == "run_short.sh" else [])
        proc.send_signal(sig)  # to the script ONLY, not its process group
        assert proc.wait(timeout=10) == rc, "the trap fires promptly (a foreground child would delay it) and the script ends"
        assert p["stop"].exists() and "stopped" in p["stop"].read_text(), "the rig is stopped"
        time.sleep(0.2)
        assert not [k for k in kids if _alive(k)], "the driver and the spend guard are both gone"
    finally:
        proc.kill()
        for f in (p["driver_pid"], p["run"] / "spend.pid"):
            if f.exists():
                try: os.kill(int(f.read_text()), signal.SIGKILL)
                except (ProcessLookupError, ValueError): pass


@pytest.mark.skipif(not __import__("shutil").which("flock"), reason="needs flock")
def test_a_capped_run_is_recorded_as_run_so_if_new_does_not_re_spend_the_cap(tmp_path):
    # the spend guard TERMs the driver: it exits 143 with SPEND-CAP-HIT set. That run happened and spent its cap.
    env, p = _stub_rig(tmp_path, driver_body=f'touch {tmp_path}/run/SPEND-CAP-HIT; exit 143')
    r = subprocess.run(["bash", str(LIVE / "run_short.sh"), "--if-new"], env=env, capture_output=True, text=True, timeout=30)
    assert r.returncode == 4 and "LIVE-SHORT CAPPED abcd1234" in r.stdout, r.stdout + r.stderr
    assert (p["state"] / "last-sha").read_text().strip() == "abcd1234"
    again = subprocess.run(["bash", str(LIVE / "run_short.sh"), "--if-new"], env=env, capture_output=True, text=True, timeout=30)
    assert "SKIPPED abcd1234" in again.stdout


@pytest.mark.skipif(not __import__("shutil").which("flock"), reason="needs flock")
def test_a_run_that_could_not_run_is_not_recorded(tmp_path):
    env, p = _stub_rig(tmp_path, driver_body="exit 2")
    r = subprocess.run(["bash", str(LIVE / "run_short.sh")], env=env, capture_output=True, text=True, timeout=30)
    assert r.returncode == 2 and not (p["state"] / "last-sha").exists()


def test_the_resume_takes_the_rig_lock_on_fd_9():
    assert 'exec 9>"$RIG_LOCK"; flock -n 9 ||' in (LIVE / "season_resume.sh").read_text()  # the whole acquisition line, not any mention of it


@pytest.mark.parametrize("text", ["The nomination ceremony is now scheduled for tomorrow.", "The nomination ceremony is now at 5pm tomorrow."])
def test_later_status_talk_is_not_a_phantom_ceremony(text):
    assert not ls.PHANTOM_CER_RE.search(text)


@pytest.mark.parametrize("text", ["The nomination ceremony is now starting.", "The nomination ceremony is now underway.", "The nomination ceremony begins.", "You're on the block.", "You\u2019re on the block.", "She's now on the block.", "They are on the block."])
def test_a_definitive_ceremony_reveal_is_a_phantom_ceremony(text):
    assert ls.PHANTOM_CER_RE.search(text)


def test_only_a_real_final_hoh_part_transition_excuses_a_clock_jump():
    a = _turn("t1", "x", clock="9:00am, Day 9", phase="hoh-competition", phase_before="hoh-competition")
    moved = _turn("t2", "x", clock="1:00pm, Day 9", phase="hoh-competition", phase_before="hoh-competition", part_before=1, ds={"finalHohPart": 2})
    same = _turn("t2", "x", clock="1:00pm, Day 9", phase="hoh-competition", phase_before="hoh-competition", part_before=2, ds={"finalHohPart": 2})
    assert [k for k in _score([a, moved]) if k.startswith("K1-clock-jump-competition")]
    assert not [k for k in _score([a, same]) if k.startswith("K1-clock-jump-competition")]



def test_a_rescore_keeps_the_live_only_checks_and_the_saved_error():
    """Review of the ORW-109 rescore: G1/G2/P1 are made only while the game plays; a rescore that drops them turned a failed run into a PASS."""
    saved = {"error": None, "checks": [
        {"id": "G1-game-started", "ok": True, "severity": "fail", "detail": "x"},
        {"id": "G2-reached-veto-morning", "ok": False, "severity": "fail", "detail": "phase premiere"},
        {"id": "P1-production-hold", "ok": False, "severity": "fail", "detail": "hoh set"},
        {"id": "A2-arrivals-progress", "ok": True, "severity": "fail", "detail": "recomputed by score(), not kept"}]}
    checks = []
    ls.keep_live_checks(saved, checks)
    assert [c["id"] for c in checks] == ["G1-game-started", "G2-reached-veto-morning", "P1-production-hold"]
    assert [c for c in checks if not c["ok"] and c["severity"] == "fail"], "the saved failures still fail the rescored run"
    keep = []; ls.keep_live_checks({}, keep); assert keep == []
