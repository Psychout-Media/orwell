#!/usr/bin/env python3
"""Front-end store reset to exact OOBE — preserving ONLY the API-key / LLM-provider config.

This is the FE-store half of ``deploy/orwell-oobe-reset.sh`` (the "keep API keys" tier).
It returns the front-end data dir to a first-run state — clearing ALL accounts, chats,
sessions, memory, MCP server configs, uploads, portraits, and every user setting — while
PRESERVING exactly the configuration an operator should never have to re-enter: the
configured LLM/image providers and the keys that decrypt them.

What "API-key / LLM-provider config" means here (and where it lives):

  * ``app.db`` → table ``model_endpoints`` — the admin-configured providers: each row's
    ``base_url``, the (Fernet-encrypted) ``api_key``, model pools, image vs llm type, etc.
    This is the PRIMARY provider config in the modern build (src/endpoint_resolver.py).
  * ``data/settings.json`` → the model SELECTION keys are RESET to the OOB defaults
    (issue #860): a reset does NOT carry the previously-selected models — only operational flags
    (image_gen_enabled, image_quality, vision_enabled) survive. After the reset the defaults stand
    (narrator + utility deepseek-flash on DeepSeek's own API (PO 2026-11-02; OpenRouter pair was z-ai/glm-4.7 + qwen/qwen3.6-27b — ADR 0016), narrator
    per the 2026-07-13 owner ruling; portrait google/gemini-3.1-flash-image). The default-ENDPOINT
    DESIGNATION (``default_endpoint_id``) is PRESERVED (2026-07-12 PROD-blocker fix): it is
    validated against the carried rows and re-pointed at the sole enabled+keyed endpoint when it
    was empty/dangling — the per-call-class resolver never had a "bind empty default to the first
    enabled endpoint" behavior, so dropping the designation bricked game creation under the strict
    0116 enrichment policy. Preserved endpoint rows are also RE-OWNED to shared (owner=NULL),
    because the reset wipes every account and a stale owner stamp fails the resolver's scoping.
  * ``data/.app_key`` → the Fernet key that decrypts ``model_endpoints.api_key`` (and the
    other EncryptedText columns). Preserving the endpoints WITHOUT this key would leave the
    stored keys permanently undecryptable, so it is preserved as a FILE (see the shell
    script's keep-list) and read here only to validate round-trips.
  * ``data/api_keys.json`` + ``data/.key`` → the legacy ``APIKeyManager`` provider keys.
    Preserved as FILES by the shell script's keep-list (not touched here).

Everything else in ``app.db`` (accounts live in ``data/auth.json``, not the DB; sessions,
chat_messages, memories, mcp_servers, documents, gallery, tasks, crew, …) is DROPPED: this
script rebuilds the SQLite file from scratch carrying ONLY the preserved ``model_endpoints``
rows, so no stray user data can survive a column we forgot to enumerate.

Design notes:
  * Operates on the SQLite file directly via the stdlib ``sqlite3`` — NO SQLAlchemy / ``core``
    import chain — so it runs in the bare deploy/CI env and is trivially unit-testable.
  * Idempotent + safe to re-run: a second run on an already-OOBE store is a clean no-op
    (no endpoints to carry, fresh empty DB) and never raises on a missing file.
  * Paths come from env (``DATA_DIR`` / ``DATABASE_URL``) exactly like the app, so a test
    points it at a temp dir; defaults match the app (``<frontend>/data``).
  * NEVER touches ``data/.env`` (the engine EnvironmentFile) — that file is the shell
    script's concern and lives in the ENGINE config dir, not the FE store.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
import tempfile

# Reset semantics (issue #860, owner ruling 2026-06-25; amended 2026-07-12): a factory/OOBE reset
# preserves ONLY the API key(s) + the provider endpoint record(s) (the model_endpoints rows, carried
# separately) — it does NOT preserve the SELECTED MODELS. After a reset the model selections revert
# to the OOB defaults (narrator + utility deepseek-flash on DeepSeek's own API (PO 2026-11-02; was the OpenRouter glm-4.7 + qwen pair — the ADR
# 0016 pair, narrator per the 2026-07-13 owner ruling; portrait google/gemini-3.1-flash-image), so a
# stale/placeholder pick (e.g. the "sakana/fugu-ultra" the owner was stuck on) can never ride across
# a reset.
#
# 2026-07-12 (PROD blocker): the default-ENDPOINT DESIGNATION (`default_endpoint_id`) is NOT a model
# selection and IS preserved. This module's earlier claim that "resolution binds the empty default
# endpoint to the first enabled endpoint" was FALSE for the per-call-class utility resolution
# (`src/endpoint_resolver.resolve_endpoint` had no such binding), so dropping the designation
# bricked game creation under the strict 0116 enrichment policy ("no model resolved for the
# cast-genesis/-identity/-authoring call class") until an operator re-picked a default by hand.
# The designation is preserved when it points at a surviving row, re-pointed at the sole surviving
# enabled+keyed LLM endpoint when it was empty/dangling, and dropped only when genuinely ambiguous
# (2+ candidates — the runtime single-endpoint auto-default in endpoint_resolver stays the belt).
PRESERVED_SETTINGS_KEYS = (
    "image_gen_enabled", "image_quality", "vision_enabled",
)

# The model/endpoint SELECTION keys that a reset RESETS to defaults (by NOT preserving them). Listed
# explicitly so the source-pinned test can assert none of them survives a reset.
# (`default_endpoint_id` moved OUT of this tuple 2026-07-12 — the designation is preserved above.)
RESET_TO_DEFAULT_SELECTION_KEYS = (
    "default_model", "default_model_fallbacks",
    "utility_endpoint_id", "utility_model", "utility_model_fallbacks",
    "research_endpoint_id", "research_model",
    "vision_endpoint_id", "vision_model", "vision_model_fallbacks",
    "image_endpoint_id", "image_model",
)


def _is_truthy_flag(value) -> bool:
    """SQLite-tolerant truthiness for a carried is_enabled cell (1 / "1" / True / "true")."""
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "on")
    return bool(value)


def preserved_default_designation(saved_settings: dict, endpoint_rows: list) -> dict:
    """The default-endpoint DESIGNATION to carry across the reset (2026-07-12 fix).

    * The prior `default_endpoint_id` survives when it points at a carried, enabled row.
    * An empty/dangling designation is RE-POINTED at the sole carried enabled endpoint that has
      an API key and is not image-only (exactly the runtime single-endpoint auto-default rule) —
      so the post-reset store is explicit and nothing downstream has to guess.
    * Two-plus candidates ⇒ no designation is written (never guess between providers; the
      runtime auto-default then simply doesn't fire either, matching pre-reset ambiguity).
    Model SELECTIONS are untouched by this — #860 still resets them to the OOB defaults."""
    prior = ""
    if isinstance(saved_settings, dict):
        prior = str(saved_settings.get("default_endpoint_id") or "").strip()
    enabled_rows = [r for r in (endpoint_rows or []) if _is_truthy_flag(r.get("is_enabled"))]
    if prior and any(str(r.get("id")) == prior for r in enabled_rows):
        return {"default_endpoint_id": prior}
    candidates = [
        r for r in enabled_rows
        if str(r.get("api_key") or "").strip()
        and str(r.get("model_type") or "llm") != "image"
    ]
    if len(candidates) == 1 and candidates[0].get("id"):
        return {"default_endpoint_id": str(candidates[0]["id"])}
    return {}


def _frontend_dir() -> str:
    # <frontend>/  (this file is <frontend>/scripts/oobe_reset.py)
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def data_dir() -> str:
    return os.environ.get("DATA_DIR") or os.path.join(_frontend_dir(), "data")


def db_path() -> str:
    """The SQLite file path, honoring DATABASE_URL exactly as core/database.py does."""
    url = os.environ.get("DATABASE_URL", "")
    if url.startswith("sqlite:///"):
        p = url[len("sqlite:///"):]
        # A relative sqlite URL (./data/app.db) resolves against the FE dir, like the app.
        return p if os.path.isabs(p) else os.path.join(_frontend_dir(), p)
    return os.path.join(data_dir(), "app.db")


def settings_path() -> str:
    return os.path.join(data_dir(), "settings.json")


def _table_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    return [row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]


def export_model_endpoints(path: str) -> list[dict]:
    """Read every model_endpoints row as a list of column→value dicts.

    Returns [] when the DB or table is absent (a fresh / already-reset store). The rows
    stay EXACTLY as stored — the encrypted ``api_key`` ciphertext is carried verbatim, so
    it still decrypts under the preserved ``.app_key`` after the rebuild (no re-encryption,
    no plaintext ever materialized here)."""
    if not os.path.isfile(path):
        return []
    conn = sqlite3.connect(path)
    try:
        if not conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='model_endpoints'"
        ).fetchone():
            return []
        cols = _table_columns(conn, "model_endpoints")
        for col in cols:
            if not re.match(r'^[a-zA-Z0-9_]+$', str(col)):
                raise ValueError("Invalid input")
        out = []
        for row in conn.execute(f"SELECT {', '.join(cols)} FROM model_endpoints").fetchall():
            out.append(dict(zip(cols, row)))
        return out
    finally:
        conn.close()


def export_preserved_settings(path: str) -> dict:
    """Read ONLY the allowlisted OPERATIONAL settings keys from settings.json (global level).

    Per issue #860, the model/endpoint SELECTION keys are deliberately NOT preserved — a reset
    resets the selected models to the OOB defaults (so a stale/placeholder pick can never ride
    across). Only operational flags (image_gen_enabled, image_quality, vision_enabled) survive;
    everything else, including default_model / image_model, reverts to DEFAULT_SETTINGS on load.

    Per-user prefs (data/user_prefs.json) are deliberately NOT preserved — they belong to
    accounts, which the reset removes."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            saved = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}
    if not isinstance(saved, dict):
        return {}
    return {k: saved[k] for k in PRESERVED_SETTINGS_KEYS if k in saved}


def _remove_db_files(path: str) -> None:
    """Remove a SQLite main file plus its WAL/SHM/journal side files (missing ⇒ fine)."""
    for p in (path, path + "-wal", path + "-shm", path + "-journal"):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass


def rebuild_db_with_endpoints(path: str, rows: list[dict], columns: list[str]) -> None:
    """Recreate the SQLite file from scratch carrying ONLY the model_endpoints rows.

    The rebuilt DB has exactly one table with exactly the preserved rows; NO other table
    (sessions, memories, mcp_servers, …) survives. The app's own ``init_db()`` re-creates every
    other table (and runs migrations) on the next boot; we only need the provider config present
    for the resolver to work pre-login.

    ATOMIC (data-safety P2, 2026-07-13): the preserved provider config lives ONLY in ``rows`` (in
    memory). The old code ``os.remove(path)`` FIRST and then recreated + re-inserted — a crash in
    that window destroyed the API-provider config the OOBE tier PROMISES to keep. So we build the
    replacement at a temp path, commit it durably, then ``os.replace()`` it over the live DB in ONE
    atomic rename (mirroring ``write_preserved_settings``). The source ``app.db`` is NEVER removed
    before the replacement is durable, so a crash anywhere here can only leave EITHER the intact
    original OR the finished replacement — never a gap that loses the provider config.
    """
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)

    if not rows or not columns:
        # Nothing to carry — remove the DB (+ side files) so the app's init_db() creates a pristine
        # schema on next boot. (Creating an endpoints-only DB here would make init_db skip the
        # other tables it lazily creates; an absent file is the cleanest OOBE state.) There is no
        # provider config to lose in this branch, so removal is safe.
        _remove_db_files(path)
        return

    # Validate the exported column set BEFORE any filesystem mutation (identifiers only).
    for col in columns:
        if not re.match(r'^[a-zA-Z0-9_]+$', str(col)):
            raise ValueError("Invalid input")

    # Build the replacement at a sibling temp path (same dir ⇒ os.replace is an atomic rename).
    # This runs as ROOT inside the service-writable FE store, so the temp is created with mkstemp
    # (O_EXCL, unpredictable name): a pre-planted symlink at a predictable temp name would otherwise
    # be followed and root would overwrite its target. An empty file is a valid new SQLite DB.
    fd, tmp = tempfile.mkstemp(prefix=os.path.basename(path) + ".rebuild.", suffix=".tmp",
                               dir=os.path.dirname(path) or ".")
    os.close(fd)
    conn = None
    try:
        conn = sqlite3.connect(tmp)
        # A minimal, app-compatible model_endpoints schema. The app's SQLAlchemy
        # create_all + migrations will reconcile/extend it on next boot; we only need the
        # columns we are carrying to round-trip. Use the exported column set verbatim.
        col_defs = ", ".join(f'"{c}" TEXT' for c in columns)
        conn.execute(f'CREATE TABLE model_endpoints ({col_defs})')
        placeholders = ", ".join("?" for _ in columns)
        col_list = ", ".join(f'"{c}"' for c in columns)
        for row in rows:
            conn.execute(
                f'INSERT INTO model_endpoints ({col_list}) VALUES ({placeholders})',
                tuple(row.get(c) for c in columns),
            )
        conn.commit()
    except BaseException:
        # A failed rebuild must not leave a half-written temp behind, and must NOT touch the
        # still-intact live DB — the original app.db stands, providers preserved.
        if conn is not None:
            conn.close()
        _remove_db_files(tmp)
        raise
    else:
        conn.close()

    # The tmp DB is durable + self-contained (default rollback-journal mode leaves no side files
    # after a clean close). Swap it in atomically, THEN clear the OLD db's WAL/SHM/journal so a
    # stale side file can't be applied against the fresh file. (Order matters: removing the old
    # side files only AFTER the replace keeps the original recoverable until the swap succeeds.)
    os.replace(tmp, path)
    for suffix in ("-wal", "-shm", "-journal"):
        try:
            os.remove(path + suffix)
        except FileNotFoundError:
            pass


def write_preserved_settings(path: str, preserved: dict) -> None:
    """Write a fresh settings.json carrying ONLY the preserved LLM-selection keys.

    The app merges this over DEFAULT_SETTINGS at load, so omitted keys revert to their
    OOBE defaults — exactly the intent. An empty preserved dict writes ``{}`` (a clean,
    all-defaults file), still a valid OOBE state."""
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    # mkstemp (O_EXCL, unpredictable name), not `path + ".tmp"`: this runs as ROOT inside the
    # service-writable FE store, where a pre-planted symlink at a predictable temp name would be
    # followed. os.replace() then swaps it in atomically (a symlink at `path` is replaced, not followed).
    fd, tmp = tempfile.mkstemp(prefix=os.path.basename(path) + ".", suffix=".tmp",
                               dir=os.path.dirname(path) or ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(preserved, f, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.remove(tmp)
        except FileNotFoundError:
            pass
        raise


def reset_frontend_store() -> dict:
    """The full FE-store OOBE reset (DB + settings). Returns a small summary dict.

    Preconditions (the shell script's job): services stopped; the file keep-list
    (.app_key, .key, api_keys.json) preserved; everything else under the FE data dir
    already removed. This step rebuilds app.db + settings.json from the in-memory
    exports it takes FIRST — so call it BEFORE the shell scrubs app.db/settings.json,
    OR (the safer order) let it read, then write the fresh versions itself."""
    dbp = db_path()
    setp = settings_path()

    endpoints = export_model_endpoints(dbp)
    columns = list(endpoints[0].keys()) if endpoints else []
    preserved = export_preserved_settings(setp)

    # 2026-07-12: carry the default-endpoint DESIGNATION (validated / re-pointed against the
    # carried rows) — see preserved_default_designation. Read the raw prior settings directly;
    # export_preserved_settings deliberately keeps only the operational flags.
    try:
        with open(setp, "r", encoding="utf-8") as f:
            prior_settings = json.load(f)
        if not isinstance(prior_settings, dict):
            prior_settings = {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        prior_settings = {}
    preserved.update(preserved_default_designation(prior_settings, endpoints))

    # 2026-07-12: RE-OWN the preserved endpoint rows to shared (owner=NULL). The reset wipes
    # every account (auth.json), so any owner stamp on a carried row is stale by construction —
    # left in place it silently fails the resolver's owner scoping for every recreated user.
    # NULL = the ModelEndpoint "legacy/shared, visible to every user" semantic.
    if columns and "owner" in columns:
        for row in endpoints:
            row["owner"] = None

    rebuild_db_with_endpoints(dbp, endpoints, columns)
    write_preserved_settings(setp, preserved)

    return {
        "db": dbp,
        "settings": setp,
        "endpoints_preserved": len(endpoints),
        "settings_keys_preserved": sorted(preserved.keys()),
    }


def main(argv: list[str] | None = None) -> int:
    summary = reset_frontend_store()
    print(
        "[oobe-reset] preserved {n} LLM/image endpoint(s) and {k} setting key(s); "
        "rebuilt {db}".format(
            n=summary["endpoints_preserved"],
            k=len(summary["settings_keys_preserved"]),
            db=summary["db"],
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
