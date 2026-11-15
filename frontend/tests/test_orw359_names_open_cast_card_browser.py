"""ORW-359 - tap a name or a face in the chat to open that houseguest's cast card; the dossier shows the photo large; the photo opens in a
full-size viewer; a cast tile has an expand button. Real app + real scripts in headless Chromium; routes stubbed with the documented shapes,
a 1024 px fixture portrait. No model. Own module so conftest routes it to the serial browser lane."""
import json
import os
import struct
import sys
import zlib

import pytest

from _settle import frames

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts"))

SHOTS = os.environ.get("ORW359_SHOTS")


def _png(size=1024):
    """A fixture portrait with visible detail: a bright border, a face-like disc and a marker bar near the bottom edge, so a clipped photo shows."""
    rows = []
    for y in range(size):
        r = bytearray(b"\x00")
        for x in range(size):
            if x < 24 or y < 24 or x >= size - 24 or y >= size - 24:
                px = (255, 200, 0)
            elif size - 120 <= y < size - 60 and 200 <= x < size - 200:
                px = (230, 40, 40)
            elif (x - size // 2) ** 2 + (y - size // 2 + 60) ** 2 < 230 ** 2:
                px = (230, 190, 160)
            else:
                px = (40, 90, 120)
            r += bytes(px)
        rows.append(bytes(r))
    raw = b"".join(rows)

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


PNG = _png()
ROSTER = [
    {"id": "player", "name": "Pat Quinn", "status": "active", "isPlayer": True, "portrait": "/api/orwell/portrait/player?v=1"},
    {"id": "npc:1", "name": "Dana Reyes", "status": "active", "portrait": "/api/orwell/portrait/npc:1?v=1"},
    {"id": "npc:2", "name": "Marcus Bell", "status": "active", "portrait": "/api/orwell/portrait/npc:2?v=1"},
    {"id": "npc:3", "name": "Dana Cho", "status": "active", "portrait": "/api/orwell/portrait/npc:3?v=1"},
    {"id": "npc:4", "name": "Priya Nair", "status": "evicted", "portrait": "/api/orwell/portrait/npc:4?v=1"},
]

ROWS = """
<div class="msg msg-ai" id="r1"><div class="role">Dana Reyes</div><div class="content">
<p class="ow-speaker-line"><span class="ow-speaker-chip" id="chip1" data-hg="npc:1" data-hg-name="Dana Reyes" role="img" aria-label="Dana Reyes"><span class="ow-speaker-chip-ini">DR</span></span><strong class="ow-speaker-name" id="spk1" data-hg="npc:1">Dana Reyes</strong>: Morning.</p>
<p id="p2"><strong id="bold1">Marcus Bell</strong> shrugged. Priya Nair's plan is thin, and Dana Cho knows it. Marcus agrees, and so does Dana.
<code id="code1">Marcus Bell</code> <a href="#x" id="link1">Priya Nair</a> Marcusville is not a name.</p>
</div></div>
"""


def _j(o, status=200):
    return {"status": status, "content_type": "application/json", "body": json.dumps(o)}


@pytest.fixture(scope="module")
def fe():
    import responsive_matrix as rm
    proc = rm.boot_fe()
    yield rm.FE
    rm.stop_fe(proc)


def _dossier(route):
    rid = route.request.url.rsplit("/", 1)[-1].split("?")[0].replace("%3A", ":")
    hg = next((h for h in ROSTER if h["id"] == rid), None)
    if not hg:
        return route.fulfill(**_j({"found": False}))
    route.fulfill(**_j({"found": True, "id": hg["id"], "name": hg["name"], "status": hg["status"], "isPlayer": bool(hg.get("isPlayer")),
                        "portrait": hg["portrait"], "persona": {"vocation": "Nurse"}, "history": [], "deals": [], "alliances": []}))


def _page(browser, fe, w, h):
    ctx = browser.new_context(viewport={"width": w, "height": h}, has_touch=w < 800)
    page = ctx.new_page()
    page.route("**/api/orwell/state", lambda r: r.fulfill(**_j({"started": True, "asleep": []})))
    page.route("**/api/orwell/status", lambda r: r.fulfill(**_j({})))
    page.route("**/api/orwell/whereabouts", lambda r: r.fulfill(**_j({"whereabouts": {"room": "kitchen", "present": []}})))
    page.route("**/api/orwell/roster", lambda r: r.fulfill(**_j({"roster": ROSTER, "imagesAvailable": True})))
    page.route("**/api/orwell/dossier/**", _dossier)
    page.route("**/api/orwell/portrait/**", lambda r: r.fulfill(status=200, content_type="image/png", body=PNG))
    page.goto(fe, wait_until="domcontentloaded")
    for _ in range(60):
        if page.evaluate("!!(window.OrwellMonogram && window.OrwellMonogram.allCards().length >= 5 && document.getElementById('chat-history'))"):
            break
        page.wait_for_timeout(250)
    else:
        raise AssertionError("roster cache never warmed")
    return page


def _until(page, expr, timeout=8000):
    """Poll a JS expression (page.wait_for_function evals a string, which the page CSP refuses)."""
    for _ in range(max(1, timeout // 150)):
        if page.evaluate(expr):
            return
        page.wait_for_timeout(150)
    raise AssertionError("never became true: " + expr)


def _rows(page):
    page.evaluate("(h) => { document.getElementById('chat-history').insertAdjacentHTML('beforeend', h); }", ROWS)
    page.wait_for_selector("#r1[data-ow-names]", timeout=8000)


def _dossier_name(page):
    page.wait_for_selector("#orwell-dossier #od-name:visible", timeout=8000)
    for _ in range(40):
        t = page.evaluate("(document.querySelector('#orwell-dossier #od-name')||{}).textContent || ''")
        if t:
            return t
        page.wait_for_timeout(150)
    return ""


FIT = """() => { const img = document.querySelector('#opv-img').getBoundingClientRect();
  const win = document.getElementById('orwell-portrait-viewer'); const body = win.querySelector('.ow-body');
  const bb = body.getBoundingClientRect(); const wb = win.getBoundingClientRect();
  return { w: img.width, h: img.height, inBody: img.left >= bb.left - 1 && img.right <= bb.right + 1 && img.top >= bb.top - 1 && img.bottom <= bb.bottom + 1,
           inView: img.top >= 0 && img.bottom <= window.innerHeight && img.left >= 0 && img.right <= window.innerWidth,
           scrolls: body.scrollHeight > body.clientHeight + 1 }; }"""


def _assert_whole_photo_visible(page):
    # ORW-414: the entrance animation has finished when the photo's box stops moving (10 identical frames), not after a fixed 1 s
    page.evaluate("""() => new Promise((resolve) => { const img = document.querySelector('#opv-img'); const t0 = performance.now(); let last = '', same = 0;
      const tick = () => { const r = img.getBoundingClientRect(); const k = [r.left, r.top, r.width, r.height].join(); if (k === last) same++; else { same = 0; last = k; }
        if (same >= 10 || performance.now() - t0 > 8000) resolve(true); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); })""")
    f = page.evaluate(FIT)
    assert abs(f["w"] - f["h"]) <= 2 and f["w"] >= 300, f
    assert f["inBody"] and f["inView"] and not f["scrolls"], f


def _close_dossier(page):
    page.evaluate("(() => { const b = document.querySelector('#orwell-dossier .ow-btn-close, #orwell-dossier [aria-label=\"Close\"]'); if (b) b.click(); })()")
    # ORW-414: closed means the dossier window is gone or hidden (the event), not 0.5 s later
    page.wait_for_function("() => { const d = document.getElementById('orwell-dossier'); return !d || d.hidden || getComputedStyle(d).display === 'none' || getComputedStyle(d).visibility === 'hidden' || d.getBoundingClientRect().width === 0; }", timeout=8000)


def test_names_and_faces_open_the_right_cast_card(fe):
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = _page(browser, fe, 1440, 900)
            _rows(page)
            # the name pass: full names and unique first names wrap; ambiguous "Dana" and non-names stay plain
            linked = page.evaluate("[...document.querySelectorAll('#r1 .ow-name-link')].map(e => e.textContent + '>' + e.dataset.hg)")
            assert "Priya Nair>npc:4" in linked and "Dana Cho>npc:3" in linked and "Marcus>npc:2" in linked, linked
            assert not any(x.startswith("Dana>") for x in linked), "an ambiguous first name stays plain text"
            # ORW-437: a partial match inside "Marcusville" would leave a link whose next sibling text starts with "ville"
            assert page.evaluate("[...document.querySelectorAll('#r1 .ow-name-link')].filter(e => (e.nextSibling && e.nextSibling.textContent || '').startsWith('ville')).length") == 0
            assert "Marcusville" in page.evaluate("document.getElementById('r1').textContent"), "the fixture really holds the longer word"
            assert page.evaluate("document.querySelector('#r1 #code1').querySelector('.ow-name-link')") is None, "code is skipped"
            assert page.evaluate("document.querySelector('#r1 #link1').querySelector('.ow-name-link')") is None, "links are skipped"
            assert page.evaluate("document.getElementById('p2').textContent") .count("Priya Nair's plan") == 1, "the text is untouched ('s stays outside)"
            assert page.evaluate("document.querySelector('#r1 .ow-name-link[data-hg=\"npc:4\"]').nextSibling.textContent.startsWith(\"'s plan\")")
            # a re-sweep never duplicates
            before = page.evaluate("document.querySelectorAll('#r1 .ow-name-link').length")
            page.evaluate("window.OrwellChatNames.refresh(); window.dispatchEvent(new CustomEvent('orwell:gamechanged'))")
            frames(page, 90)  # ORW-414: a negative check ("a re-sweep never duplicates") - a bounded window in the page's own frames, not a wall-clock sleep
            assert page.evaluate("document.querySelectorAll('#r1 .ow-name-link').length") == before
            assert page.evaluate("document.querySelectorAll('#r1 .ow-name-link .ow-name-link').length") == 0
            # the sender face carries the id and is a button
            face = page.evaluate("(() => { const f = document.querySelector('#r1 .ow-chatface'); return f && [f.dataset.hg, f.getAttribute('role')]; })()")
            assert face == ["npc:1", "button"], face

            cases = [("#spk1", "Dana Reyes"), ("#chip1", "Dana Reyes"), ("#bold1", "Marcus Bell"),
                     ("#r1 .ow-name-link[data-hg='npc:4']", "Priya Nair"), ("#r1 .ow-name-link[data-hg='npc:3']", "Dana Cho"),
                     ("#r1 .ow-chatface", "Dana Reyes")]
            for sel, who in cases:
                page.click(sel)
                assert _dossier_name(page) == who, sel
                if SHOTS and sel == "#bold1":
                    os.makedirs(SHOTS, exist_ok=True)
                    page.wait_for_timeout(1200)  # let the window animation and the photo settle
                    page.screenshot(path=os.path.join(SHOTS, "after-desktop-1440-dossier-large-photo.png"), timeout=90000)
                _close_dossier(page)
            # the dossier photo is big, a button, and opens the viewer at full size
            page.click("#r1 #bold1")
            _dossier_name(page)
            page.wait_for_selector("#orwell-dossier .od-portrait button.od-photo-btn", timeout=5000)
            w, hh = page.evaluate("(() => { const r = document.querySelector('#orwell-dossier .od-portrait').getBoundingClientRect(); return [r.width, r.height]; })()")
            # ORW-437: the photo is measured once the window has settled (two identical readings 120 ms apart); a reading taken
            # while the dossier is still opening or reflowing was the source of an intermittent 216 px result in CI.
            prev = None
            for _ in range(30):
                cur = page.evaluate("(() => { const r = document.querySelector('#orwell-dossier .od-portrait').getBoundingClientRect(); return [r.width, r.height]; })()")
                if cur == prev:
                    break
                prev = cur
                page.wait_for_timeout(120)
            w, hh = cur
            assert w >= 280 and hh >= 280 and abs(w - hh) <= 2, (w, hh)
            assert page.get_attribute("#orwell-dossier .od-portrait button.od-photo-btn", "aria-label") == "View photo of Marcus Bell"
            page.click("#orwell-dossier .od-portrait button.od-photo-btn")
            page.wait_for_selector("#orwell-portrait-viewer #opv-img", timeout=5000)
            _until(page, "document.querySelector('#opv-img').complete && document.querySelector('#opv-img').naturalWidth === 1024", 8000)
            assert page.get_attribute("#opv-img", "alt") == "Marcus Bell"
            assert page.get_attribute("#orwell-portrait-viewer", "aria-modal") == "true"
            _assert_whole_photo_visible(page)
            if SHOTS:
                page.wait_for_timeout(1200)  # let the window animation and the photo settle
                page.screenshot(path=os.path.join(SHOTS, "after-desktop-1440-viewer-open.png"), timeout=90000)
            page.keyboard.press("Escape")
            page.wait_for_selector("#orwell-portrait-viewer", state="detached", timeout=5000)
            assert page.evaluate("document.activeElement && document.activeElement.classList.contains('od-photo-btn')"), "focus returns to the opener"
        finally:
            browser.close()


def test_evicted_photo_stays_grayscale_in_the_viewer(fe):
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = _page(browser, fe, 1440, 900)
            page.evaluate("window.OrwellPortraitViewer.open('npc:4', null)")
            page.wait_for_selector("#opv-img.opv-evicted", timeout=5000)
            assert "grayscale" in page.evaluate("getComputedStyle(document.querySelector('#opv-img')).filter")
            page.evaluate("window.OrwellPortraitViewer.open('npc:1', null)")  # singleton: retargets
            _until(page, "document.querySelector('#opv-img').alt === 'Dana Reyes'", 5000)
            assert page.evaluate("document.querySelectorAll('#orwell-portrait-viewer').length") == 1
            assert page.evaluate("getComputedStyle(document.querySelector('#opv-img')).filter") == "none"
        finally:
            browser.close()


def test_tile_expand_button_opens_only_the_viewer(fe):
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = _page(browser, fe, 1440, 900)
            page.evaluate("window._orwellCastEnsure()")
            page.wait_for_selector("#orwell-cast .oc-hg .oc-expand:visible", timeout=10000)
            _until(page, "[...document.querySelectorAll('#orwell-cast .oc-portrait img')].every(i => i.complete && i.naturalWidth > 0)", 10000)
            n = page.evaluate("document.querySelectorAll('#orwell-cast .oc-hg .oc-expand:not([hidden])').length")
            assert n == 5, "every tile with a photo, the player's own included"
            box = page.evaluate("(() => { const r = document.querySelector('#orwell-cast .oc-expand').getBoundingClientRect(); return [r.width, r.height]; })()")
            assert box[0] >= 44 and box[1] >= 44, box
            assert page.get_attribute("#orwell-cast .oc-hg >> nth=1 >> .oc-expand", "aria-label") == "View photo of Dana Reyes"
            if SHOTS:
                os.makedirs(SHOTS, exist_ok=True)
                page.wait_for_timeout(1200)  # let the window animation and the photo settle
                page.screenshot(path=os.path.join(SHOTS, "after-desktop-1440-cast-tile-expand.png"), timeout=90000)
            page.click("#orwell-cast .oc-hg >> nth=1 >> .oc-expand")
            page.wait_for_selector("#orwell-portrait-viewer #opv-img", timeout=5000)
            assert page.evaluate("!document.getElementById('orwell-dossier')"), "the expand button must not open the dossier"
            page.keyboard.press("Escape")
            page.wait_for_selector("#orwell-portrait-viewer", state="detached", timeout=5000)
            # a plain tile tap still opens the dossier
            page.click("#orwell-cast .oc-hg >> nth=2 >> .oc-name")
            assert _dossier_name(page) == "Marcus Bell"
            # player's own tile
            page.click("#orwell-cast .oc-hg >> nth=0 >> .oc-expand")
            _until(page, "document.querySelector('#opv-img') && document.querySelector('#opv-img').alt === 'Pat Quinn'", 5000)
        finally:
            browser.close()


def test_phone_width_has_no_sideways_scroll_and_keyboard_only_path(fe):
    sync_api = pytest.importorskip("playwright.sync_api")
    with sync_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = _page(browser, fe, 412, 915)
            _rows(page)
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "no sideways scroll with linked names"
            # keyboard only: focus a name, Enter opens the dossier, focus the photo, Enter opens the viewer, Escape closes it
            page.focus("#r1 .ow-name-link[data-hg='npc:4']")
            page.keyboard.press("Enter")
            assert _dossier_name(page) == "Priya Nair"
            if SHOTS:
                os.makedirs(SHOTS, exist_ok=True)
                page.wait_for_timeout(1200)  # let the window animation and the photo settle
                page.screenshot(path=os.path.join(SHOTS, "after-phone-412-dossier-large-photo.png"), timeout=90000)
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "no sideways scroll with the dossier open"
            # ORW-437: the kit re-clamps every open window whenever a top banner appears or the viewport changes (a banner can arrive at any moment in CI).
            # That pass must never shrink the dossier below the width its large photo needs; fire it on purpose so the result no longer depends on timing.
            page.evaluate("window.dispatchEvent(new CustomEvent('orwell:banner-inset')); window.dispatchEvent(new Event('resize'))")
            frames(page, 6)
            w, hh = page.evaluate("(() => { const r = document.querySelector('#orwell-dossier .od-portrait').getBoundingClientRect(); return [r.width, r.height]; })()")
            assert w >= 280 and hh >= 280 and abs(w - hh) <= 2, (w, hh)
            page.wait_for_selector("#orwell-dossier .od-portrait button.od-photo-btn", timeout=5000)
            page.focus("#orwell-dossier .od-portrait button.od-photo-btn")
            page.keyboard.press("Enter")
            page.wait_for_selector("#orwell-portrait-viewer #opv-img", timeout=5000)
            _until(page, "document.querySelector('#opv-img').naturalWidth === 1024", 8000)
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "no sideways scroll with the viewer open"
            _assert_whole_photo_visible(page)
            iw = page.evaluate("document.querySelector('#opv-img').getBoundingClientRect().width")
            assert iw <= 412, iw
            if SHOTS:
                page.wait_for_timeout(1200)  # let the window animation and the photo settle
                page.screenshot(path=os.path.join(SHOTS, "after-phone-412-viewer-open.png"), timeout=90000)
            page.keyboard.press("Escape")
            page.wait_for_selector("#orwell-portrait-viewer", state="detached", timeout=5000)
            # Space also activates a name
            _close_dossier(page)
            page.focus("#r1 .ow-name-link[data-hg='npc:3']")
            page.keyboard.press(" ")
            assert _dossier_name(page) == "Dana Cho"
        finally:
            browser.close()
