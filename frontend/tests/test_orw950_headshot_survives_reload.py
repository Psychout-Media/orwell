"""ORW-950: the headshot step survives a reload (an iPhone drops a backgrounded tab while the photo picker is open),
and the photo is shrunk on the device before the preview and the upload.

The browser-only parts (a real decode, a real canvas, iOS tab discard) cannot run here: the shrink is driven in node with a
fake browser, the page wiring is pinned by source, and the server side the page relies on is run for real."""
import importlib
import io
import json
import pathlib
import shutil
import subprocess

import pytest
from PIL import Image

FE = pathlib.Path(__file__).resolve().parent.parent
HS = (FE / "static" / "js" / "orwellHeadshot.js").read_text()
op = importlib.import_module("src.orwell_portraits")


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
def test_shrink_scales_to_the_server_bound_as_jpeg_and_falls_back():
    r = subprocess.run(["node", str(FE / "tests" / "js" / "orw950_photo_shrink_harness.mjs"), str(FE / "static" / "js")],
                       capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr
    out = json.loads(r.stdout.strip().splitlines()[-1])
    assert out["sizeLandscape"] == {"w": 1024, "h": 768}
    assert out["sizeSmallUnchanged"] == {"w": 800, "h": 600}
    assert out["big"] == {"type": "image/jpeg", "name": "IMG_1.jpg", "drawn": [1024, 768], "orientation": "from-image",
                          "q": 0.9, "closed": 1, "isOrig": False}
    assert out["imgFallbackStillShrinks"] == {"type": "image/jpeg", "drawn": [768, 1024]}
    assert out["undecodableKeepsOriginal"] is True
    assert out["noBlobKeepsOriginal"] is True


def test_shrink_bound_matches_the_server_bound():
    js = (FE / "static" / "js" / "photoShrink.js").read_text()
    assert "MAX_EDGE_PX = 1024" in js
    assert "im.thumbnail((1024, 1024)" in (FE / "src" / "orwell_portraits.py").read_text()


def test_change_handler_uses_the_shrunk_copy_for_preview_and_upload():
    i = HS.index('fi.addEventListener("change"')
    block = HS[i:i + 900]
    assert "shrinkPhoto(picked)" in block and "st.file = small" in block
    assert "createObjectURL(st.file)" in block


def test_page_reopens_the_studio_on_server_state_instead_of_the_pill():
    i = HS.index("async function resumeStudioFromServer")
    block = HS[i:i + 700]
    assert "/api/orwell/portrait/intake" in block and "ik.generating" in block and "ik.candidates" in block
    assert "mount();" in block
    r = HS.index("async function route()")
    assert HS.index("await resumeStudioFromServer()", r) < HS.index("showPill();", r)


def test_uploaded_reference_counts_as_chosen():
    assert 'status.present && status.mode === "reference"' in HS
    assert 'id="hs-studio" ${chosen ? "" : "disabled"}' in HS


def test_single_flight_and_page_leaving_kept():
    assert "if (pageLeaving) return;" in HS and 'addEventListener("pagehide"' in HS


def test_status_after_reload_says_enough(tmp_path, monkeypatch):
    monkeypatch.setattr(op, "PORTRAITS_DIR", tmp_path / "portraits")
    b = io.BytesIO(); Image.new("RGB", (64, 64), (70, 90, 110)).save(b, "JPEG")
    op.save_player_intake("u", b.getvalue(), "reference")
    s = op.intake_status("u")
    assert s["present"] is True and s["mode"] == "reference" and s["finalized"] is False and s["generating"] is False
