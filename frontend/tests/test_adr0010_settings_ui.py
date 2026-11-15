"""ADR 0010 / feature 0069 — the Token Economy admin settings UI is wired.

Source-pins (matching test_s1s2_settings_wiring.py's convention): the controls exist in index.html,
`initTokenEconomySettings` reads/writes `/api/auth/settings` for every token-economy key, the per-class
`reasoning_budget` dict is rebuilt from the four selects, and the OpenRouter provider JSON is validated
before save. The POST /settings route already persists these DEFAULT_SETTINGS keys
(test_adr0010_admin_token_economy.py covers the route + the keys).
"""
import os

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(rel):
    with open(os.path.join(FRONTEND, rel), encoding="utf-8") as f:
        return f.read()


def test_controls_exist_in_index_html():
    html = _read("static/index.html")
    for cid in (
        "set-reasoningNarration", "set-reasoningExtract", "set-reasoningCasting",
        "set-reasoningAuthoring", "set-tokenSpendAlert", "set-tokenPinThreshold",
        "set-contextTieringToggle", "set-openrouterProvider", "set-tokenEconomyMsg",
    ):
        assert f'id="{cid}"' in html, f"missing Token Economy control: {cid}"
    assert "Token Economy" in html


def test_init_is_defined_and_registered():
    js = _read("static/js/settings.js")
    assert "async function initTokenEconomySettings" in js, "the init function must exist"
    assert "initTokenEconomySettings();" in js, "the init must be called in the settings bootstrap"


def test_init_reads_and_writes_every_token_economy_key():
    js = _read("static/js/settings.js")
    start = js.index("async function initTokenEconomySettings")
    block = js[start:]
    end = block.index("/* ── Vision ── */")
    block = block[:end]
    for key in (
        "reasoning_budget", "token_spend_alert_usd", "token_pin_threshold_tokens",
        "context_tiering_enabled", "openrouter_provider",
    ):
        assert key in block, f"the init must read/write {key}"
    assert "/api/auth/settings" in block, "must use the settings route the rest of the UI uses"
    # the four call classes drive the reasoning_budget dict
    for cls in ("narration", "utility-extraction", "casting", "background-authoring"):
        assert f"'{cls}'" in block, f"reasoning_budget must map the {cls} class"
    # the provider field is parsed + object-validated before saving (no garbage to the API)
    assert "JSON.parse" in block, "provider JSON must be parsed"
    assert "Array.isArray" in block, "provider must be validated as an object (not a list)"


def test_keys_present_in_default_settings():
    from src.settings import DEFAULT_SETTINGS
    assert DEFAULT_SETTINGS["reasoning_budget"] == {
        # narration "off" (owner ruling 2026-07-13, perf audit F-PY-1): the "low"/"medium" effort levels
        # are INERT on OpenRouter (llm_core drops effort, sends the computed sub-budget) so the model
        # still bursts ~4096 pre-token reasoning ("it hangs then streams"). Only "off" resolves to an
        # active reasoning:{enabled:false} that STOPS the burst. Supersedes the ADR-0016 "low" seed.
        "narration": "off", "utility-extraction": "off",
        # #1007: background-authoring is "off" — structured JSON extraction, not a reasoning task.
        # casting "off" (2026-07-14): on GLM-4.7 the reasoning-effort knob is inert, so the old
        # "medium" only front-loaded the burst that HANGS casting (prod + golden-record). off is
        # tool-safe (createCharacter is force-called).
        "casting": "off", "background-authoring": "off",
    }
    # Hard pin to Novita, no fallback (owner ruling 2026-07-14): all four call classes run reasoning
    # "off", and a direct probe proved StreamLake ignores reasoning-off and bursts — hanging live
    # turns. Novita honored reasoning-off 0/5, fp8, so it is the pinned provider. allow_fallbacks:false
    # so OpenRouter can never route a game turn to a burst-prone sub-provider.
    assert DEFAULT_SETTINGS["openrouter_provider"] == {"only": ["novita"], "allow_fallbacks": False}
    assert DEFAULT_SETTINGS["token_spend_alert_usd"] == 0.0
    assert DEFAULT_SETTINGS["token_pin_threshold_tokens"] == 0
    assert DEFAULT_SETTINGS["context_tiering_enabled"] is True


def test_narrator_reasoning_control_surfaced_in_default_chat_model_card():
    """ADR 0016 — the narrator's reasoning effort is editable in the Default Chat Model card (not
    only buried in Token Economy). The control is the same setting (reasoning_budget.narration),
    synced in lockstep with the Token Economy 'Narration' select."""
    html = _read("static/index.html")
    assert 'id="set-narratorReasoning"' in html, "the Default Chat Model card must expose a reasoning select"
    # ordering: it sits in the Default Chat Model card (after the model select) and BEFORE the
    # Token Economy 'Narration' select further down the page.
    i_model = html.index('id="set-defaultModelSelect"')
    i_reason = html.index('id="set-narratorReasoning"')
    i_econ = html.index('id="set-reasoningNarration"')
    assert i_model < i_reason < i_econ, "the narrator reasoning select must live in the Default Chat Model card"

    js = _read("static/js/settings.js")
    start = js.index("async function initTokenEconomySettings")
    block = js[start:]
    block = block[: block.index("/* ── Vision ── */")]
    assert "set-narratorReasoning" in block, "settings.js must wire the narrator reasoning select"
    # kept in sync with the canonical Token Economy 'Narration' select (mirrors into set-reasoningNarration)
    assert "set-reasoningNarration" in block
