"""ORW-229 — deploy/orwell-update.sh skips the reinstalls and rebuilds a commit does not need, and builds /play non-fatally.

Runs the REAL update script in the sandboxed box of test_update_script_failure_revert.py (a real git checkout of a
local "origin"; npm, node, pip and systemctl replaced by stubs on PATH), with an npm/pip stub pair that models what
the skip logic depends on:

  * `npm ci` deletes node_modules and installs the full tree (runtime + build tools); `npm prune --omit=dev` drops the
    build tools; `npm install --include=dev` puts them back; each rewrites npm's hidden lockfile
    (node_modules/.package-lock.json) the way npm does. The engine build FAILS without the build tools (esbuild is a
    dev dependency), so a "skip `npm ci`" that forgot to restore them would be caught here.
  * the engine build output is a pure function of its inputs (src/, package.json, package-lock.json), so "keep the
    existing build" is checked against what a rebuild of the new commit would produce.
  * pip records what it installed in a fake site-packages (the venv witness).

Proves, for the skip logic: no record (the first run with this updater) => the full `npm ci` + `pip install`, and a
record is written; unchanged lockfiles => no `npm ci` and no `pip install` — a code-only engine change only restores
the pruned build tools and rebuilds, a commit that changes nothing the engine reads keeps node_modules and dist as
they are; a changed engine or front-end lockfile, a node/npm upgrade, a deleted record, a previous FAILED update, a
--rollback, or a node_modules / venv / build changed outside the updater => the full reinstall of that part; a
failure after a skipped step still reverts to a runnable previous build, offline.

And for /play: no frontend/web => no build; with it => built from a clean export in a temp dir OUTSIDE the app, live
only after the commit point (the current build keeps answering while the next one builds), skipped when
frontend/web + frontend/static/js are unchanged, rebuilt when the classic markdown it imports changes; a failed
/play build never fails the update; a failed update never puts a new /play build live; --rollback brings back the
previous /play build.

Name-agnostic: roles only, no houseguests.
"""
import hashlib
import shutil
import subprocess
from pathlib import Path

import pytest

from test_update_script_failure_revert import (  # the shared sandboxed-box harness
    _CHECKOUT_DEPLOY_FILES,
    DEPLOY,
    Box,
    _combined,
    _wait_for_call,
    _write_exec,
    pytestmark,  # noqa: F401  (same tool requirements: bash, git, flock, curl, python3)
)

_NPM = r"""#!/usr/bin/env bash
echo "npm $*" >> "$STUB_LOG"
printf '%s\t%s\n' "$*" "$PWD" >> "$STUB_LOG.npm"
tree() { printf 'TREE %s %s\n' "$(sha256sum < package-lock.json | cut -c1-16)" "$1" > node_modules/.package-lock.json; }
case "$1" in
  -v) echo "${STUB_NPM_VERSION:-10.0.0}" ;;
  ci)   # real `npm ci` removes node_modules FIRST
    rm -rf node_modules
    if [[ -n "$STUB_OFFLINE" ]] || grep -q BREAK_NPM_CI package-lock.json; then echo "npm ERR! simulated registry failure" >&2; exit 1; fi
    mkdir node_modules; cp package-lock.json node_modules/.installed-from-lock
    if [[ " $* " == *" --omit=dev "* ]]; then tree runtime; else : > node_modules/.build-tools; tree full; fi ;;
  install)
    if [[ -n "$STUB_FAIL_NPM_INSTALL" ]]; then echo "npm ERR! simulated install failure" >&2; exit 1; fi
    mkdir -p node_modules; : > node_modules/.build-tools; tree full ;;
  prune)
    rm -f node_modules/.build-tools; tree runtime ;;
  run)
    [[ -f node_modules/.build-tools ]] || { echo "sh: 1: esbuild: not found (the build tools were pruned)" >&2; exit 127; }
    if grep -q '"name":"orwell-play"' package.json; then      # the React /play app (vite empties its outDir first)
      if grep -q BREAK_PLAY src/app.txt; then echo "simulated /play build failure" >&2; exit 1; fi
      if grep -q SLOW_PLAY src/app.txt; then sleep 3; fi
      rm -rf dist; mkdir -p dist/assets
      printf 'PLAY %s %s\n' "$(head -n1 src/app.txt)" "$(head -n1 ../static/js/markdown.js)" > dist/index.html
      cp dist/index.html dist/assets/app.js
    else                                                       # the engine bundle: a pure function of its inputs
      if grep -q BREAK_BUILD src/main.ts; then mkdir -p dist; echo PARTIAL > dist/main.js; echo "simulated build failure" >&2; exit 1; fi
      mkdir -p dist
      echo "BUILD:$(cat src/main.ts package.json package-lock.json | sha256sum | cut -c1-16)" > dist/main.js
      : > dist/embedWorker.js
    fi ;;
  cache) exit 1 ;;
esac
exit 0
"""

_PIP = r"""#!/usr/bin/env bash
echo "pip $*" >> "$STUB_LOG"
req="${@: -1}"
if grep -q BREAK_PIP "$req"; then echo "ERROR: simulated pip failure" >&2; exit 1; fi
venv="$(cd "$(dirname "$0")/.." && pwd)"
cp "$req" "$venv/installed-from-requirements"
sp="$venv/lib/python3.12/site-packages"; mkdir -p "$sp"; rm -rf "$sp"/*.dist-info
mkdir -p "$sp/pins-$(sha256sum < "$req" | cut -c1-12).dist-info"
"""

_NPM_WORK = ("npm ci", "npm install", "npm run", "npm prune")   # anything that touches node_modules or dist
_START = dict(src="1", lock="1", req="1", fe="1", md="1", doc="1", play=None, play_lock="1")
_ONE_SHOT = ("break_build", "break_play", "slow_play", "break_host")


class FastBox(Box):
    """The shared sandboxed box, with the npm/pip stubs above and commits authored field by field."""

    def __init__(self, root: Path):
        super().__init__(root)
        _write_exec(root / "bin" / "npm", _NPM)
        self.state = dict(_START)
        self.tmp = root / "tmp"
        self.tmp.mkdir()

    def put(self, **changes) -> str:
        """One commit on origin. Fields not named keep the previous commit's value; break_* / slow_* apply once."""
        once = {k: changes.pop(k) for k in _ONE_SHOT if k in changes}
        self.state.update(changes)
        st, w = self.state, self.src
        files = {
            "src/main.ts": f"SRC-{st['src']}\n" + ("BREAK_BUILD\n" if once.get("break_build") else ""),
            "package.json": '{"name":"fixture"}\n',
            "package-lock.json": f"LOCK-{st['lock']}\n",
            "frontend/requirements.lock.txt": f"REQ-{st['req']}\n",
            "frontend/app.py": f"# FE-{st['fe']}\n",
            "frontend/static/js/markdown.js": f"MD-{st['md']}\n",
            "docs/notes.md": f"DOC-{st['doc']}\n",
        }
        shutil.rmtree(w / "frontend" / "web", ignore_errors=True)
        if st["play"] is not None:
            files.update({
                "frontend/web/package.json": '{"name":"orwell-play"}\n',
                "frontend/web/package-lock.json": f"PLAYLOCK-{st['play_lock']}\n",
                "frontend/web/src/app.txt": f"APP-{st['play']}\n" + ("BREAK_PLAY\n" if once.get("break_play") else "")
                + ("SLOW_PLAY\n" if once.get("slow_play") else ""),
            })
        for rel, text in files.items():
            (w / rel).parent.mkdir(parents=True, exist_ok=True)
            (w / rel).write_text(text)
        (w / "deploy").mkdir(exist_ok=True)
        for name in _CHECKOUT_DEPLOY_FILES:
            shutil.copy(DEPLOY / name, w / "deploy" / name)
        if once.get("break_host"):   # the host reconcile `install`s the login panel from the checkout: absent => it fails
            (w / "deploy" / "orwell-login-panel.sh").unlink()
        self.git(w, "add", "-A")
        self.git(w, "commit", "-q", "--allow-empty", "-m", "c")
        self.git(w, "push", "-q", "origin", "HEAD:main")
        return self.git(w, "rev-parse", "HEAD")

    def install(self):
        super().install()
        app = self.app
        (app / "node_modules" / ".package-lock.json").write_text("TREE installed runtime\n")
        _write_exec(app / "frontend" / ".venv" / "bin" / "pip", _PIP)
        (self.site_packages() / "pins-install.dist-info").mkdir(parents=True)

    def run_update(self, *args, timeout=120, **env_extra):
        env_extra.setdefault("TMPDIR", str(self.tmp))
        return super().run_update(*args, timeout=timeout, **env_extra)

    # ── observations ──
    def site_packages(self) -> Path:
        return self.app / "frontend" / ".venv" / "lib" / "python3.12" / "site-packages"

    def stamp_file(self) -> Path:
        return self.app / "dist" / ".orwell-deps-stamp"

    def stamp(self) -> dict:
        return dict(line.split("=", 1) for line in self.stamp_file().read_text().splitlines() if "=" in line)

    def npm_calls(self, after=0):
        p = Path(f"{self.log}.npm")
        rows = [tuple(line.split("\t", 1)) for line in p.read_text().splitlines()] if p.exists() else []
        return rows[after:]

    def play_calls(self, after=0):
        return [(a, cwd) for a, cwd in self.npm_calls(after) if cwd.endswith("/frontend/web")]

    def play_live(self) -> str:
        return self._read("frontend/web/dist/index.html")

    def expected_build(self, sha: str) -> str:
        """What the stub engine build of commit `sha` produces (it depends on the inputs only, never on the SHA)."""
        blob = "".join(self.git(self.src, "show", f"{sha}:{p}") + "\n" for p in ("src/main.ts", "package.json", "package-lock.json"))
        return "BUILD:" + hashlib.sha256(blob.encode()).hexdigest()[:16]


@pytest.fixture
def fbox(tmp_path):
    b = FastBox(tmp_path)
    b.v1 = b.put()
    b.install()
    return b


def _update(box, *args, **env):
    """Run one update; return (result, the stub calls THIS run made)."""
    before = len(box.calls())
    r = box.run_update(*args, **env)
    return r, box.calls()[before:]


def _npm_work(calls):
    return [c for c in calls if c.startswith(_NPM_WORK)]


def _pip(calls):
    return [c for c in calls if c.startswith("pip ")]


def _recorded(box):
    """One full update that records the stamp (the fixture's install has none)."""
    box.put(src="2")
    r = box.run_update()
    assert r.returncode == 0, _combined(r)
    assert box.stamp_file().is_file()


# ═════════════════════════════════════════════ no record => the full reinstall, and a record ════════════════════
def test_without_a_record_the_update_reinstalls_in_full_and_records_what_it_installed(fbox):
    v2 = fbox.put(src="2")
    r, calls = _update(fbox)
    assert r.returncode == 0, _combined(r)
    assert "npm ci" in calls and _pip(calls), "no stamp: the full install, exactly as before"
    assert "no record of a completed update" in r.stdout
    st = fbox.stamp()
    assert st["sha"] == v2
    for key in ("engine_inputs", "engine_deps", "engine_tree", "engine_dist", "frontend_inputs", "frontend_tree"):
        assert len(st[key]) == 64 and set(st[key]) <= set("0123456789abcdef"), key
    assert fbox.dist() == fbox.expected_build(v2)


# ═════════════════════════════════════════════ unchanged lockfiles => no npm ci, no pip ═════════════════════════
def test_a_code_only_engine_change_restores_just_the_pruned_build_tools_and_skips_pip(fbox):
    _recorded(fbox)
    v3 = fbox.put(src="3")                                   # engine code changed; both lockfiles did not
    r, calls = _update(fbox)
    assert r.returncode == 0, _combined(r)
    assert "npm ci" not in calls and not _pip(calls)
    tools = "npm install --include=dev --no-save --prefer-offline --no-audit --no-fund"
    assert calls.index(tools) < calls.index("npm run build") < calls.index("npm prune --omit=dev")
    assert fbox.dist() == fbox.expected_build(v3) and fbox.dist_stamp() == v3
    assert fbox.deps() == "LOCK-1", "node_modules was never re-installed"
    assert not (fbox.app / "node_modules" / ".build-tools").exists(), "the build tools are pruned again"
    assert "front-end dependencies unchanged" in r.stdout
    assert fbox.stamp()["sha"] == v3


@pytest.mark.parametrize("change", ["fe", "doc", "md"])
def test_a_commit_that_changes_nothing_the_engine_reads_keeps_node_modules_and_its_build(fbox, change):
    _recorded(fbox)
    v2 = fbox.head()
    built = fbox.dist()
    v3 = fbox.put(**{change: "3"})
    r, calls = _update(fbox)
    assert r.returncode == 0, _combined(r)
    assert not _npm_work(calls), "no npm ci, install, build or prune at all"
    assert not _pip(calls)
    assert fbox.dist() == built == fbox.expected_build(v3), "the build it kept is exactly this commit's build"
    assert fbox.dist_stamp() == v3
    # the rollback pair still moves as before, and the record never rides along in a copy of dist/
    assert fbox.prev_sha() == v2 and fbox.prev_dist() == built and fbox.prev_stamp() == v2
    assert not (fbox.app / "dist.prev" / ".orwell-deps-stamp").exists()
    assert fbox.stamp()["sha"] == v3


def test_a_rerun_at_the_same_commit_installs_nothing(fbox):
    _recorded(fbox)
    r, calls = _update(fbox)
    assert r.returncode == 0, _combined(r)
    assert not _npm_work(calls) and not _pip(calls)
    assert "keeping the existing rollback target" in r.stdout


# ═════════════════════════════════════════ what changed is reinstalled, nothing else ════════════════════════════
def test_a_changed_engine_lockfile_reinstalls_the_engine_in_full(fbox):
    _recorded(fbox)
    fbox.put(lock="3")
    r, calls = _update(fbox)
    assert r.returncode == 0, _combined(r)
    assert "npm ci" in calls and "package-lock.json" in r.stdout
    assert fbox.deps() == "LOCK-3"
    assert not _pip(calls), "the front-end lockfile did not change"


def test_a_changed_frontend_lockfile_reinstalls_the_venv_and_nothing_else(fbox):
    _recorded(fbox)
    fbox.put(req="3")
    r, calls = _update(fbox)
    assert r.returncode == 0, _combined(r)
    assert _pip(calls) and fbox.fe_deps() == "REQ-3"
    assert not _npm_work(calls), "frontend/ is not an engine input"


def test_a_node_or_npm_upgrade_reinstalls_the_engine_in_full(fbox):
    _recorded(fbox)
    fbox.put(src="3")
    r, calls = _update(fbox, STUB_NPM_VERSION="11.0.0")
    assert r.returncode == 0, _combined(r)
    assert "npm ci" in calls, "native addons are fetched per node/npm: a version change is a dependency change"


@pytest.mark.parametrize("cause, engine, pip", [
    ("record deleted", "npm ci", True),
    ("node_modules changed outside the updater", "npm ci", False),
    ("venv changed outside the updater", None, True),
    ("build changed outside the updater", "npm run build", False),
])
def test_a_record_that_no_longer_matches_the_disk_forces_the_reinstall(fbox, cause, engine, pip):
    _recorded(fbox)
    if cause == "record deleted":
        fbox.stamp_file().unlink()
    elif cause.startswith("node_modules"):
        (fbox.app / "node_modules" / ".package-lock.json").write_text("TREE a hand-run npm ci\n")
    elif cause.startswith("venv"):
        (fbox.site_packages() / "extra-1.0.dist-info").mkdir()
    else:
        (fbox.app / "dist" / "main.js").write_text("BUILD:edited-by-hand\n")
    v3 = fbox.put(fe="3")                                    # nothing the engine reads: only a mismatch can rebuild it
    r, calls = _update(fbox)
    assert r.returncode == 0, _combined(r)
    if engine is None:
        assert not _npm_work(calls)
    else:
        assert engine in calls
        assert fbox.dist() == fbox.expected_build(v3)
    if engine == "npm run build":
        assert "npm ci" not in calls, "only the build is suspect; node_modules is still the recorded tree"
    assert bool(_pip(calls)) is pip


def test_after_a_failed_update_the_next_one_reinstalls_in_full(fbox):
    _recorded(fbox)
    v2 = fbox.head()
    fbox.put(src="3", break_build=True)
    r = fbox.run_update()
    assert r.returncode == 1 and f"reverted to {v2}" in _combined(r)
    assert not fbox.stamp_file().exists(), "a run that did not reach its commit point leaves no record"
    fbox.put(src="4")
    r, calls = _update(fbox)
    assert r.returncode == 0, _combined(r)
    assert "npm ci" in calls and _pip(calls)


@pytest.mark.parametrize("previous_build", ["reused", "rebuilt from source"])
def test_a_rollback_clears_the_record_so_the_next_update_reinstalls_in_full(fbox, previous_build):
    _recorded(fbox)
    fbox.put(src="3")
    assert fbox.run_update().returncode == 0
    if previous_build == "rebuilt from source":   # an untrusted dist.prev: the rollback builds INTO the live dist/
        (fbox.app / "dist.prev" / ".orwell-build-sha").write_text("0" * 40)
    rb = fbox.run_update("--rollback")
    assert rb.returncode == 0, _combined(rb)
    assert ("NOT using it" in rb.stdout) is (previous_build == "rebuilt from source")
    assert not fbox.stamp_file().exists()
    fbox.put(src="4")
    r, calls = _update(fbox)
    assert r.returncode == 0, _combined(r)
    assert "npm ci" in calls and _pip(calls)


def test_if_restoring_the_build_tools_fails_it_falls_back_to_a_clean_npm_ci(fbox):
    _recorded(fbox)
    v3 = fbox.put(src="3")
    r, calls = _update(fbox, STUB_FAIL_NPM_INSTALL="1")
    assert r.returncode == 0, _combined(r)
    tools = "npm install --include=dev --no-save --prefer-offline --no-audit --no-fund"
    assert calls.index(tools) < calls.index("npm ci") < calls.index("npm run build")
    assert fbox.dist() == fbox.expected_build(v3)


def test_a_failure_after_a_skipped_install_reverts_offline_to_the_running_build(fbox):
    _recorded(fbox)
    v2 = fbox.head()
    built = fbox.dist()
    fbox.put(fe="3", break_host=True)                       # nothing the engine reads; fails in the host reconcile
    r, calls = _update(fbox, STUB_OFFLINE="1")              # `npm ci` would fail: the revert must not need it
    assert r.returncode == 1, _combined(r)
    assert f"reverted to {v2}" in _combined(r)
    assert "npm ci" not in " ".join(calls)
    assert fbox.head() == v2 and fbox.dist() == built and fbox.dist_stamp() == v2
    assert fbox.deps() == "LOCK-1" and fbox.fe_deps() == "REQ-1"
    assert not fbox.stamp_file().exists()


# ═════════════════════════════════════════════════════ the /play app ═════════════════════════════════════════════
def test_without_frontend_web_there_is_no_play_build(fbox):
    fbox.put(src="2")
    r = fbox.run_update()
    assert r.returncode == 0, _combined(r)
    assert "/play" not in r.stdout
    assert not fbox.play_calls() and not (fbox.app / "frontend" / "web").exists()


def test_play_is_built_from_a_clean_export_outside_the_app_and_goes_live_with_the_update(fbox):
    fbox.put(play="1")
    r = fbox.run_update()
    out = r.stdout
    assert r.returncode == 0, _combined(r)
    assert fbox.play_live() == "PLAY APP-1 MD-1"
    builds = fbox.play_calls()
    assert [a for a, _ in builds] == ["ci --prefer-offline --no-audit --no-fund", "run build"]
    assert all(cwd.startswith(str(fbox.tmp)) for _, cwd in builds), "a temp export, never the live tree"
    assert not list(fbox.tmp.iterdir()), "the temp build dir is removed"
    web = fbox.app / "frontend" / "web"
    assert not (web / "node_modules").exists() and not (web / "dist.next").exists()
    stamp = (web / "dist" / ".orwell-web-inputs").read_text().strip()
    assert len(stamp) == 64 and set(stamp) <= set("0123456789abcdef")
    assert out.index("/play built") < out.index("/play: the new build is live") < out.index("restart services")


def test_unchanged_play_inputs_are_not_rebuilt(fbox):
    fbox.put(play="1")
    assert fbox.run_update().returncode == 0
    n = len(fbox.npm_calls())
    fbox.put(src="2")                                        # an engine change only
    r = fbox.run_update()
    assert r.returncode == 0, _combined(r)
    assert "/play unchanged" in r.stdout and not fbox.play_calls(n)
    assert fbox.play_live() == "PLAY APP-1 MD-1"


@pytest.mark.parametrize("change, live", [
    ({"play": "2"}, "PLAY APP-2 MD-1"),
    ({"play_lock": "2"}, "PLAY APP-1 MD-1"),
    ({"md": "2"}, "PLAY APP-1 MD-2"),        # the classic markdown module /play imports
])
def test_a_change_to_anything_play_is_built_from_rebuilds_it(fbox, change, live):
    fbox.put(play="1")
    assert fbox.run_update().returncode == 0
    n = len(fbox.npm_calls())
    fbox.put(**change)
    r = fbox.run_update()
    assert r.returncode == 0, _combined(r)
    assert [a for a, _ in fbox.play_calls(n)] == ["ci --prefer-offline --no-audit --no-fund", "run build"]
    assert fbox.play_live() == live


def test_a_failed_play_build_never_fails_the_update_and_keeps_the_live_build(fbox):
    fbox.put(play="1")
    assert fbox.run_update().returncode == 0
    v3 = fbox.put(src="3", play="2", break_play=True)
    r = fbox.run_update()
    assert r.returncode == 0, _combined(r)
    assert "the /play build FAILED" in r.stdout
    assert fbox.head() == v3 and fbox.dist() == fbox.expected_build(v3)
    assert fbox.status()["ok"] is True
    assert fbox.play_live() == "PLAY APP-1 MD-1"
    assert not (fbox.app / "frontend" / "web" / "dist.next").exists()


def test_a_failed_update_never_puts_a_new_play_build_live(fbox):
    fbox.put(play="1")
    assert fbox.run_update().returncode == 0
    v2 = fbox.head()
    fbox.put(play="2", break_host=True)                     # /play builds fine, then the update fails and reverts
    r = fbox.run_update()
    assert r.returncode == 1 and f"reverted to {v2}" in _combined(r)
    assert fbox.play_live() == "PLAY APP-1 MD-1"
    assert not (fbox.app / "frontend" / "web" / "dist.next").exists()


def test_the_live_play_build_keeps_answering_while_the_next_one_builds(fbox):
    fbox.put(play="1")
    assert fbox.run_update().returncode == 0
    fbox.put(play="2", slow_play=True)
    seen = len(fbox.calls())
    proc = subprocess.Popen(["bash", str(fbox.script)], cwd=str(fbox.root), env=fbox.env(TMPDIR=str(fbox.tmp)),
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    _wait_for_call(fbox, "npm run build", seen)             # the /play build is running (the engine is unchanged)
    assert fbox.play_live() == "PLAY APP-1 MD-1", "never emptied or half-written while vite runs"
    out, _ = proc.communicate(timeout=120)
    assert proc.returncode == 0, out
    assert fbox.play_live() == "PLAY APP-2 MD-1"


def test_rollback_brings_back_the_previous_play_build_without_rebuilding(fbox):
    v2 = fbox.put(play="1")
    assert fbox.run_update().returncode == 0
    fbox.put(play="2")
    assert fbox.run_update().returncode == 0
    assert fbox.play_live() == "PLAY APP-2 MD-1"
    n = len(fbox.npm_calls())
    rb = fbox.run_update("--rollback")
    assert rb.returncode == 0, _combined(rb)
    assert fbox.head() == v2 and fbox.play_live() == "PLAY APP-1 MD-1"
    assert not fbox.play_calls(n), "offline: the previous build is reused, never rebuilt"
