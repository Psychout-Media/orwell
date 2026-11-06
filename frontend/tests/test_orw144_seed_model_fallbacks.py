"""ORW-144: startup seed of default_model_fallbacks (DeepSeek default -> OpenRouter)."""
import importlib
import json

import pytest

seed_mod = importlib.import_module("src.deepseek_seed")
settings_mod = importlib.import_module("src.settings")

EXPECTED = [{"endpoint_id": "or-1", "model": "deepseek/deepseek-v4.1-flash"}]


def _add(ep_id, base_url, enabled=True):
    from core.database import SessionLocal, ModelEndpoint
    db = SessionLocal()
    try:
        db.add(ModelEndpoint(id=ep_id, name=ep_id, base_url=base_url, api_key="sk-z",
                             is_enabled=enabled, model_type="llm", owner=None))
        db.commit()
    finally:
        db.close()


def _write(saved):
    with open(settings_mod.SETTINGS_FILE, "w") as f:
        json.dump(saved, f)
    settings_mod._invalidate_caches()


def _saved():
    with open(settings_mod.SETTINGS_FILE) as f:
        return json.load(f)


@pytest.fixture(autouse=True)
def _iso(monkeypatch, tmp_path):
    from core.database import SessionLocal, ModelEndpoint

    def clear():
        db = SessionLocal()
        try:
            db.query(ModelEndpoint).delete()
            db.commit()
        finally:
            db.close()
    clear()
    monkeypatch.setattr(settings_mod, "SETTINGS_FILE", str(tmp_path / "settings.json"))
    settings_mod._invalidate_caches()
    yield
    clear()
    settings_mod._invalidate_caches()


def test_seeds_when_default_is_deepseek_and_openrouter_exists():
    _add("ds-1", "https://api.deepseek.com")
    _add("or-1", "https://openrouter.ai/api/v1")
    _write({"default_endpoint_id": "ds-1"})
    assert seed_mod.seed_default_model_fallbacks() is True
    assert _saved()["default_model_fallbacks"] == EXPECTED
    assert _saved()["default_endpoint_id"] == "ds-1"


def test_seeds_over_an_empty_list():
    _add("ds-1", "https://api.deepseek.com")
    _add("or-1", "https://openrouter.ai/api/v1")
    _write({"default_endpoint_id": "ds-1", "default_model_fallbacks": []})
    assert seed_mod.seed_default_model_fallbacks() is True
    assert _saved()["default_model_fallbacks"] == EXPECTED


def test_noop_when_a_chain_is_already_set():
    _add("ds-1", "https://api.deepseek.com")
    _add("or-1", "https://openrouter.ai/api/v1")
    mine = [{"endpoint_id": "x", "model": "my/pick"}]
    _write({"default_endpoint_id": "ds-1", "default_model_fallbacks": mine})
    assert seed_mod.seed_default_model_fallbacks() is False
    assert _saved()["default_model_fallbacks"] == mine


def test_noop_without_an_enabled_openrouter_endpoint():
    _add("ds-1", "https://api.deepseek.com")
    _write({"default_endpoint_id": "ds-1"})
    assert seed_mod.seed_default_model_fallbacks() is False
    _add("or-1", "https://openrouter.ai/api/v1", enabled=False)
    assert seed_mod.seed_default_model_fallbacks() is False
    assert "default_model_fallbacks" not in _saved()


def test_noop_when_default_is_not_deepseek():
    _add("ds-1", "https://api.deepseek.com")
    _add("or-1", "https://openrouter.ai/api/v1")
    _write({"default_endpoint_id": "or-1"})
    assert seed_mod.seed_default_model_fallbacks() is False
    assert "default_model_fallbacks" not in _saved()
    _write({})  # no default designation at all
    assert seed_mod.seed_default_model_fallbacks() is False


def test_idempotent():
    _add("ds-1", "https://api.deepseek.com")
    _add("or-1", "https://openrouter.ai/api/v1")
    _write({"default_endpoint_id": "ds-1"})
    assert seed_mod.seed_default_model_fallbacks() is True
    first = _saved()
    assert seed_mod.seed_default_model_fallbacks() is False
    assert _saved() == first


def test_wired_into_startup():
    import os
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "app.py")).read()
    assert "seed_default_model_fallbacks()" in src
