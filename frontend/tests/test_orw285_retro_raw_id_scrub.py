"""ORW-285 (PR #2412 note) - the retrospective panel never shows a raw `npc:<id>` from a model-authored quote or message: every
free-text field it renders goes through `clean`, which swaps `npc:<digits>` for "someone". Runs the real `clean` under node."""
import os
import re
import shutil
import subprocess

import pytest

JS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js", "orwellRetrospective.js")


def _src() -> str:
    with open(JS, encoding="utf-8") as f:
        return f.read()


def test_every_rendered_free_text_field_goes_through_clean():
    src = _src()
    assert "const clean = (t) => String(t).replace(/npc:\\d+/g," in src
    for field in ("x.message", "unsealed.finaleInterview.message", "q.quote"):
        assert f"clean({field})" in src, f"{field} must be scrubbed"
    assert re.search(r"playerConfessionals[^;]*\.map\(clean\)", src), "the player's own confessionals must be scrubbed"


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_clean_replaces_a_raw_id_in_a_quote():
    src = _src()
    m = re.search(r"const clean = [^\n]*", src)
    assert m, "clean helper missing"
    out = subprocess.run(["node", "-e", f"{m.group(0)}\nconsole.log(clean('she told npc:12 and npc:3 everything'))"],
                         capture_output=True, text=True, check=True).stdout.strip()
    assert out == "she told someone and someone everything"
