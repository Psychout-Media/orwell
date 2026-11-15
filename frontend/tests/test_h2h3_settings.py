"""Lane H2+H3 — settings fixes (2026-06-11).

H2 — every "default <X> model" select mirrors the Default Chat Model card.
The image-generation select (and the other flat model selects) used to be fed
from a keyword include-list over /api/models plus a short HARDCODED fallback
list ("dall-e-3 (not detected)" …) — a few options that "don't make sense".
Now every default-model select draws from the ONE shared pool the chat card
offers (`_fetchModelEndpoints()` → `_availableModelIds()`): the models of
every enabled endpoint, with unavailable/offline ones excluded — data-driven,
no hardcoded model names, current selection preserved when still available.

H3 — the Settings → Appearance "Theme" card is gone. The theme picker already
has a standing home in the sidebar's bottom cluster (#tool-theme-btn), so the
redundant launcher card (and its dead JS wiring) was removed; the rest of the
appearance panel (Sidebar visibility toggles, Chat Area, …) stays intact, and
the browser smoke drives the picker via the sidebar entry instead.

Source pins are JS/HTML-as-text (the suite's convention); the runtime check
boots the real app, opens settings in headless chromium, and proves the image
select's options are a subset of the chat select's options. The runtime check
skips when chromium isn't available (CI's pytest step runs before playwright
installs; the browser-smoke step still gates the same surface there).
"""

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

import pytest

from _ports import free_port

from _settings_open import open_settings_deterministically

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel):
    with open(os.path.join(FRONTEND, rel), encoding="utf-8") as f:
        return f.read()


def _block(text, start, end):
    """Slice a source block between two unique markers."""
    i = text.index(start)
    j = text.index(end, i)
    return text[i:j]


# ── H2 source pins: one shared, availability-filtered model pool ──────────────


def test_settings_defines_the_shared_available_model_pool():
    js = _read("static/js/settings.js")
    assert "function _availableModelIds(" in js, "the shared model-pool helper must exist"
    helper = _block(js, "function _availableModelIds(", "function _registerAiEndpointRefresh")
    # The chat card's availability rule: enabled endpoints only, offline ones
    # contribute nothing.
    assert "if (!ep.is_enabled || !ep.online) return;" in helper


def test_image_model_select_mirrors_the_chat_source_not_a_hardcoded_list():
    js = _read("static/js/settings.js")
    img = _block(js, "async function initImageSettings", "/* ── Vision ── */")
    # Same source as the Default Chat Model card…
    assert "_fetchModelEndpoints()" in img
    # …narrowed by the image-capability filter (G21 — parallel to Vision's), so a
    # chat model can't be offered. Still the shared pool, just filtered.
    assert "_availableModelIds(_endpoints, function(mid) { return _isImageModel(mid); })" in img
    # …and the saved selection is preserved when still available.
    assert "refreshModels(settings.image_model || '')" in img
    # The select stays fresh when endpoints change, keeping the current pick.
    assert "_registerAiEndpointRefresh" in img
    # The old population path is gone: no /api/models keyword scrape, no
    # hardcoded fallback entries.
    assert "/api/models" not in img
    assert "not detected" not in img
    assert "_imgInclude" not in img


def test_image_model_names_live_only_in_the_capability_filter():
    """G21: the Image select gained its OWN capability filter (`_isImageModel`),
    exactly parallel to the Vision card's `_vlExclude` — so a chat model can't be
    picked. Image-family NAMES are therefore allowed, but ONLY inside that filter,
    never as a hardcoded <option> or in the populate path (`initImageSettings`)."""
    js = _read("static/js/settings.js")
    assert "function _isImageModel(" in js
    img_filter = _block(js, "function _isImageModel(", "/* ── Image Generation ── */")
    img_block = _block(js, "async function initImageSettings", "/* ── Vision ── */")
    for name in ("gpt-image", "dall-e", "stable-diffusion", "imagen", "ideogram", "flux"):
        assert name in img_filter, f"{name!r} is an image-family token of the capability filter"
        assert name not in img_block, f"{name!r} must not leak into the image populate path"
    # The old synthetic "(not detected)" fallback stays gone wholesale.
    assert "not detected" not in js
    # 'dall-e' now lives in exactly two capability filters — Vision's EXCLUDE and the
    # Image INCLUDE — never as an offered <option>.
    assert "dall-e" in _block(js, "var _vlExclude", "];")
    assert "dall-e" in img_filter


def test_vision_model_select_draws_from_the_same_pool():
    js = _read("static/js/settings.js")
    vision = _block(js, "/* ── Vision ── */", "/* ── Face Recognition ── */")
    assert "_availableModelIds(_visionEndpoints" in vision
    assert "/api/models" not in vision, "vision must use the shared endpoint source"
    assert "refreshModels(settings.vision_model || '')" in vision


def test_tts_endpoint_mode_models_are_endpoint_driven():
    js = _read("static/js/settings.js")
    tts = _block(js, "/* ── Text to Speech ── */", "/* ── Speech to Text ── */")
    assert "function refreshTtsModels(" in tts
    assert "_availableModelIds(" in tts
    # The provider switch no longer force-resets to a hardcoded model id.
    assert "modelSelect.value = 'tts-1'" not in tts


# ── H3 source pins: the appearance Theme card is gone, the sidebar owns it ────


def test_appearance_panel_ships_no_theme_card():
    html = _read("static/index.html")
    assert "appearance-theme-btn" not in html
    assert "Open theme picker" not in html
    # The rest of the appearance panel is intact: the panel exists and still
    # carries the Sidebar visibility toggles.
    assert 'data-settings-panel="appearance"' in html
    panel = _block(html, 'data-settings-panel="appearance"', 'data-settings-panel="shortcuts"')
    assert 'data-ui-key="sidebar-brand"' in panel
    assert 'data-ui-key="tool-theme"' in panel  # the sidebar Theme toggle stays


def test_sidebar_theme_entry_and_modal_survive():
    html = _read("static/index.html")
    assert 'id="tool-theme-btn"' in html, "the standing sidebar theme entry must stay"
    # The theme window migrated to the OrwellWindow kit: its content is hosted
    # (hidden) in #theme-host and the kit window (id "theme-modal") is built at
    # runtime by theme.js. The static markup carries the host + content card.
    assert 'id="theme-host"' in html and 'id="theme-popup"' in html


def test_dead_appearance_launcher_wiring_is_gone():
    app_js = _read("static/app.js")
    assert "appearance-theme-btn" not in app_js
    # The sidebar entry's wiring is still the one opener.
    assert "el('tool-theme-btn')" in app_js
    settings_js = _read("static/js/settings.js")
    assert "appearance-theme-btn" not in settings_js


def test_browser_smoke_drives_the_picker_via_the_sidebar():
    smoke = _read("scripts/browser_smoke.py")
    # The re-pointed check: trusted click on the sidebar entry…
    assert 'page.click("#tool-theme-btn")' in smoke
    # …the old Settings → Appearance launcher flow is gone…
    assert "theme picker launcher is the topmost" not in smoke
    # …and the only remaining launcher reference is the negative pin.
    assert "!document.getElementById('appearance-theme-btn')" in smoke


def test_appearance_card_order_css_no_longer_counts_a_theme_card():
    css = _read("static/style.css")
    block = _block(css, ".settings-appearance-panel {", "/* Narrow settings")
    assert "Theme picker */" not in block, "the order: indices must not assume the removed card"
    # The designed order survives the removal: Chat Area renders first.
    assert ".settings-appearance-panel > .admin-card:nth-of-type(2) { order: 0; }" in block


# ── runtime: boot + open settings — image options ⊆ chat options ──────────────

# #925: a DISTINCT default port from test_h2b_all_model_pools.py (which also defaults to 8967).
# Run back-to-back, a lingering h2b uvicorn on 8967 that hasn't released the socket would let this
# test's _boot() connect to the WRONG (h2b-seeded) app — so the convergence/select-population waits
# below could never satisfy this test's assertions and time out (a flake that compounded the orphan-
# scrim lockup these two gates were diagnosed under). A separate port removes the cross-test race.
PORT = free_port()  # ORW-414: a kernel-assigned free port per process (was a fixed default), so two browser tests can run at once


def _boot(env):
    os.makedirs(os.path.join(FRONTEND, "data"), exist_ok=True)
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=FRONTEND, env=env,
        stdout=open(f"/tmp/fe-h2h3-{PORT}-{os.getpid()}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{PORT}"
    for _ in range(300):  # ORW-414: poll every 0.2 s (same 60 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            pytest.fail(f"uvicorn exited early; see /tmp/fe-h2h3-{PORT}-{os.getpid()}.log")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            return proc, base
        except Exception:
            time.sleep(0.2)
    proc.terminate()
    pytest.fail("front-end never became ready")


def test_runtime_image_options_are_a_subset_of_chat_options():
    """Boot the real app, seed model endpoints through the real admin API,
    open settings in a browser, and prove the image-model select offers
    exactly what the chat card can offer — and nothing unavailable."""
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        pytest.skip("playwright not installed")
    import httpx

    # ORW-414: this stack gets its OWN data dir (settings.json, sessions, game-session binding), so it never touches the shared frontend/data
    # and can run beside another browser test.
    fe_data = tempfile.mkdtemp(prefix="orwell-h2h3-data-")
    env = dict(
        os.environ,
        ORWELL_DATA_DIR_FE=fe_data,
        ORWELL_GAME_BUILD="1",
        AUTH_ENABLED="false",
        LOCALHOST_BYPASS="true",
        # Isolate the endpoint rows from the developer's real DB.
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-h2h3-"), "app.db"),
    )
    # Snapshot the shared data/settings.json BY FILE — the endpoint POST
    # auto-writes default_endpoint_id into it, and the settings POST API is
    # admin-gated even with auth disabled, so an API-level restore can't work.
    settings_path = os.path.join(fe_data, "settings.json")
    settings_before = None
    if os.path.exists(settings_path):
        with open(settings_path, "rb") as f:
            settings_before = f.read()

    proc, base = _boot(env)
    try:
        # An ONLINE endpoint (pinned models count as available — no probe), and
        # a DISABLED endpoint whose models must never be offered anywhere.
        r = httpx.post(base + "/api/model-endpoints", timeout=15, data={
            "name": "H2 Mirror Source",
            # h2-dall-e-3 is image-capable (G21's Image filter offers it) so the Image
            # select is populated; the chat-only models prove the filter narrows the pool.
            "base_url": "http://192.0.2.10:9101/v1",
            "skip_probe": "true",
            "pinned_models": json.dumps(["h2-alpha-model", "h2-beta-model", "h2-dall-e-3"]),
        })
        assert r.status_code == 200, r.text
        r = httpx.post(base + "/api/model-endpoints", timeout=15, data={
            "name": "H2 Ghost",
            "base_url": "http://192.0.2.11:9102/v1",
            "skip_probe": "true",
            "pinned_models": json.dumps(["h2-ghost-model"]),
        })
        assert r.status_code == 200, r.text
        ghost_id = r.json()["id"]
        r = httpx.patch(base + f"/api/model-endpoints/{ghost_id}", timeout=15,
                        json={"is_enabled": False})
        assert r.status_code == 200, r.text

        with sync_playwright() as pw:
            try:
                browser = pw.chromium.launch()
            except Exception as e:  # chromium binary not installed in this env
                pytest.skip(f"chromium unavailable: {e}")
            page = browser.new_page()
            page.goto(base + "/", wait_until="load", timeout=30000)
            page.wait_for_timeout(4000)  # module graph + async init
            # Open Settings past the boot loader (#app-loader) + the no-engine
            # onboarding holding card — the deterministic recipe that ends the
            # #925/#1148/#930 flake (see _settings_open.py for the full root cause).
            open_settings_deterministically(page)
            page.wait_for_function(
                """() => {
                  const ep = document.getElementById('set-defaultEpSelect');
                  const img = document.getElementById('set-imgModelSelect');
                  return ep && img && ep.options.length > 0 && img.options.length > 1;
                }""",
                timeout=15000,
            )
            # Pick the (one) available endpoint in the Default Chat Model card
            # the way a user does — a stale saved default_endpoint_id otherwise
            # leaves the chat model list empty until the endpoint is re-picked.
            page.evaluate(
                """() => {
                  const ep = document.getElementById('set-defaultEpSelect');
                  ep.value = ep.options[0].value;
                  ep.dispatchEvent(new Event('change'));
                }"""
            )
            page.wait_for_function(
                "document.getElementById('set-defaultModelSelect').options.length > 0",
                timeout=5000,
            )
            opts = page.evaluate(
                """() => {
                  const read = (id) => [...document.getElementById(id).options]
                    .map(o => ({ value: o.value, label: o.textContent }));
                  return { chat: read('set-defaultModelSelect'), img: read('set-imgModelSelect') };
                }"""
            )
            # H3, runtime half: the appearance launcher is genuinely gone.
            assert page.evaluate("!document.getElementById('appearance-theme-btn')") is True
            browser.close()

        chat_values = {o["value"] for o in opts["chat"]}
        img_values = {o["value"] for o in opts["img"]} - {""}  # minus the Auto-detect blank
        assert img_values, f"image select must be populated from the shared source ({opts})"
        assert img_values <= chat_values, (
            f"image options must be a subset of the chat options ({img_values} vs {chat_values})"
        )
        # G21: the Image filter narrows the shared pool to image-capable models — the
        # chat-only models are offered in chat but NOT here.
        assert img_values == {"h2-dall-e-3"}, (
            f"image select must offer only the image-capable model ({img_values})"
        )
        assert "h2-ghost-model" not in img_values, "a disabled endpoint's models must not be offered"
        assert all("not detected" not in o["label"] for o in opts["img"]), (
            "no synthetic hardcoded entries in the image select"
        )
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except Exception:
            proc.kill()
        # Put the shared settings file back exactly as found (the DB rows died
        # with the temp DATABASE_URL; this reverts the auto-default write).
        try:
            if settings_before is None:
                if os.path.exists(settings_path):
                    os.remove(settings_path)
            else:
                with open(settings_path, "wb") as f:
                    f.write(settings_before)
        except OSError:
            pass
