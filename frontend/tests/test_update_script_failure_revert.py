"""deploy/orwell-update.sh — a failed update leaves a RUNNABLE app, and the rollback state stays consistent.

Runs the REAL update script (and, for the lock tests, the real orwell-update-reset.sh) against a sandboxed
box: a real git checkout of a local "origin", with `npm`, `node`, `pip` and `systemctl` replaced by small
stubs on PATH. The stubs model the parts that matter — `npm ci` DELETES node_modules before it can fail,
and whether a step fails is decided by the contents of the commit that is checked out (so reverting to the
previous commit naturally makes the same step succeed again), exactly like a real box.

Proves:
  * the rollback pair (data/.update-prev SHA + dist.prev) is replaced ONLY when an update fully succeeds,
    and the two move together — a failed attempt can no longer pair an older SHA with a newer build;
  * a failure at ANY step after the update begins (fetch, engine build, `npm ci`, pip, env reconcile)
    restores the previous SHA, its engine + front-end dependencies and its dist, and "reverted" is printed
    only AFTER the restored build is verified to start; if that verification fails the script says the
    revert FAILED (exit 3) instead of claiming success;
  * `--rollback` after a failed update returns to the older SHA with ITS build, refuses a dist.prev that is
    not stamped as built from that SHA, and works after `git gc` (the previous commit is pinned);
  * `REF=<tag|annotated tag|full SHA|abbreviated SHA>` all work (`git fetch origin v1.0` leaves the tag in
    FETCH_HEAD only, so the old `reset --hard v1.0` exited 128);
  * ONE shared flock: a second run refuses (75) without touching anything; Update + Reset holds it across
    both phases and its update child does NOT deadlock on it; the ops units' own locks are other files.

Name-agnostic: roles only, no houseguests. The script is re-rooted (/etc, /usr/local/bin -> the sandbox)
in a COPY before it runs, so none of its root-only host writes can ever touch the machine running the test.
"""
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
DEPLOY = REPO / "deploy"
UPDATE = DEPLOY / "orwell-update.sh"
UPDATE_RESET = DEPLOY / "orwell-update-reset.sh"

_TOOLS = ("bash", "git", "flock", "curl", "python3")
pytestmark = pytest.mark.skipif(
    any(shutil.which(t) is None for t in _TOOLS), reason="needs " + ", ".join(_TOOLS)
)

# Libraries the script sources from its own directory / from the checkout's deploy/ dir.
_LIBS = ("orwell-tui.sh", "orwell-ops-progress.sh", "orwell-env-defaults.sh", "smoke_embeddings.sh",
         "orwell-login-panel.sh")
_CHECKOUT_DEPLOY_FILES = ("orwell-env-defaults.sh", "smoke_embeddings.sh", "orwell-login-panel.sh")

# ── stubs ─────────────────────────────────────────────────────────────────────────────────────────
_NPM = r"""#!/usr/bin/env bash
echo "npm $*" >> "$STUB_LOG"
case "$1" in
  ci)  # real `npm ci` removes node_modules FIRST — a failure leaves the app without dependencies
    rm -rf node_modules
    if [[ -n "$STUB_OFFLINE" ]] || grep -q BREAK_NPM_CI package-lock.json; then echo "npm ERR! simulated registry failure" >&2; exit 1; fi
    mkdir node_modules; cp package-lock.json node_modules/.installed-from-lock ;;
  run)
    if grep -q SLOW_FAIL_BUILD package.json; then sleep 3; echo "simulated slow build failure" >&2; exit 1; fi
    if grep -q BREAK_BUILD package.json; then
      mkdir -p dist; echo PARTIAL > dist/main.js; echo "simulated build failure" >&2; exit 1
    fi
    mkdir -p dist; echo "BUILD:$(git rev-parse HEAD)" > dist/main.js; : > dist/embedWorker.js ;;
  cache) exit 1 ;;
esac
exit 0
"""

_NODE = r"""#!/usr/bin/env bash
echo "node $*" >> "$STUB_LOG"
case "$1" in
  *embedWorker.js) exit 0 ;;                                   # the embedding-model prefetch
  dist/main.js)                                                # the engine: only boots if it really could
    [[ -d node_modules ]] || { echo "Error: Cannot find package 'better-sqlite3' (node_modules is gone)" >&2; exit 1; }
    if grep -q BROKEN dist/main.js 2>/dev/null; then echo "SyntaxError: simulated unstartable build" >&2; exit 1; fi
    exec "$STUB_PYTHON" -c '
import http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"{\"ok\":true}"
        self.send_response(200); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
' "$ORWELL_ENGINE_PORT" ;;
esac
exit 0
"""

_SYSTEMCTL = r"""#!/usr/bin/env bash
echo "systemctl $*" >> "$STUB_LOG"
if [[ "$1" == list-unit-files ]]; then echo "$2 enabled"; fi
if [[ "$1" == restart && "$2" == orwell-engine && -n "$STUB_FAIL_RESTART" ]]; then echo "simulated restart failure" >&2; exit 1; fi
exit 0
"""

_PIP = r"""#!/usr/bin/env bash
echo "pip $*" >> "$STUB_LOG"
req="${@: -1}"
if grep -q BREAK_PIP "$req"; then echo "ERROR: simulated pip failure" >&2; exit 1; fi
cp "$req" "$(dirname "$0")/../installed-from-requirements"
"""


def _write_exec(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    path.chmod(0o755)


def _reroot(text: str, root: Path) -> str:
    """Point every root-only host path the script writes (/etc, /usr/local/bin) at the sandbox."""
    return text.replace("/usr/local/bin", f"{root}/usr/local/bin").replace("/etc/", f"{root}/etc/")


class Box:
    """A sandboxed box: bare origin + authoring repo + an installed checkout + stubs."""

    def __init__(self, root: Path):
        self.root = root
        self.origin = root / "origin.git"
        self.src = root / "src"
        self.app = root / "app"
        self.lock = root / "update.lock"
        self.script = root / "tools" / "orwell-update.sh"
        self.log = root / "stubs.log"
        (root / "home").mkdir()
        for sub in ("etc/profile.d", "usr/local/bin", "tools"):
            (root / sub).mkdir(parents=True)
        for name, text in (("npm", _NPM), ("node", _NODE), ("systemctl", _SYSTEMCTL)):
            _write_exec(root / "bin" / name, text)
        # The script under test: a COPY, re-rooted; the libs it sources sit beside it.
        for lib in _LIBS:
            shutil.copy(DEPLOY / lib, root / "tools" / lib)
        self.script.write_text(_reroot(UPDATE.read_text(), root))
        self.git(self.root, "init", "-q", "--bare", "-b", "main", str(self.origin))
        self.git(self.root, "init", "-q", "-b", "main", str(self.src))
        self.git(self.src, "remote", "add", "origin", str(self.origin))

    # ── environment / process helpers ──
    def env(self, **extra) -> dict:
        env = {k: v for k, v in os.environ.items() if not k.startswith(("GIT_", "ORWELL_", "BBAI_"))}
        env.update(
            PATH=f"{self.root / 'bin'}:{os.environ['PATH']}",
            HOME=str(self.root / "home"),
            APP_DIR=str(self.app),
            BRANCH="main",
            GIT_CONFIG_GLOBAL="/dev/null",
            GIT_CONFIG_SYSTEM=str(self.root / "gitconfig-system"),
            GIT_TERMINAL_PROMPT="0",
            GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.invalid",
            GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.invalid",
            STUB_LOG=str(self.log),
            STUB_PYTHON=sys.executable,
            ORWELL_UPDATE_LOCK=str(self.lock),
        )
        env.update(extra)
        return env

    def git(self, cwd, *args, check=True) -> str:
        r = subprocess.run(["git", *args], cwd=str(cwd), env=self.env(), capture_output=True, text=True)
        if check and r.returncode != 0:
            raise AssertionError(f"git {' '.join(args)} failed: {r.stderr}")
        return r.stdout.strip()

    def run_update(self, *args, timeout=120, **env_extra) -> subprocess.CompletedProcess:
        return subprocess.run(["bash", str(self.script), *args], cwd=str(self.root), env=self.env(**env_extra),
                              capture_output=True, text=True, timeout=timeout)

    # ── authoring commits on "origin" ──
    def commit(self, version, *, break_build=False, break_npm=False, break_pip=False, break_env=False,
               break_host=False, slow_fail_build=False, same_locks=False) -> str:
        w = self.src
        lock = "1" if same_locks else version  # same_locks: a code-only change (lockfiles identical to v1)
        (w / "VERSION").write_text(version)
        marker = ("// BREAK_BUILD\n" if break_build else "") + ("// SLOW_FAIL_BUILD\n" if slow_fail_build else "")
        (w / "package.json").write_text('{"name":"fixture"}\n' + marker)
        (w / "package-lock.json").write_text(f"LOCK-{lock}\n" + ("BREAK_NPM_CI\n" if break_npm else ""))
        (w / "frontend").mkdir(exist_ok=True)
        (w / "frontend" / "requirements.lock.txt").write_text(f"REQ-{lock}\n" + ("BREAK_PIP\n" if break_pip else ""))
        (w / "deploy").mkdir(exist_ok=True)
        for name in _CHECKOUT_DEPLOY_FILES:
            shutil.copy(DEPLOY / name, w / "deploy" / name)
        if break_env:  # a broken env-defaults lib: the data/.env reconcile fails when it is sourced
            (w / "deploy" / "orwell-env-defaults.sh").write_text("false\n")
        if break_host:  # the host reconcile `install`s the login panel from the checkout: absent => it fails
            (w / "deploy" / "orwell-login-panel.sh").unlink()
        self.git(w, "add", "-A")
        self.git(w, "commit", "-q", "-m", f"v{version}")
        self.git(w, "push", "-q", "origin", "HEAD:main")
        return self.git(w, "rev-parse", "HEAD")

    def tag(self, name, sha, annotated=False):
        args = ["tag", "-a", "-m", name, name, sha] if annotated else ["tag", name, sha]
        self.git(self.src, *args)
        self.git(self.src, "push", "-q", "origin", name)

    # ── the installed checkout a first install leaves behind ──
    def install(self):
        app = self.app
        app.mkdir()
        self.git(app, "init", "-q", "-b", "main")
        self.git(app, "remote", "add", "origin", f"file://{self.origin}")
        self.git(app, "fetch", "-q", "--depth", "1", "origin", "main")
        self.git(app, "reset", "-q", "--hard", "origin/main")
        sha = self.head()
        (app / "node_modules").mkdir()
        shutil.copy(app / "package-lock.json", app / "node_modules" / ".installed-from-lock")
        (app / "dist").mkdir()
        (app / "dist" / "main.js").write_text(f"BUILD:{sha}\n")
        (app / "dist" / ".orwell-build-sha").write_text(sha)  # the build stamp this updater writes
        for name, text in (("pip", _PIP), ("python", "#!/usr/bin/env bash\nexit 0\n"),
                           ("uvicorn", "#!/usr/bin/env bash\nexit 0\n")):
            _write_exec(app / "frontend" / ".venv" / "bin" / name, text)
        shutil.copy(app / "frontend" / "requirements.lock.txt", app / "frontend" / ".venv" / "installed-from-requirements")
        (app / "data" / "ops").mkdir(parents=True)
        (app / "data" / ".env").write_text("ORWELL_PORT=8080\n")

    # ── observations ──
    def head(self): return self.git(self.app, "rev-parse", "HEAD")
    def _read(self, rel): return (self.app / rel).read_text().strip()
    def dist(self): return self._read("dist/main.js")
    def deps(self): return self._read("node_modules/.installed-from-lock")
    def fe_deps(self): return self._read("frontend/.venv/installed-from-requirements")
    def prev_sha(self): return self._read("data/.update-prev")
    def prev_dist(self): return self._read("dist.prev/main.js")
    def prev_stamp(self): return self._read("dist.prev/.orwell-build-sha")
    def dist_stamp(self): return self._read("dist/.orwell-build-sha")
    def calls(self): return self.log.read_text().splitlines() if self.log.exists() else []
    def status(self): return json.loads(self._read("data/ops/update-status.json"))


@pytest.fixture
def box(tmp_path):
    b = Box(tmp_path)
    b.v1 = b.commit("1")
    b.install()
    return b


def _combined(r) -> str:
    return r.stdout + r.stderr


# ═════════════════════════════════════════════ success: the pair moves together ═══════════════════════
def test_successful_update_records_sha_and_its_dist_together(box):
    v2 = box.commit("2")
    r = box.run_update()
    assert r.returncode == 0, _combined(r)
    assert box.head() == v2
    assert box.dist() == f"BUILD:{v2}" and box.deps() == "LOCK-2" and box.fe_deps() == "REQ-2"
    assert box.dist_stamp() == v2, "every build carries the SHA it was built from"
    # the rollback pair: the PREVIOUS sha and the PREVIOUS build, stamped as built from that sha
    assert box.prev_sha() == box.v1
    assert box.prev_dist() == f"BUILD:{box.v1}" and box.prev_stamp() == box.v1
    assert not (box.app / "dist.staging").exists()
    # and that previous commit is pinned, so a later gc / shallow fetch can't lose it
    assert box.git(box.app, "rev-parse", "refs/orwell/update-prev") == box.v1
    assert "systemctl restart orwell-engine orwell-frontend" in box.calls()


def test_rerun_at_the_same_commit_keeps_the_existing_rollback_target(box):
    box.commit("2")
    assert box.run_update().returncode == 0
    again = box.run_update()
    assert again.returncode == 0, _combined(again)
    # overwriting the pair here would make --rollback a no-op onto the version already running
    assert box.prev_sha() == box.v1
    assert box.prev_dist() == f"BUILD:{box.v1}"


# ═════════════════════════ failure at any step: previous SHA + deps + dist, verified ═══════════════════
_FAILURES = {
    "engine build": {"break_build": True},
    "npm ci": {"break_npm": True},
    "front-end pip install": {"break_pip": True},
    "env reconcile": {"break_env": True},
}


@pytest.mark.parametrize("step", list(_FAILURES))
def test_failed_update_restores_a_runnable_previous_build_and_rollback_stays_consistent(box, step):
    v2 = box.commit("2")
    assert box.run_update().returncode == 0            # box now on v2, rollback pair = v1
    before = len(box.calls())
    box.commit("3", **_FAILURES[step])

    r = box.run_update()
    out = _combined(r)
    assert r.returncode == 1, out
    # previous SHA, its engine + front-end dependencies, and its dist are all back
    assert box.head() == v2
    assert box.deps() == "LOCK-2", "npm ci deleted node_modules: the previous deps must be reinstalled"
    assert box.fe_deps() == "REQ-2"
    assert box.dist() == f"BUILD:{v2}"
    assert not (box.app / "dist.staging").exists()
    # services were never restarted by the failed attempt
    assert not any(c.startswith("systemctl restart orwell-engine") for c in box.calls()[before:])
    # "reverted" is claimed only AFTER the restored build was verified to start
    assert "verifying the restored build can start" in out
    assert out.index("verifying the restored build can start") < out.index(f"reverted to {v2}")
    st = box.status()
    assert st["ok"] is False and st["running"] is False and f"reverted to {v2}" in st["message"]
    # the rollback pair is still the OLDER, mutually consistent one (the bug paired v1 with v2's dist)
    assert box.prev_sha() == box.v1
    assert box.prev_dist() == f"BUILD:{box.v1}" and box.prev_stamp() == box.v1

    # a rollback after the failed update lands on v1 WITH v1's build and dependencies
    rb = box.run_update("--rollback")
    assert rb.returncode == 0, _combined(rb)
    assert box.head() == box.v1
    assert box.dist() == f"BUILD:{box.v1}" and box.deps() == "LOCK-1" and box.fe_deps() == "REQ-1"
    assert "rollback complete" in rb.stdout
    assert rb.stdout.index("verifying the restored build can start") < rb.stdout.index("rollback complete")
    assert box.dist_stamp() == box.v1


def test_fetch_failure_changes_nothing_and_does_not_reinstall_dependencies(box):
    box.git(box.app, "remote", "set-url", "origin", f"file://{box.root}/no-such-origin.git")
    r = box.run_update()
    assert r.returncode == 1, _combined(r)
    assert box.head() == box.v1 and box.dist() == f"BUILD:{box.v1}" and box.deps() == "LOCK-1"
    # nothing was damaged, so nothing is reinstalled (an `npm ci` on a dead network would delete node_modules)
    assert not any(c.startswith("npm ci") for c in box.calls())
    assert not any(c.startswith("node dist/main.js") for c in box.calls()), "no throwaway engine for a no-op"
    assert "nothing had been changed" in _combined(r) and "reverted to" not in _combined(r)
    assert not (box.app / "data" / ".update-prev").exists()


def test_a_revert_that_cannot_start_is_reported_as_failed_not_reverted(box):
    v2 = box.commit("2")
    assert box.run_update().returncode == 0
    (box.app / "dist" / "main.js").write_text("BROKEN\n")   # the build that was running cannot start
    box.commit("3", break_build=True)

    r = box.run_update()
    out = _combined(r)
    assert r.returncode == 3, out
    assert "revert FAILED" in out
    assert "reverted to" not in out, "must not claim success when the restored build does not start"
    st = box.status()
    assert st["ok"] is False and "revert FAILED" in st["message"] and "reverted to" not in st["message"]
    assert box.head() == v2
    assert (box.app / "dist.staging.failed").is_dir(), "the build that was running is kept for manual recovery"
    assert not (box.app / "dist.staging").exists()


# ═════════════════════════════════════ --rollback: consistent pair, gc-proof, never a mismatched dist ══
def test_rollback_works_after_gc_because_the_previous_commit_is_pinned(box):
    box.commit("2")
    assert box.run_update().returncode == 0
    box.git(box.app, "reflog", "expire", "--expire=now", "--all")
    box.git(box.app, "gc", "-q", "--prune=now")
    rb = box.run_update("--rollback")
    assert rb.returncode == 0, _combined(rb)
    assert box.head() == box.v1 and box.dist() == f"BUILD:{box.v1}"


@pytest.mark.parametrize("damage", ["stamp of another sha", "no stamp (pre-fix dist.prev)"])
def test_rollback_never_pairs_its_sha_with_a_dist_it_was_not_built_from(box, damage):
    box.commit("2")
    assert box.run_update().returncode == 0
    (box.app / "dist.prev" / "main.js").write_text("BUILD:some-newer-build\n")
    stamp = box.app / "dist.prev" / ".orwell-build-sha"
    if damage.startswith("stamp"):
        stamp.write_text("0" * 40)
    else:
        stamp.unlink()
    before = len(box.calls())
    rb = box.run_update("--rollback")
    assert rb.returncode == 0, _combined(rb)
    assert "NOT using it" in rb.stdout
    assert box.head() == box.v1
    assert box.dist() == f"BUILD:{box.v1}", "the mismatched dist.prev must not be copied in; it is rebuilt"
    assert any(c == "npm run build" for c in box.calls()[before:])


def test_rollback_refuses_a_recorded_value_that_is_not_a_sha(box):
    (box.app / "data" / ".update-prev").write_text("--help")   # data/ is writable by the unprivileged FE
    r = box.run_update("--rollback")
    assert r.returncode == 1
    assert "does not hold a commit SHA" in r.stderr
    assert box.head() == box.v1


@pytest.mark.parametrize("stamp", ["no stamp", "another sha's stamp"])
def test_a_build_not_proven_to_come_from_head_is_never_trusted_as_a_rollback_target(box, stamp):
    # A failed revert leaves HEAD on one SHA and a dist of unknown origin. A later (recovery) update must not
    # file that dist under HEAD's SHA — that is exactly the older-SHA-with-a-newer-dist pairing, and a broken
    # build trusted by --rollback.
    v2 = box.commit("2")
    assert box.run_update().returncode == 0
    dist = box.app / "dist"
    (dist / "main.js").write_text("BROKEN\n")
    if stamp == "no stamp":
        (dist / ".orwell-build-sha").unlink()
    else:
        (dist / ".orwell-build-sha").write_text("0" * 40)
    box.commit("3", break_build=True)
    assert box.run_update().returncode == 3                # the revert cannot start the broken build
    v4 = box.commit("4")
    rec = box.run_update()                                  # the recovery update
    assert rec.returncode == 0, _combined(rec)
    assert box.head() == v4 and box.prev_sha() == v2
    assert not (box.app / "dist.prev" / ".orwell-build-sha").exists(), "unproven build must not be stamped"
    rb = box.run_update("--rollback")
    assert rb.returncode == 0, _combined(rb)
    assert "NOT using it" in rb.stdout
    assert box.head() == v2 and box.dist() == f"BUILD:{v2}"   # rebuilt from source, not the broken copy


def test_the_front_end_half_of_the_verification_can_fail_the_revert(box):
    box.commit("2")
    (box.app / "frontend" / ".venv" / "bin" / "uvicorn").unlink()      # a venv that cannot serve
    box.commit("3", break_build=True)
    r = box.run_update()
    assert r.returncode == 3, _combined(r)
    assert "front-end virtualenv cannot import" in r.stderr and "reverted to" not in _combined(r)


def test_a_log_pipe_that_closes_mid_update_cannot_kill_the_revert(box):
    # `orwell-update.sh | tee log` — if the reader dies, SIGPIPE must not stop the revert between `npm ci`
    # having deleted node_modules and the restore.
    v2 = box.commit("2")
    assert box.run_update().returncode == 0
    box.commit("3", slow_fail_build=True)
    seen = len(box.calls())
    proc = subprocess.Popen(["bash", str(box.script)], cwd=str(box.root), env=box.env(), text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    _wait_for_call(box, "npm run build", seen)
    proc.stdout.close()
    proc.stderr.close()
    assert proc.wait(timeout=120) == 1
    assert box.head() == v2 and box.deps() == "LOCK-2" and box.dist() == f"BUILD:{v2}"
    assert box.status()["ok"] is False and f"reverted to {v2}" in box.status()["message"]


def test_ctrl_c_mid_build_reverts_instead_of_leaving_a_half_updated_tree(box):
    v2 = box.commit("2")
    assert box.run_update().returncode == 0
    box.commit("3", slow_fail_build=True)
    seen = len(box.calls())
    proc = subprocess.Popen(["bash", str(box.script)], cwd=str(box.root), env=box.env(), text=True,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    _wait_for_call(box, "npm run build", seen)
    os.killpg(proc.pid, signal.SIGINT)                     # what Ctrl-C (or a service stop) delivers
    assert proc.wait(timeout=120) == 1
    assert box.head() == v2 and box.deps() == "LOCK-2" and box.dist() == f"BUILD:{v2}"
    assert not (box.app / "dist.staging").exists()


def test_a_restart_failure_after_the_commit_point_keeps_the_new_build_and_its_rollback_pair(box):
    v2 = box.commit("2")
    r = box.run_update(STUB_FAIL_RESTART="1")
    assert r.returncode != 0
    assert box.head() == v2 and box.dist() == f"BUILD:{v2}"            # a service problem, not a code revert
    assert box.prev_sha() == box.v1 and box.prev_dist() == f"BUILD:{box.v1}"
    assert "reverted to" not in _combined(r)
    assert box.status()["ok"] is False


def test_a_host_reconcile_failure_reverts_and_says_the_unit_files_were_not(box):
    v2 = box.commit("2")
    assert box.run_update().returncode == 0
    box.commit("3", break_host=True)
    r = box.run_update()
    assert r.returncode == 1, _combined(r)
    assert box.head() == v2 and box.dist() == f"BUILD:{v2}" and box.deps() == "LOCK-2" and box.fe_deps() == "REQ-2"
    assert "NOT reverted" in r.stderr
    assert box.prev_sha() == box.v1 and box.prev_dist() == f"BUILD:{box.v1}"


def test_revert_prefers_the_npm_cache_so_a_registry_failure_does_not_strand_the_box(box):
    box.commit("2")
    assert box.run_update().returncode == 0
    before = len(box.calls())
    box.commit("3", break_build=True)
    assert box.run_update().returncode == 1
    assert "npm ci --omit=dev --prefer-offline" in box.calls()[before:]


# ═════════════════════════════════════ --rollback without the network ══════════════════════════════════
def test_rollback_of_a_code_only_change_never_touches_node_modules_so_it_works_offline(box):
    v2 = box.commit("2", same_locks=True)                  # lockfiles identical to v1
    assert box.run_update().returncode == 0
    before = len(box.calls())
    rb = box.run_update("--rollback", STUB_OFFLINE="1")    # `npm ci` would fail and delete node_modules
    assert rb.returncode == 0, _combined(rb)
    assert box.head() == box.v1 and box.dist() == f"BUILD:{box.v1}" and box.deps() == "LOCK-1"
    assert not any(c.startswith("npm ci") for c in box.calls()[before:])
    assert v2 != box.v1


def test_rollback_that_needs_a_reinstall_and_cannot_get_one_says_so(box):
    box.commit("2")                                        # lockfiles differ from v1
    assert box.run_update().returncode == 0
    rb = box.run_update("--rollback", STUB_OFFLINE="1")
    assert rb.returncode == 3, _combined(rb)
    assert "ROLLBACK FAILED" in rb.stderr and "rollback complete" not in rb.stdout


def _wait_for_call(box, call, after, timeout=30):
    """Block until `call` appears in the stub log AFTER index `after` (i.e. in THIS run, not an earlier one)."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if call in box.calls()[after:]:
            return
        time.sleep(0.05)
    raise AssertionError(f"{call!r} never ran")


# ═════════════════════════════════════════════ REF=<tag|sha> ═══════════════════════════════════════════
@pytest.mark.parametrize("kind", ["tag", "annotated tag", "full sha", "abbreviated sha"])
def test_ref_pins_to_a_tag_or_a_sha(box, kind):
    pinned = box.commit("2")
    tip = box.commit("3")
    box.tag("v2.0", pinned)
    box.tag("rel-2", pinned, annotated=True)
    ref = {"tag": "v2.0", "annotated tag": "rel-2", "full sha": pinned, "abbreviated sha": pinned[:8]}[kind]

    r = box.run_update(REF=ref)
    assert r.returncode == 0, _combined(r)
    assert box.head() == pinned and box.head() != tip
    assert box.dist() == f"BUILD:{pinned}"
    assert box.prev_sha() == box.v1


def test_an_abbreviated_sha_older_than_the_shallow_tip_is_resolved_by_deepening(box):
    older = box.commit("2")
    box.commit("3")
    assert box.run_update().returncode == 0          # the shallow checkout now has the tip as its root
    r = box.run_update(REF=older[:9])
    assert r.returncode == 0, _combined(r)
    assert box.head() == older
    assert box.dist() == f"BUILD:{older}"


def test_without_ref_the_branch_tip_is_deployed(box):
    box.commit("2")
    tip = box.commit("3")
    assert box.run_update().returncode == 0
    assert box.head() == tip


def test_an_unknown_ref_fails_without_changing_the_box(box):
    box.commit("2")
    r = box.run_update(REF="no-such-tag")
    assert r.returncode == 1, _combined(r)
    assert "does not resolve to a commit" in r.stderr
    assert box.head() == box.v1 and box.dist() == f"BUILD:{box.v1}" and box.deps() == "LOCK-1"


def test_an_option_shaped_ref_is_rejected_up_front(box):
    r = box.run_update(REF="--upload-pack=touch /tmp/pwned")
    assert r.returncode == 1
    assert "not a valid tag or commit SHA" in r.stderr
    assert box.calls() == []


# ═════════════════════════════════════════════ the shared lock ═════════════════════════════════════════
def test_a_second_run_refuses_without_touching_the_tree_or_the_running_runs_status(box):
    box.commit("2")
    fd = os.open(box.lock, os.O_WRONLY | os.O_CREAT)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)         # "a manual update is running"
        r = box.run_update()
    finally:
        os.close(fd)
    assert r.returncode == 75, _combined(r)
    assert "already running" in r.stderr
    assert box.head() == box.v1 and box.calls() == []
    assert not (box.app / "data" / "ops" / "update-status.json").exists(), "must not clobber the live run's status"


def test_a_stale_inherited_lock_fd_cannot_bypass_the_lock(box):
    box.commit("2")
    fd = os.open(box.lock, os.O_WRONLY | os.O_CREAT)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # an exported variable naming an fd that is NOT the lock file (a stale value from some other shell)
        r = box.run_update(ORWELL_UPDATE_LOCK_FD="1")
    finally:
        os.close(fd)
    assert r.returncode == 75, _combined(r)
    assert box.head() == box.v1 and box.calls() == []


def test_the_lock_is_released_when_the_run_ends(box):
    box.commit("2")
    assert box.run_update().returncode == 0
    fd = os.open(box.lock, os.O_WRONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)         # would raise BlockingIOError if leaked
    finally:
        os.close(fd)


def test_the_web_update_unit_shape_does_not_deadlock_with_the_shared_lock(box):
    # orwell-ops-update.service: `exec 9>>/run/orwell-ops-update.lock; flock -n 9; exec bash orwell-update.sh`
    box.commit("2")
    unit = f"exec 9>>{box.root}/unit.lock; flock -n 9 || exit 99; exec bash {box.script}"
    r = subprocess.run(["bash", "-c", unit], cwd=str(box.root), env=box.env(), capture_output=True, text=True, timeout=120)
    assert r.returncode == 0, _combined(r)


def test_the_ops_units_take_their_own_lock_files_never_the_shared_one():
    pat = r'UPDATE_LOCK="\$\{ORWELL_UPDATE_LOCK:-([^}]+)\}"'
    shared = re.search(pat, UPDATE.read_text()).group(1)
    assert shared == re.search(pat, UPDATE_RESET.read_text()).group(1)
    for unit in (DEPLOY / "systemd").glob("orwell-ops-*.service"):
        locks = re.findall(r"exec 9>>(\S+?);", unit.read_text())
        assert locks and shared not in locks, f"{unit.name} would collide with the shared update lock"


def _stub_reset(box) -> Path:
    """An OOBE-reset stand-in: records whether the shared update lock is HELD while the reset phase runs."""
    marker = box.root / "reset-ran"
    script = box.root / "stub-oobe-reset.sh"
    script.write_text(
        f'#!/usr/bin/env bash\nif flock -n 8 8>>"{box.lock}"; then echo free > "{marker}"; else echo held > "{marker}"; fi\n'
    )
    return script


def _run_update_reset(box, **env_extra):
    return subprocess.run(
        ["bash", str(UPDATE_RESET), "--yes", "--no-restart"], cwd=str(box.root), capture_output=True, text=True,
        env=box.env(ORWELL_UPDATE_SCRIPT=str(box.script), ORWELL_OOBE_RESET_SCRIPT=str(_stub_reset(box)), **env_extra),
        timeout=120,  # a deadlock must FAIL this test, not hang the suite
    )


def test_update_reset_holds_the_lock_across_both_phases_and_the_update_child_does_not_deadlock(box):
    v2 = box.commit("2")
    r = _run_update_reset(box)
    assert r.returncode == 0, _combined(r)
    assert box.head() == v2
    assert (box.root / "reset-ran").read_text().strip() == "held", "the reset phase must run under the shared lock"
    fd = os.open(box.lock, os.O_WRONLY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    finally:
        os.close(fd)


def test_update_reset_refuses_while_another_update_holds_the_lock(box):
    box.commit("2")
    fd = os.open(box.lock, os.O_WRONLY | os.O_CREAT)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        r = _run_update_reset(box)
    finally:
        os.close(fd)
    assert r.returncode == 75, _combined(r)
    assert box.head() == box.v1 and not (box.root / "reset-ran").exists()


def test_update_reset_never_wipes_after_a_failed_update_and_only_claims_the_previous_build_when_true(box):
    box.commit("2", break_build=True)
    r = _run_update_reset(box)
    out = _combined(r)
    assert r.returncode == 1 and not (box.root / "reset-ran").exists()
    assert "NOTHING was wiped" in out and "is on its previous build" in out
    assert box.head() == box.v1 and box.dist() == f"BUILD:{box.v1}"


def test_update_reset_says_so_plainly_when_the_automatic_revert_failed(box):
    (box.app / "dist" / "main.js").write_text("BROKEN\n")   # the running build cannot start
    box.commit("2", break_build=True)
    r = _run_update_reset(box)
    out = _combined(r)
    assert r.returncode == 1 and not (box.root / "reset-ran").exists()
    assert "automatic revert FAILED" in out and "NOTHING was wiped" in out
    assert "is on its previous build" not in out
    status = json.loads((box.app / "data" / "ops" / "update-reset-status.json").read_text())
    assert "automatic revert failed" in status["error"]


# ═════════════════════════════════════════════ housekeeping ════════════════════════════════════════════
def test_scripts_are_valid_bash_and_the_rerooted_copy_has_no_host_paths_left():
    for script in (UPDATE, UPDATE_RESET):
        assert subprocess.run(["bash", "-n", str(script)]).returncode == 0
    rerooted = _reroot(UPDATE.read_text(), Path("/sandbox"))
    for line in rerooted.splitlines():
        if line.lstrip().startswith("#"):
            continue
        assert not re.search(r"(?<!/sandbox)/etc/", line), line
        assert not re.search(r"(?<!/sandbox)/usr/local/bin", line), line
