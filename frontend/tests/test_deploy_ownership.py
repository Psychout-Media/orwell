"""Deploy ownership — the code tree stays root-owned; only the dirs the services write belong to them.

`orwell_apply_ownership` is one function, byte-identical in orwell-install.sh and orwell-update.sh. It
hands ONLY data/ (or a custom DATA_DIR), frontend/data, backups/ and .orwell-data to the service user;
everything else is root:root with no group/other write bit, and a symlink is never followed. The tests run
the REAL function over a throwaway tree under tmp (no /opt, no systemd, no root needed): `chown` is
replaced by a recording stub, `find` and `chmod` are real. Name-agnostic: roles only, no houseguests.
"""
import os
import re
import shutil
import stat
import subprocess

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEPLOY = os.path.join(REPO, "deploy")
INSTALL = os.path.join(DEPLOY, "orwell-install.sh")
UPDATE = os.path.join(DEPLOY, "orwell-update.sh")

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
# 1. OWNERSHIP
# =============================================================================================

def _ownership_fn():
    return _extract(_read(INSTALL), "orwell_apply_ownership() {")


def test_install_and_update_share_one_ownership_function():
    assert _ownership_fn() == _extract(_read(UPDATE), "orwell_apply_ownership() {")


@pytest.mark.parametrize("path", [INSTALL, UPDATE])
def test_nothing_chowns_the_whole_app_dir_to_the_service_user(path):
    text = _read(path)
    allowed = ("data", "frontend/data", "backups", ".orwell-data")
    for ln in text.splitlines():
        code = ln.split("#", 1)[0]
        if re.search(r"\bchown\b[^\n]*-R", code):
            # every recursive chown that is left may reference $APP_DIR (braced or not, quoted or not) ONLY
            # as one of the named writable dirs — never the app dir itself or a code subdirectory
            for m in re.finditer(r'\$\{?APP_DIR\}?(/[^\s"\'}]*)?', code):
                sub = (m.group(1) or "").strip("/")
                assert sub in allowed, f"{path}: {ln.strip()}"
    assert "orwell_apply_ownership" in text


def test_a_failing_code_tree_chmod_makes_the_ownership_function_fail(tmp_path):
    app = _make_app(tmp_path)
    bin_dir = _stub_chown(tmp_path)
    (bin_dir / "chmod").write_text("#!/usr/bin/env bash\nexit 1\n")
    (bin_dir / "chmod").chmod(0o755)
    log = tmp_path / "chown.log"
    env = _clean_env(PATH=f"{bin_dir}:{os.environ['PATH']}", CHOWN_LOG=str(log))
    # called the way orwell-update.sh now calls it: directly, under set -e, NOT inside an `||` list
    script = f"set -euo pipefail\n{_ownership_fn()}\nif orwell_apply_ownership \"$@\"; then echo OK; else echo FAILED; fi\n"
    proc = _bash(["-c", script, "x", str(app), "orwell", "orwell"], env)
    assert "FAILED" in proc.stdout and "OK" not in proc.stdout


def test_update_does_not_swallow_an_ownership_failure():
    text = _read(UPDATE)
    call = text.index('orwell_apply_ownership "$APP_DIR" "$SVC_USER" "$SVC_GROUP"')
    window = text[call - 30:call + 400]
    assert window.lstrip().startswith("if ! orwell_apply_ownership") or "if ! orwell_apply_ownership" in window
    assert "|| echo" not in text[call:call + 200]


def test_update_migrates_through_the_same_function():
    assert 'orwell_apply_ownership "$APP_DIR" "$SVC_USER" "$SVC_GROUP"' in _read(UPDATE)
    assert 'orwell_apply_ownership "$APP_DIR" orwell orwell "$DATA_DIR"' in _read(INSTALL)


def _stub_chown(tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    stub = bin_dir / "chown"
    stub.write_text('#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$CHOWN_LOG"\n')
    stub.chmod(0o755)
    return bin_dir


def _make_app(tmp_path):
    app = tmp_path / "app"
    for rel in ("src", "deploy", "dist", "node_modules/pkg", "node_modules/.bin", "frontend/.venv/bin",
                "frontend/data", "data/saves/u1", "data/ops", "backups", ".orwell-data", ".git"):
        (app / rel).mkdir(parents=True)
    for rel in ("src/a.ts", "deploy/orwell-update.sh", "dist/main.js", "node_modules/pkg/cli.js",
                "frontend/.venv/bin/python", ".git/config", "data/.env", "data/saves/u1/save.json",
                "frontend/data/app.db", "backups/old.tar.gz"):
        (app / rel).write_text("x")
    os.chmod(app / "src" / "a.ts", 0o666)          # left group/other-writable by an older install
    os.chmod(app / "frontend" / "data" / "app.db", 0o600)
    os.chmod(app / "dist" / "main.js", 0o600)       # code the service user must still be able to read
    os.chmod(app / "deploy" / "orwell-update.sh", 0o700)
    os.chmod(app / "node_modules" / "pkg", 0o700)
    (app / "node_modules" / ".bin" / "tool").symlink_to("../pkg/cli.js")
    return app


def _run_ownership(tmp_path, app, *extra_dirs):
    log = tmp_path / "chown.log"
    env = _clean_env(PATH=f"{_stub_chown(tmp_path)}:{os.environ['PATH']}", CHOWN_LOG=str(log))
    script = f"set -euo pipefail\n{_ownership_fn()}\norwell_apply_ownership \"$@\"\n"
    proc = _bash(["-c", script, "x", str(app), "orwell", "orwell", *map(str, extra_dirs)], env)
    calls = log.read_text().splitlines() if log.exists() else []
    return proc, calls


def _under(path, roots):
    return any(path == r or path.startswith(r + "/") for r in roots)


def test_code_tree_goes_to_root_and_only_the_writable_dirs_to_the_service_user(tmp_path):
    app = _make_app(tmp_path)
    custom = tmp_path / "custom-data"
    custom.mkdir()
    proc, calls = _run_ownership(tmp_path, app, custom)
    assert proc.returncode == 0, proc.stderr

    root_paths = [p for c in calls if c.startswith("-h root:root ") for p in c.split()[2:]]
    svc_dirs = [c.split()[3] for c in calls if c.startswith("-R -h orwell:orwell ")]
    writable = [str(app / "data"), str(app / "frontend" / "data"), str(app / "backups"),
                str(app / ".orwell-data")]

    # the code tree — including deploy/, dist/, node_modules, frontend/.venv, .git and the app dir
    # itself — is handed to root …
    for rel in ("", "src/a.ts", "deploy/orwell-update.sh", "dist/main.js", "node_modules/pkg/cli.js",
                "node_modules/.bin/tool", "frontend", "frontend/.venv/bin/python", ".git/config"):
        assert str(app / rel).rstrip("/") in root_paths, rel
    # … and NOTHING under a service-writable dir is (it never even briefly flips to root)
    assert not [p for p in root_paths if _under(p, writable)]
    # the service user gets exactly the writable dirs: data/, frontend/data, backups/, the engine's
    # default save dir .orwell-data, + the custom DATA_DIR
    assert sorted(svc_dirs) == sorted(writable + [str(custom)])


def test_code_tree_loses_group_and_other_write_bits_but_data_modes_are_untouched(tmp_path):
    app = _make_app(tmp_path)
    victim = tmp_path / "victim"
    victim.write_text("outside the tree")
    os.chmod(victim, 0o666)
    (app / "src" / "outside-link").symlink_to(victim)

    proc, _ = _run_ownership(tmp_path, app)
    assert proc.returncode == 0, proc.stderr

    assert stat.S_IMODE(os.stat(app / "src" / "a.ts").st_mode) & 0o022 == 0
    # root-owned code stays readable (dirs/scripts traversable/executable) by the service user, even if
    # an earlier root umask left it private
    assert stat.S_IMODE(os.stat(app / "dist" / "main.js").st_mode) & 0o044 == 0o044
    assert stat.S_IMODE(os.stat(app / "deploy" / "orwell-update.sh").st_mode) & 0o055 == 0o055
    assert stat.S_IMODE(os.stat(app / "node_modules" / "pkg").st_mode) & 0o055 == 0o055
    assert stat.S_IMODE(os.stat(app / "frontend" / "data" / "app.db").st_mode) == 0o600
    # a symlink in the tree is acted on itself — chmod must never reach through to its target
    assert stat.S_IMODE(os.stat(victim).st_mode) == 0o666


def test_a_symlinked_writable_dir_is_never_chowned_through(tmp_path):
    app = _make_app(tmp_path)
    real = tmp_path / "elsewhere"
    real.mkdir()
    shutil.rmtree(app / "backups")
    (app / "backups").symlink_to(real)

    proc, calls = _run_ownership(tmp_path, app)
    assert proc.returncode == 0
    assert "backups is a symlink" in proc.stderr
    assert not [c for c in calls if str(app / "backups") in c or str(real) in c]


def test_missing_writable_dirs_are_skipped_not_fatal(tmp_path):
    app = _make_app(tmp_path)
    shutil.rmtree(app / "backups")
    proc, calls = _run_ownership(tmp_path, app)
    assert proc.returncode == 0, proc.stderr
    assert not [c for c in calls if c.startswith("-R ") and "backups" in c]
