"""DeepSeek's own API is the new-install default (PO ruling 2026-11-02) — roles only, no live calls.

Pins: the OOB model defaults; thinking-disabled on the DeepSeek host (the reasoning_content 400 in tool
loops); the forced `required` rung staying GLM-only; the env-key first-boot endpoint seed (idempotent,
never touches existing endpoints or saved settings, key encrypted at rest); a DeepSeek-only install
skipping portraits silently; and the curated model list. OpenRouter must stay selectable and byte-identical.
"""
import importlib
import json
import os
import sqlite3

import pytest

settings_mod = importlib.import_module("src.settings")
llm_core = importlib.import_module("src.llm_core")
seed_mod = importlib.import_module("src.deepseek_seed")

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _clear_endpoints():
    from core.database import SessionLocal, ModelEndpoint
    db = SessionLocal()
    try:
        db.query(ModelEndpoint).delete()
        db.commit()
    finally:
        db.close()


def _rows():
    from core.database import SessionLocal, ModelEndpoint
    db = SessionLocal()
    try:
        return db.query(ModelEndpoint).all()
    finally:
        db.close()


@pytest.fixture(autouse=True)
def _isolation(monkeypatch, tmp_path):
    _clear_endpoints()
    monkeypatch.setattr(settings_mod, "SETTINGS_FILE", str(tmp_path / "settings.json"))
    settings_mod._invalidate_caches()
    yield
    _clear_endpoints()
    settings_mod._invalidate_caches()


# ── defaults ─────────────────────────────────────────────────────────────────────────────

def test_oob_defaults_are_deepseek_flash_and_portrait_stays_openrouter():
    d = settings_mod.DEFAULT_SETTINGS
    assert d["default_model"] == "deepseek-flash"
    assert d["utility_model"] == "deepseek-flash"
    assert d["image_model"] == "google/gemini-3.1-flash-image"  # PO (c): unchanged


def test_curated_deepseek_list_has_no_stale_legacy_names():
    src = open(os.path.join(FRONTEND, "routes", "model_routes.py"), encoding="utf-8").read()
    block = src[src.index('"deepseek": ['):][:200]
    assert "deepseek-flash" in block and "deepseek-v4-pro" in block
    assert "deepseek-chat" not in block and "deepseek-reasoner" not in block


def test_picker_and_webhook_use_the_canonical_deepseek_base():
    for rel in ("static/index.html", "static/js/slashCommands.js", "routes/webhook_routes.py"):
        text = open(os.path.join(FRONTEND, rel), encoding="utf-8").read()
        assert "api.deepseek.com/v1" not in text, rel
        assert "https://api.deepseek.com" in text, rel  # the canonical base is actually present
    from src.endpoint_resolver import build_chat_url
    assert build_chat_url("https://api.deepseek.com") == "https://api.deepseek.com/chat/completions"


# ── thinking-off + forced tool_choice ────────────────────────────────────────────────────

@pytest.mark.parametrize("url", ["https://api.deepseek.com", "https://api.deepseek.com/chat/completions"])
def test_thinking_is_disabled_on_the_deepseek_host(url):
    payload = {"model": "deepseek-flash", "reasoning": {"enabled": False}, "reasoning_effort": "low"}
    llm_core._apply_deepseek_thinking_off(payload, url, "deepseek-flash")
    assert payload["thinking"] == {"type": "disabled"}
    assert "reasoning" not in payload and "reasoning_effort" not in payload


def test_thinking_field_never_added_elsewhere():
    for url, model in (("https://openrouter.ai/api/v1", "deepseek/deepseek-v4-pro"),
                       ("https://openrouter.ai/api/v1", "z-ai/glm-4.7"),
                       ("https://api.deepseek.com", "deepseek-reasoner")):
        payload = {"model": model, "reasoning": {"enabled": False}}
        llm_core._apply_deepseek_thinking_off(payload, url, model)
        assert "thinking" not in payload and payload["reasoning"] == {"enabled": False}


def test_forced_required_rung_is_a_known_rejecter_denylist():
    """The gate is a DENYLIST of known `tool_choice` rejecters (not a GLM allow-list): every DeepSeek
    thinking-family id is blocked, while any non-listed model (GLM, an OpenAI model) still honors it."""
    al = importlib.import_module("src.agent_loop")
    for rejecter in ("deepseek-flash", "deepseek-v4-pro", "deepseek/deepseek-v4-pro",
                     "deepseek-reasoner", "deepseek-r1"):
        assert al._model_honors_forced_tool_choice(rejecter) is False, rejecter
    for honoring in ("z-ai/glm-4.7", "openai/gpt-4o"):
        assert al._model_honors_forced_tool_choice(honoring) is True, honoring


def test_sync_llm_call_also_sends_thinking_disabled(monkeypatch):
    captured = {}

    class _Resp:
        is_success = True
        def json(self):
            return {"choices": [{"message": {"role": "assistant", "content": "ok"}}]}

    def _post(url, headers=None, json=None, timeout=None):
        captured["url"], captured["payload"] = url, json
        return _Resp()

    monkeypatch.setattr(llm_core.httpx, "post", _post)
    llm_core.llm_call("https://api.deepseek.com", "deepseek-flash",
                      [{"role": "user", "content": "hi unique-sync-probe"}], max_tokens=16)
    assert captured["url"] == "https://api.deepseek.com/chat/completions"
    assert captured["payload"]["thinking"] == {"type": "disabled"}


def test_bare_deepseek_root_gets_the_chat_path_but_other_urls_do_not():
    f = llm_core._ensure_openai_chat_path
    assert f("https://api.deepseek.com") == "https://api.deepseek.com/chat/completions"
    assert f("https://api.deepseek.com/") == "https://api.deepseek.com/chat/completions"
    assert f("https://api.deepseek.com/chat/completions") == "https://api.deepseek.com/chat/completions"
    assert f("https://api.deepseek.com/anthropic") == "https://api.deepseek.com/anthropic"  # untouched
    assert f("https://example.com") == "https://example.com"


# ── env-key first-boot seed ──────────────────────────────────────────────────────────────

def _saved():
    try:
        return json.load(open(settings_mod.SETTINGS_FILE))
    except FileNotFoundError:
        return None


def test_seed_noop_without_a_key():
    assert seed_mod.seed_deepseek_endpoint_from_env({}) is None
    assert seed_mod.seed_deepseek_endpoint_from_env({"DEEPSEEK_API_KEY": "  "}) is None
    assert _rows() == [] and _saved() is None


def test_seed_creates_one_shared_endpoint_and_binds_only_the_default_endpoint():
    ep_id = seed_mod.seed_deepseek_endpoint_from_env({"DEEPSEEK_API_KEY": "sk-test-seed"})
    rows = _rows()
    assert len(rows) == 1 and rows[0].id == ep_id
    ep = rows[0]
    assert ep.base_url == "https://api.deepseek.com" and ep.owner is None and ep.is_enabled
    assert ep.api_key == "sk-test-seed"  # decrypts through the existing EncryptedText path
    assert json.loads(ep.pinned_models) == ["deepseek-flash"]
    # ONLY the designation is persisted — model defaults stay unsaved so they can't go stale.
    assert _saved() == {"default_endpoint_id": ep_id}


def test_seed_encrypts_the_key_at_rest():
    from core.database import engine
    seed_mod.seed_deepseek_endpoint_from_env({"DEEPSEEK_API_KEY": "sk-test-at-rest"})
    with engine.connect() as conn:
        raw = conn.exec_driver_sql("SELECT api_key FROM model_endpoints").scalar()
    assert raw and "sk-test-at-rest" not in raw


def test_seed_is_idempotent_and_never_touches_existing_endpoints():
    from core.database import SessionLocal, ModelEndpoint
    first = seed_mod.seed_deepseek_endpoint_from_env({"DEEPSEEK_API_KEY": "sk-a"})
    assert seed_mod.seed_deepseek_endpoint_from_env({"DEEPSEEK_API_KEY": "sk-b"}) is None
    assert [r.id for r in _rows()] == [first]

    _clear_endpoints()
    db = SessionLocal()
    try:
        db.add(ModelEndpoint(id="or-1", name="OpenRouter", base_url="https://openrouter.ai/api/v1",
                             api_key="sk-or", is_enabled=True, model_type="llm"))
        db.commit()
    finally:
        db.close()
    assert seed_mod.seed_deepseek_endpoint_from_env({"DEEPSEEK_API_KEY": "sk-c"}) is None
    rows = _rows()
    assert [r.id for r in rows] == ["or-1"] and rows[0].api_key == "sk-or"


def test_seed_never_overwrites_a_saved_default_endpoint_or_other_settings(tmp_path):
    with open(settings_mod.SETTINGS_FILE, "w") as f:
        json.dump({"default_endpoint_id": "keep-me", "default_model": "z-ai/glm-4.7"}, f)
    settings_mod._invalidate_caches()
    seed_mod.seed_deepseek_endpoint_from_env({"DEEPSEEK_API_KEY": "sk-d"})
    assert _saved() == {"default_endpoint_id": "keep-me", "default_model": "z-ai/glm-4.7"}


# ── portraits fail soft on a DeepSeek-only install ───────────────────────────────────────

def test_deepseek_only_install_has_no_image_capable_endpoint():
    from src.ai_interaction import has_image_capable_endpoint
    seed_mod.seed_deepseek_endpoint_from_env({"DEEPSEEK_API_KEY": "sk-e"})
    assert has_image_capable_endpoint(None) is False


def test_openrouter_endpoint_still_counts_as_image_capable():
    from core.database import SessionLocal, ModelEndpoint
    from src.ai_interaction import has_image_capable_endpoint
    seed_mod.seed_deepseek_endpoint_from_env({"DEEPSEEK_API_KEY": "sk-f"})
    db = SessionLocal()
    try:
        db.add(ModelEndpoint(id="or-2", name="OpenRouter", base_url="https://openrouter.ai/api/v1",
                             api_key="sk-or", is_enabled=True, model_type="llm"))
        db.commit()
    finally:
        db.close()
    assert has_image_capable_endpoint(None) is True


# ── review hardening: recoverable + race-safe seed, existing installs keep their models ───

def test_seed_recovers_a_partial_boot_that_never_bound_the_default():
    from core.database import SessionLocal, ModelEndpoint
    db = SessionLocal()
    try:  # the prior boot committed the endpoint, then died before writing the default designation
        db.add(ModelEndpoint(id="seeded1", name="DeepSeek", base_url="https://api.deepseek.com",
                             api_key="sk-x", is_enabled=True, model_type="llm", owner=None))
        db.commit()
    finally:
        db.close()
    assert _saved() is None
    assert seed_mod.seed_deepseek_endpoint_from_env({"DEEPSEEK_API_KEY": "sk-y"}) == "seeded1"
    assert _saved() == {"default_endpoint_id": "seeded1"}
    assert _rows()[0].api_key == "sk-x"  # recovery re-binds only; the stored key is never rewritten
    assert seed_mod.seed_deepseek_endpoint_from_env({"DEEPSEEK_API_KEY": "sk-y"}) is None  # now complete
    assert len(_rows()) == 1


def test_concurrent_first_boot_creates_exactly_one_endpoint():
    import threading
    results, errors = [], []
    gate = threading.Barrier(8)

    def _boot():
        try:
            gate.wait()
            results.append(seed_mod.seed_deepseek_endpoint_from_env({"DEEPSEEK_API_KEY": "sk-race"}))
        except BaseException as e:  # a crashed worker must fail the test, not silently shrink `results`
            errors.append(repr(e))

    threads = [threading.Thread(target=_boot) for _ in range(8)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert errors == []
    assert len(results) == 8
    assert len(_rows()) == 1
    assert len([r for r in results if r]) == 1


def _add_endpoint(ep_id, base_url):
    from core.database import SessionLocal, ModelEndpoint
    db = SessionLocal()
    try:
        db.add(ModelEndpoint(id=ep_id, name=ep_id, base_url=base_url, api_key="sk-z",
                             is_enabled=True, model_type="llm", owner=None))
        db.commit()
    finally:
        db.close()


def test_existing_openrouter_install_without_saved_models_keeps_its_prior_pair():
    _add_endpoint("or-1", "https://openrouter.ai/api/v1")
    assert seed_mod.pin_legacy_model_defaults() is True
    assert _saved() == {"default_model": "z-ai/glm-4.7", "utility_model": "qwen/qwen3.6-27b"}
    assert seed_mod.pin_legacy_model_defaults() is False  # idempotent


def test_pin_writes_only_the_missing_keys_and_keeps_saved_choices():
    _add_endpoint("or-1", "https://openrouter.ai/api/v1")
    with open(settings_mod.SETTINGS_FILE, "w") as f:
        json.dump({"default_model": "my/own-pick"}, f)
    settings_mod._invalidate_caches()
    assert seed_mod.pin_legacy_model_defaults() is True
    assert _saved() == {"default_model": "my/own-pick", "utility_model": "qwen/qwen3.6-27b"}


def test_pin_leaves_fresh_and_deepseek_installs_alone():
    assert seed_mod.pin_legacy_model_defaults() is False and _saved() is None  # fresh: no endpoints
    seed_mod.seed_deepseek_endpoint_from_env({"DEEPSEEK_API_KEY": "sk-g"})
    before = _saved()
    assert seed_mod.pin_legacy_model_defaults() is False and _saved() == before
