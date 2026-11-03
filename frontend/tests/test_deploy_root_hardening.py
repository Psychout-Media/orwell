"""Deploy root-side hardening — root never follows a path the unprivileged service user controls.

Runs the REAL deploy scripts over throwaway layouts under tmp (no /opt, no real units, no root needed):
  * the reset scripts refuse any path that resolves outside the app's data directories (ORWELL_DATA_DIR
    is read from data/.env, which the service user can write);
  * the ops scripts (tls / public-deployment / https / progress) claim or refuse a symlinked file or ops
    dir before they read, shred, chown or write through it, and never write a value the route layer would
    have rejected.

Name-agnostic: roles only, no houseguests.
"""
import os
import shutil
import stat
import subprocess
import sys

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEPLOY = os.path.join(REPO, "deploy")
OOBE = os.path.join(DEPLOY, "orwell-oobe-reset.sh")
GAME = os.path.join(DEPLOY, "orwell-game-reset.sh")
OPS_TLS = os.path.join(DEPLOY, "orwell-ops-tls.sh")
OPS_PUBLIC = os.path.join(DEPLOY, "orwell-ops-public-deployment.sh")
HTTPS = os.path.join(DEPLOY, "orwell-https.sh")
PROGRESS = os.path.join(DEPLOY, "orwell-ops-progress.sh")
OOBE_HELPER = os.path.join(REPO, "frontend", "scripts", "oobe_reset.py")

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def _clean_env(**extra):
    """The caller's env minus anything that could steer a deploy script away from the tmp layout."""
    env = {k: v for k, v in os.environ.items()
           if not k.startswith(("ORWELL_", "BBAI_")) and k not in ("APP_DIR", "DATA_DIR", "CTID")}
    env.update(extra)
    return env


def _bash(args, env, **kw):
    return subprocess.run(["bash", *args], env=env, capture_output=True, text=True, timeout=60, **kw)


def _extract(text, start, end_prefix=None):
    """Lines of `text` from the first line starting with `start` through the first later line that
    starts with `end_prefix` (default: a lone closing brace), inclusive."""
    lines = text.splitlines()
    begin = next(i for i, ln in enumerate(lines) if ln.startswith(start))
    stop = next(i for i in range(begin + 1, len(lines))
                if (lines[i] == "}" if end_prefix is None else lines[i].startswith(end_prefix)))
    return "\n".join(lines[begin:stop + 1])


# =============================================================================================
# 2a. RESET SCRIPTS — root deletes/chowns only inside the app's data directories
# =============================================================================================

RESET_SCRIPTS = [pytest.param(OOBE, id="oobe"), pytest.param(GAME, id="game")]


def test_reset_scripts_share_one_confinement_block():
    start = "# ── Safety: root only deletes/chowns inside the app's own data directories"
    assert _extract(_read(OOBE), start, "recheck_data_dir()") == _extract(_read(GAME), start, "recheck_data_dir()")


def _reset_layout(tmp_path):
    app = tmp_path / "app"
    for rel in (".git", "src", "data/saves/u1", "data/ops", "frontend/data", "frontend/scripts"):
        (app / rel).mkdir(parents=True)
    shutil.copy(OOBE_HELPER, app / "frontend" / "scripts" / "oobe_reset.py")
    (app / "src" / "keep.txt").write_text("code")
    (app / "data" / "saves" / "u1" / "save.json").write_text("{}")
    (app / "frontend" / "data" / "auth.json").write_text("{}")
    elsewhere = tmp_path / "elsewhere"
    (elsewhere / "u1").mkdir(parents=True)
    (elsewhere / "u1" / "save.json").write_text("{}")
    return app, elsewhere


def _run_reset(script, app, dotenv_data_dir, *flags, **env_extra):
    (app / "data" / ".env").write_text(f"ORWELL_ENGINE_TOKEN=t\nORWELL_DATA_DIR={dotenv_data_dir}\n")
    env = _clean_env(**{"APP_DIR": str(app), "ORWELL_ENGINE_SVC": "orwell-test-none",
                        "ORWELL_FRONTEND_SVC": "orwell-test-none", "ORWELL_PYTHON": sys.executable,
                        **env_extra})
    return _bash([script, "--yes", "--no-restart", *flags], env)


def _assert_refused(proc, app, elsewhere):
    assert proc.returncode != 0
    assert "outside the app's data directories" in proc.stderr, proc.stderr
    # nothing was deleted anywhere: code, saves, the FE store, and the foreign dir all survive
    assert (app / "src" / "keep.txt").exists()
    assert (app / "data" / "saves" / "u1" / "save.json").exists()
    assert (app / "frontend" / "data" / "auth.json").exists()
    assert (elsewhere / "u1" / "save.json").exists()


@pytest.mark.parametrize("script", RESET_SCRIPTS)
@pytest.mark.parametrize("how", ["app-dir", "dotdot", "outside", "symlink-to-app", "symlink-to-outside", "relative"])
def test_reset_refuses_a_data_dir_outside_the_data_dirs(tmp_path, script, how):
    app, elsewhere = _reset_layout(tmp_path)
    (app / "data" / "to-app").symlink_to(app)
    (app / "data" / "to-outside").symlink_to(elsewhere)
    target = {
        "app-dir": str(app),                        # the app dir itself
        "dotdot": f"{app}/data/../",                # resolves to the app dir
        "outside": str(elsewhere),
        "symlink-to-app": f"{app}/data/to-app",     # a symlink planted inside data/ pointing at the app
        "symlink-to-outside": f"{app}/data/to-outside",
        "relative": "../..",                        # relative paths resolve against the app dir
    }[how]
    _assert_refused(_run_reset(script, app, target), app, elsewhere)


@pytest.mark.parametrize("script", RESET_SCRIPTS)
def test_reset_refusal_also_applies_to_a_dry_run(tmp_path, script):
    app, elsewhere = _reset_layout(tmp_path)
    _assert_refused(_run_reset(script, app, str(app), "--dry-run"), app, elsewhere)


def test_game_reset_refuses_a_portraits_dir_that_leaves_the_data_dirs(tmp_path):
    app, elsewhere = _reset_layout(tmp_path)
    (elsewhere / "portrait.png").write_text("png")
    (app / "frontend" / "data" / "portraits").symlink_to(elsewhere)      # planted symlink
    proc = _run_reset(GAME, app, str(app / "data" / "saves"))
    _assert_refused(proc, app, elsewhere)
    assert (elsewhere / "portrait.png").exists()


def test_game_reset_still_scrubs_the_dotenv_save_dir_inside_data(tmp_path):
    app, elsewhere = _reset_layout(tmp_path)
    (app / "frontend" / "data" / "portraits").mkdir()
    (app / "frontend" / "data" / "portraits" / "p.png").write_text("png")
    proc = _run_reset(GAME, app, str(app / "data" / "saves"))
    assert proc.returncode == 0, proc.stderr
    assert not (app / "data" / "saves" / "u1").exists()
    assert not (app / "frontend" / "data" / "portraits").exists()
    assert (app / "frontend" / "data" / "auth.json").exists()           # accounts kept
    assert (app / "data" / ".env").exists()                            # config kept
    assert (app / "src" / "keep.txt").exists() and (elsewhere / "u1" / "save.json").exists()


def test_oobe_reset_still_scrubs_the_dotenv_save_dir_inside_data(tmp_path):
    app, elsewhere = _reset_layout(tmp_path)
    proc = _run_reset(OOBE, app, str(app / "data" / "saves"))
    assert proc.returncode == 0, proc.stderr
    assert not (app / "data" / "saves" / "u1").exists()
    assert not (app / "frontend" / "data" / "auth.json").exists()      # OOBE wipes the FE store
    assert (app / "data" / ".env").exists()
    assert (app / "src" / "keep.txt").exists() and (elsewhere / "u1" / "save.json").exists()


@pytest.mark.skipif(not os.path.isdir("/run/systemd/system"), reason="the scripts only manage units under systemd")
@pytest.mark.parametrize("script", RESET_SCRIPTS)
def test_reset_refuses_to_scrub_under_a_service_that_would_not_stop(tmp_path, script):
    # The post-stop re-check only means something if nothing is still writing: a unit that is still
    # active after `systemctl stop` aborts the run before a single file is touched.
    app, elsewhere = _reset_layout(tmp_path)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _stub(bin_dir / "systemctl",
          'case "$1" in\n  list-unit-files) echo "orwell-test-live.service enabled" ;;\n'
          '  is-active) exit 0 ;;\n  *) exit 0 ;;\nesac\n')
    # With a live unit the script insists on root; pretend to be it (the run aborts before any root action).
    _stub(bin_dir / "id", f'[[ "$1" == "-u" ]] && {{ echo 0; exit 0; }}\nexec {shutil.which("id")} "$@"\n')
    proc = _run_reset(script, app, str(app / "data" / "saves"),
                      PATH=f"{bin_dir}:{os.environ['PATH']}",
                      ORWELL_ENGINE_SVC="orwell-test-live", ORWELL_FRONTEND_SVC="orwell-test-live")
    assert proc.returncode != 0
    assert "still running" in proc.stderr, proc.stderr
    assert (app / "data" / "saves" / "u1" / "save.json").exists()
    assert (app / "frontend" / "data" / "auth.json").exists()


@pytest.mark.skipif(not os.path.isdir("/run/systemd/system"), reason="the scripts only manage units under systemd")
@pytest.mark.parametrize("script", RESET_SCRIPTS)
def test_reset_rechecks_the_destination_after_the_services_stop(tmp_path, script):
    # The window between validating a path and deleting under it: while the unit is being stopped, a
    # path component of the .env-derived save dir is swapped for a symlink to a foreign dir. The
    # re-check after the stop must catch it — otherwise `rm` would follow the new link out of the app.
    app, elsewhere = _reset_layout(tmp_path)
    (app / "data" / "a" / "b" / "u1").mkdir(parents=True)
    (app / "data" / "a" / "b" / "u1" / "save.json").write_text("{}")
    (elsewhere / "b" / "u1").mkdir(parents=True)
    (elsewhere / "b" / "u1" / "save.json").write_text("{}")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _stub(bin_dir / "systemctl",
          'case "$1" in\n  list-unit-files) echo "orwell-test-live.service enabled" ;;\n'
          f'  stop) rm -rf "{app}/data/a"; ln -s "{elsewhere}" "{app}/data/a" ;;\n'
          '  is-active) exit 3 ;;\n  *) exit 0 ;;\nesac\n')
    _stub(bin_dir / "id", f'[[ "$1" == "-u" ]] && {{ echo 0; exit 0; }}\nexec {shutil.which("id")} "$@"\n')
    proc = _run_reset(script, app, str(app / "data" / "a" / "b"),
                      PATH=f"{bin_dir}:{os.environ['PATH']}",
                      ORWELL_ENGINE_SVC="orwell-test-live", ORWELL_FRONTEND_SVC="orwell-test-live")
    assert proc.returncode != 0
    assert "refusing" in proc.stderr, proc.stderr
    assert (elsewhere / "b" / "u1" / "save.json").exists(), "root deleted through a symlink swapped in after validation"


@pytest.mark.parametrize("script", RESET_SCRIPTS)
def test_an_operator_env_override_is_still_honored(tmp_path, script):
    # ORWELL_DATA_DIR in root's OWN environment is a deliberate dev/operator choice (the existing
    # test_oobe_reset_script relies on it); only the value read from data/.env is untrusted.
    app, elsewhere = _reset_layout(tmp_path)
    proc = _run_reset(script, app, str(app), ORWELL_DATA_DIR=str(elsewhere))
    assert proc.returncode == 0, proc.stderr
    assert not (elsewhere / "u1").exists()
    assert (app / "src" / "keep.txt").exists()


# =============================================================================================
# 2b. OPS SCRIPTS — never follow a symlink under data/ or data/ops
# =============================================================================================

def _ops_layout(tmp_path):
    app = tmp_path / "app"
    for rel in (".git", "deploy", "data/ops"):
        (app / rel).mkdir(parents=True)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    log = tmp_path / "stub.log"
    return app, bin_dir, log


def _stub(path, body):
    path.write_text("#!/usr/bin/env bash\n" + body)
    path.chmod(0o755)


def _victim(tmp_path, name="victim", text="VICTIM-SECRET"):
    path = tmp_path / name
    path.write_text(text)
    return path


# ---- orwell-ops-tls.sh -----------------------------------------------------------------------

TLS_CONFIG = '{"action": "apply", "localNames": ["orwell.lan"], "domains": [], "dnsProvider": ""}'


def _tls_setup(tmp_path):
    app, _, log = _ops_layout(tmp_path)
    _stub(app / "deploy" / "orwell-https.sh",
          f'echo "ARGS=$*" >> "{log}"; echo "TOKEN=${{ORWELL_TLS_DNS_API_TOKEN:-}}" >> "{log}"\n')
    ops = app / "data" / "ops"
    (ops / "tls.json").write_text(TLS_CONFIG)
    (ops / "tls-dns-token").write_text("dns-token-value\n")
    return app, ops, log


def _run_tls(app):
    tmpdir = app.parent / "tmpdir"
    tmpdir.mkdir(exist_ok=True)
    return _bash([OPS_TLS], _clean_env(APP_DIR=str(app), TMPDIR=str(tmpdir)))


def _no_claim_leftovers(app):
    """The private claim dir (mktemp -d under TMPDIR) — and the shredded token inside it — must be gone."""
    return os.listdir(app.parent / "tmpdir") == []


def test_ops_tls_happy_path_passes_the_token_via_env_and_shreds_it(tmp_path):
    app, ops, log = _tls_setup(tmp_path)
    proc = _run_tls(app)
    assert proc.returncode == 0, proc.stderr
    assert "ARGS=--mode local --yes --local-names orwell.lan" in log.read_text()
    assert "TOKEN=dns-token-value\n" in log.read_text()
    assert not (ops / "tls-dns-token").exists() and not (ops / "tls.json").exists()
    assert _no_claim_leftovers(app)
    assert "dns-token-value" not in proc.stdout + proc.stderr


@pytest.mark.parametrize("which", ["tls-dns-token", "tls.json", "tls-requested", "ops-dir"])
def test_ops_tls_refuses_symlinks_and_leaves_their_targets_alone(tmp_path, which):
    app, ops, log = _tls_setup(tmp_path)
    victim = _victim(tmp_path, text=TLS_CONFIG if which == "tls.json" else "VICTIM-SECRET")
    if which == "ops-dir":
        real = tmp_path / "real-ops"
        shutil.move(str(ops), real)
        ops.symlink_to(real)
    else:
        (ops / which).unlink(missing_ok=True)
        (ops / which).symlink_to(victim)
    proc = _run_tls(app)
    assert proc.returncode != 0
    assert "symlink" in proc.stderr
    assert not log.exists(), "orwell-https.sh must not run when a path is a symlink"
    assert victim.read_text() in ("VICTIM-SECRET", TLS_CONFIG), "the symlink target was shredded/overwritten"
    assert _no_claim_leftovers(app)
    if which == "ops-dir":
        assert (tmp_path / "real-ops" / "tls.json").exists(), "nothing may be removed through a symlinked ops dir"
    else:
        assert not (ops / which).is_symlink(), "the planted link is claimed/dropped, never left to be re-followed"


def test_ops_tls_refuses_a_token_carrying_a_control_character(tmp_path):
    app, ops, log = _tls_setup(tmp_path)
    (ops / "tls-dns-token").write_text("tok\nen")
    proc = _run_tls(app)
    assert proc.returncode != 0
    assert not log.exists(), "orwell-https.sh must not run with a multi-line token"
    assert _no_claim_leftovers(app)


# ---- orwell-ops-public-deployment.sh ---------------------------------------------------------

PUBLIC_CONFIG = ('{"action": "apply", "env": {"ORWELL_PUBLIC": "1", "ALLOWED_HOSTS": "hiorwell.com", '
                 '"ALLOWED_ORIGINS": "https://hiorwell.com", "SECURE_COOKIES": "true"}, "domains": ["hiorwell.com"]}')


def _public_setup(tmp_path):
    app, bin_dir, log = _ops_layout(tmp_path)
    _stub(bin_dir / "systemctl", "exit 0\n")
    _stub(bin_dir / "cloudflared", f'echo "TUNNEL_TOKEN=${{TUNNEL_TOKEN:-}}" >> "{log}"\n')
    ops = app / "data" / "ops"
    (ops / "public-deployment.json").write_text(PUBLIC_CONFIG)
    (ops / "cloudflared-token").write_text("tunnel-token-value\n")
    (app / "data" / ".env").write_text("ORWELL_PORT=8080\n")
    return app, bin_dir, ops, log


def _run_public(app, bin_dir):
    tmpdir = app.parent / "tmpdir"
    tmpdir.mkdir(exist_ok=True)
    return _bash([OPS_PUBLIC], _clean_env(APP_DIR=str(app), TMPDIR=str(tmpdir),
                                          PATH=f"{bin_dir}:{os.environ['PATH']}"))


def test_ops_public_deployment_happy_path_upserts_env_and_shreds_the_token(tmp_path):
    app, bin_dir, ops, log = _public_setup(tmp_path)
    proc = _run_public(app, bin_dir)
    assert proc.returncode == 0, proc.stderr
    env_text = (app / "data" / ".env").read_text()
    for line in ("ORWELL_PORT=8080", "ORWELL_PUBLIC=1", "ALLOWED_HOSTS=hiorwell.com", "AUTH_ENABLED=true",
                 "LOCALHOST_BYPASS=false", "ORWELL_BIND_HOST=127.0.0.1"):
        assert line in env_text.splitlines(), line
    assert "TUNNEL_TOKEN=tunnel-token-value\n" in log.read_text()
    assert not (ops / "cloudflared-token").exists()
    assert os.listdir(tmp_path / "tmpdir") == [], "the private claim dir (and the shredded token) must be gone"
    assert "tunnel-token-value" not in proc.stdout + proc.stderr


def test_ops_public_deployment_only_writes_the_wizards_keys_and_never_a_multiline_value(tmp_path):
    # The side file is written by the unprivileged web tier (or anything running as its user), so the ROOT
    # script must not trust it to be what the route layer validated.
    import json
    app, bin_dir, ops, log = _public_setup(tmp_path)
    cfg = json.loads(PUBLIC_CONFIG)
    cfg["env"]["LD_PRELOAD"] = "/tmp/evil.so"                                   # not one of the wizard's keys
    cfg["env"]["ALLOWED_ORIGINS"] = "https://hiorwell.com\nORWELL_ENGINE_ADMIN_TOKEN=known"   # newline injection
    (ops / "public-deployment.json").write_text(json.dumps(cfg))
    proc = _run_public(app, bin_dir)
    assert proc.returncode == 0, proc.stderr
    env_text = (app / "data" / ".env").read_text()
    assert "LD_PRELOAD" not in env_text and "ORWELL_ENGINE_ADMIN_TOKEN" not in env_text
    assert "ALLOWED_ORIGINS=" not in env_text, "a value with a control character is skipped entirely"
    assert "ALLOWED_HOSTS=hiorwell.com" in env_text.splitlines()                # the clean keys still land
    assert "unexpected key 'LD_PRELOAD'" in proc.stderr and "control character" in proc.stderr


def test_ops_public_deployment_refuses_a_token_carrying_a_control_character(tmp_path):
    app, bin_dir, ops, log = _public_setup(tmp_path)
    (ops / "cloudflared-token").write_text("tok\nen")
    proc = _run_public(app, bin_dir)
    assert proc.returncode != 0
    assert not log.exists(), "cloudflared must not run with a multi-line token"
    assert os.listdir(tmp_path / "tmpdir") == []


@pytest.mark.parametrize("which", ["cloudflared-token", "public-deployment.json", "public-deployment-requested",
                                   "dotenv", "ops-dir"])
def test_ops_public_deployment_refuses_symlinks_and_leaves_their_targets_alone(tmp_path, which):
    app, bin_dir, ops, log = _public_setup(tmp_path)
    victim = _victim(tmp_path, text=PUBLIC_CONFIG if which == "public-deployment.json" else "VICTIM-SECRET")
    if which == "ops-dir":
        real = tmp_path / "real-ops"
        shutil.move(str(ops), real)
        ops.symlink_to(real)
    elif which == "dotenv":
        (app / "data" / ".env").unlink()
        (app / "data" / ".env").symlink_to(victim)
    else:
        (ops / which).unlink(missing_ok=True)
        (ops / which).symlink_to(victim)
    proc = _run_public(app, bin_dir)
    assert proc.returncode != 0
    assert "symlink" in proc.stderr
    assert not log.exists(), "cloudflared must not run when a path is a symlink"
    assert victim.read_text() in ("VICTIM-SECRET", PUBLIC_CONFIG), "the symlink target was shredded/overwritten"
    assert os.listdir(tmp_path / "tmpdir") == []
    if which == "ops-dir":
        assert (tmp_path / "real-ops" / "cloudflared-token").exists()


# ---- orwell-https.sh -------------------------------------------------------------------------

def _run_https(app, *flags):
    return _bash([HTTPS, *flags], _clean_env(APP_DIR=str(app)))


@pytest.mark.parametrize("which", ["dotenv", "tls-dir"])
def test_https_refuses_a_symlinked_env_or_tls_dir(tmp_path, which):
    app, _, _ = _ops_layout(tmp_path)
    victim = _victim(tmp_path, text="A=1\n")
    if which == "dotenv":
        (app / "data" / ".env").symlink_to(victim)
    else:
        real = tmp_path / "real-tls"
        real.mkdir()
        (app / "data" / "tls").symlink_to(real)
    proc = _run_https(app, "--mode", "local", "--yes", "--no-restart")
    assert proc.returncode != 0
    assert "is a symlink" in proc.stderr
    assert victim.read_text() == "A=1\n"
    assert not os.listdir(tmp_path / "real-tls") if which == "tls-dir" else True


def _https_fns(body, env_file, **env_extra):
    """Run `body` with orwell-https.sh's real .env helpers sourced (extracted, not re-typed)."""
    text = _read(HTTPS)
    fns = "\n".join([
        'die() { echo "ERROR: $*" >&2; exit 1; }',
        next(ln for ln in text.splitlines() if ln.startswith("refuse_symlink()")),
        _extract(text, "write_env_file() {"), _extract(text, "set_env_key() {"),
        _extract(text, "del_env_key() {"), _extract(text, "restore_env_owner() {"),
    ])
    env = _clean_env(ENV_FILE=str(env_file), FRONTEND_SVC="orwell-test-none", **env_extra)
    return _bash(["-c", f"set -euo pipefail\n{fns}\n{body}"], env)


def test_https_env_helpers_upsert_in_place_and_create_0600(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("A=1\nORWELL_TLS_MODE=off\nB=2\n")
    inode = os.stat(env_file).st_ino
    proc = _https_fns('set_env_key ORWELL_TLS_MODE local; set_env_key C 3; del_env_key A', env_file)
    assert proc.returncode == 0, proc.stderr
    assert env_file.read_text() == "ORWELL_TLS_MODE=local\nB=2\nC=3\n"
    assert os.stat(env_file).st_ino == inode, "the .env is rewritten IN PLACE (owner/mode preserved)"
    fresh = tmp_path / "new" / ".env"
    assert _https_fns("set_env_key X 1", fresh).returncode == 0
    assert fresh.read_text() == "X=1\n" and stat.S_IMODE(os.stat(fresh).st_mode) == 0o600


def test_https_env_helpers_refuse_a_symlinked_env_and_leave_the_target_alone(tmp_path):
    victim = _victim(tmp_path, text="A=1\n")
    env_file = tmp_path / ".env"
    env_file.symlink_to(victim)
    for body in ("set_env_key K v", "del_env_key A", "restore_env_owner"):
        proc = _https_fns(body, env_file)
        assert proc.returncode != 0 and "is a symlink" in proc.stderr, body
    assert victim.read_text() == "A=1\n"


def test_https_writes_and_chmods_are_nofollow_even_if_the_check_is_raced(tmp_path):
    # The refuse_symlink check can lose a race (the path is swapped for a link right after it), so the
    # write / fchmod themselves must refuse a link: neutralise the check and prove the target survives.
    victim = _victim(tmp_path, text="A=1\n")
    os.chmod(victim, 0o644)
    env_file = tmp_path / ".env"
    env_file.symlink_to(victim)
    body = 'refuse_symlink() { :; }\n(write_env_file /dev/null) || true\nrestore_env_owner\n'
    _https_fns(body, env_file, ORWELL_SERVICE_USER=os.environ.get("USER") or "root")
    assert victim.read_text() == "A=1\n", "write_env_file followed a symlink"
    assert stat.S_IMODE(os.stat(victim).st_mode) == 0o644, "restore_env_owner chmod'ed through a symlink"


def test_https_restore_env_owner_sets_mode_600_on_a_regular_file(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text("A=1\n")
    os.chmod(env_file, 0o644)
    me = subprocess.run(["id", "-un"], capture_output=True, text=True).stdout.strip()
    assert _https_fns("restore_env_owner", env_file, ORWELL_SERVICE_USER=me).returncode == 0
    assert stat.S_IMODE(os.stat(env_file).st_mode) == 0o600


@pytest.mark.parametrize("extra,flag", [
    ({"ORWELL_TLS_DNS_API_TOKEN": "tok\nen"}, None),
    ({}, ("--acme-email", "me@example.com\nevil")),
    ({}, ("--acme-email", "x@y.z } evil.test {")),
])
def test_https_refuses_a_control_character_token_or_a_non_email_acme_address(tmp_path, extra, flag):
    app, _, _ = _ops_layout(tmp_path)
    args = ["--print-caddyfile", "--mode", "local", "--local-names", "orwell.lan", *(flag or ())]
    proc = _bash([HTTPS, *args], _clean_env(APP_DIR=str(app), **extra))
    assert proc.returncode != 0 and "refusing" in proc.stderr


def test_https_still_prints_a_caddyfile_for_a_normal_layout(tmp_path):
    app, _, _ = _ops_layout(tmp_path)
    proc = _run_https(app, "--print-caddyfile", "--mode", "local", "--local-names", "orwell.lan")
    assert proc.returncode == 0, proc.stderr
    assert "orwell.lan" in proc.stdout


# ---- orwell-ops-progress.sh ------------------------------------------------------------------

def _progress(ops_dir, body):
    env = _clean_env(ORWELL_OPS_DIR=str(ops_dir))
    return _bash(["-c", f'. "{PROGRESS}"\n{body}'], env)


def test_progress_status_file_is_written_atomically_and_readable(tmp_path):
    ops = tmp_path / "ops"
    proc = _progress(ops, 'ops_progress_init tls 2; ops_progress_step 1 "going"; ops_progress_done "ok"')
    assert proc.returncode == 0, proc.stderr
    assert '"ok":true' in (ops / "tls-status.json").read_text()
    assert stat.S_IMODE(os.stat(ops / "tls-status.json").st_mode) == 0o644
    assert os.listdir(ops) == ["tls-status.json"], "no temp file may be left behind"


def test_progress_replaces_a_planted_symlink_instead_of_writing_through_it(tmp_path):
    ops = tmp_path / "ops"
    ops.mkdir()
    victim = _victim(tmp_path)
    (ops / "tls-status.json").symlink_to(victim)
    assert _progress(ops, 'ops_progress_init tls 1; ops_progress_done').returncode == 0
    assert victim.read_text() == "VICTIM-SECRET"
    assert not (ops / "tls-status.json").is_symlink()


def test_progress_replaces_a_symlink_to_a_directory_instead_of_moving_into_it(tmp_path):
    ops = tmp_path / "ops"
    ops.mkdir()
    target = tmp_path / "somewhere"
    target.mkdir()
    (ops / "tls-status.json").symlink_to(target, target_is_directory=True)
    assert _progress(ops, 'ops_progress_init tls 1; ops_progress_done').returncode == 0
    assert os.listdir(target) == []
    assert (ops / "tls-status.json").is_file()


def test_progress_refuses_a_symlinked_ops_dir(tmp_path):
    real = tmp_path / "real"
    real.mkdir()
    ops = tmp_path / "ops"
    ops.symlink_to(real)
    proc = _progress(ops, 'ops_progress_init tls 1; ops_progress_done')
    assert proc.returncode == 0                      # best-effort: a status write never fails the run
    assert "symlink" in proc.stderr
    assert os.listdir(real) == []


def test_progress_uses_mktemp_not_a_predictable_temp_name():
    text = _read(PROGRESS)
    assert "mktemp" in text
    assert ".tmp.$$" not in text
