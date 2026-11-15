"""ORW-359 source pins: tap a name/face in chat to open the cast card; large dossier photo; the full-size viewer composes the window kit;
the cast tile expand button. (The real-browser behaviour is in test_orw359_names_open_cast_card_browser.py.)"""
import pathlib
import re

JS = pathlib.Path(__file__).resolve().parents[1] / "static" / "js"


def _r(n):
    return (JS / n).read_text(encoding="utf-8")


def test_one_delegated_listener_on_the_transcript():
    s = _r("orwellChatNames.js")
    assert 'box.addEventListener("click", onClick);' in s and 'box.addEventListener("keydown", onKeydown);' in s
    assert s.count("addEventListener(\"click\"") == 1, "no per-element click handlers"
    assert "OrwellDossier.open(id, el)" in s and 'ev.key !== "Enter" && ev.key !== " "' in s
    assert "MutationObserver" in s and 'row.classList.contains("streaming")' in s, "settled rows only"
    assert 'data-ow-names' in s or "owNames" in s


def test_chip_name_and_face_carry_the_id():
    md = _r("markdown.js")
    assert "data-hg=" in md and 'class="ow-speaker-name"' in md
    assert re.search(r'ow-speaker-chip"\$\{idAttr\}\$\{hgAttr\}', md)
    faces = _r("orwellChatFaces.js")
    assert 'holder.setAttribute("data-hg"' in faces and 'holder.setAttribute("role", "button")' in faces
    assert "allCards" in _r("orwellMonogram.js")


def test_viewer_composes_the_kit_and_has_no_escape_or_backdrop_handler():
    s = _r("orwellPortraitViewer.js")
    assert "OrwellWindowKit.create(" in s and "modal: true" in s and 'id: WIN_ID' in s
    assert "Escape" not in s.replace("// ", "") or "Escape or backdrop handler" in s
    code = "\n".join(l for l in s.splitlines() if not l.strip().startswith("//"))
    assert "Escape" not in code and "keydown" not in code and "scrim" not in code
    for opt in ("persistLayout: false", "minimizable: false", "dockable: false", "resizable: false", "draggable: false", "closable: true", "focus: true"):
        assert opt in s


def test_dossier_photo_is_large_and_opens_the_viewer():
    s = _r("orwellDossier.js")
    assert "max-width: 320px" in s and "aspect-ratio: 1 / 1" in s and "width: 56px" not in s
    assert "View photo of " in s and "OrwellPortraitViewer.open" in s


def test_cast_tile_expand_button_stops_the_tap():
    s = _r("orwellCast.js")
    assert 'expandBtn.className = "oc-expand"' in s and "e.stopPropagation();" in s
    assert "width: 44px; height: 44px" in s and "View photo of " in s


def test_viewer_script_is_loaded_before_the_cast():
    html = (JS.parent / "index.html").read_text(encoding="utf-8")
    assert html.index("orwellPortraitViewer.js") > html.index("orwellDossier.js")
    assert "orwellChatNames.js" in html


def test_inline_name_links_are_exempt_from_the_44px_touch_floor():
    """A name inside a sentence is role=button but is an INLINE target (WCAG 2.5.5 / 2.5.8 inline exception). Without `tap-exempt` the responsive
    matrix's touch sweep (it matches `[role=button]`) fails every phone viewport with "touch: 'Kevin' 32x14" whenever a roster name is in the prose
    (fe-responsive on #2705 and #2715, 2026-11-15)."""
    s = _r("orwellChatNames.js")
    made = [ln for ln in s.splitlines() if "ow-name-link" in ln and ("classList.add(" in ln or "className =" in ln)]
    assert len(made) == 3, made
    assert all("tap-exempt" in ln for ln in made), made
    matrix = (pathlib.Path(__file__).resolve().parents[1] / "scripts" / "responsive_matrix.py").read_text(encoding="utf-8")
    assert "e.classList.contains('tap-exempt')" in matrix and "[role=button]" in matrix
