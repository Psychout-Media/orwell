"""Lane H2b — the full model-select sweep (2026-06-11, follow-up to H2 / PR #265).

H2 made the flat default-model selects (Image Generation, Vision, TTS endpoint
mode) draw from the ONE shared pool the Default Chat Model card offers
(`_fetchModelEndpoints()` → `_availableModelIds()` / per-endpoint `ep.models`).
H2b closed out the straggler the follow-up audit found — a model select with a
REAL backend setting that was never populated, stuck forever on its inherit
placeholder:

  * `#set-researchModel`  — backend pair research_endpoint_id + research_model
    (src/settings.py; routes/model_routes.py:_ENDPOINT_SETTING_FIELDS treats
    them exactly like the utility pair). `initResearchSettings()` wired the
    endpoint select but never the model select, and never saved the model.

It now mirrors the existing pattern: research is endpoint-scoped exactly like
the Utility card; blank stays the inherit/unset default; it persists through
the same /api/auth/settings POST the other AI-defaults use. (The Teacher Model
card was removed wholesale in F4 — that escalation is not an active feature.)

The sweep below is exhaustive and ratcheted: it enumerates EVERY `<select>` on
the settings page whose purpose is choosing a model, pins that the set is
exactly the known six, that none ships hardcoded model options in markup
(the TTS markup trio is the one H2-sanctioned no-data fallback, pinned as
such), and — at runtime — that every model select's options are a subset of
the chat pool, with a disabled endpoint's models offered nowhere.

Source pins are JS/HTML-as-text (the suite's convention); the runtime check
boots the real app, seeds endpoints through the real admin API, and drives the
settings modal in headless chromium. It skips when chromium isn't available
(CI's pytest step runs before playwright installs; the browser-smoke step
still gates the surface there).
"""

import json
import os
import re
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


# Every settings-page <select> whose purpose is choosing a MODEL. Endpoint
# pickers (set-*EpSelect / set-researchEndpoint), providers, voices, speeds,
# quality tiers and search providers are NOT model selects.
MODEL_SELECT_IDS = {
    "set-defaultModelSelect",   # the chat picker itself — the pool's source
    "set-utilityModelSelect",   # endpoint-scoped (chat-picker mechanism)
    "set-faithModelSelect",     # endpoint-scoped, like utility (feature 0081 — the faithfulness judge model)
    "set-vlModelSelect",        # union pool, vision-capability filter (H2)
    "set-researchModel",        # endpoint-scoped, like utility (H2b)
    "set-imgModelSelect",       # union pool (H2)
    "set-ttsModelSelect",       # endpoint-scoped TTS models (H2)
}

# The one sanctioned markup fallback (H2): the TTS select's options are used
# ONLY when the chosen endpoint reports no TTS-capable models.
TTS_MARKUP_FALLBACK = {"tts-1", "tts-1-hd", "gpt-4o-mini-tts"}


def _settings_modal_markup():
    html = _read("static/index.html")
    # The settings modal is the last modal in the document; the search overlay is
    # the first top-level element after it. (#1638 KM-W9 retired the legacy #toast
    # markup that used to anchor the end of this slice — toasts now render through
    # the kit notice, so search-overlay is the stable end marker.)
    return _block(html, 'id="settings-modal"', 'id="search-overlay"')


def _select_markup(markup, sel_id):
    m = re.search(r'<select id="%s".*?</select>' % re.escape(sel_id), markup, re.S)
    assert m, f"select #{sel_id} must exist on the settings page"
    return m.group(0)


def _option_values(select_markup):
    return re.findall(r'<option\s+value="([^"]*)"', select_markup)


# ── the sweep: enumeration is exhaustive and ratcheted ─────────────────────────


def test_sweep_every_model_select_on_the_settings_page_is_accounted_for():
    """Any `<select id="set-*">` with "model" in its id IS a model select and
    must be in the audited set — a new model dropdown can't ship outside this
    sweep without failing here."""
    markup = _settings_modal_markup()
    select_ids = set(re.findall(r'<select id="([^"]+)"', markup))
    model_ish = {sid for sid in select_ids if "model" in sid.lower()}
    assert model_ish == MODEL_SELECT_IDS, (
        f"model-select sweep drifted: markup has {sorted(model_ish)}, "
        f"audited set is {sorted(MODEL_SELECT_IDS)} — wire any new select to "
        f"the shared pool and add it here"
    )
    # And the known set really is on the page (guards marker/regex rot).
    assert MODEL_SELECT_IDS <= select_ids


def test_sweep_no_model_select_ships_hardcoded_model_options_in_markup():
    """Every model select's markup carries at most the blank inherit option —
    real options only ever arrive from the shared endpoint pool at runtime.
    The TTS trio is the single sanctioned exception (H2's no-data fallback),
    pinned exactly so it can't quietly grow."""
    markup = _settings_modal_markup()
    for sel_id in sorted(MODEL_SELECT_IDS - {"set-ttsModelSelect"}):
        values = _option_values(_select_markup(markup, sel_id))
        assert set(values) <= {""}, (
            f"#{sel_id} must not hardcode model options in markup, got {values}"
        )
    tts_values = set(_option_values(_select_markup(markup, "set-ttsModelSelect")))
    assert tts_values == TTS_MARKUP_FALLBACK, (
        f"the TTS markup fallback is pinned to {sorted(TTS_MARKUP_FALLBACK)}, got {sorted(tts_values)}"
    )
    # …and the JS still treats those as a fallback only, never the source.
    js = _read("static/js/settings.js")
    tts = _block(js, "/* ── Text to Speech ── */", "/* ── Speech to Text ── */")
    assert "var _ttsMarkupModels" in tts
    assert "models.length ? models : _ttsMarkupModels" in tts


def test_sweep_every_model_select_is_populated_from_the_shared_endpoint_source():
    """Each audited select is filled by `_fillModelSelect` from
    `_fetchModelEndpoints()` data (per-endpoint models or the
    `_availableModelIds` union) — no other population path."""
    js = _read("static/js/settings.js")
    blocks = {
        "set-defaultModelSelect": _block(js, "async function initDefaultChat", "/* ── Utility Model ── */"),
        "set-utilityModelSelect": _block(js, "async function initUtilityModel", "/* ── Image Generation ── */"),
        "set-imgModelSelect": _block(js, "async function initImageSettings", "/* ── Vision ── */"),
        "set-vlModelSelect": _block(js, "async function initVisionSettings", "/* ── Face Recognition ── */"),
        "set-ttsModelSelect": _block(js, "async function initTtsSettings", "/* ── Speech to Text ── */"),
        "set-researchModel": _block(js, "async function initResearchSettings", "/* ── Deep Research Search"),
    }
    for sel_id, block in blocks.items():
        assert "_fetchModelEndpoints()" in block, f"{sel_id}: models must come from the endpoint source"
        assert "_fillModelSelect(" in block, f"{sel_id}: must fill via the shared helper"
        assert "/api/models" not in block, f"{sel_id}: the legacy keyword-scrape path must stay gone"
        if sel_id != "set-ttsModelSelect":
            # TTS rebuilds its model list on every provider change instead of
            # holding a live refresher (H2's accepted shape).
            assert "_registerAiEndpointRefresh" in block, f"{sel_id}: must stay fresh when endpoints change"


# ── H2b straggler 1: the research model select ─────────────────────────────────


def test_research_model_select_is_populated_loaded_and_saved():
    js = _read("static/js/settings.js")
    research = _block(js, "async function initResearchSettings", "/* ── Deep Research Search")
    # The select is wired at all (the H2b bug: it never was)…
    assert "el('set-researchModel')" in research
    # …endpoint-scoped exactly like the Utility card, keeping the blank inherit…
    assert "_fillModelSelect(modelSel, ep ? ep.models : [], selectedModel, true)" in research
    # …the saved model is loaded back into the select…
    assert "refreshModels(settings.research_model || '')" in research
    # …a change persists through the same settings POST as the other AI defaults…
    assert "research_model: modelSel.value || ''" in research
    assert "modelSel.addEventListener('change', saveResearch)" in research
    # …switching endpoint re-scopes the list (and the save picks up the reset)…
    assert "refreshModels('')" in research
    # …and endpoint refreshes keep the model list current.
    assert "refreshModels(modelSel.value)" in research




def test_backend_keys_the_two_cards_persist_actually_exist():
    py = _read("src/settings.py")
    assert '"research_endpoint_id": ""' in py
    assert '"research_model": ""' in py


# ── runtime: boot + seed + open settings — every model select ⊆ the chat pool ──

PORT = free_port()  # ORW-414: a kernel-assigned free port per process (was a fixed default), so two browser tests can run at once


def _boot(env):
    os.makedirs(os.path.join(FRONTEND, "data"), exist_ok=True)
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=FRONTEND, env=env,
        stdout=open(f"/tmp/fe-h2b-{PORT}-{os.getpid()}.log", "w"), stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{PORT}"
    for _ in range(300):  # ORW-414: poll every 0.2 s (same 60 s budget) so a ready server is noticed at once
        if proc.poll() is not None:
            pytest.fail(f"uvicorn exited early; see /tmp/fe-h2b-{PORT}-{os.getpid()}.log")
        try:
            urllib.request.urlopen(base + "/openapi.json", timeout=2)
            return proc, base
        except Exception:
            time.sleep(0.2)
    proc.terminate()
    pytest.fail("front-end never became ready")


def test_runtime_every_model_select_offers_a_subset_of_the_chat_pool():
    """Seed one ONLINE endpoint (with a TTS-capable model so the TTS endpoint
    mode participates) and one DISABLED endpoint, open settings, drive each
    endpoint-scoped card onto the live endpoint, and prove EVERY model select
    offers only models the chat picker can offer — research
    included (the two H2b stragglers), the ghost's models nowhere."""
    try:
        from playwright.sync_api import sync_playwright
    except Exception:
        pytest.skip("playwright not installed")
    import httpx

    # ORW-414: this stack gets its OWN data dir (settings.json, sessions, game-session binding), so it never touches the shared frontend/data
    # and can run beside another browser test.
    fe_data = tempfile.mkdtemp(prefix="orwell-h2b-data-")
    env = dict(
        os.environ,
        ORWELL_DATA_DIR_FE=fe_data,
        ORWELL_GAME_BUILD="1",
        AUTH_ENABLED="false",
        LOCALHOST_BYPASS="true",
        # Isolate the endpoint rows from the developer's real DB.
        DATABASE_URL="sqlite:///" + os.path.join(tempfile.mkdtemp(prefix="orwell-h2b-"), "app.db"),
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
        # An ONLINE endpoint (pinned models count as available — no probe)…
        r = httpx.post(base + "/api/model-endpoints", timeout=15, data={
            "name": "H2b Pool Source",
            "base_url": "http://192.0.2.20:9201/v1",
            "skip_probe": "true",
            # h2b-dall-e-3 is image-capable (G21 Image filter offers it) AND
            # vision-excluded (the 'dall-e' keyword), so it exercises the Image
            # select without disturbing the Vision assertion below.
            "pinned_models": json.dumps(["h2b-alpha-model", "h2b-beta-model", "h2b-tts-model", "h2b-dall-e-3"]),
        })
        assert r.status_code == 200, r.text
        live_id = r.json()["id"]
        # …and a DISABLED endpoint whose models must never be offered anywhere.
        r = httpx.post(base + "/api/model-endpoints", timeout=15, data={
            "name": "H2b Ghost",
            "base_url": "http://192.0.2.21:9202/v1",
            "skip_probe": "true",
            "pinned_models": json.dumps(["h2b-ghost-model"]),
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
            # Wait for EVERY endpoint-scoped card the pick below drives to be
            # populated by its OWN async init() — not just the three originally
            # gated here. Each init* is fire-and-forget (initAll() does not await
            # them), so a select can lag the others on a slow runner; driving a
            # `change` on a select whose options haven't arrived yet picks
            # nothing (set-utilityEpSelect → firstReal()===undefined) or — for
            # the TTS provider — fails to STICK: initTtsSettings() appends the
            # `endpoint:<id>` <option> only after its first await resolves, so
            # setting the value before then is silently rejected, isEndpoint() is
            # false, and the TTS model select keeps its OpenAI markup fallback
            # ({tts-1, tts-1-hd, gpt-4o-mini-tts}) — the historical h2b
            # TTS-subset flake. Gate on the endpoint option's presence so the
            # pick is deterministic.
            page.wait_for_function(
                """() => {
                  const opts = (id) => {
                    const s = document.getElementById(id);
                    return s ? [...s.options].map(o => o.value) : [];
                  };
                  const hasReal = (id) => opts(id).some(v => v !== '');
                  const ttsEndpointReady =
                    opts('set-ttsProviderSelect').some(v => v.startsWith('endpoint:'));
                  return hasReal('set-defaultEpSelect')
                      && hasReal('set-utilityEpSelect')
                      && opts('set-imgModelSelect').length > 1
                      && opts('set-researchEndpoint').length > 1   // endpoint arrived
                      && ttsEndpointReady;
                }""",
                timeout=15000,
            )

            # Drive each endpoint-scoped card onto the live endpoint the way a
            # user does (the chat card may hold a stale saved endpoint id, and
            # utility/research start blank = inherit). Kept as a re-runnable
            # snippet so a trailing initTtsSettings() auth-settings await that
            # resets the TTS provider to the saved default ("disabled") is simply
            # re-overwritten by the convergence loop below.
            pick_js = """(liveId) => {
                  const pick = (id, value) => {
                    const s = document.getElementById(id);
                    s.value = value;
                    s.dispatchEvent(new Event('change'));
                  };
                  const firstReal = (id) => {
                    const s = document.getElementById(id);
                    return [...s.options].map(o => o.value).find(v => v !== '');
                  };
                  pick('set-defaultEpSelect', firstReal('set-defaultEpSelect'));
                  pick('set-utilityEpSelect', firstReal('set-utilityEpSelect'));
                  pick('set-researchEndpoint', firstReal('set-researchEndpoint'));
                  // TTS: endpoint mode is the pool-fed path (markup options are
                  // only the no-data fallback).
                  pick('set-ttsProviderSelect', 'endpoint:' + liveId);
                }"""
            page.evaluate(pick_js, live_id)
            page.wait_for_function(
                "document.getElementById('set-defaultModelSelect').options.length > 0",
                timeout=5000,
            )
            # Wait for the TTS model select to actually reflect the live endpoint's
            # TTS-capable model (the pool path) instead of the OpenAI markup
            # fallback — re-applying the pick if a trailing initTtsSettings() await
            # clobbered the provider in the gap. Replaces the old fixed 300ms
            # sleep, which raced the TTS chain's second (auth-settings) await on a
            # slow CI runner.
            tts_deadline = time.monotonic() + 10
            tts_vals = None
            while time.monotonic() < tts_deadline:
                tts_vals = page.evaluate(
                    "() => [...document.getElementById('set-ttsModelSelect').options].map(o => o.value)"
                )
                if set(tts_vals) == {"h2b-tts-model"}:
                    break
                page.evaluate(pick_js, live_id)  # idempotent re-pick beats a late clobber
                page.wait_for_timeout(150)
            else:
                raise AssertionError(
                    "TTS model select never settled on the live endpoint's pool model "
                    f"(last saw {tts_vals}) — initTtsSettings did not converge"
                )

            opts = page.evaluate(
                """() => {
                  const read = (id) => [...document.getElementById(id).options]
                    .map(o => ({ value: o.value, label: o.textContent }));
                  return {
                    chat: read('set-defaultModelSelect'),
                    utility: read('set-utilityModelSelect'),
                    vision: read('set-vlModelSelect'),
                    research: read('set-researchModel'),
                    img: read('set-imgModelSelect'),
                    tts: read('set-ttsModelSelect'),
                  };
                }"""
            )
            browser.close()

        pool = {o["value"] for o in opts["chat"]} - {""}
        assert pool == {"h2b-alpha-model", "h2b-beta-model", "h2b-tts-model", "h2b-dall-e-3"}, (
            f"the chat pool must be the live endpoint's models, got {pool}"
        )

        for name in ("utility", "vision", "research", "img", "tts"):
            values = {o["value"] for o in opts[name]}
            nonblank = values - {""}
            assert nonblank, f"the {name} model select must be populated from the pool ({opts[name]})"
            assert nonblank <= pool, (
                f"the {name} options must be a subset of the chat pool ({nonblank} vs {pool})"
            )
            assert "h2b-ghost-model" not in values, (
                f"a disabled endpoint's models must not be offered in the {name} select"
            )
            assert all("not detected" not in o["label"] for o in opts[name]), (
                f"no synthetic hardcoded entries in the {name} select"
            )

        # The research straggler specifically: scoped to the live endpoint it
        # offers exactly its models.
        assert {o["value"] for o in opts["research"]} - {""} == pool
        # Vision applies its capability filter (a narrowing of the pool only —
        # the tts-flavored AND dall-e models are excluded, nothing is added).
        assert {o["value"] for o in opts["vision"]} - {""} == {"h2b-alpha-model", "h2b-beta-model"}
        # G21: the Image select applies its OWN capability filter — only the
        # image-capable model is offered, the chat/tts models excluded.
        assert {o["value"] for o in opts["img"]} - {""} == {"h2b-dall-e-3"}
        # TTS endpoint mode offers the endpoint's TTS-capable models, not the
        # markup fallback.
        assert {o["value"] for o in opts["tts"]} == {"h2b-tts-model"}
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
