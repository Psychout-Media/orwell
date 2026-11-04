"""OOBE-reset FE-store helper (frontend/scripts/oobe_reset.py) — the keep-API-keys surgery.

The load-bearing guarantee of the whole "Factory Reset (OOBE)" feature: after the reset the
LLM / image PROVIDER config and the LLM-selection settings SURVIVE, while every other table
(accounts live in auth.json off-DB; sessions, chat_messages, memories, mcp_servers, …) is GONE.

Operates on a throwaway SQLite file + settings.json in a tmp dir (DATA_DIR / DATABASE_URL env),
so it never touches a real store and needs no SQLAlchemy / core import chain.
"""
import importlib.util
import json
import os
import sqlite3

import pytest

_HELPER = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "oobe_reset.py")


def _load_helper(monkeypatch, tmp_path):
    """Import the helper fresh with DATA_DIR/DATABASE_URL pointed at tmp_path."""
    db = tmp_path / "app.db"
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db}")
    spec = importlib.util.spec_from_file_location("oobe_reset_under_test", _HELPER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod, db


def _seed_store(db_path, settings_path):
    """A populated store: provider endpoints (KEEP) + plenty of user data (WIPE)."""
    conn = sqlite3.connect(db_path)
    # The provider config we must preserve — including the encrypted api_key ciphertext verbatim.
    conn.execute(
        "CREATE TABLE model_endpoints (id TEXT, name TEXT, base_url TEXT, api_key TEXT, "
        "model_type TEXT, is_enabled INTEGER)")
    conn.execute(
        "INSERT INTO model_endpoints VALUES (?,?,?,?,?,?)",
        ("ep1", "My Provider", "https://api.example/v1", "enc:CIPHERTEXT-KEEPME", "llm", 1))
    conn.execute(
        "INSERT INTO model_endpoints VALUES (?,?,?,?,?,?)",
        ("ep2", "Image Provider", "https://img.example/v1", "enc:IMGKEY", "image", 1))
    # User data that MUST NOT survive the reset.
    conn.execute("CREATE TABLE sessions (id TEXT, name TEXT, owner TEXT)")
    conn.execute("INSERT INTO sessions VALUES ('s1', 'a chat', 'alice')")
    conn.execute("CREATE TABLE chat_messages (id TEXT, content TEXT)")
    conn.execute("INSERT INTO chat_messages VALUES ('m1', 'secret talk')")
    conn.execute("CREATE TABLE mcp_servers (id TEXT, name TEXT, command TEXT)")
    conn.execute("INSERT INTO mcp_servers VALUES ('mcp1', 'a server', '/bin/x')")
    conn.execute("CREATE TABLE memories (id TEXT, text TEXT)")
    conn.execute("INSERT INTO memories VALUES ('mem1', 'remembered thing')")
    conn.commit()
    conn.close()

    # settings.json: model SELECTION keys (now RESET to default — #860) + operational flags
    # (KEEP) + unrelated user settings (WIPE). The model picks here include a STALE placeholder
    # (sakana/fugu-ultra) to prove it never rides across the reset.
    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump({
            "default_endpoint_id": "ep1",
            "default_model": "sakana/fugu-ultra",
            "image_endpoint_id": "ep2",
            "image_model": "the-image-model",
            "image_gen_enabled": True,
            "image_quality": "high",
            # Non-LLM settings that must be dropped to OOBE defaults:
            "theme": "midnight",
            "keybinds": {"send": "ctrl+enter"},
            "some_game_pref": 42,
        }, f)


def test_preserves_providers_and_wipes_everything_else(monkeypatch, tmp_path):
    mod, db = _load_helper(monkeypatch, tmp_path)
    settings = tmp_path / "settings.json"
    _seed_store(str(db), str(settings))

    summary = mod.reset_frontend_store()
    assert summary["endpoints_preserved"] == 2

    # The provider rows survive — base_url AND the encrypted api_key ciphertext, VERBATIM
    # (no re-encryption, so it still decrypts under the preserved .app_key).
    conn = sqlite3.connect(str(db))
    rows = conn.execute(
        "SELECT id, base_url, api_key, model_type FROM model_endpoints ORDER BY id").fetchall()
    # No other table survived the rebuild.
    tables = {r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    conn.close()

    assert rows == [
        ("ep1", "https://api.example/v1", "enc:CIPHERTEXT-KEEPME", "llm"),
        ("ep2", "https://img.example/v1", "enc:IMGKEY", "image"),
    ]
    assert tables == {"model_endpoints"}, f"only the provider table may survive, got {tables}"

    # settings.json carries ONLY the operational flags + the default-ENDPOINT designation
    # (2026-07-12 fix — `default_endpoint_id` survives, still pointing at the carried ep1 row);
    # model SELECTIONS and user settings are gone (#860 — the selections revert to
    # DEFAULT_SETTINGS on load: glm-4.7 narrator, gemini-3.1-flash-image portraits). The stale
    # sakana/fugu-ultra pick does NOT survive.
    with open(settings, encoding="utf-8") as f:
        kept = json.load(f)
    assert kept == {
        "image_gen_enabled": True,
        "image_quality": "high",
        "default_endpoint_id": "ep1",
    }
    # Every model SELECTION key is RESET (not preserved) — incl. the stale placeholder.
    for reset_key in ("default_model", "image_endpoint_id", "image_model"):
        assert reset_key not in kept, f"{reset_key} must reset to default, not ride across the reset"
    assert "sakana/fugu-ultra" not in json.dumps(kept), "the stale placeholder must never survive"
    for wiped in ("theme", "keybinds", "some_game_pref"):
        assert wiped not in kept


def test_empty_store_is_a_clean_noop(monkeypatch, tmp_path):
    # No DB, no settings → OOBE already: a clean no-op that never raises, leaves an ABSENT db.
    mod, db = _load_helper(monkeypatch, tmp_path)
    summary = mod.reset_frontend_store()
    assert summary["endpoints_preserved"] == 0
    assert summary["settings_keys_preserved"] == []
    # With nothing to carry, the helper leaves the DB file absent (the app's init_db creates it).
    assert not os.path.exists(db)
    # A fresh settings.json with no preserved keys is written ({} = all defaults).
    with open(tmp_path / "settings.json", encoding="utf-8") as f:
        assert json.load(f) == {}


def test_idempotent_second_run(monkeypatch, tmp_path):
    # Running twice yields the same preserved state (no growth, no loss).
    mod, db = _load_helper(monkeypatch, tmp_path)
    settings = tmp_path / "settings.json"
    _seed_store(str(db), str(settings))
    first = mod.reset_frontend_store()
    second = mod.reset_frontend_store()
    assert first["endpoints_preserved"] == second["endpoints_preserved"] == 2
    conn = sqlite3.connect(str(db))
    n = conn.execute("SELECT COUNT(*) FROM model_endpoints").fetchone()[0]
    conn.close()
    assert n == 2


def test_db_path_honors_relative_database_url(monkeypatch, tmp_path):
    # A relative sqlite:/// URL resolves against the frontend dir, exactly like the app.
    monkeypatch.setenv("DATABASE_URL", "sqlite:///./data/app.db")
    monkeypatch.delenv("DATA_DIR", raising=False)
    spec = importlib.util.spec_from_file_location("oobe_reset_rel", _HELPER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    p = mod.db_path()
    assert os.path.isabs(p)
    assert p.endswith(os.path.join("data", "app.db"))


def test_never_touches_dotenv(monkeypatch, tmp_path):
    # Guard the hard constraint: the FE-store helper must NEVER operate on the engine data/.env.
    # It writes/reads exactly two targets (the app.db + settings.json); prove neither is .env and
    # that a .env sitting in the same dir survives a full reset untouched.
    mod, db = _load_helper(monkeypatch, tmp_path)
    assert not mod.db_path().endswith(".env")
    assert not mod.settings_path().endswith(".env")

    # A .env in the data dir (e.g. a dev layout) must be byte-stable across the reset.
    env_file = tmp_path / ".env"
    env_file.write_text("ANTHROPIC_API_KEY=keepme\nORWELL_ENGINE_TOKEN=secret\n")
    _seed_store(str(db), str(tmp_path / "settings.json"))
    mod.reset_frontend_store()
    assert env_file.read_text() == "ANTHROPIC_API_KEY=keepme\nORWELL_ENGINE_TOKEN=secret\n"


def test_rebuild_is_atomic_original_survives_a_crash(monkeypatch, tmp_path):
    """DATA-SAFETY P2: a crash DURING the rebuild must NOT destroy the live app.db.

    The preserved provider config lives only in memory (`rows`) during the swap. The old
    remove-then-recreate deleted app.db FIRST, so a crash before the re-insert committed lost the
    API-provider config the OOBE tier promises to keep. The atomic version builds a temp DB and
    os.replace()s it, leaving the original intact until the swap succeeds — so a failed rebuild
    loses nothing.
    """
    mod, db = _load_helper(monkeypatch, tmp_path)
    settings = tmp_path / "settings.json"
    _seed_store(str(db), str(settings))

    real_connect = mod.sqlite3.connect

    # Snapshot the providers BEFORE the (doomed) reset, via the un-patched connect.
    before_conn = real_connect(str(db))
    endpoints_before = before_conn.execute(
        "SELECT id, base_url, api_key FROM model_endpoints ORDER BY id").fetchall()
    before_conn.close()
    assert endpoints_before, "precondition: the seeded store has provider rows"

    def _crashing_connect(target, *a, **kw):
        # Fail ONLY when building the temp replacement — i.e. in the rebuild's write window.
        if ".rebuild." in os.path.basename(str(target)) and str(target).endswith(".tmp"):
            raise sqlite3.OperationalError("simulated crash mid-rebuild")
        return real_connect(target, *a, **kw)

    monkeypatch.setattr(mod.sqlite3, "connect", _crashing_connect)

    with pytest.raises(sqlite3.OperationalError):
        mod.reset_frontend_store()

    # The ORIGINAL app.db is untouched — providers are all still there (nothing silently lost).
    after_conn = real_connect(str(db))
    endpoints_after = after_conn.execute(
        "SELECT id, base_url, api_key FROM model_endpoints ORDER BY id").fetchall()
    after_conn.close()
    assert endpoints_after == endpoints_before, \
        "the live provider config MUST survive a failed rebuild (source never removed pre-swap)"

    # No half-written temp DB is left behind after the failure.
    assert not _rebuild_temps(tmp_path)


def _rebuild_temps(tmp_path):
    """Any leftover temp DB / sidecar from the rebuild (mkstemp names: app.db.rebuild.<rand>.tmp[-journal])."""
    return [n for n in os.listdir(tmp_path) if ".rebuild." in n or n.endswith(".tmp")]


def test_rebuild_leaves_no_temp_file_on_success(monkeypatch, tmp_path):
    """The happy-path atomic swap consumes its temp file (os.replace renames it into place)."""
    mod, db = _load_helper(monkeypatch, tmp_path)
    settings = tmp_path / "settings.json"
    _seed_store(str(db), str(settings))
    mod.reset_frontend_store()
    assert os.path.exists(str(db)), "the rebuilt DB must be present"
    assert not _rebuild_temps(tmp_path), "no temp DB may linger after a clean swap"
    # And the carried providers round-tripped through the swap.
    conn = sqlite3.connect(str(db))
    n = conn.execute("SELECT COUNT(*) FROM model_endpoints").fetchone()[0]
    conn.close()
    assert n == 2


def test_helper_never_writes_through_a_planted_symlink_at_a_temp_name(monkeypatch, tmp_path):
    """The helper runs as ROOT inside the service-writable FE store: a symlink pre-planted at the old
    predictable temp names (`settings.json.tmp`, `app.db.rebuild.tmp`) must NOT be followed."""
    mod, db = _load_helper(monkeypatch, tmp_path)
    settings = tmp_path / "settings.json"
    _seed_store(str(db), str(settings))
    victim = tmp_path / "victim.txt"
    victim.write_text("VICTIM")
    for planted in ("settings.json.tmp", "app.db.rebuild.tmp"):
        (tmp_path / planted).symlink_to(victim)
    mod.reset_frontend_store()
    assert victim.read_text() == "VICTIM"
    assert os.path.exists(str(db)) and os.path.exists(str(settings))
