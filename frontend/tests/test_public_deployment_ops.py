"""Feature 0068 — DEPLOY / OPS lane structural gates ("Connect to the internet").

The admin "Connect to the internet" wizard drives the public deployment through the existing G19b
privileged-ops mechanism: an existence-only flag → a root path unit → a root oneshot service → the
one fixed script → progress JSON + a live log. These are file-content asserts (no app stand-up):
the units carry the oneshot/root/flag-removal/flock/log-append shape, both the installer and the
updater reconcile them, the script passes `bash -n`, the connector token is SHREDDED and NEVER
echoed, and the engine port still appears in NO ops artifact (extends 0067's structural gate).
"""
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))  # frontend/tests -> repo root
ENGINE_PORT = "8765"

SCRIPT = os.path.join("deploy", "orwell-ops-public-deployment.sh")
PATH_UNIT = os.path.join("deploy", "systemd", "orwell-ops-public-deployment.path")
SERVICE_UNIT = os.path.join("deploy", "systemd", "orwell-ops-public-deployment.service")
LOG_PATH = "/opt/orwell/data/ops-public-deployment.log"
FLAG = "public-deployment-requested"


def _read(*parts):
    with open(os.path.join(REPO, *parts), "r", encoding="utf-8") as fh:
        return fh.read()


def test_path_unit_watches_the_existence_only_flag():
    unit = _read(PATH_UNIT)
    assert f"PathExists=/opt/orwell/data/ops/{FLAG}" in unit
    assert "Unit=orwell-ops-public-deployment.service" in unit
    assert "WantedBy=multi-user.target" in unit
    # the existence-only contract is documented (the flag content is never read/parsed/executed)
    assert "existence" in unit.lower()


def test_service_unit_is_oneshot_root_with_flag_removal_flock_and_log_append():
    unit = _read(SERVICE_UNIT)
    lines = unit.splitlines()
    # oneshot + root by design (no User= drop, no RemainAfterExit DIRECTIVE — the word may appear
    # in a comment explaining its deliberate absence, so key on a line that STARTS with it)
    assert "Type=oneshot" in unit
    assert not any(ln.startswith("User=") for ln in lines)
    assert not any(ln.startswith("RemainAfterExit=") for ln in lines)
    assert "root" in unit.lower()
    # the flag is removed BEFORE the run (no PathExists= retrigger loop)
    flag_rm = f"ExecStartPre=/bin/rm -rf --one-file-system -- /opt/orwell/data/ops/{FLAG}"
    assert flag_rm in unit
    assert unit.index(flag_rm) < unit.index("ExecStart=")
    # overlapping triggers no-op on a flock
    assert "flock -n" in unit
    # stdout+stderr append LIVE to the log the status page tails
    assert f"StandardOutput=append:{LOG_PATH}" in unit
    assert f"StandardError=append:{LOG_PATH}" in unit
    # only the one fixed script path runs — the web tier picks WHEN, never WHAT
    assert "orwell-ops-public-deployment.sh" in unit


def test_install_and_update_reconcile_the_new_units():
    install = _read("deploy", "orwell-install.sh")
    update = _read("deploy", "orwell-update.sh")
    for name, text in (("orwell-install.sh", install), ("orwell-update.sh", update)):
        assert "orwell-ops-public-deployment" in text, f"{name} must reference the new ops unit"
        # the units are installed from the checkout into /etc/systemd/system
        assert "orwell-ops-public-deployment.path" in text, name
        assert "orwell-ops-public-deployment.service" in text, name
        # the path unit is the TRIGGER — enabled (it may be enabled alone or as the tail of a
        # combined `enable --now … .path` line); the service is started by the watcher only.
        enable_lines = [ln for ln in text.splitlines() if "enable --now" in ln]
        assert any(
            "orwell-ops-public-deployment.path" in ln for ln in enable_lines
        ), f"{name} must `enable --now` the public-deployment PATH unit"
        assert "enable --now orwell-ops-public-deployment.service" not in text, name


def test_script_passes_bash_n():
    proc = subprocess.run(
        ["bash", "-n", SCRIPT],
        cwd=REPO,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, f"bash -n failed: {proc.stderr}"


def test_script_shreds_the_token_and_never_echoes_it():
    script = _read(SCRIPT)
    # the token file path is shredded / overwritten + removed
    assert "shred" in script, "the script must shred the connector token file"
    assert "TOKEN_FILE" in script
    # a shred -u OR an overwrite-then-rm of the token file is present
    assert ("shred -u" in script) or ("dd if=/dev/zero" in script and "rm -f" in script)
    # the token must NEVER be echoed/printed to stdout (the run log). No `echo`/`printf` line that
    # interpolates the token file's contents, and no bare `cat` of it to stdout.
    for line in script.splitlines():
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        lowered = stripped.lower()
        # cat "$TOKEN_FILE" is only ever allowed as a command SUBSTITUTION argument (consumed by
        # cloudflared), never piped/redirected to stdout on its own.
        if lowered.startswith("cat ") and "token" in lowered:
            raise AssertionError(f"token cat to stdout: {line}")
        if (lowered.startswith("echo ") or lowered.startswith("printf ")) and "token_file" in lowered:
            raise AssertionError(f"token echoed to stdout: {line}")


def test_engine_port_appears_in_no_ops_artifact():
    for rel in (SCRIPT, PATH_UNIT, SERVICE_UNIT):
        text = _read(rel)
        assert ENGINE_PORT not in text, f"engine port {ENGINE_PORT} leaked into {rel}"


def test_apply_forces_loopback_bind_host_regardless_of_config():
    # DEPLOY-2 (B15): the 0067 floor's non-negotiable upserts (auth ON, localhost bypass OFF) must
    # include pinning the bind host to loopback too — belt-and-suspenders alongside the route-layer
    # validator fix, so the two code paths (validate vs. apply) can't drift out of sync again.
    script = _read(SCRIPT)
    assert 'upsert_env "ORWELL_BIND_HOST" "127.0.0.1"' in script
    # it sits with the other two non-negotiable, config-independent floor upserts
    idx_auth = script.index('upsert_env "AUTH_ENABLED" "true"')
    idx_bypass = script.index('upsert_env "LOCALHOST_BYPASS" "false"')
    idx_bind = script.index('upsert_env "ORWELL_BIND_HOST" "127.0.0.1"')
    assert idx_auth < idx_bypass < idx_bind
