"""ORW-170 slice 2 - the YouTube transcript library is imported on first use, not at boot.

`import app` used to call `init_youtube()`, which imported `youtube_transcript_api` (about 0.3 s plus its
HTTP stack) on every boot, even though the game build never fetches a transcript. Runs in a subprocess so
this process's module cache cannot mask it. No model.
"""
import os
import subprocess
import sys
import textwrap

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def test_import_app_does_not_import_the_transcript_library(tmp_path):
    code = textwrap.dedent("""
        import sys
        import app  # noqa: F401
        print("LOADED" if "youtube_transcript_api" in sys.modules else "LAZY")
    """)
    env = dict(os.environ, DATABASE_URL=f"sqlite:///{tmp_path / 'orw170.db'}", DATA_DIR=str(tmp_path / "data"))
    r = subprocess.run([sys.executable, "-c", code], cwd=FRONTEND, env=env, capture_output=True, text=True, timeout=240)
    assert r.stdout.strip().endswith("LAZY"), (r.stdout[-400:], r.stderr[-800:])


def test_the_transcript_fetch_initialises_the_library_on_first_use():
    src = open(os.path.join(FRONTEND, "services", "youtube", "youtube_handler.py"), encoding="utf-8").read()
    fetch = src.split("YOUTUBE_AVAILABLE or YouTubeTranscriptApi is None", 1)[0]
    assert "if YouTubeTranscriptApi is None:\n        init_youtube()" in fetch.rsplit("def ", 1)[1]
    app_src = open(os.path.join(FRONTEND, "app.py"), encoding="utf-8").read()
    assert "\ninit_youtube()" not in app_src
