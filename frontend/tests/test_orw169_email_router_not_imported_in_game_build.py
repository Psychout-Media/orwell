"""ORW-169 slice 2 - the game build neither imports nor mounts the dropped email router.

`import app` used to import `routes.email_routes` (about 0.5 s) and build its router in the game build, where
the email vertical is dropped. Now the import sits behind the feature gate (email or codex, which borrows the
email router). Subprocess per build mode so this process's module cache cannot mask it. No model.
"""
import json
import os
import subprocess
import sys
import textwrap

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

_CODE = textwrap.dedent("""
    import json, sys
    import app
    paths = {getattr(r, "path", "") for r in app.app.routes}
    print("RESULT" + json.dumps({
        "email_routes_imported": "routes.email_routes" in sys.modules,
        "email_path_mounted": any(p.startswith("/api/email") for p in paths),
    }))
""")


def _run(game_build: str, tmp_path):
    env = dict(os.environ, ORWELL_GAME_BUILD=game_build, DATABASE_URL=f"sqlite:///{tmp_path / 'orw169.db'}",
               DATA_DIR=str(tmp_path / "data"))
    r = subprocess.run([sys.executable, "-c", _CODE], cwd=FRONTEND, env=env, capture_output=True, text=True, timeout=240)
    line = [ln for ln in r.stdout.splitlines() if ln.startswith("RESULT")]
    assert line, (r.stdout[-400:], r.stderr[-800:])
    return json.loads(line[-1][len("RESULT"):])


def test_game_build_does_not_import_or_mount_the_email_router(tmp_path):
    res = _run("1", tmp_path)
    assert res == {"email_routes_imported": False, "email_path_mounted": False}


def test_workspace_build_still_imports_and_mounts_it(tmp_path):
    res = _run("0", tmp_path)
    assert res == {"email_routes_imported": True, "email_path_mounted": True}
