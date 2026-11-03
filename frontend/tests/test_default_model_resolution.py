"""The assumed/OOB default models resolve correctly.

Two bugs/specs covered:

  Bug 2 (chat default): the chat picker used to auto-pick `items[0].models[0]`
  — an arbitrary first-sorted model ("fugu") — IGNORING the configured default.
  The owner ALWAYS wants the OOB default chat model to be the narrator tier on
  the OpenRouter endpoint (z-ai/glm-4.7 — ADR 0016; the 2026-07-07/09 glm-5.2
  two-tier retarget was reverted for the shipped default by the 2026-07-13
  owner ruling). The picker now resolves the auto-pick via
  `_resolveDefaultPick(items)`, which PREFERS the server-resolved configured
  default (cached on `window.__orwellDefaultChat`, out-of-box glm-4.7)
  over the first-listed model, and NEVER picks an image model. An explicit user
  selection clears the auto-pick marker, so the configured default never
  overrides a real choice (only the unset/auto case resolves to the default).

  Image default: the OOB image model is gemini-3.1-flash-image. That lives in
  DEFAULT_SETTINGS["image_model"]; when blank ("Auto-detect") it resolves via
  IMAGE_AUTODETECT_CANDIDATES, which leads with gemini-3.1-flash-image. An
  explicit image_model is honored as-is.

Mechanism for "explicit choice still wins": the configured-default preference
only fires when the picker has NO model selected (auto-pick path), and an
explicit pick sets `_autoPickedMid = null` so the late-default correction is
skipped. The backend `/api/default-chat` reads the user's saved
default_model/default_endpoint_id first and only falls through to the OOB
default when unset.
"""

import json
import os
import re
import shutil
import subprocess
import tempfile

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel):
    with open(os.path.join(FRONTEND, rel), encoding="utf-8") as f:
        return f.read()


# ── OOB defaults live in DEFAULT_SETTINGS (the assumed defaults) ────────────────


def test_oob_default_chat_model_is_deepseek_flash():
    # OWNER RULING 2026-07-13 (live prod debug-bundle audit): the OOB narrator/chat model is the
    # ADR 0016 GLM-4.7 tier (the 2026-07-07/09 glm-5.2 retarget is reverted). The golden fixture is
    # ALSO recorded on glm-4.7 now (owner ruling 2026-07-14 — the gate tests what prod runs).
    from src.settings import DEFAULT_SETTINGS
    # PO RULING 2026-11-02: DeepSeek's own API (`deepseek-flash`) is the new-install default; the
    # OpenRouter glm-4.7 default above is superseded (OpenRouter stays selectable, saved stores keep theirs).
    assert DEFAULT_SETTINGS["default_model"] == "deepseek-flash", (
        "the assumed default chat model must be deepseek-flash (DeepSeek's own API)"
    )


def test_oob_default_image_model_is_gemini_flash_image():
    from src.settings import DEFAULT_SETTINGS
    assert DEFAULT_SETTINGS["image_model"] == "google/gemini-3.1-flash-image", (
        "the assumed default image model must be gemini-3.1-flash-image"
    )


def test_image_autodetect_leads_with_gemini_flash_image():
    """When image_model is blank (Auto-detect), the first candidate tried is
    gemini-3.1-flash-image — so the assumed default holds even unset."""
    from src.ai_interaction import IMAGE_AUTODETECT_CANDIDATES
    assert IMAGE_AUTODETECT_CANDIDATES[0] == "google/gemini-3.1-flash-image", (
        "the image auto-detect default must lead with gemini-3.1-flash-image"
    )


def test_oob_default_utility_model_is_deepseek_flash():
    """ADR 0016 as amended (2026-07-07/09 two-tier retarget; corrected 2026-07-21) — the OOB utility
    model (background JSON: cast authoring/prewarm/zeitgeist, summarization, naming) is a cheap, fast
    Qwen 3.6 tier on OpenRouter. OWNER RULING 2026-07-21 (live prod debug bundle): the previously
    shipped `qwen/qwen3.6-flash` slug is NOT served on OpenRouter — every OOB utility/faithfulness
    call fell through to an arbitrary first-enabled model and hung casting-finalize — so the default
    is the SERVED `qwen/qwen3.6-27b`. It is its OWN key (utility_model), so it does NOT inherit the
    narrator swap."""
    from src.settings import DEFAULT_SETTINGS
    assert DEFAULT_SETTINGS["utility_model"] == "deepseek-flash", (
        "the assumed default utility model must be deepseek-flash (DeepSeek's own API, PO 2026-11-02)"
    )


# ── source pins: the picker honors the configured default, not first-listed ─────


def test_picker_resolves_configured_default_not_arbitrary_first():
    js = _read("static/js/modelPicker.js")
    # The auto-pick no longer reaches for items[0].models[0]; it goes through the
    # configured-default resolver.
    assert "_resolveDefaultPick(" in js, (
        "the picker auto-pick must resolve via _resolveDefaultPick (the configured-"
        "default-preferring resolver), not an arbitrary first-listed model"
    )
    assert "__orwellDefaultChat" in js, (
        "_resolveDefaultPick must consult the server-resolved configured default "
        "(window.__orwellDefaultChat)"
    )
    # The arbitrary `models[0]` / `first.models[0]` auto-pick is gone.
    assert "modelId = models[0]" not in js and "modelId = first.models[0]" not in js, (
        "the picker must not auto-pick the first-listed model ('fugu' bug)"
    )


def test_picker_default_pick_never_an_image_or_nonchat_model():
    js = _read("static/js/modelPicker.js")
    # The floor filters via the composed chat-capability check, which excludes BOTH image models
    # AND non-image non-chat models (embeddings / tts / rerank / …) — the client mirror of the
    # server's `_NON_CHAT_MODEL` rule.
    assert "_firstChatPick" in js, "the auto-pick floor must exist (_firstChatPick)"
    fn_start = js.index("function _firstChatPick(")
    fn = js[fn_start:fn_start + 600]
    assert "_isChatCapableModelId(mid)" in fn, \
        "the auto-pick floor must filter by chat-capability (not just image models)"
    # The capability predicate composes both exclusions.
    cap_start = js.index("function _isChatCapableModelId(")
    cap = js[cap_start:cap_start + 400]
    assert "_isImageModelId(mid)" in cap and "_isNonChatModelId(mid)" in cap, \
        "chat-capability must exclude BOTH image and non-chat (embedding/tts/rerank/…) models"


def test_explicit_pick_clears_auto_marker():
    """An explicit user pick clears `_autoPickedMid`, so the late-arriving
    configured default cannot override the user's choice."""
    js = _read("static/js/modelPicker.js")
    pick_start = js.index("async function _pick(")
    pick = js[pick_start:pick_start + 400]
    assert "_autoPickedMid = null" in pick, (
        "an explicit _pick must clear the auto-pick marker so a configured default "
        "never overrides an explicit selection"
    )


# ── behavioral: _resolveDefaultPick prefers glm-5.2 over first-listed ───


def _slice_fns(js):
    """Pull the module-level helpers the resolver harness needs (in dependency order:
    `_firstChatPick` now calls `_isChatCapableModelId` → `_isNonChatModelId`/`_isImageModelId`)."""
    out = []
    for name in ("_isImageModelId", "_isNonChatModelId", "_isChatCapableModelId",
                 "_firstChatPick", "_resolveDefaultPick"):
        start = js.index(f"function {name}(")
        end = js.index("\n}\n", start) + len("\n}\n")
        out.append(js[start:end])
    return "\n".join(out)


def _run_resolver(items, default_chat):
    js = _read("static/js/modelPicker.js")
    harness = (
        "const ITEMS = " + json.dumps(items) + ";\n"
        "const window = { __orwellDefaultChat: " + json.dumps(default_chat) + " };\n"
        + _slice_fns(js) +
        "\nconst pick = _resolveDefaultPick(ITEMS);\n"
        "console.log(JSON.stringify(pick));\n"
    )
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(harness)
        path = f.name
    try:
        res = subprocess.run(["node", path], capture_output=True, text=True, timeout=20)
    finally:
        os.unlink(path)
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout.strip().splitlines()[-1])


# A catalog where "fugu" sorts/lists FIRST but glm-5.2 is the configured
# default served by the OpenRouter endpoint.
_ITEMS = [
    {"endpoint_id": "misc", "endpoint_name": "Misc", "url": "http://m/v1",
     "models": ["fugu/fugu-1", "google/gemini-2.5-flash-image"]},
    {"endpoint_id": "or", "endpoint_name": "OpenRouter", "url": "http://or/v1",
     "models": ["z-ai/glm-5.2", "openai/gpt-4o"]},
]


def test_resolver_prefers_configured_glm_over_first_listed():
    if shutil.which("node") is None:
        pytest.skip("node not available")
    pick = _run_resolver(_ITEMS, {"model": "z-ai/glm-5.2", "endpoint_id": "or"})
    assert pick and pick["mid"] == "z-ai/glm-5.2", (
        f"expected the configured default glm-5.2, got {pick}"
    )
    assert pick["endpointId"] == "or", "must bind to the OpenRouter endpoint that serves it"


def test_resolver_falls_back_to_first_chat_when_no_default_configured():
    if shutil.which("node") is None:
        pytest.skip("node not available")
    # No configured default → first NON-IMAGE model (never the image model).
    pick = _run_resolver(_ITEMS, None)
    assert pick and pick["mid"] == "fugu/fugu-1", (
        f"with no configured default, fall back to the first CHAT model, got {pick}"
    )


def test_resolver_never_returns_image_model_even_when_default_is_image():
    if shutil.which("node") is None:
        pytest.skip("node not available")
    # A corrupted default pointing at an image model must not be honored; the
    # floor returns the first chat model instead.
    pick = _run_resolver(_ITEMS, {"model": "google/gemini-2.5-flash-image", "endpoint_id": "misc"})
    assert pick and pick["mid"] != "google/gemini-2.5-flash-image", (
        f"the resolver must never hand back an image model as the chat default, got {pick}"
    )


def test_first_chat_pick_skips_a_leading_embedding_model():
    """CodeRabbit (Minor): the CLIENT auto-pick floor must skip NON-CHAT models (embeddings /
    tts / rerank), not just image models — mirroring the server's `_NON_CHAT_MODEL` gap that was
    just closed. An endpoint that lists an embedding BEFORE a real chat model must auto-select the
    CHAT model, never the embedding (which can only 400 a chat completion)."""
    if shutil.which("node") is None:
        pytest.skip("node not available")
    items = [
        {"endpoint_id": "or", "endpoint_name": "OpenRouter", "url": "http://or/v1",
         "models": ["text-embedding-3-large", "tts-1", "z-ai/glm-4.7"]},
    ]
    pick = _run_resolver(items, None)  # no configured default → the first-chat floor
    assert pick and pick["mid"] == "z-ai/glm-4.7", (
        f"the client floor must skip the embedding/tts and land on the chat model, got {pick}"
    )


def test_first_chat_pick_returns_null_for_an_all_nonchat_endpoint():
    """An endpoint that serves ONLY non-chat models (embeddings + tts + image) yields no
    auto-pick — the picker resolves nothing rather than a chat-incapable model."""
    if shutil.which("node") is None:
        pytest.skip("node not available")
    items = [
        {"endpoint_id": "emb", "endpoint_name": "Embeddings", "url": "http://e/v1",
         "models": ["text-embedding-3-large", "tts-1", "google/gemini-3.1-flash-image"]},
    ]
    pick = _run_resolver(items, None)
    assert pick is None, f"an all-non-chat endpoint must yield no auto-pick, got {pick}"


def test_resolver_trusts_configured_default_on_an_empty_stale_catalog():
    """2026-07-13 (the arbitrary-default class, mirroring the server's #1550/#1551 ruling): a
    fresh box whose endpoint hasn't cached its model list yet must NOT kick the configured
    default over to the first-listed model of some other endpoint — when the default's own
    endpoint is present and online, the configured default stands."""
    if shutil.which("node") is None:
        pytest.skip("node not available")
    items = [
        {"endpoint_id": "misc", "endpoint_name": "Misc", "url": "http://m/v1",
         "models": ["fugu/fugu-1"]},
        # The default's own endpoint is present but its catalog is EMPTY (unprobed cache).
        {"endpoint_id": "or", "endpoint_name": "OpenRouter", "url": "http://or/v1",
         "models": []},
    ]
    pick = _run_resolver(items, {"model": "z-ai/glm-4.7", "endpoint_id": "or"})
    assert pick and pick["mid"] == "z-ai/glm-4.7", (
        f"an empty/stale catalog must not swap the configured default, got {pick}"
    )
    assert pick["endpointId"] == "or"


def test_resolver_still_falls_back_when_the_defaults_endpoint_is_gone():
    """The original guard stands: a stale default whose ENDPOINT no longer exists must not
    pin a dead model — the first-chat floor applies."""
    if shutil.which("node") is None:
        pytest.skip("node not available")
    items = [
        {"endpoint_id": "misc", "endpoint_name": "Misc", "url": "http://m/v1",
         "models": ["fugu/fugu-1"]},
    ]
    pick = _run_resolver(items, {"model": "z-ai/glm-4.7", "endpoint_id": "gone-ep"})
    assert pick and pick["mid"] == "fugu/fugu-1"


def test_resolver_falls_back_when_default_endpoint_catalog_excludes_the_model():
    """Greptile P1 (2026-07-13): the default's OWN endpoint is present + online but its NON-EMPTY
    visible catalog EXCLUDES dc.model (a stale/renamed default the provider no longer offers). The
    picker must NOT auto-select the unofferable model — it falls to the first-chat floor. (An
    EMPTY/unprobed catalog still honors the default — pinned by the sibling test above.)"""
    if shutil.which("node") is None:
        pytest.skip("node not available")
    items = [
        # The default's own endpoint, online, NON-EMPTY catalog that does NOT contain glm-4.7.
        {"endpoint_id": "or", "endpoint_name": "OpenRouter", "url": "http://or/v1",
         "models": ["deepseek/deepseek-v4-pro", "openai/gpt-4o"]},
    ]
    pick = _run_resolver(items, {"model": "z-ai/glm-4.7", "endpoint_id": "or"})
    assert pick and pick["mid"] == "deepseek/deepseek-v4-pro", (
        f"a non-empty catalog excluding the default must fall to the first chat model, got {pick}"
    )
    assert pick["endpointId"] == "or"


def test_resolver_falls_back_when_default_endpoint_catalog_excludes_it_across_endpoints():
    """Same Greptile case with a second endpoint present: still no online catalog serves glm-4.7,
    and the default's own endpoint has a non-empty excluding catalog ⇒ first-chat floor, never the
    unofferable configured default."""
    if shutil.which("node") is None:
        pytest.skip("node not available")
    items = [
        {"endpoint_id": "misc", "endpoint_name": "Misc", "url": "http://m/v1",
         "models": ["fugu/fugu-1"]},
        {"endpoint_id": "or", "endpoint_name": "OpenRouter", "url": "http://or/v1",
         "models": ["openai/gpt-4o"]},  # non-empty, excludes glm-4.7
    ]
    pick = _run_resolver(items, {"model": "z-ai/glm-4.7", "endpoint_id": "or"})
    assert pick and pick["mid"] != "z-ai/glm-4.7", (
        f"must never pin the unofferable configured default, got {pick}"
    )
    assert pick["mid"] == "fugu/fugu-1"  # the first-chat floor across items


# ── #860: a factory/OOBE reset RESETS model selections to the OOB defaults ──────
#
# Root cause of #860: the reset preserved the previously-SELECTED models, so a stale placeholder
# (sakana/fugu-ultra) the owner once had selected was faithfully re-kept across every reset — a
# circular trap (Settings was locked, #870, so they couldn't change it either). The fix: a reset
# keeps only the API key(s) + endpoint and RESETS the model selections, so they revert to the OOB
# defaults (glm-4.7 narrator, gemini-3.1-flash-image portraits). A real served selection
# is also reset by design (owner ruling) — the defaults are what the owner wants post-reset.


def _load_oobe_helper(monkeypatch, tmp_path):
    import importlib.util
    helper = os.path.join(FRONTEND, "scripts", "oobe_reset.py")
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'app.db'}")
    spec = importlib.util.spec_from_file_location("oobe_reset_860", helper)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_reset_drops_stale_model_selection_so_defaults_stand(monkeypatch, tmp_path):
    """A reset whose prior settings.json had a stale default_model=sakana/fugu-ultra (+ any
    portrait pick) must NOT carry those across — they reset, so the merge over DEFAULT_SETTINGS
    restores glm-4.7 / gemini-3.1-flash-image."""
    mod = _load_oobe_helper(monkeypatch, tmp_path)
    setp = tmp_path / "settings.json"
    setp.write_text(json.dumps({
        "default_endpoint_id": "ep-or",
        "default_model": "sakana/fugu-ultra",      # the stale placeholder that was stuck
        "image_endpoint_id": "ep-or",
        "image_model": "some/old-portrait-model",
        "image_gen_enabled": True,                  # operational flag → kept
        "theme": "midnight",                        # unrelated → dropped
    }))
    preserved = mod.export_preserved_settings(str(setp))

    # The model SELECTIONS are NOT preserved (they reset to defaults on load). NOTE
    # (2026-07-12): the default-ENDPOINT designation (`default_endpoint_id`) is now carried
    # separately by reset_frontend_store/preserved_default_designation — validated against the
    # surviving endpoint rows — so it is deliberately absent from THIS operational-flags export.
    for reset_key in ("default_endpoint_id", "default_model", "image_endpoint_id", "image_model"):
        assert reset_key not in preserved, f"{reset_key} must not ride via the flags export"
    assert "sakana/fugu-ultra" not in json.dumps(preserved)
    # Operational flags survive; unrelated settings are dropped.
    assert preserved.get("image_gen_enabled") is True
    assert "theme" not in preserved

    # The effective post-reset values are the OOB defaults (merge over DEFAULT_SETTINGS).
    from src.settings import DEFAULT_SETTINGS
    effective = {**DEFAULT_SETTINGS, **preserved}
    assert effective["default_model"] == "deepseek-flash"
    assert effective["image_model"] == "google/gemini-3.1-flash-image"


def test_reset_resets_even_a_valid_served_selection_to_defaults(monkeypatch, tmp_path):
    """Per the owner ruling, a reset resets model selections to the defaults regardless — even a
    perfectly valid prior pick. Only the API key + endpoint record (carried separately) survive."""
    mod = _load_oobe_helper(monkeypatch, tmp_path)
    setp = tmp_path / "settings.json"
    setp.write_text(json.dumps({
        "default_model": "deepseek/deepseek-v3.1",  # a real, valid earlier pick
        "image_model": "google/gemini-2.0-flash-image",
    }))
    preserved = mod.export_preserved_settings(str(setp))
    assert "default_model" not in preserved and "image_model" not in preserved

    from src.settings import DEFAULT_SETTINGS
    effective = {**DEFAULT_SETTINGS, **preserved}
    assert effective["default_model"] == "deepseek-flash"
    assert effective["image_model"] == "google/gemini-3.1-flash-image"


def test_no_sakana_fugu_seed_anywhere_in_frontend_source():
    """Belt-and-braces: sakana/fugu-ultra must never appear as a seed/default VALUE in FE source —
    only as test/fixture/comment material. Guards against a build re-planting the placeholder."""
    import subprocess
    res = subprocess.run(
        ["grep", "-rn", "sakana/fugu-ultra", os.path.join(FRONTEND, "src"),
         os.path.join(FRONTEND, "scripts"), os.path.join(FRONTEND, "routes")],
        capture_output=True, text=True,
    )
    # grep exit 1 == no matches. Any hit must be a COMMENT (documenting the #860 fix), never a
    # value/assignment — a planted seed would be a non-comment line.
    code_hits = []
    for line in res.stdout.splitlines():
        # "path:lineno:content" — inspect the content after the second colon.
        parts = line.split(":", 2)
        content = parts[2] if len(parts) == 3 else line
        if content.lstrip().startswith("#"):
            continue  # a comment mention is fine
        code_hits.append(line)
    assert not code_hits, f"sakana/fugu-ultra must not be a seed/value in FE source, found:\n" + "\n".join(code_hits)
