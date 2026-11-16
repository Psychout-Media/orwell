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
    cross = ls.not_covered([{"id": "G1-x"}, {"id": "X0-reached-eviction-night"}])
    assert any("stops at the Week 1 veto morning" in x for x in plain)
    assert not any("stops at the Week 1 veto morning" in x for x in cross) and any("Week 2" in x for x in cross)
    # a --rescore keeps only the turns (the live X0 check is gone): the crossover turns still say the run went past the veto morning (review of #2795)
    assert ls.not_covered([{"id": "G1-x"}], [{"label": "veto-morning-1"}, {"label": "cross-bed"}]) == cross
    assert ls.not_covered([{"id": "G1-x"}], [{"label": "veto-morning-1"}]) == plain


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
