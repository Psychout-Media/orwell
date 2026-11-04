"""Deploy lifecycle scripts must tell the truth about what they did (and undo what they could not finish).

Runs the REAL deploy scripts over a sandboxed layout with stub ``systemctl`` / ``curl`` / ``pct`` /
``id`` on PATH, in the style of test_backup_unit_and_script.py / test_oobe_reset_script.py. Covers:

  * orwell-ready.sh      - the LLM check no longer calls /api/models anonymously and calls a 401 "not ready"
  * orwell-game-reset.sh / orwell-oobe-reset.sh - a flagless host run forwards NO empty argument
  * orwell-restore.sh    - any failure after move-aside rolls back and restarts the services; a good
                           restore carries data/models and data/.update-prev across
  * orwell-change-port.sh - a foreign listener is fatal; a port that never serves is reverted
  * orwell-oobe-reset.sh - a failed helper restarts the services; a service that will not start fails
                           the run instead of printing "OOBE reset complete"
  * source pins          - the corrected prompt/header text, the FE-store DB path, token temp-file traps

HOST PATHS: the stubs stand in for systemd / the Proxmox ``pct`` bridge / root, and the drop-in dir is
redirected with ORWELL_SYSTEMD_DIR. None of that proves the real host behaviour - a dev run on the Proxmox
box (``orwell restore``, ``orwell-change-port.sh 80``, a game/OOBE reset from the host) is still owed.
"""
import json
import os
import re
import shutil
import socket
import sqlite3
import stat
import subprocess
import tarfile

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEPLOY = os.path.join(REPO, "deploy")
HAVE_SYSTEMD_DIR = os.path.isdir("/run/systemd/system")

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")


def _read(*parts):
    with open(os.path.join(REPO, *parts), encoding="utf-8") as f:
        return f.read()


# ── stubs ────────────────────────────────────────────────────────────────────────────────────────
_SYSTEMCTL = r"""#!/usr/bin/env bash
# Stateful stub: units start ACTIVE; stop deactivates; start activates unless STUB_FAIL_START names it.
echo "$*" >> "$STUB_DIR/systemctl.log"
args=(); for a in "$@"; do [[ "$a" == --* ]] || args+=("$a"); done
cmd="${args[0]:-}"; units=("${args[@]:1}")
case "$cmd" in
  list-unit-files) echo "${units[0]} enabled"; exit 0 ;;
  stop)   for u in "${units[@]}"; do [[ "${STUB_STOP_STICKS:-0}" == 1 ]] || rm -f "$STUB_DIR/active-$u"; done; exit 0 ;;
  start|restart)
    rc=0
    for u in "${units[@]}"; do
      if [[ " ${STUB_FAIL_START:-} " == *" $u "* ]]; then rc=1; else touch "$STUB_DIR/active-$u"; fi
    done
    exit "$rc" ;;
  is-active) [[ -e "$STUB_DIR/active-${units[0]}" ]]; exit $? ;;
  show) exit 0 ;;
  *) exit 0 ;;
esac
"""
_ID = r"""#!/usr/bin/env bash
if [[ "$1" == "-u" && $# -eq 1 ]]; then echo 0; exit 0; fi
exec /usr/bin/id "$@"
"""
_PCT = r"""#!/usr/bin/env bash
echo "$*" >> "$STUB_DIR/pct.log"
case "$1" in
  list)   printf 'VMID Status Lock Name\n104 running orwell\n' ;;
  status) echo "status: running" ;;
  exec)   printf '%s\0' "$@" >> "$STUB_DIR/pct-exec.args"; printf '\n--END--\0' >> "$STUB_DIR/pct-exec.args" ;;
esac
exit 0
"""
# curl stub for orwell-ready.sh: STUB_MODELS_CODE / STUB_MODELS_BODY drive /api/models; the rest is "up".
_CURL_READY = r"""#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
open(os.path.join(os.environ["STUB_DIR"], "curl.log"), "a").write(" ".join(args) + "\n")
if "-K" in args:  # curl config on stdin (how the script passes the bearer token): log it separately
    open(os.path.join(os.environ["STUB_DIR"], "curl-config.log"), "a").write(sys.stdin.read() + "\n")
url = args[-1]
out = None; code_fmt = "-w" in args
if "-o" in args:
    out = args[args.index("-o") + 1]
if url.endswith("/api/models"):
    code = os.environ.get("STUB_MODELS_CODE", "200")
    body = os.environ.get("STUB_MODELS_BODY", "{}")
    if out:
        open(out, "w").write(body)
    elif code.startswith("2"):
        sys.stdout.write(body)
    if code_fmt:
        sys.stdout.write(code)
    sys.exit(0 if (code_fmt or code.startswith("2")) else 22)
sys.stdout.write("{}" if not code_fmt else "200")
"""
# curl stub for orwell-change-port.sh: /api/health is "healthy" only on the ports in STUB_HEALTHY_PORTS.
_CURL_PORT = r"""#!/usr/bin/env python3
import os, re, sys
url = sys.argv[-1]
m = re.search(r":(\d+)/", url)
if m and m.group(1) in os.environ.get("STUB_HEALTHY_PORTS", "").split():
    status = "unhealthy" if m.group(1) in os.environ.get("STUB_UNHEALTHY_PORTS", "").split() else "healthy"
    sys.stdout.write('{"status": "%s"}' % status); sys.exit(0)
sys.exit(7)
"""


# cp stub: fails when the DESTINATION is a data/.env (uid-independent failure injection, unlike chmod 0).
_CP_FAIL_ENV = r"""#!/usr/bin/env bash
dest="${@: -1}"
if [[ "$dest" == */data/.env && -n "${STUB_CP_FAIL_ENV:-}" ]]; then echo "cp: simulated failure" >&2; exit 1; fi
exec /bin/cp "$@"
"""


@pytest.fixture
def stubs(tmp_path):
    d = tmp_path / "stubs"
    d.mkdir()
    state = tmp_path / "state"
    state.mkdir()

    def put(name, body):
        p = d / name
        p.write_text(body)
        p.chmod(p.stat().st_mode | stat.S_IEXEC)

    put("systemctl", _SYSTEMCTL)
    put("id", _ID)
    put("pct", _PCT)
    put("cp", _CP_FAIL_ENV)
    for unit in ("orwell-frontend", "orwell-engine"):
        (state / f"active-{unit}").write_text("")
    env = dict(os.environ)
    env["PATH"] = f"{d}:{env['PATH']}"
    env["STUB_DIR"] = str(state)
    return type("Stubs", (), {"dir": d, "state": state, "env": env, "put": staticmethod(put),
                              "log": lambda self, n="systemctl.log": (state / n).read_text().splitlines()
                              if (state / n).exists() else []})()


# ── orwell-ready.sh ──────────────────────────────────────────────────────────────────────────────
def _run_ready(stubs, **extra):
    stubs.put("curl", _CURL_READY)
    env = {**stubs.env, "NO_COLOR": "1", **extra}
    return subprocess.run(["bash", os.path.join(DEPLOY, "orwell-ready.sh")], env=env,
                          capture_output=True, text=True, cwd=str(stubs.dir))


_ONLINE = json.dumps({"items": [{"models": ["m"], "offline": False}]})
_OFFLINE = json.dumps({"items": [{"models": ["m"], "offline": True}]})


def test_ready_401_is_skipped_not_not_ready(stubs):
    r = _run_ready(stubs, STUB_MODELS_CODE="401")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "READY" in r.stdout and "NOT READY" not in r.stdout
    assert "skipped" in r.stdout and "ORWELL_READY_TOKEN" in r.stdout


def test_ready_with_token_sends_bearer_and_passes(stubs):
    r = _run_ready(stubs, ORWELL_READY_TOKEN="ody_abc", STUB_MODELS_BODY=_ONLINE)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "an LLM is configured and online" in r.stdout
    assert any("Authorization: Bearer ody_abc" in ln for ln in stubs.log("curl-config.log"))
    assert not any("ody_abc" in ln for ln in stubs.log("curl.log")), "the token must not be on curl's command line"


def test_ready_auth_off_needs_no_token(stubs):
    r = _run_ready(stubs, STUB_MODELS_BODY=_ONLINE)
    assert r.returncode == 0 and "an LLM is configured and online" in r.stdout
    assert not any("Authorization" in ln for ln in stubs.log("curl.log"))


def test_ready_rejected_token_is_not_ready(stubs):
    r = _run_ready(stubs, ORWELL_READY_TOKEN="ody_bad", STUB_MODELS_CODE="401")
    assert r.returncode == 1 and "NOT READY" in r.stdout and "REJECTED" in r.stdout


def test_ready_models_server_error_is_reported_as_such_not_as_no_llm(stubs):
    r = _run_ready(stubs, STUB_MODELS_CODE="503")
    assert r.returncode == 1 and "could not query the model list (HTTP 503)" in r.stdout
    assert "no usable LLM" not in r.stdout


def test_ready_reachable_but_no_online_model_is_still_not_ready(stubs):
    r = _run_ready(stubs, ORWELL_READY_TOKEN="ody_abc", STUB_MODELS_BODY=_OFFLINE)
    assert r.returncode == 1 and "NOT READY" in r.stdout and "no usable LLM" in r.stdout


# ── host bridge: a flagless run must not forward an empty argument ───────────────────────────────
def _bridged_args(stubs, script, flags):
    env = {**stubs.env, "APP_DIR": "/nonexistent/orwell-app", "CTID": "104"}
    r = subprocess.run(["bash", os.path.join(DEPLOY, script), *flags], env=env,
                       capture_output=True, text=True, cwd=str(stubs.dir))
    assert r.returncode == 0, r.stdout + r.stderr
    raw = (stubs.state / "pct-exec.args").read_text()
    calls = [c.split("\0")[:-1] for c in raw.split("\n--END--\0") if c]
    return [c for c in calls if any(a.endswith(script.replace("orwell-", "/tmp/orwell-")) for a in c)]


@pytest.mark.parametrize("script", ["orwell-game-reset.sh", "orwell-oobe-reset.sh"])
def test_flagless_host_run_forwards_no_empty_argument(stubs, script):
    calls = _bridged_args(stubs, script, [])
    assert calls, "the script should have been exec'd inside the container"
    assert "" not in calls[-1], f"an empty argument reaches the script as 'unknown option': {calls[-1]}"
    assert calls[-1][-1].endswith(script)


@pytest.mark.parametrize("script", ["orwell-game-reset.sh", "orwell-oobe-reset.sh"])
def test_flagged_host_run_still_forwards_flags(stubs, script):
    calls = _bridged_args(stubs, script, ["--yes", "--no-restart"])
    assert calls[-1][-2:] == ["--yes", "--no-restart"]


# ── orwell-restore.sh ────────────────────────────────────────────────────────────────────────────
def _make_backup(tmp_path):
    src = tmp_path / "bk"
    (src / "data" / "saves").mkdir(parents=True)
    (src / "data" / "saves" / "v000001.json").write_text("OLD-SAVE")
    (src / "data" / ".env").write_text("ORWELL_PORT=1111\n")
    (src / "data" / ".update-prev").write_text("backup-sha\n")
    (src / "frontend" / "data").mkdir(parents=True)
    (src / "frontend" / "data" / "app.db").write_text("OLD-DB")
    out = tmp_path / "orwell-backup-test.tar.gz"
    with tarfile.open(out, "w:gz") as t:
        t.add(src / "data", arcname="data")
        t.add(src / "frontend" / "data", arcname="frontend/data")
    return str(out)


def _live_app(tmp_path):
    app = tmp_path / "app"
    (app / "data" / "saves").mkdir(parents=True)
    (app / "data" / "saves" / "v000009.json").write_text("NEW-SAVE")
    (app / "data" / ".env").write_text("ORWELL_PORT=2222\n")
    (app / "data" / ".update-prev").write_text("live-sha\n")
    (app / "data" / "models").mkdir()
    (app / "data" / "models" / "onnx.bin").write_text("WEIGHTS")
    (app / "frontend" / "data").mkdir(parents=True)
    (app / "frontend" / "data" / "app.db").write_text("LIVE-DB")
    return app


def _restore(stubs, app, backup, **extra):
    env = {**stubs.env, "APP_DIR": str(app), **extra}
    return subprocess.run(["bash", os.path.join(DEPLOY, "orwell-restore.sh"), backup], env=env,
                          capture_output=True, text=True)


def test_restore_success_carries_models_and_update_prev_and_restarts(stubs, tmp_path):
    app = _live_app(tmp_path)
    r = _restore(stubs, app, _make_backup(tmp_path))
    assert r.returncode == 0, r.stdout + r.stderr
    assert (app / "data" / "saves" / "v000001.json").read_text() == "OLD-SAVE"
    assert not (app / "data" / "saves" / "v000009.json").exists()
    assert (app / "data" / ".env").read_text() == "ORWELL_PORT=2222\n"
    assert (app / "data" / ".update-prev").read_text() == "live-sha\n", "a backup must not rewind the rollback pointer"
    assert (app / "data" / "models" / "onnx.bin").read_text() == "WEIGHTS", "the embedding cache must survive"
    assert (app / "frontend" / "data" / "app.db").read_text() == "OLD-DB"
    log = stubs.log()
    assert any(ln.startswith("stop ") for ln in log) and any(ln.startswith("start ") for ln in log)


def test_restore_failure_after_move_aside_rolls_back_and_restarts(stubs, tmp_path):
    app = _live_app(tmp_path)
    r = _restore(stubs, app, _make_backup(tmp_path), STUB_CP_FAIL_ENV="1")  # the post-extract .env carry-over fails
    assert r.returncode != 0
    assert (app / "data" / "saves" / "v000009.json").read_text() == "NEW-SAVE", "live data must be back in place"
    assert not (app / "data" / "saves" / "v000001.json").exists(), "nothing of the backup may remain"
    assert (app / "data" / "models" / "onnx.bin").exists()
    assert (app / "frontend" / "data" / "app.db").read_text() == "LIVE-DB"
    assert not [p for p in app.iterdir() if p.name.startswith(".pre-restore-")], "no stranded move-aside dir"
    assert any(ln.startswith("start ") for ln in stubs.log()), "services must be restarted after a failed restore"
    assert (stubs.state / "active-orwell-engine").exists() and (stubs.state / "active-orwell-frontend").exists()


def test_restore_rollback_removes_subtrees_that_did_not_exist_before(stubs, tmp_path):
    app = _live_app(tmp_path)
    shutil.rmtree(app / "frontend")                          # no live frontend/data at all
    r = _restore(stubs, app, _make_backup(tmp_path), STUB_CP_FAIL_ENV="1")
    assert r.returncode != 0
    assert (app / "data" / "saves" / "v000009.json").read_text() == "NEW-SAVE"
    assert not (app / "frontend" / "data").exists(), "the backup's newly extracted frontend/data must not survive a failed restore"


def test_failed_restore_restarts_only_the_services_that_were_running(stubs, tmp_path):
    app = _live_app(tmp_path)
    (stubs.state / "active-orwell-frontend").unlink()        # the operator had the front-end stopped
    r = _restore(stubs, app, _make_backup(tmp_path), STUB_CP_FAIL_ENV="1")
    assert r.returncode != 0
    assert (stubs.state / "active-orwell-engine").exists()
    assert not (stubs.state / "active-orwell-frontend").exists(), "a unit that was stopped before must stay stopped"


def test_restore_refuses_when_a_service_will_not_stop_and_leaves_data_alone(stubs, tmp_path):
    app = _live_app(tmp_path)
    r = _restore(stubs, app, _make_backup(tmp_path), STUB_STOP_STICKS="1")
    assert r.returncode != 0 and "still running" in r.stderr
    assert (app / "data" / "saves" / "v000009.json").exists()
    assert not [p for p in app.iterdir() if p.name.startswith(".pre-restore-")]
    assert any(ln.startswith("start ") for ln in stubs.log())


def test_restore_reports_failure_when_services_do_not_come_back(stubs, tmp_path):
    app = _live_app(tmp_path)
    r = _restore(stubs, app, _make_backup(tmp_path), STUB_FAIL_START="orwell-engine")
    assert r.returncode != 0 and "failed to start" in r.stderr
    assert "restore complete" not in r.stdout
    assert (app / "data" / "saves" / "v000001.json").exists(), "the data restore itself stands"


# ── orwell-change-port.sh ────────────────────────────────────────────────────────────────────────
def _port_env(stubs, tmp_path, **extra):
    app = tmp_path / "app"
    (app / ".git").mkdir(parents=True, exist_ok=True)
    (app / "data").mkdir(exist_ok=True)
    (app / "data" / ".env").write_text("ORWELL_PORT=8080\nOTHER=1\n")
    stubs.put("curl", _CURL_PORT)
    return app, {**stubs.env, "APP_DIR": str(app), "ORWELL_SYSTEMD_DIR": str(tmp_path / "systemd"),
                 "ORWELL_PORT_WAIT": "1", "STUB_HEALTHY_PORTS": "8080", **extra}


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.mark.skipif(shutil.which("ss") is None, reason="ss required")
def test_change_port_foreign_listener_is_fatal_and_changes_nothing(stubs, tmp_path):
    app, env = _port_env(stubs, tmp_path)
    with socket.socket() as srv:
        srv.bind(("127.0.0.1", 0)); srv.listen(1)
        port = srv.getsockname()[1]
        r = subprocess.run(["bash", os.path.join(DEPLOY, "orwell-change-port.sh"), str(port), "--yes"],
                           env=env, capture_output=True, text=True)
    assert r.returncode != 0 and "already has a listener" in r.stderr
    assert (app / "data" / ".env").read_text() == "ORWELL_PORT=8080\nOTHER=1\n"
    assert not any(ln.startswith("restart") for ln in stubs.log())


def test_change_port_reverts_when_the_new_port_never_serves(stubs, tmp_path):
    app, env = _port_env(stubs, tmp_path)
    port = _free_port()
    if port < 1024:
        pytest.skip("odd ephemeral port")
    r = subprocess.run(["bash", os.path.join(DEPLOY, "orwell-change-port.sh"), str(port), "--yes"],
                       env=env, capture_output=True, text=True)
    assert r.returncode != 0, r.stdout + r.stderr
    assert "did not answer" in r.stderr and "reverting" in r.stderr
    assert (app / "data" / ".env").read_text() == "ORWELL_PORT=8080\nOTHER=1\n", "the old port must be restored"
    restarts = [ln for ln in stubs.log() if ln.startswith("restart")]
    assert len(restarts) == 2, "restart onto the new port, then restart back onto the old one"


def test_change_port_unhealthy_status_does_not_count_as_serving(stubs, tmp_path):
    app, env = _port_env(stubs, tmp_path)
    port = _free_port()
    if port < 1024:
        pytest.skip("odd ephemeral port")
    env.update(STUB_HEALTHY_PORTS=f"8080 {port}", STUB_UNHEALTHY_PORTS=str(port))   # answers, but {"status": "unhealthy"}
    r = subprocess.run(["bash", os.path.join(DEPLOY, "orwell-change-port.sh"), str(port), "--yes"],
                       env=env, capture_output=True, text=True)
    assert r.returncode != 0, r.stdout + r.stderr
    assert "did not answer" in r.stderr
    assert (app / "data" / ".env").read_text() == "ORWELL_PORT=8080\nOTHER=1\n"


def test_change_port_privileged_failure_removes_the_new_dropin(stubs, tmp_path):
    app, env = _port_env(stubs, tmp_path)
    r = subprocess.run(["bash", os.path.join(DEPLOY, "orwell-change-port.sh"), "80", "--yes"],
                       env=env, capture_output=True, text=True)
    assert r.returncode != 0
    assert not (tmp_path / "systemd" / "orwell-frontend.service.d" / "10-privileged-port.conf").exists()
    assert (app / "data" / ".env").read_text().startswith("ORWELL_PORT=8080\n")


def test_change_port_success_commits_when_the_frontend_answers(stubs, tmp_path):
    port = _free_port()
    app, env = _port_env(stubs, tmp_path, STUB_HEALTHY_PORTS=f"8080 {port}")
    r = subprocess.run(["bash", os.path.join(DEPLOY, "orwell-change-port.sh"), str(port), "--yes"],
                       env=env, capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
    assert (app / "data" / ".env").read_text() == f"ORWELL_PORT={port}\nOTHER=1\n"


# ── orwell-oobe-reset.sh ─────────────────────────────────────────────────────────────────────────
def _oobe_layout(tmp_path, helper=True):
    app = tmp_path / "app"
    fe_data, config, saves = app / "frontend" / "data", app / "data", app / ".orwell-data"
    for d in (fe_data, config, saves, app / "frontend" / "scripts", app / ".git"):
        d.mkdir(parents=True, exist_ok=True)
    if helper:
        shutil.copy(os.path.join(REPO, "frontend", "scripts", "oobe_reset.py"), app / "frontend" / "scripts" / "oobe_reset.py")
    (fe_data / "auth.json").write_text("{}")
    conn = sqlite3.connect(str(fe_data / "app.db"))
    conn.execute("CREATE TABLE model_endpoints (id TEXT, name TEXT, base_url TEXT, api_key TEXT, model_type TEXT, is_enabled INTEGER)")
    conn.commit(); conn.close()
    (config / ".env").write_text("X=1\n")
    (config / "ops").mkdir()
    env = {"APP_DIR": str(app), "ORWELL_CONFIG_DIR": str(config), "ORWELL_DATA_DIR": str(saves),
           "ORWELL_FE_DIR": str(app / "frontend"), "ORWELL_FE_DATA_DIR": str(fe_data)}
    return app, fe_data, env


def _run_oobe(stubs, env, *flags):
    return subprocess.run(["bash", os.path.join(DEPLOY, "orwell-oobe-reset.sh"), "--yes", *flags],
                          env={**stubs.env, "ORWELL_START_SETTLE": "0", **env}, capture_output=True, text=True)


@pytest.mark.skipif(not HAVE_SYSTEMD_DIR, reason="the script only drives services when /run/systemd/system exists")
def test_oobe_failed_helper_restarts_services_and_does_not_claim_nothing_removed(stubs, tmp_path):
    app, fe_data, env = _oobe_layout(tmp_path)
    env["ORWELL_OOBE_HELPER"] = str(tmp_path / "helper.py")
    (tmp_path / "helper.py").write_text("import sys; sys.exit(3)\n")
    r = _run_oobe(stubs, env)
    assert r.returncode != 0
    assert (fe_data / "auth.json").exists(), "the wipe must be aborted"
    log = stubs.log()
    assert any(ln.startswith("stop ") for ln in log) and any(ln.startswith("start ") for ln in log)
    assert (stubs.state / "active-orwell-engine").exists() and (stubs.state / "active-orwell-frontend").exists()
    assert "NOTHING removed" not in r.stderr and "ABORTED" in r.stderr


@pytest.mark.skipif(not HAVE_SYSTEMD_DIR, reason="the script only drives services when /run/systemd/system exists")
def test_oobe_refuses_to_wipe_when_a_service_will_not_stop(stubs, tmp_path):
    app, fe_data, env = _oobe_layout(tmp_path)
    r = _run_oobe(stubs, {**env, "STUB_STOP_STICKS": "1"})
    assert r.returncode != 0 and "still running" in r.stderr
    assert (fe_data / "auth.json").exists(), "nothing may be wiped under a live service"


@pytest.mark.skipif(not HAVE_SYSTEMD_DIR, reason="the script only drives services when /run/systemd/system exists")
def test_oobe_aborted_reset_restarts_only_services_that_were_running(stubs, tmp_path):
    app, fe_data, env = _oobe_layout(tmp_path)
    (stubs.state / "active-orwell-frontend").unlink()        # was stopped before the reset
    env["ORWELL_OOBE_HELPER"] = str(tmp_path / "helper.py")
    (tmp_path / "helper.py").write_text("import sys; sys.exit(3)\n")
    r = _run_oobe(stubs, env)
    assert r.returncode != 0
    assert (stubs.state / "active-orwell-engine").exists()
    assert not (stubs.state / "active-orwell-frontend").exists()


@pytest.mark.skipif(not HAVE_SYSTEMD_DIR, reason="the script only drives services when /run/systemd/system exists")
def test_oobe_reports_failure_when_services_do_not_come_back(stubs, tmp_path):
    app, fe_data, env = _oobe_layout(tmp_path)
    r = _run_oobe(stubs, {**env, "STUB_FAIL_START": "orwell-frontend"})
    assert r.returncode != 0
    assert "OOBE reset complete" not in r.stdout
    assert "did not come back up" in r.stderr and "orwell-frontend" in r.stderr


@pytest.mark.skipif(not HAVE_SYSTEMD_DIR, reason="the script only drives services when /run/systemd/system exists")
def test_oobe_success_with_services_up_says_complete(stubs, tmp_path):
    app, fe_data, env = _oobe_layout(tmp_path)
    r = _run_oobe(stubs, env)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "OOBE reset complete" in r.stdout


# ── source pins: wrong text / wrong path / leaked temp files ─────────────────────────────────────
def test_oobe_text_says_models_are_reset_not_kept():
    src = _read("deploy", "orwell-oobe-reset.sh")
    assert "and the LLM-selection settings\n" not in src
    assert "• the LLM-selection settings (default chat" not in src
    assert src.count("SELECTED MODELS") >= 3, "header + both prompts must say the selected models are reset"
    assert "the difference from orwell-factory-reset.sh" not in src
    assert "orwell-factory-reset.sh is a thin\n# wrapper that delegates here" in src


def test_factory_reset_header_names_the_real_default_models():
    hdr = _read("deploy", "orwell-factory-reset.sh").split("set -euo pipefail")[0]
    settings = _read("frontend", "src", "settings.py")
    default_model = re.search(r'"default_model":\s*"([^"]+)"', settings).group(1)
    image_model = re.search(r'"image_model":\s*"([^"]+)"', settings).group(1)
    assert default_model in hdr and image_model in hdr
    assert "glm" not in hdr.lower() and "qwen" not in hdr.lower()


def test_update_script_cruft_cleanup_targets_the_frontend_db():
    upd = _read("deploy", "orwell-update.sh")
    assert '/frontend/data}/app.db"' in upd
    assert 'local db="${APP_DIR}/data/app.db"' not in upd


@pytest.mark.parametrize("script,var", [("orwell-update.sh", "TMP_TOKEN"), ("orwell-update.sh", "TMP_ENV"),
                                        ("orwell.sh", "TMP_TOKEN")])
def test_token_temp_files_are_removed_by_an_exit_trap(script, var):
    src = _read("deploy", script)
    assert f"trap 'rm -f \"${var}\"" in src and "' EXIT" in src


def test_set_token_keeps_env_ownership():
    src = _read("deploy", "orwell-update.sh")
    assert 'chown --reference="$OWNER_REF" "$TMP_ENV"' in src
    assert src.index('chown --reference="$OWNER_REF" "$TMP_ENV"') < src.index('mv "$TMP_ENV" "$ENV_FILE"')


def test_orwell_sh_exit_trap_also_removes_the_token_file_inside_the_container():
    src = _read("deploy", "orwell.sh")
    assert 'pct exec "$CTID" -- rm -f /tmp/orwell-token' in src.split("trap 'rm -f \"$TMP_TOKEN\"", 1)[1].split("EXIT", 1)[0]
