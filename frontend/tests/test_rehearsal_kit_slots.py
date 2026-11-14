"""ORW-344: the rehearsal kit has two rig slots (RIG_SLOT). Slot 1 is today's rig byte for byte; slot 2 shares nothing with it. Pure shell/python checks; nothing is started, nothing is spent."""
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import time

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
KIT = ROOT / "scripts" / "rehearsal-kit"
LIVE = ROOT / "scripts" / "live-run"
VARS = ["RIG_SLOT", "RIG_ENGINE_PORT", "RIG_FE_PORT", "WT", "RIG_RUN_PTR", "RIG_LOCK", "RIG_RUN_PREFIX", "RIG_SUFFIX", "RIG_BASE", "RIG_ENGINE_URL"]


def _slot(slot=None, extra_env=None, cwd=KIT):
    env = {k: v for k, v in os.environ.items() if not k.startswith("RIG_") and k not in ("ORWELL_LIVE_STATE", "ORWELL_PLAYTEST_DIR")}
    if slot is not None:
        env["RIG_SLOT"] = str(slot)
    env.update(extra_env or {})
    prog = '. "$1"; ' + "; ".join(f'echo "{v}=${v}"' for v in VARS)
    r = subprocess.run(["bash", "-c", prog, "x", str(KIT / "slot.sh")], capture_output=True, text=True, env=env, cwd=cwd)
    return r.returncode, dict(ln.split("=", 1) for ln in r.stdout.splitlines() if "=" in ln), r.stderr


# What the rig has ALWAYS used (the literals the scripts carried before slots): slot 1 must never drift from these.
SLOT1 = {"RIG_SLOT": "1", "RIG_ENGINE_PORT": "18765", "RIG_FE_PORT": "17000", "WT": "/home/ryne/orwell-rehearsal", "RIG_RUN_PTR": "/tmp/claude-1000/a11_run",
         "RIG_LOCK": "/home/ryne/orwell-playtest/live-short/rig.lock", "RIG_RUN_PREFIX": "rehearsal-", "RIG_SUFFIX": "",
         "RIG_BASE": "http://127.0.0.1:17000", "RIG_ENGINE_URL": "http://127.0.0.1:18765"}


def test_slot_one_is_exactly_todays_rig_whether_or_not_the_variable_is_set():
    for slot in (None, 1):
        rc, got, _ = _slot(slot)
        assert rc == 0 and got == SLOT1, got


def test_slot_two_shares_nothing_with_slot_one():
    rc, two, _ = _slot(2)
    assert rc == 0
    for k in ("RIG_ENGINE_PORT", "RIG_FE_PORT", "WT", "RIG_RUN_PTR", "RIG_LOCK", "RIG_RUN_PREFIX", "RIG_BASE", "RIG_ENGINE_URL"):
        assert two[k] != SLOT1[k], f"slot 2 must not reuse slot 1's {k}"
    assert two["RIG_ENGINE_PORT"] == "18766" and two["RIG_FE_PORT"] == "17001"
    assert pathlib.Path(two["RIG_LOCK"]).name == "rig-2.lock" and pathlib.Path(two["RIG_LOCK"]).parent == pathlib.Path(SLOT1["RIG_LOCK"]).parent, "rig-2.lock sits beside rig.lock"
    assert not two["WT"].startswith(SLOT1["WT"] + "/") and two["WT"] != SLOT1["WT"], "its own worktree, not inside slot 1's"
    assert two["RIG_RUN_PREFIX"] == "slot2-rehearsal-" and not two["RIG_RUN_PREFIX"].startswith(SLOT1["RIG_RUN_PREFIX"]), "a glob of slot 1's run dirs never matches slot 2's"


def test_an_unknown_slot_is_refused_not_guessed():
    rc, _, err = _slot(3)
    assert rc != 0 and "RIG_SLOT must be 1 or 2" in err


def test_a_run_directory_follows_its_own_slot_env_not_the_callers():
    """The scripts a stage copies into a run dir carry slot.env; they must follow THEIR run's slot even if the caller's shell says otherwise."""
    import tempfile
    d = pathlib.Path(tempfile.mkdtemp())
    (d / "slot.sh").write_text((KIT / "slot.sh").read_text())
    rc, two, _ = _slot(2)
    (d / "slot.env").write_text("".join(f"{k}={v}\n" for k, v in two.items()))
    prog = '. "$1"; echo "$RIG_SLOT $RIG_FE_PORT $WT"'
    r = subprocess.run(["bash", "-c", prog, "x", str(d / "slot.sh")], capture_output=True, text=True, env={**os.environ, "RIG_SLOT": "1"})
    assert r.stdout.split() == ["2", "17001", two["WT"]], r.stdout


def test_every_kit_and_live_run_script_parses():
    for p in list(KIT.glob("*.sh")) + list(LIVE.glob("*.sh")):
        r = subprocess.run(["bash", "-n", str(p)], capture_output=True, text=True)
        assert r.returncode == 0, f"{p.name}: {r.stderr}"
    for p in list(KIT.glob("*.py")) + list(LIVE.glob("*.py")):
        r = subprocess.run([sys.executable, "-m", "py_compile", str(p)], capture_output=True, text=True)
        assert r.returncode == 0, f"{p.name}: {r.stderr}"


def test_no_script_hard_codes_a_slot_value_outside_slot_sh():
    """The point of the variable: a literal port, worktree, pointer or lock in a script would quietly pin it to slot 1. Comments, docs and the two marked slot-1 DEFAULTS are allowed."""
    bad = re.compile(r"17000|18765|orwell-rehearsal\b|a11_run|rig\.lock")
    offenders = []
    for p in sorted(list(KIT.glob("*.sh")) + list(KIT.glob("*.py")) + list(LIVE.glob("*.sh")) + list(LIVE.glob("*.py"))):
        if p.name == "slot.sh":
            continue
        for n, ln in enumerate(p.read_text().splitlines(), 1):
            code = ln.split("#", 1)[0] if p.suffix == ".sh" or not ("'" in ln or '"' in ln) else ln
            if p.suffix == ".sh" and ln.lstrip().startswith("#"):
                continue
            if bad.search(ln) and not ln.lstrip().startswith("#") and "slot-1 default" not in ln and "slot 1 by default" not in ln and 'os.environ.get("RIG_' not in ln:
                offenders.append(f"{p.name}:{n}: {ln.strip()[:90]}")
    assert not offenders, offenders


def test_daemon_base_follows_the_run_slot_env():
    import tempfile
    for name in ("daemon.py", "a9drive.py"):
        src = (KIT / name).read_text()
        m = re.search(r"\ndef _rig_base\(run\):.*?\n    return \"http://127\.0\.0\.1:17000\"  # slot-1 default\n", src, re.S)
        assert m, f"{name} reads its base through _rig_base"
        ns = {"os": os}
        exec(m.group(0), ns)
        d = pathlib.Path(tempfile.mkdtemp())
        os.environ.pop("RIG_BASE", None)
        assert ns["_rig_base"](str(d)) == "http://127.0.0.1:17000", "a run staged before slots existed (no slot.env) is slot 1"
        (d / "slot.env").write_text("RIG_BASE=http://127.0.0.1:17001\n")
        assert ns["_rig_base"](str(d)) == "http://127.0.0.1:17001"


# ── the spend guard ────────────────────────────────────────────────────────────────────────────────────────────────────
sys.path.insert(0, str(KIT))
import spend_guard  # noqa: E402


def _rows(path, rows):
    path.write_text("".join(json.dumps(r) + "\n" for r in rows))


def test_spend_is_the_providers_cost_when_given_else_a_high_estimate(tmp_path):
    f = tmp_path / "llm-io.jsonl"
    _rows(f, [{"usage": {"prompt_tokens": 1_000_000, "completion_tokens": 100_000, "prompt_tokens_details": {"cached_tokens": 400_000}}},
              {"usage": {"input_tokens": 10, "output_tokens": 10, "cost": 0.5}}, {"kind": "no-usage"}, {"usage": {}}])
    t = spend_guard.totals(str(f))
    assert t["calls"] == 2
    est = 600_000 * 0.30 / 1e6 + 400_000 * 0.03 / 1e6 + 100_000 * 1.2 / 1e6
    assert abs(t["usd_estimate"] - (est + 0.5)) < 1e-6


def test_the_cap_stops_the_run_by_pid_and_marks_it(tmp_path):
    f = tmp_path / "llm-io.jsonl"
    _rows(f, [{"usage": {"input_tokens": 5_000_000, "output_tokens": 1_000_000}}])
    victim = subprocess.Popen(["sleep", "60"])
    try:
        (tmp_path / "driver.pid").write_text(str(victim.pid))
        rc = spend_guard.main([str(f), "1.0", str(tmp_path), "--once"])
        assert rc == 3 and (tmp_path / "SPEND-CAP-HIT").exists()
        assert json.loads((tmp_path / "spend.json").read_text())["usd_estimate"] >= 1.0
        victim.wait(timeout=10)
        assert victim.returncode == -signal.SIGTERM, "the driver was stopped by its pid file"
    finally:
        if victim.poll() is None:
            victim.kill()


def test_under_the_cap_nothing_is_touched(tmp_path):
    f = tmp_path / "llm-io.jsonl"
    _rows(f, [{"usage": {"input_tokens": 1000, "output_tokens": 100}}])
    victim = subprocess.Popen(["sleep", "30"])
    try:
        (tmp_path / "driver.pid").write_text(str(victim.pid))
        assert spend_guard.main([str(f), "3", str(tmp_path), "--once"]) == 0
        assert not (tmp_path / "SPEND-CAP-HIT").exists() and victim.poll() is None
    finally:
        victim.kill()


def test_rig_stats_reports_sent_size_and_the_e22_rate(tmp_path):
    import rig_stats
    _rows(tmp_path / "llm-io.jsonl", [{"kind": "chat", "usage": {"input_tokens": 1000, "output_tokens": 50}}, {"kind": "chat", "usage": {"input_tokens": 3000, "output_tokens": 50, "cached_tokens": 1000}}])
    (tmp_path / "turns.jsonl").write_text('{"a":1}\n{"a":2}\n')
    (tmp_path / "fe.log").write_text("x\nE22 guard: game turn narrated with no engine write\ny\n")
    rig_stats.main(str(tmp_path / "llm-io.jsonl"), str(tmp_path))
    txt = (tmp_path / "rig-stats.md").read_text()
    assert "model calls: 2" in txt and "sent size per turn" in txt and "E22 guard firings: 1; per turn: 0.500" in txt


def test_spend_guard_reads_the_live_archive_row_shape(tmp_path):
    """The real llm-io.jsonl nests usage under response.usage; a guard that only read a top-level `usage` counted $0 forever."""
    f = tmp_path / "llm-io.jsonl"
    f.write_text(json.dumps({"response": {"usage": {"input_tokens": 1000, "output_tokens": 100, "cached_tokens": 0, "cost": 0.5}}}) + "\n")
    t = spend_guard.totals(str(f))
    assert t["calls"] == 1 and t["usd_estimate"] == 0.5
