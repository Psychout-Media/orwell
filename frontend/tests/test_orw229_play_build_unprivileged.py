"""ORW-229 follow-up — the /play build never runs third-party code as root.

The updater runs as root, and building /play runs its dependencies' code (tsc, vite, plugins). As root the build now
runs as an unprivileged account (`nobody` by default), in a clean environment (nothing of the updater's environment
leaks in), with its own npm cache; root takes the output back, refuses anything but plain files and directories in
it, and copies it without keeping the build account's ownership. If privileges cannot be dropped, /play is not built
(a warning; it keeps its current build). As a non-root user (tests, dev) the build runs as that user, as before.

The /play functions are taken verbatim from the real updater and run against a small git checkout with an npm stub;
"root" is simulated with fake `id`, `runuser`, `chown` and `install` on PATH. Name-agnostic: roles only.
"""
import os
import shutil
import subprocess
from pathlib import Path

import pytest

UPDATE = Path(__file__).resolve().parents[2] / "deploy" / "orwell-update.sh"
pytestmark = pytest.mark.skipif(any(shutil.which(t) is None for t in ("bash", "git", "tar")), reason="needs bash, git, tar")
not_root = pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0, reason="simulates root as an unprivileged user")
_TOOLS = ("bash", "git", "tar", "mktemp", "rm", "cp", "mv", "find", "head", "tr", "cat", "env", "sha256sum", "cut",
          "mkdir", "printf", "id", "dirname", "sed", "grep", "ls", "touch", "ln")


def _region(text, start_prefix, stop_prefix):
    lines = text.splitlines()
    begin = next(i for i, ln in enumerate(lines) if ln.startswith(start_prefix))
    stop = next(i for i in range(begin + 1, len(lines)) if lines[i].startswith(stop_prefix))
    return "\n".join(lines[begin:stop])


def _fake(bindir, name, body):
    p = bindir / name
    if p.exists() or p.is_symlink():
        p.unlink()
    p.write_text("#!/usr/bin/env bash\n" + body)
    p.chmod(0o755)


class Rig:
    def __init__(self, root: Path):
        self.root = root
        self.app = root / "app"
        self.bin = root / "bin"
        self.bin.mkdir()
        self.log = root / "calls.log"
        self.tmp = root / "tmp"
        self.tmp.mkdir()
        for tool in _TOOLS:
            real = shutil.which(tool)
            if real:
                (self.bin / tool).symlink_to(real)
        # npm stub: the log path is baked in, because the unprivileged build runs with a CLEAN environment
        _fake(self.bin, "npm", f"""printf 'npm %s | user=%s home=%s cache=%s secret=%s\\n' "$*" "$(id -un)" "$HOME" "${{npm_config_cache-<unset>}}" "${{PLANTED_SECRET-<unset>}}" >> '{self.log}'
case "$1" in
  ci) rm -rf node_modules; mkdir node_modules ;;
  run) rm -rf dist; mkdir -p dist/assets; cat src/app.txt > dist/index.html; cp dist/index.html dist/assets/app.js
       if grep -q PLANT_SYMLINK src/app.txt; then ln -s /etc/hostname dist/assets/evil.js; fi ;;
esac
exit 0
""")
        (self.app / "frontend" / "web" / "src").mkdir(parents=True)
        (self.app / "frontend" / "static" / "js").mkdir(parents=True)
        (self.app / "frontend" / "web" / "package.json").write_text('{"name":"orwell-play"}\n')
        (self.app / "frontend" / "web" / "package-lock.json").write_text("PLAYLOCK-1\n")
        (self.app / "frontend" / "static" / "js" / "markdown.js").write_text("MD-1\n")
        self.set_app("APP-1")

    def git(self, *args):
        env = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"}
        subprocess.run(["git", *args], cwd=self.app, env=env, check=True, capture_output=True)

    def set_app(self, text):
        (self.app / "frontend" / "web" / "src" / "app.txt").write_text(text + "\n")
        if not (self.app / ".git").exists():
            self.git("init", "-q", "-b", "main")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "c")

    def pretend_root(self, *, runuser=True):
        real_id = shutil.which("id")
        _fake(self.bin, "id", f'if [[ "$*" == "-u" ]]; then echo 0; elif [[ "$1" == -gn ]]; then echo buildgroup; '
                              f'elif [[ "$1" == build-account ]]; then echo "uid=999(build-account)"; else exec {real_id} "$@"; fi\n')
        for tool in ("chown", "install"):
            _fake(self.bin, tool, f'echo "{tool} $*" >> \'{self.log}\'\n')
        if runuser:
            _fake(self.bin, "runuser", f'echo "runuser $*" >> \'{self.log}\'\n[[ "$1" == -u && "$3" == -- ]] || exit 99\nshift 3\nexec "$@"\n')

    def build(self, env=None):
        text = UPDATE.read_text()
        lib = _region(text, "# ── ORW-229 — fast updates:", "# Put the tree back on $1")
        (self.root / "lib.sh").write_text(lib + "\n")
        full = {"PATH": str(self.bin), "HOME": str(self.root), "TMPDIR": str(self.tmp), "LANG": "C.UTF-8",
                "PLANTED_SECRET": "do-not-leak", "ORWELL_PLAY_BUILD_USER": "build-account",
                "ORWELL_PLAY_NPM_CACHE": str(self.root / "play-npm-cache")}
        full.update(env or {})
        web = self.app / "frontend" / "web"
        script = (f"set -euo pipefail; APP_DIR='{self.app}'; PLAY_DIR='{web}'; PLAY_DIST='{web}/dist'; PLAY_NEXT='{web}/dist.next'; "
                  f"PLAY_PREV='{web}/dist.prev'; PLAY_STAMP=.orwell-web-inputs; __UPDATER_FP=test; "
                  f". '{self.root}/lib.sh'; build_play_app || true; echo BUILD-DONE")
        r = subprocess.run([str(self.bin / "bash"), "-c", script], capture_output=True, text=True, timeout=60, env=full)
        assert r.returncode == 0 and "BUILD-DONE" in r.stdout, r.stdout + r.stderr
        return r.stdout + r.stderr

    def calls(self):
        """Every recorded call except `npm -v` (the inputs fingerprint asks for the npm version; not an install)."""
        lines = self.log.read_text().splitlines() if self.log.exists() else []
        return [c for c in lines if not c.startswith("npm -v ")]

    def staged(self):
        p = self.app / "frontend" / "web" / "dist.next" / "index.html"
        return p.read_text().strip() if p.exists() else None


@pytest.fixture
def rig(tmp_path):
    return Rig(tmp_path)


@not_root
def test_as_root_the_build_runs_as_the_unprivileged_account_in_a_clean_environment(rig):
    rig.pretend_root()
    rig.build()
    calls = rig.calls()
    npm = [c for c in calls if c.startswith("npm ")]
    assert [c.split(" |")[0] for c in npm] == ["npm ci --prefer-offline --ignore-scripts --no-audit --no-fund", "npm run build"]
    run = [c for c in calls if c.startswith("runuser ")]
    assert run and run[0].startswith("runuser -u build-account -- env -i "), run
    assert all("secret=<unset>" in c for c in npm), "nothing of the updater's environment reaches the build"
    assert all(f"cache={rig.root / 'play-npm-cache'}" in c for c in npm), "its own npm cache"
    assert all(f"home={rig.tmp}" in c for c in npm), "HOME is the temp build dir, never root's"
    chowns = [c for c in calls if c.startswith("chown ")]
    assert any(c.startswith("chown -R build-account:buildgroup ") for c in chowns), chowns
    assert any(c.startswith("chown -R -h root:root ") for c in chowns), "root takes the output back before copying it"
    assert rig.staged() == "APP-1"


@not_root
@pytest.mark.parametrize("missing", ["runuser", "the build account"])
def test_as_root_without_a_way_to_drop_privileges_play_is_not_built(rig, missing):
    rig.pretend_root(runuser=(missing != "runuser"))
    out = rig.build({"ORWELL_PLAY_BUILD_USER": "no-such-account-xyz"} if missing != "runuser" else None)
    assert not [c for c in rig.calls() if c.startswith("npm ")], "no npm ran (as root or otherwise)"
    assert rig.staged() is None
    assert "not building it as root" in out


@not_root
def test_as_a_normal_user_the_build_runs_in_process_as_before(rig):
    rig.build()
    calls = rig.calls()
    assert not [c for c in calls if c.startswith(("runuser ", "chown "))]
    assert [c.split(" |")[0] for c in calls if c.startswith("npm ")] == [
        "npm ci --prefer-offline --ignore-scripts --no-audit --no-fund", "npm run build"]
    assert rig.staged() == "APP-1"


@not_root
def test_a_build_with_a_symlink_in_it_is_refused(rig):
    rig.set_app("APP-2 PLANT_SYMLINK")
    out = rig.build()
    assert rig.staged() is None, "a symlink (or device, FIFO) in the output never reaches the code tree"
    assert "other than files and directories" in out
