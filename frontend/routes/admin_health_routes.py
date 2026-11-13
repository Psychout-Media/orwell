"""Lane G1 — admin Health & Logs (UI-backed health checking + debug bundle).

The user commission: "robust health checking and logging, visible in the admin side
of settings" plus a one-click mechanism to gather debug data (the image pipeline's
silent placeholder failures were the trigger). Two read-only, admin-gated routes
(the same ``require_admin`` contract as ``admin_transcript_routes.py``):

  GET /api/admin/health        — one aggregated snapshot: the engine's /health
                                 (uptime, call counters, the G1 recent-failure ring,
                                 embeddings provider + degrade flag) measured with
                                 round-trip latency, the FE store stats (incl. a
                                 DEGRADED-boot flag when the DB failed to init), the
                                 FE's own view of the engine (lastError), whether the
                                 two tiers AGREE, and the image-generation provider
                                 state. NEVER hard-fails (P1) — it renders what it can.
  GET /api/admin/debug-bundle  — the same snapshot as a downloadable JSON file, BEEFED
                                 UP (owner: "let's beef up that file") with: FE + engine
                                 versions/build, recent app logs + recent errors, the
                                 ops-status files, engine /health + reachability, the
                                 REDACTED settings/provider config, a Vault-free game/
                                 session-state summary (counts/phase/week only), system
                                 info (python/node/disk/memory), feature flags, and
                                 recent chat-session METADATA — PLUS (schema 3, owner
                                 ruling 2026-07-13: "include everything an operator/
                                 debugger could need"): the full LLM I/O record tail
                                 (0112), the complete chat store dump (bounded per
                                 session), the whole FE log ring, the token ledger
                                 (0069), the sync/divergence ledger + belt telemetry
                                 (0065), the enrichment ledger, the overseer report
                                 ring (0079), cast-authoring + house-entry detail,
                                 portrait/image state, a REDACTED settings snapshot,
                                 and the engine's per-sandbox health projection.

Two exports, ONE assembler (owner ruling 2026-07-13): the STANDARD export (the default
button/endpoint) is the complete schema-3 bundle, Vault-free; the UNSEALED export
(?vault=1, behind require_vault_reveal + the explicit /admin/status spoiler affordance)
is the IDENTICAL bundle PLUS the live producerVault dump, self-identifying as
``"bundle": "orwell-debug-unsealed"`` with a ``_SPOILERS`` banner. They differ ONLY in
the Vault section; credential redaction applies to BOTH (Vault ≠ credentials).

Boundaries:
  * Vault-free by construction — everything here is operational metadata (the engine's
    /health carries tool names + sanitized error classes + timings only; G1 engine side).
    The game-state summary is reduced to scalar counts/phase — no roster, no Vault/soul.
  * READ-ONLY — no mutating verb exists on this surface (the ops POST triggers excepted).
  * Secrets never cross: the bundle redacts by key pattern BEFORE serialization, AND
    every value that crosses is a name/model/url/count — never an api key, token, or .env.
  * P1 resilience: the status page + its health endpoints never refuse to connect or 500;
    a broken DB, a down engine, or partial state degrade into a diagnostic, not a wall.
"""

import asyncio
import inspect
import json
import logging
import os
import platform
import re
import shutil
import sys
import time
from datetime import datetime, timezone

from fastapi import APIRouter, Request, Response

from core.middleware import require_admin, require_vault_reveal
from core.admin_guard import guard_root_op
from core.ops_watcher import inactive_reason, watcher_active
from src import orwell_engine
from src.auth_helpers import effective_user

logger = logging.getLogger(__name__)

from src import log_rings  # the G1b live rings (FE log + Engine I/O tap)


def _data_dir() -> str:
    """The FRONT-END app-data dir (frontend/data): the FE's own logs (portrait-log.jsonl, the
    G19a script-run logs) live here. DATA_DIR overrides (tests/dev)."""
    return os.environ.get("DATA_DIR") or os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


def _ops_data_dir() -> str:
    """The DEPLOY data dir (e.g. /opt/orwell/data): where the root-side systemd ops path units
    watch data/ops/<flag>, where the installer creates data/ops, and where the ops-*.log run logs
    live. This is a DIFFERENT tree from _data_dir()/frontend/data — one level higher (APP_DIR).
    The maintenance buttons (Update / Factory Reset / Update+Reset) hand off through this tree;
    pointing them at frontend/data was the bug (the FE dropped flags no root watcher ever saw).
    DATA_DIR overrides (tests/dev) so it collapses onto _data_dir() under a single test root."""
    return os.environ.get("DATA_DIR") or os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "data")


def _log_dirs() -> list:
    """The trees the admin log viewer tails: the FE app-data dir (its own logs) AND the deploy
    data dir (the root-side ops-*.log the maintenance buttons stream). De-duplicated, FE-dir first
    (so an FE log wins a same-name collision). Under a test DATA_DIR the two collapse to one."""
    out = []
    for d in (_data_dir(), _ops_data_dir()):
        if d and d not in out:
            out.append(d)
    return out


# On-disk logs that are ALREADY surfaced as a live ring source — listing them as a separate
# "(file)" source duplicates the stream (and the file looked "full" beside a post-restart-blank
# live view). The live ring is seeded from the archive at startup, so it represents the file fully.
_RING_BACKED_LOG_FILES = {"llm-io.jsonl"}  # ↔ the "LLM I/O (live)" source


def _log_files() -> list:
    """On-disk log basenames across the viewer's data dirs (allowlist for the file tail).

    Excludes files already represented by a live ring source (e.g. llm-io.jsonl ↔ "LLM I/O
    (live)") so the viewer never lists the same stream twice."""
    out: list = []
    seen: set = set()
    for d in _log_dirs():
        try:
            for n in sorted(os.listdir(d)):
                if n in seen or n in _RING_BACKED_LOG_FILES:
                    continue
                if n.endswith((".log", ".jsonl")) and os.path.isfile(os.path.join(d, n)):
                    out.append(n)
                    seen.add(n)
        except OSError:
            pass
    return out


def _pretty_log_line(name: str, raw: str) -> str:
    """Pretty-print a single log line for the file viewer. A ``.jsonl`` archive stores one JSON
    object per line, which rendered as an unreadable one-liner; expand it to indented JSON so the
    file viewer is legible (the pane is ``white-space: pre-wrap``, so newlines show). Plain
    ``.log`` text and anything that isn't valid JSON is returned unchanged."""
    if not name.endswith(".jsonl"):
        return raw
    s = raw.strip()
    if not s or s[0] not in "{[":
        return raw
    try:
        return json.dumps(json.loads(s), indent=2, ensure_ascii=False)
    except (ValueError, TypeError):
        return raw


def _log_path(name: str) -> str:
    """Resolve an (already allowlisted) log basename to the first data dir that holds it; falls
    back to the FE data dir so a brand-new file still has a stable home. No traversal — callers
    pass only names from _log_files()."""
    for d in _log_dirs():
        p = os.path.join(d, name)
        if os.path.isfile(p):
            return p
    return os.path.join(_data_dir(), name)

# Env keys worth bundling (the deploy-relevant knobs). Values matching _SECRET_RE are redacted.
_ENV_PREFIXES = ("ORWELL_", "BBAI_", "AUTH_")

# BL-057: 'secret' is AMBIGUOUS — `client_secret` / `SECRET_KEY` / a trailing `_secret` are
# credentials, but a feature FLAG like `ORWELL_SECRET_PACING` is not. Match 'secret' ONLY as a
# credential-shaped token: standalone/trailing, or `secret[_-](key|token|id|access[_-]?key)` —
# NEVER as a prefix adjective on a non-credential word (…SECRET_PACING / SECRET_SAUCE), so a
# harmless flag value crosses the debug bundle intact instead of being spuriously redacted.
_SECRET_WORD = r"secret(?:[_-](?:key|token|id|access(?:[_-]?key)?))?(?![_-]?[a-z0-9])"
_SECRET_RE = re.compile(
    r"token|" + _SECRET_WORD + r"|key|password|passwd|credential|pat\b", re.IGNORECASE)
REDACTED = "***REDACTED***"


def _redact_config(env: dict) -> dict:
    """Every secret-shaped key is replaced with a marker — values never cross."""
    out = {}
    for k in sorted(env):
        if not (k.startswith(_ENV_PREFIXES) or k == "DATABASE_URL"):
            continue
        val = env[k]
        if _SECRET_RE.search(k):
            val = REDACTED
        elif isinstance(val, str):
            # URL-embedded credentials (e.g. postgres://user:pass@host) never cross either.
            val = re.sub(r"//[^/@\s]+:[^/@\s]+@", f"//{REDACTED}@", val)
        out[k] = val
    return out


async def _engine_raw_health() -> tuple[dict | None, int | None]:
    """The engine's own /health body (G1: uptime + counters + failure ring + embeddings)
    plus the measured round-trip latency in ms. (None, None) when unreachable."""
    try:
        client = orwell_engine._shared_client()
        started = time.monotonic()
        r = await client.get(orwell_engine.ENGINE_URL.rstrip("/") + "/health", timeout=5.0)
        latency_ms = int((time.monotonic() - started) * 1000)
        if r.status_code == 200:
            body = r.json()
            return (body if isinstance(body, dict) else None), latency_ms
        return None, latency_ms
    except Exception:
        return None, None


def _store_stats() -> dict:
    """Light FE-store counts (sessions/messages + db size) — best-effort, never raises.

    P1: surfaces the DEGRADED-boot flag when init_db() failed (the operator's signal that
    the store is broken and the app is serving in recovery mode), so the status page can
    say so and the recovery buttons remain the obvious next action."""
    stats: dict = {}
    # The degraded-boot diagnostic comes first — it explains WHY the counts below may be
    # missing (a broken/inaccessible DB the app booted past on purpose, P1).
    try:
        from core.database import db_init_error
        err = db_init_error()
        if err:
            stats["degraded"] = True
            stats["initError"] = err.get("error")
    except Exception:
        pass
    try:
        from core.database import SessionLocal, Session as DbSession, ChatMessage as DbChatMessage
        db = SessionLocal()
        try:
            stats["sessions"] = db.query(DbSession).count()
            stats["messages"] = db.query(DbChatMessage).count()
            # ORW-199: which provider each live session uses (host only + model; no key/path).
            from routes.admin_provider_routes import provider_host
            stats["sessionProviders"] = [
                {"id": r.id, "provider": provider_host(r.endpoint_url), "model": r.model}
                for r in db.query(DbSession).filter(DbSession.archived == False)  # noqa: E712
                .order_by(DbSession.last_accessed.desc()).limit(50).all()]
        finally:
            db.close()
    except Exception as e:
        stats["error"] = f"{type(e).__name__}: {e}"
    try:
        from core.database import get_detailed_stats
        stats["database_size_mb"] = get_detailed_stats().get("database_size_mb")
    except Exception:
        pass
    return stats


async def _image_state(user: str | None) -> dict:
    """The image-generation provider state (0051): enabled? model? usable right now?
    Plus (G20) `portraits: {total, present, missing}` — completeness over the ACTIVE
    cast via the shared roster derivation, or None pre-game / engine down. Best-effort —
    a broken resolver reads as available:false, never a 500."""
    state: dict = {"enabled": False, "model": "", "quality": "", "available": False,
                   "portraits": None}
    try:
        from src import orwell_portraits
        enabled, model_spec, quality = orwell_portraits._image_settings(user)
        state.update({"enabled": bool(enabled), "model": model_spec or "", "quality": quality or ""})
        state["available"] = bool(orwell_portraits.image_generation_available(user))
        # M1-9 (audit A9): availability is deliberately permissive ("configured is enough to
        # TRY"), so the row also carries the last run's honest verdict — 0-of-N ⇒ failing.
        state["lastRun"] = orwell_portraits.last_run_outcome(user)
    except Exception as e:
        state["error"] = f"{type(e).__name__}: {e}"
    try:
        from src import orwell_portraits
        state["portraits"] = await orwell_portraits.portrait_completeness(user)
    except Exception:
        state["portraits"] = None
    return state


async def _cast_authoring_state(user: str | None) -> dict | None:
    """Deep cast-authoring completeness `{total, authored, missing, missingIds}` over the ACTIVE NPC
    cast (the player is human-authored, excluded), so the operator can SEE whether the producer-LLM
    actually enriched this cast or it all fell back to the thin deterministic floor (mandate #1). The
    counts come from the SAME helper the backfill acts on (`orwell_cast_authoring.unauthored_ids`), so
    the status page can never disagree with what a re-author lever would do.

    2026-07-12 (owner: the debug bundle showed `castAuthoring: null` while `enrichment.failures`
    carried the real story): PRE-GAME is no longer null-blind — during casting (a warmed but
    unstarted season, exactly when genesis/identity/deep-authoring RUN) this returns a small
    Vault-free run-state block `{pregame, givenUp, houseEntryHold}` (ids/flags only, no cast
    content). None still means unknown (engine down / state unreadable). Best-effort — any
    failure reads as None, never a 500."""
    try:
        from src import orwell_engine, orwell_cast_authoring
    except Exception:
        return None
    try:
        state = await orwell_engine.get_game_state(user=user)
    except Exception:
        return None
    if not isinstance(state, dict):
        return None
    if state.get("started") is False:
        # Casting / pre-game: surface the authoring RUN STATE instead of null-blindness.
        out: dict = {"pregame": True}
        try:
            out["givenUp"] = orwell_cast_authoring.giveups(user)
        except Exception:
            out["givenUp"] = []
        try:
            out["houseEntryHold"] = orwell_cast_authoring.house_entry_gate_status(user)
        except Exception:
            out["houseEntryHold"] = None
        # The pre-warm pipeline's own run state (genesis → identity → author): authorStarted /
        # authorDone / promptCount — the only pre-game completion signal (counts and flags only,
        # no cast content). The golden driver waits on authorDone here so the cast is fully
        # enriched BEFORE the season starts, in record and replay alike.
        try:
            from src import orwell_prewarm
            out["prewarm"] = orwell_prewarm.warm_state(user)
        except Exception:
            out["prewarm"] = None
        return out
    try:
        from routes.orwell_routes import _roster_cards
        cards = _roster_cards(state, user)
        comp = orwell_cast_authoring.authoring_completeness(user, cards)
        comp["missingIds"] = orwell_cast_authoring.unauthored_ids(user, cards)
        return comp
    except Exception:
        return None


# ── Debug-bundle enrichment (owner: "let's beef up that file") ────────────────
# Every helper below is best-effort and Vault-free by construction: it returns ONLY
# operational metadata (versions, counts, names, models, urls, phases, sizes) and
# NEVER an api key, token, .env value, transcript body, roster, or any Vault/soul
# state. A failure reads as an {"error": "..."} string, never a 500 — the bundle is
# the operator's last resort, so it must always assemble.

def _versions() -> dict:
    """FE + engine build/version strings (no secrets) for one-glance triage."""
    out: dict = {}
    try:
        from src.orwell_version import get_display_version, get_build
        out["frontend"] = get_display_version()
        out["build"] = get_build()
    except Exception as e:
        out["frontend"] = f"error: {type(e).__name__}"
    try:
        from core.constants import APP_VERSION
        out["frontendApp"] = APP_VERSION
    except Exception:
        pass
    return out


def _recent_logs(limit: int = 200) -> dict:
    """The tail of the live FE log ring + a recent-ERRORs slice, so a pasted bundle
    carries the in-process log without the operator hunting for files. The ring already
    redacts nothing sensitive (it is the app's own log lines), but we still cap the size."""
    out: dict = {"frontendTail": [], "recentErrors": []}
    try:
        _, lines = log_rings.LIVE.since(0)
        tail = lines[-limit:]
        out["frontendTail"] = [
            {"ts": l.get("ts"), "level": l.get("level"), "logger": l.get("logger"),
             "msg": (l.get("msg") or "")[:1000]}
            for l in tail
        ]
        out["recentErrors"] = [
            e for e in out["frontendTail"]
            if str(e.get("level") or "").upper() in ("ERROR", "CRITICAL", "WARNING")
        ][-60:]
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
    return out


def _update_trigger_ready() -> bool:
    """The update trigger works only if the root ``orwell-ops-update.path`` watcher is installed AND
    active. A bare ``data/ops/`` dir (created on every box) or a stopped unit used to read as
    "installed", so a flag was dropped that nothing would consume."""
    from routes.admin_update_routes import _watcher_unit_path
    return watcher_active(_watcher_unit_path())


def _ops_status_files() -> dict:
    """The ops-status files under the data dir: which log basenames exist, their sizes,
    and a short TAIL of each (the most recent maintenance/diagnostic output). These are the
    app's own ops logs — operational, not secret. Sizes are bounded; tails are clipped."""
    out: dict = {"updateTriggerInstalled": False, "logs": []}
    try:
        # The trigger seam lives in the DEPLOY data dir (where the root path units watch), not the
        # FE app-data dir — check there.
        out["updateTriggerInstalled"] = _update_trigger_ready()
    except Exception:
        pass
    for name in _log_files():
        entry: dict = {"name": name}
        try:
            path = _log_path(name)
            entry["sizeBytes"] = os.path.getsize(path)
            with open(path, "rb") as fh:
                size = entry["sizeBytes"]
                fh.seek(max(0, size - 4096))
                chunk = fh.read(4096)
            entry["tail"] = chunk.decode("utf-8", "replace").splitlines()[-30:]
        except Exception as e:
            entry["error"] = f"{type(e).__name__}: {e}"
        out["logs"].append(entry)
    return out


def _provider_config() -> dict:
    """The configured LLM/image providers — REDACTED: names, models, and base-urls only,
    NEVER the api key. Pulled from the model_endpoints table (the key column is dropped here,
    not just redacted). Best-effort; an unreadable store reads as an error string.

    DB7: the bundle must let an operator answer "which endpoint actually resolves?" — so we
    surface the configured default (`defaultEndpointId` / `defaultModel`) and flag each endpoint
    with `isDefault`, alongside `defaultResolved` (the default endpoint's name/baseUrl). `supportsTools`
    is populated when the column is known (NULL = unknown ⇒ the agent_loop keyword heuristic decides);
    a tool-less default endpoint is exactly what fails casting like F7, so it must be auditable."""
    out: dict = {"endpoints": []}
    # Resolve the configured global default first so each endpoint can be flagged.
    default_ep_id = ""
    default_model = ""
    try:
        from src.settings import load_settings
        _s = load_settings() or {}
        default_ep_id = (_s.get("default_endpoint_id") or "").strip()
        default_model = (_s.get("default_model") or "").strip()
    except Exception:
        pass
    out["defaultEndpointId"] = default_ep_id or None
    out["defaultModel"] = default_model or None
    try:
        from core.database import SessionLocal, ModelEndpoint
        db = SessionLocal()
        try:
            default_resolved = None
            for ep in db.query(ModelEndpoint).all():
                ep_id = getattr(ep, "id", None)
                is_default = bool(default_ep_id) and ep_id == default_ep_id
                # Whitelist of non-secret fields ONLY — api_key is never read.
                entry = {
                    "id": ep_id,
                    "name": getattr(ep, "name", None),
                    "baseUrl": getattr(ep, "base_url", None),
                    "modelType": getattr(ep, "model_type", None),
                    "endpointKind": getattr(ep, "endpoint_kind", None),
                    "isEnabled": bool(getattr(ep, "is_enabled", False)),
                    "isDefault": is_default,
                    "supportsTools": getattr(ep, "supports_tools", None),
                    "hasApiKey": bool(getattr(ep, "api_key", None)),  # presence only, never the value
                }
                out["endpoints"].append(entry)
                if is_default:
                    default_resolved = {
                        "id": ep_id,
                        "name": entry["name"],
                        "baseUrl": entry["baseUrl"],
                        "model": default_model or None,
                        "supportsTools": entry["supportsTools"],
                    }
            out["defaultResolved"] = default_resolved
        finally:
            db.close()
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
    return out


async def _game_state_summary(user: str | None) -> dict:
    """A Vault-free, SCALAR-ONLY game/session summary: started?, phase, week, whose-turn,
    cast/jury counts, the player's status/placement. Reduced from the engine's public
    ceremony projection (gameStatus / getGameState) — NO roster names, NO Vault/soul/secret
    state. Pre-game and engine-down both read as a clean status, never a 500."""
    out: dict = {"available": False}
    try:
        st = await orwell_engine.game_status(user=user)
        if isinstance(st, dict):
            if st.get("started") is False:
                return {"available": True, "started": False}
            out["available"] = True
            out["started"] = bool(st.get("started", True))
            for k in ("week", "phase", "day"):
                if k in st:
                    out[k] = st[k]
            # Whose-turn / pending decision SHAPE only — a key/kind, never content.
            pend = st.get("pending")
            if isinstance(pend, dict):
                out["pendingKind"] = pend.get("kind") or pend.get("type")
            elif pend is not None:
                out["pendingKind"] = str(pend)[:60]
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
    # Counts come from getGameState (still Vault-free) but reduced to integers only.
    try:
        gs = await orwell_engine.get_game_state(user=user)
        if isinstance(gs, dict) and gs.get("started") is not False:
            roster = gs.get("houseguests") or gs.get("cast") or gs.get("roster")
            if isinstance(roster, list):
                out["castCount"] = len(roster)
                out["activeCount"] = sum(
                    1 for h in roster
                    if isinstance(h, dict) and (h.get("status") or "active") == "active"
                )
            jury = gs.get("jury")
            if isinstance(jury, list):
                out["juryCount"] = len(jury)
            player = gs.get("player")
            if isinstance(player, dict):
                out["playerStatus"] = player.get("status")
    except Exception:
        # The scalar summary above is enough; a counts failure is not worth surfacing twice.
        pass
    return out


def _system_info() -> dict:
    """Host/runtime info: python + node versions, platform, disk + memory headroom. All
    operational — no secrets. Memory comes from /proc/meminfo (Linux) when psutil is absent."""
    out: dict = {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "pid": os.getpid(),
    }
    try:
        import subprocess
        node = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=3)
        out["node"] = (node.stdout or "").strip() or (node.stderr or "").strip()[:40]
    except Exception:
        out["node"] = None
    try:
        du = shutil.disk_usage(_data_dir())
        # DB4: derive usedPct from (total - free), the SAME basis as freeMb.
        # `du.used` uses different block accounting than `du.free` on an overlay
        # fs, so `100*used/total` and `freeMb` contradict each other (reported
        # 3.3% used while only ~11% was free). (total - free)/total is internally
        # consistent with the freeMb we surface right next to it.
        out["disk"] = {"totalMb": du.total // (1024 * 1024),
                       "freeMb": du.free // (1024 * 1024),
                       "usedPct": round(100 * (du.total - du.free) / du.total, 1) if du.total else None}
    except Exception:
        pass
    try:
        # Linux /proc/meminfo — kB. Avoids a hard psutil dependency.
        meminfo: dict = {}
        with open("/proc/meminfo", "r", encoding="utf-8") as fh:
            for line in fh:
                key, _, rest = line.partition(":")
                kb = rest.strip().split(" ")[0]
                if kb.isdigit() and key in ("MemTotal", "MemAvailable", "SwapTotal"):
                    meminfo[key] = int(kb)
        if meminfo:
            out["memory"] = {"totalMb": meminfo.get("MemTotal", 0) // 1024,
                             "availableMb": meminfo.get("MemAvailable", 0) // 1024,
                             "swapTotalMb": meminfo.get("SwapTotal", 0) // 1024}
    except Exception:
        pass
    return out


def _feature_flags() -> dict:
    """The build/feature posture: game-build on?, auth on?, embeddings provider, localhost
    bypass. Pure booleans/labels — never a secret value."""
    out: dict = {}
    try:
        from src.settings import game_build_enabled
        out["gameBuild"] = bool(game_build_enabled())
    except Exception:
        out["gameBuild"] = None
    out["authEnabled"] = os.getenv("AUTH_ENABLED", "true").lower() != "false"
    out["localhostBypass"] = os.getenv("LOCALHOST_BYPASS", "false").lower() == "true"
    out["embeddings"] = os.getenv("ORWELL_EMBEDDINGS") or "fake"
    out["multiuser"] = bool(os.getenv("ORWELL_ENGINE_MULTIUSER"))
    return out


def _session_metadata(limit: int = 25) -> dict:
    """Recent chat-session METADATA — id, name, owner, model, message count, timestamps —
    so a playtest report carries which sessions exist WITHOUT shipping a single transcript
    line. Strictly counts/labels: no message content ever leaves the box. Best-effort."""
    out: dict = {"recent": []}
    try:
        from core.database import SessionLocal, Session as DbSession
        db = SessionLocal()
        try:
            rows = (db.query(DbSession)
                      .order_by(DbSession.last_accessed.desc())
                      .limit(limit).all())
            for s in rows:
                out["recent"].append({
                    "id": getattr(s, "id", None),
                    "name": getattr(s, "name", None),  # a user-chosen title, not transcript content
                    "owner": getattr(s, "owner", None),
                    "model": getattr(s, "model", None),
                    "messageCount": getattr(s, "message_count", None),
                    "mode": getattr(s, "mode", None),
                    "createdAt": s.created_at.isoformat() if getattr(s, "created_at", None) else None,
                    "lastAccessed": s.last_accessed.isoformat() if getattr(s, "last_accessed", None) else None,
                })
        finally:
            db.close()
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
    return out


# F11/BL-056: a sane per-game spend-alert threshold used when the admin left `token_spend_alert_usd`
# at its 0.0 default (which `check_soft_alert` reads as "disabled"). A single game is a handful of
# cents to a few dollars of tokens, so ~$10 is a comfortable "something is runaway" tripwire.
_DEFAULT_SPEND_ALERT_USD = 10.0


def _token_economy(user: str | None) -> dict:
    """ADR 0010 / feature 0069 — the admin token-economy view for one user.

    Vault-free / body-free BY CONSTRUCTION: the ledger stores ONLY numbers, short ids,
    and one known call-class token (no message body, narration, prompt, or engine secret
    can land in it — enforced in orwell_token_ledger). This helper reads that store and
    derives a small summary; it never touches the Vault or any transcript.

    Returns the recent ledger entries, a per-session cost total + whether the soft alert
    (against the admin-set ``token_spend_alert_usd``) is tripped, and an aggregate summary
    (summed token counts by kind, total cost, latest context-percent). Best-effort — a
    missing/corrupt store reads as empty numbers, never a 500."""
    from src import orwell_token_ledger
    from src.settings import get_setting

    out: dict = {"user": user or "default"}
    try:
        threshold = float(get_setting("token_spend_alert_usd", 0.0) or 0.0)
    except (TypeError, ValueError):
        threshold = 0.0
    # F11/BL-056: the shipped default is 0.0, which `check_soft_alert` treats as "disabled" — so the
    # ops view showed `spendAlertThresholdUsd: 0.0`, reading as an UNSET/misconfigured alert rather
    # than an armed cost guard. Arm a sane per-game default when the admin left it at 0 (or set a
    # non-positive value); an explicit positive admin value always wins. Surfaced with
    # `spendAlertThresholdDefaulted` so the UI can show it's the default, not an operator choice.
    defaulted = threshold <= 0
    if defaulted:
        threshold = _DEFAULT_SPEND_ALERT_USD
    out["spendAlertThresholdUsd"] = threshold
    out["spendAlertThresholdDefaulted"] = defaulted

    entries: list = []
    try:
        entries = orwell_token_ledger.get_recent(user, limit=200)
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"
        entries = []
    out["entries"] = entries

    # Per-session cost totals + per-session soft-alert state (strictly-over the threshold).
    sessions: dict = {}
    for e in entries:
        sid = e.get("session") or ""
        if sid and sid not in sessions:
            try:
                total = orwell_token_ledger.game_cost_total(user, sid)
            except Exception:
                total = 0.0
            try:
                alert = orwell_token_ledger.check_soft_alert(user, sid, threshold)
            except Exception:
                alert = False
            sessions[sid] = {"costTotal": total, "softAlert": bool(alert)}
    out["sessions"] = sessions
    out["softAlert"] = any(s.get("softAlert") for s in sessions.values())

    # Aggregate summary — summed token counts by kind, total cost, latest context-percent.
    summary = {
        "inputTokens": 0, "cachedTokens": 0, "reasoningTokens": 0, "outputTokens": 0,
        "totalCost": 0.0, "latestContextPercent": None, "turns": len(entries),
        # A-3: how much of totalCost is the FE's own estimate (DeepSeek reports no dollar cost) rather than a
        # provider-reported figure, so the operator never reads an estimate as authoritative.
        "estimatedCost": 0.0, "costIsEstimated": False,
    }
    for e in entries:
        for k in ("inputTokens", "cachedTokens", "reasoningTokens", "outputTokens"):
            try:
                summary[k] += int(e.get(k) or 0)
            except (TypeError, ValueError):
                pass
        try:
            summary["totalCost"] += float(e.get("cost") or 0.0)
            if e.get("costEstimated"):
                summary["estimatedCost"] += float(e.get("cost") or 0.0)
                summary["costIsEstimated"] = True
        except (TypeError, ValueError):
            pass
    if entries:
        summary["latestContextPercent"] = entries[-1].get("contextPercent")
    # Cost-observability: the DERIVED prompt-cache hit rate (feature 0069 / cost lane). The raw
    # cachedTokens are already tracked per turn (OpenRouter usage.prompt_tokens_details.cached_tokens),
    # but the operator had no at-a-glance measure of how well provider prompt-caching is actually
    # landing. cachedTokens is the cached SUBSET of inputTokens (== usage.prompt_tokens, cached
    # inclusive), so the fraction is well-defined in [0,1]; null when there is no input yet (avoids a
    # divide-by-zero and reads as "no data" rather than a fake 0%). Vault-free scalar — pure arithmetic
    # over two Vault-free counters. This is the meter you watch when tuning the cacheable prefix.
    # ORW-198: slow-turn suspects - turns whose reasoning tokens exceeded the alarm bar (ids and counts only).
    from src.orwell_token_ledger import REASONING_ALARM_TOKENS, reasoning_alarm
    _alarms = [e for e in entries if reasoning_alarm(e)]
    summary["reasoningAlarmTokens"] = REASONING_ALARM_TOKENS
    summary["reasoningAlarmCount"] = len(_alarms)
    summary["reasoningAlarms"] = [{"turnId": e.get("turnId"), "session": e.get("session"), "reasoningTokens": e.get("reasoningTokens")} for e in _alarms[-10:]]
    _inp = summary["inputTokens"]
    summary["cacheHitRate"] = round(summary["cachedTokens"] / _inp, 4) if _inp > 0 else None
    out["summary"] = summary
    return out


# ── Schema 3: "include everything an operator/debugger could need" (owner, 2026-07-13) ──
# Every helper below follows the same two hard lines as the rest of this module:
#   * Vault-free by construction — each reads ONLY Vault-free FE ledgers/rings/stores or
#     the engine's public/admin projections (NO new engine tools; `sandboxHealth` and the
#     portrait-prompt read are existing admin/player-channel reads). The one sanctioned
#     Vault crossing stays `_producer_vault_section`, reached ONLY on the unsealed export.
#   * Secrets redacted — the assembled bundle passes through `_scrub_bundle` (key-shaped
#     credential redaction + string scrubbing for bearer/vendor-key shapes) before it is
#     serialized, so an Authorization header / api key can never ride out inside ANY
#     section (incl. LLM I/O records, chat content, settings).
# Each helper is fail-soft: a broken subsystem degrades to an {"error": ...} section (the
# meta.sections index marks it), never a build error — the bundle must always assemble.

BUNDLE_SCHEMA = 3
_BUNDLE_CHAT_MSG_CAP = 500          # last N messages per session (bound the unbounded)
_BUNDLE_LLM_IO_CAP = 200            # last N full LLM I/O records (the live ring's seed size)
_BUNDLE_LLM_IO_TAIL_BYTES = 8 * 1024 * 1024  # bounded tail read of the durable archive
_BUNDLE_RING_LIMIT = 100_000        # "everything the ring holds" (rings cap themselves)

# Key shapes whose STRING values are credentials — redacted wherever they appear. Deliberately
# `token(?!s)` so the plural *_tokens COUNT fields (inputTokens, maxTokens, prompt_tokens …)
# survive while `token`/`access_token`/`api_token` values are masked (same discriminator as
# src/llm_trace._scrub). Booleans/numbers are never redacted (presence flags like `hasApiKey`
# and numeric budgets are not secrets).
# BL-057: 'secret' is credential-shaped ONLY (standalone/trailing or `secret[_-](key|token|id|
# access[_-]?key)`), never a prefix adjective on a non-credential word (…SECRET_PACING) — so a
# feature flag whose NAME merely contains "secret" isn't spuriously value-redacted. `token(?![a-z0-9])`
# is boundary/suffix-aware (under IGNORECASE the class also excludes A-Z): it matches the credential
# forms (`token`/`token_id`/`access_token`/`api_token`) but NOT the plural *_tokens COUNT fields
# (inputTokens/maxTokens) NOR benign words like TOKENIZER/TOKENIZED/TOKENIZATION_MODE.
_BUNDLE_SECRET_KEY_RE = re.compile(
    r"authorization|api[-_]?key|token(?![a-z0-9])|" + _SECRET_WORD +
    r"|password|passwd|credential|bearer",
    re.IGNORECASE)


def _scrub_text(s: str) -> str:
    """Defence-in-depth string scrub: vendor-prefixed api keys (sk-/ghp_/…), Authorization /
    x-api-key header values, URL query-param secrets, and bare `Bearer <token>` shapes."""
    try:
        from src.secret_redaction import redact
        s = redact(s)
    except Exception:
        pass
    try:
        from src.llm_trace import _scrub_str
        s = _scrub_str(s)
    except Exception:
        pass
    return s


def _scrub_bundle(obj, redact_keys: bool = True):
    """Recursively scrub a bundle object BEFORE serialization.

    * a dict key matching `_BUNDLE_SECRET_KEY_RE` with a STRING value ⇒ the value is
      replaced with the REDACTED marker (an `Authorization` header in a stored session's
      headers, an `api_key` in a settings snapshot, …);
    * every string value (any key) is passed through `_scrub_text`;
    * dicts/lists recurse; other scalars cross unchanged.

    `redact_keys=False` is used ONLY for the unsealed producerVault section: its game
    "secrets" are the deliberately-revealed content (mandate #2 override), so key-shaped
    game fields must survive — but the credential STRING scrub still applies (Vault ≠
    credentials)."""
    if isinstance(obj, str):
        return _scrub_text(obj)
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            if (redact_keys and isinstance(k, str) and isinstance(v, str) and v
                    and _BUNDLE_SECRET_KEY_RE.search(k)):
                out[k] = REDACTED
            else:
                out[k] = _scrub_bundle(v, redact_keys)
        return out
    if isinstance(obj, list):
        return [_scrub_bundle(v, redact_keys) for v in obj]
    return obj


def _llm_io_section() -> dict:
    """0112 — the full LLM I/O record tail: complete request/response records (system
    prompts + messages + REASONING + tool calls + finish reasons + per-call class `kind`
    + the applied maxTokens), from the durable `llm-io.jsonl` archive the LLMIO ring is
    seeded from. Since 2026-07-13 (prod bundle audit) each record also carries TOP-LEVEL
    `finishReason` and `callClass` triage fields (records that predate the change simply
    lack them), so an empty `finish_reason=stop` utility completion is spottable without
    digging into `response`. Records were auth-scrubbed at write time (llm_trace._scrub)
    and are re-scrubbed on export by `_scrub_bundle`. Bounded to the ring's natural seed
    size."""
    from src import llm_trace
    out: dict = {"meta": {"source": "llm-io.jsonl", "cap": _BUNDLE_LLM_IO_CAP,
                          "truncated": False}, "records": []}
    path = llm_trace.trace_path()
    try:
        size = os.path.getsize(path)
    except OSError:
        out["meta"]["note"] = "no LLM I/O archive on disk"
        return out
    out["meta"]["fileBytes"] = size
    with open(path, "rb") as fh:
        partial = size > _BUNDLE_LLM_IO_TAIL_BYTES
        if partial:
            fh.seek(size - _BUNDLE_LLM_IO_TAIL_BYTES)
        chunk = fh.read()
    lines = chunk.decode("utf-8", "replace").splitlines()
    if partial and len(lines) > 1:
        lines = lines[1:]  # drop the (likely truncated) first line from a mid-file seek
    parsed = []
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        try:
            rec = json.loads(ln)
        except (ValueError, TypeError):
            continue
        if isinstance(rec, dict):
            parsed.append(rec)
    out["meta"]["truncated"] = partial or len(parsed) > _BUNDLE_LLM_IO_CAP
    # #1865: redact sealed call class records unless vault is unsealed
    from src import llm_trace as _lt
    vault_open = _lt._vault_is_unsealed()
    raw = parsed[-_BUNDLE_LLM_IO_CAP:]
    if not vault_open:
        out["records"] = [_lt.redact_sealed_record(r) for r in raw]
    else:
        out["records"] = raw
    return out


def _chat_store_section() -> dict:
    """The COMPLETE chat store dump: every session with its metadata AND its messages
    (role, content, parsed metadata — reasoning / tool_events / round_texts /
    client_msg_id / variants ride inside — seq, timestamps), capped at the LAST
    `_BUNDLE_CHAT_MSG_CAP` messages per session (truncation noted in the meta).
    Session `headers` are NEVER dumped (they can carry Authorization) — presence only."""
    from sqlalchemy import func as _sqlfunc
    from core.database import SessionLocal, Session as DbSession, ChatMessage as DbChatMessage
    out: dict = {"meta": {"messageCapPerSession": _BUNDLE_CHAT_MSG_CAP,
                          "truncatedSessions": [], "sessionCount": 0, "messageCount": 0},
                 "sessions": []}
    db = SessionLocal()
    try:
        rows = db.query(DbSession).order_by(DbSession.last_accessed.desc()).all()
        for s in rows:
            sid = getattr(s, "id", None)
            entry: dict = {
                "id": sid,
                "name": getattr(s, "name", None),
                "owner": getattr(s, "owner", None),
                "model": getattr(s, "model", None),
                "endpointUrl": getattr(s, "endpoint_url", None),
                "mode": getattr(s, "mode", None),
                "folder": getattr(s, "folder", None),
                "archived": bool(getattr(s, "archived", False)),
                "messageCount": getattr(s, "message_count", None),
                "hasHeaders": bool(getattr(s, "headers", None)),  # presence only, never values
                "createdAt": s.created_at.isoformat() if getattr(s, "created_at", None) else None,
                "lastAccessed": s.last_accessed.isoformat() if getattr(s, "last_accessed", None) else None,
                "lastMessageAt": s.last_message_at.isoformat() if getattr(s, "last_message_at", None) else None,
                "messages": [],
            }
            try:
                total = (db.query(_sqlfunc.count(DbChatMessage.id))
                           .filter(DbChatMessage.session_id == sid).scalar()) or 0
                msgs = (db.query(DbChatMessage)
                          .filter(DbChatMessage.session_id == sid)
                          .order_by(DbChatMessage.seq.desc(), DbChatMessage.timestamp.desc())
                          .limit(_BUNDLE_CHAT_MSG_CAP).all())
                msgs.reverse()  # chronological
                for m in msgs:
                    meta = None
                    raw_meta = getattr(m, "meta_data", None)
                    if raw_meta:
                        try:
                            meta = json.loads(raw_meta)
                        except (ValueError, TypeError):
                            meta = str(raw_meta)[:2000]
                    entry["messages"].append({
                        "id": getattr(m, "id", None),
                        "seq": getattr(m, "seq", None),
                        "role": getattr(m, "role", None),
                        "content": getattr(m, "content", None),
                        "timestamp": m.timestamp.isoformat() if getattr(m, "timestamp", None) else None,
                        "metadata": meta,
                    })
                if total > _BUNDLE_CHAT_MSG_CAP:
                    out["meta"]["truncatedSessions"].append(
                        {"id": sid, "total": int(total), "included": len(entry["messages"])})
                out["meta"]["messageCount"] += len(entry["messages"])
            except Exception as e:
                entry["messagesError"] = f"{type(e).__name__}: {e}"
            out["sessions"].append(entry)
        out["meta"]["sessionCount"] = len(out["sessions"])
    finally:
        db.close()
    return out


def _frontend_log_section() -> dict:
    """The FULL front-end log ring (everything `log_rings.LIVE` holds — not just the
    tail), plus the WARN/ERROR history filtered from it."""
    _, lines = log_rings.LIVE.since(0, limit=_BUNDLE_RING_LIMIT)
    warn_errors = [l for l in lines
                   if str(l.get("level") or "").upper() in ("WARNING", "ERROR", "CRITICAL")]
    return {"meta": {"count": len(lines), "warnErrorCount": len(warn_errors),
                     "note": "the in-process ring (capped); older history lives in on-disk logs"},
            "lines": lines, "warnErrors": warn_errors}


def _token_ledger_section(user: str | None) -> dict:
    """ADR 0010 / 0069 — the full per-turn token/cost ledger view (entries incl.
    appliedMaxTokens + finishReason), via the same helper the admin route serves."""
    return _token_economy(user)


def _sync_ledger_section(user: str | None) -> dict:
    """0065 Part D — the per-turn sync/divergence ledger + the belt-fire telemetry
    aggregate (`get_belt_totals`)."""
    from src import orwell_sync_ledger as _sl
    recent = _sl.get_recent(user, limit=200)
    return {"meta": {"count": len(recent)}, "recent": recent,
            "beltTotals": _sl.get_belt_totals(user)}


def _enrichment_section(user: str | None) -> dict:
    """The enrichment policy + its LOUD failure ledger (call-class names, reasons,
    timestamps — never content)."""
    from src import enrichment_policy as _ep
    fails = _ep.failures(user)
    return {"meta": {"count": len(fails)}, "policy": _ep.current_policy(), "failures": fails}


def _overseer_section(user: str | None) -> dict:
    """0079 — the overseer report ring (the log_rings OVERSEER channel: diagnoses,
    levers, beatSeq before→after), plus the opt-in verbose debug telemetry when on."""
    _, lines = log_rings.OVERSEER.since(0, limit=_BUNDLE_RING_LIMIT)
    out: dict = {"meta": {"count": len(lines)}, "reports": lines}
    try:
        from src import orwell_overseer_debug as _ovd
        if _ovd.overseer_debug_enabled():
            out["debug"] = {"tier": _ovd.overseer_debug_tier(),
                            "recent": _ovd.get_recent(200, user=user)}
    except Exception as e:
        out["debugError"] = f"{type(e).__name__}: {e}"
    return out


async def _cast_authoring_section(user: str | None, state=None, cards=None) -> dict:
    """Deep cast-authoring DETAIL: per-NPC authored/floored + attempts spent + give-ups,
    the pre-game run state, and the completeness counters — all from the SAME helpers the
    backfill acts on (Vault-free public roster projection only). `state`/`cards` are the
    shared per-bundle reads (one engine round-trip for every section that needs them)."""
    from src import orwell_cast_authoring as _ca
    out: dict = {"meta": {}, "perNpc": []}
    attempts = {}
    try:
        attempts = _ca.attempts_spent(user)
        out["attemptsSpent"] = attempts
    except Exception:
        out["attemptsSpent"] = {}
    try:
        out["givenUp"] = _ca.giveups(user)
    except Exception:
        out["givenUp"] = []
    if isinstance(state, dict) and state.get("started") is False:
        out["pregame"] = True
    elif isinstance(state, dict) and cards is not None:
        try:
            out["completeness"] = _ca.authoring_completeness(user, cards)
            out["missingIds"] = _ca.unauthored_ids(user, cards)
            given = set(out.get("givenUp") or [])
            for c in cards:
                if not isinstance(c, dict) or c.get("isPlayer") or c.get("id") == "player":
                    continue
                hid = str(c.get("id") or "")
                out["perNpc"].append({
                    "id": hid,
                    "name": c.get("name"),
                    "status": c.get("status"),
                    "authored": bool(c.get("authored")),
                    "attemptsSpent": int(attempts.get(hid, 0) or 0),
                    "givenUp": hid in given,
                })
        except Exception as e:
            out["rosterError"] = f"{type(e).__name__}: {e}"
    out["meta"]["count"] = len(out["perNpc"])
    return out


def _house_entry_section(user: str | None) -> dict:
    """The house-entry gate: the current HOLD/refusal marker (with its timestamp), whether
    the background gate-clear WATCH is armed, and the operator floor-start escape hatch."""
    from src import orwell_cast_authoring as _ca
    out: dict = {}
    try:
        out["hold"] = _ca.house_entry_gate_status(user)
    except Exception:
        out["hold"] = None
    try:
        out["watchActive"] = _ca.house_ready_watch_active(user)
    except Exception:
        out["watchActive"] = None
    try:
        out["floorStartAllowed"] = _ca.floor_start_allowed()
    except Exception:
        out["floorStartAllowed"] = None
    return out


async def _portrait_section(user: str | None, state=None, cards=None) -> dict:
    """0051 portrait/image state: the per-NPC manifest (file/name/source/prompt
    fingerprint), completeness, last run + live progress, the G20 retry-budget counters,
    the attempt log (its own capped ring), and the current Vault-free portrait prompts
    re-derived from the engine's PUBLIC facets (an existing player-channel read).
    `state`/`cards` are the shared per-bundle reads."""
    from src import orwell_portraits as _op
    out: dict = {"meta": {}}
    try:
        out["manifest"] = _op.load_manifest(user)
    except Exception:
        out["manifest"] = {}
    try:
        out["lastRun"] = _op.last_run_outcome(user)
    except Exception:
        out["lastRun"] = None
    try:
        out["progress"] = _op.generation_progress(user)
    except Exception:
        out["progress"] = None
    try:
        out["budget"] = _op.reconcile_budget(user)
    except Exception:
        out["budget"] = {}
    try:
        out["attemptLog"] = _op.read_attempt_log()
    except Exception:
        out["attemptLog"] = []
    # The last Vault-free prompts (engine-built, public-facets-only). Bounded to the
    # active cast; best-effort with an overall timeout — an unreachable engine ⇒ [].
    prompts: list = []
    active_ids: list = []
    try:
        if isinstance(state, dict) and state.get("started") is not False and cards:
            active_ids = [c.get("id") for c in cards
                          if isinstance(c, dict) and (c.get("status") or "active") == "active"
                          and c.get("id")]
            out["completeness"] = _op.completeness(user, cards)

            async def _one(hid):
                try:
                    p = await orwell_engine.get_portrait_prompt(hid, user=user)
                    return p if isinstance(p, dict) else None
                except Exception:
                    return None

            results = await asyncio.wait_for(
                asyncio.gather(*(_one(h) for h in active_ids)), timeout=10.0)
            prompts = [r for r in results if r]
    except Exception:
        prompts = []
    out.setdefault("completeness", None)
    out["prompts"] = prompts
    out["meta"]["count"] = len(out.get("manifest") or {})
    return out


def _settings_section() -> dict:
    """The full settings snapshot (the admin already receives this dict via the admin
    settings route) — every secret-shaped value is redacted by `_scrub_bundle` before
    serialization; this helper just snapshots the dict."""
    from src.settings import load_settings
    s = load_settings() or {}
    return {"settings": dict(s), "meta": {"count": len(s)}}


async def _sandbox_health_section(user: str | None) -> dict:
    """The engine's per-sandbox health/fault-ring projection — an EXISTING admin-channel
    read (`sandboxHealth`); Vault-free by the engine's own admin-surface construction.
    Play-clock stamps arrive RELABELED (`lastAdvancePlayClock` / `faults[].whenPlayClock`
    + the `playClock` legend — orwell_engine.label_play_clock, 2026-07-13): the engine's
    LogicalClock values look like epoch-ms but are NOT wall time and must never be
    rendered as a date."""
    h = await orwell_engine.sandbox_health(user=user)
    return h if isinstance(h, dict) else {"error": "no sandbox health available"}


# The schema-3 section registry: name → builder (sync or async). Drives both the
# assembly and the meta.sections index, so a new section is one line here.
# `state`/`cards` are the SHARED per-bundle reads (one engine round-trip + one roster
# derivation for every section that needs them — an unreachable engine costs one
# bounded failure, not one per section).
def _bundle_v3_builders(user: str | None, state, cards) -> list:
    return [
        ("llmIo", _llm_io_section),
        ("chatStore", _chat_store_section),
        ("frontendLog", _frontend_log_section),
        ("tokenEconomy", lambda: _token_ledger_section(user)),
        ("syncLedger", lambda: _sync_ledger_section(user)),
        ("enrichment", lambda: _enrichment_section(user)),
        ("overseer", lambda: _overseer_section(user)),
        ("castAuthoring", lambda: _cast_authoring_section(user, state, cards)),
        ("houseEntry", lambda: _house_entry_section(user)),
        ("portraits", lambda: _portrait_section(user, state, cards)),
        ("settings", _settings_section),
        ("sandboxHealth", lambda: _sandbox_health_section(user)),
    ]


async def _bundle_v3_sections(user: str | None) -> dict:
    """Build every schema-3 section, each individually fail-soft: a broken subsystem
    yields an {"error": ...} section (marked in the meta index), never a build error."""
    # The shared engine reads (fail-soft: engine down ⇒ None ⇒ the sections that need
    # them simply carry less).
    state = None
    cards = None
    try:
        state = await orwell_engine.get_game_state(user=user)
    except Exception:
        state = None
    if isinstance(state, dict) and state.get("started") is not False:
        try:
            from routes.orwell_routes import roster_cards
            cards = roster_cards(state, user)
        except Exception:
            cards = None
    out: dict = {}
    for name, builder in _bundle_v3_builders(user, state, cards):
        try:
            v = builder()
            if inspect.isawaitable(v):
                v = await v
            out[name] = v
        except Exception as e:
            out[name] = {"error": f"{type(e).__name__}: {e}"}
    return out


# Ordered: the FIRST matching key is the section's natural item collection (e.g. the
# token ledger's "entries" must win over its per-session cost map "sessions").
_SECTION_COUNT_KEYS = ("records", "entries", "recent", "lines", "failures", "reports",
                       "perNpc", "sessions", "manifest", "endpoints", "frontendTail",
                       "logs", "settings")


def _section_count(val):
    """A best-effort per-section item count for the meta index."""
    if isinstance(val, list):
        return len(val)
    if isinstance(val, dict):
        for k in _SECTION_COUNT_KEYS:
            v = val.get(k)
            if isinstance(v, (list, dict)):
                return len(v)
        return None
    return None


def _sections_index(bundle: dict, names: list) -> dict:
    """The meta.sections index: what's present / skipped (with the error), and per-
    section item counts + truncation notes."""
    idx: dict = {}
    for name in names:
        val = bundle.get(name)
        entry: dict = {"present": val is not None}
        if isinstance(val, dict):
            err = val.get("error")
            if err and isinstance(err, str):
                entry["present"] = bool([k for k in val if k != "error"])
                entry["error"] = err
            meta = val.get("meta")
            if isinstance(meta, dict):
                if meta.get("truncated") or meta.get("truncatedSessions"):
                    entry["truncated"] = True
        count = _section_count(val)
        if count is not None:
            entry["items"] = count
        idx[name] = entry
    return idx


# Every top-level content section, in bundle order (schema 2 carry-overs + schema 3).
_BUNDLE_SECTION_NAMES = [
    "health", "recentFailures", "config", "versions", "systemInfo", "featureFlags",
    "logs", "opsStatus", "providerConfig", "gameState", "sessions", "overseerDebug",
    "llmIo", "chatStore", "frontendLog", "tokenEconomy", "syncLedger", "enrichment",
    "overseer", "castAuthoring", "houseEntry", "portraits", "settings", "sandboxHealth",
]


async def _assemble_bundle(user: str | None) -> dict:
    """The ONE bundle assembler (owner ruling 2026-07-13): builds the complete, Vault-free
    schema-3 bundle, secret-scrubbed and carrying the meta.sections index. The unsealed
    export is THIS bundle plus the producerVault section — attached by the route, behind
    the explicit unseal gate, so the two flavors can never drift."""
    try:
        snapshot = await _health_snapshot(user)
    except Exception as e:
        snapshot = {"generatedAt": datetime.now(timezone.utc).isoformat(),
                    "error": f"health snapshot failed: {type(e).__name__}: {e}"}
    try:
        extras = await _bundle_extras(user)
    except Exception as e:
        extras = {"error": f"bundle extras failed: {type(e).__name__}: {e}"}
    try:
        v3 = await _bundle_v3_sections(user)
    except Exception as e:
        v3 = {"error": f"schema-3 sections failed: {type(e).__name__}: {e}"}
    bundle: dict = {
        "bundle": "orwell-debug",
        "schema": BUNDLE_SCHEMA,
        "generatedAt": snapshot.get("generatedAt") or datetime.now(timezone.utc).isoformat(),
        "health": snapshot,
        # The engine's recent-failure ring, hoisted for one-glance triage
        # (tool name + sanitized error class + timing only — G1 engine side).
        "recentFailures": (snapshot.get("engine") or {}).get("recentFailures", []),
        "config": _redact_config(dict(os.environ)),
        # ── BEEFED-UP sections (schema 2) — all Vault-free + secret-free by construction ──
        "versions": extras.get("versions"),
        "systemInfo": extras.get("systemInfo"),
        "featureFlags": extras.get("featureFlags"),
        "logs": extras.get("logs"),
        "opsStatus": extras.get("opsStatus"),
        "providerConfig": extras.get("providerConfig"),
        "gameState": extras.get("gameState"),
        "sessions": extras.get("sessions"),
    }
    if isinstance(extras, dict) and "overseerDebug" in extras:
        bundle["overseerDebug"] = extras["overseerDebug"]
    # ── schema-3 sections (each fail-soft; see _bundle_v3_sections) ──
    if isinstance(v3, dict) and "error" in v3 and len(v3) == 1:
        bundle["sectionsError"] = v3["error"]
    else:
        bundle.update(v3 if isinstance(v3, dict) else {})
    # HARD LINE #2: credential redaction over the WHOLE assembled bundle (both flavors).
    bundle = _scrub_bundle(bundle)
    bundle["meta"] = {
        "schema": BUNDLE_SCHEMA,
        "sections": _sections_index(bundle, _BUNDLE_SECTION_NAMES),
    }
    # The Vault section row exists in BOTH flavors' index (self-describing); the route
    # flips it to present on the unsealed export.
    bundle["meta"]["sections"]["producerVault"] = {
        "present": False,
        "note": "vault-free export — the unsealed export (explicit ?vault=1 behind the "
                "/admin/status spoiler affordance) adds the live Producer's Vault",
    }
    return bundle


async def _bundle_extras(user: str | None) -> dict:
    """Assemble the BEEFED-UP sections of the debug bundle. Each is best-effort and
    Vault-free; the whole assembly is wrapped so the bundle always serializes."""
    extras: dict = {}
    extras["versions"] = _versions()
    extras["systemInfo"] = await asyncio.to_thread(_system_info)
    extras["featureFlags"] = _feature_flags()
    extras["logs"] = _recent_logs()
    extras["opsStatus"] = await asyncio.to_thread(_ops_status_files)   # shells out to `systemctl is-active`
    extras["providerConfig"] = _provider_config()
    extras["sessions"] = _session_metadata()
    try:
        extras["gameState"] = await _game_state_summary(user)
    except Exception as e:
        extras["gameState"] = {"error": f"{type(e).__name__}: {e}"}
    # Verbose overseer/corrector DEBUG telemetry (opt-in, default OFF). Only populated when the
    # ORWELL_OVERSEER_DEBUG / settings `overseer_debug` flag is on — the recent ring-buffer entries
    # (Vault-free: tool/guardrail NAMES, verdicts, injected-arg KEY shapes only). When off the
    # section is omitted entirely, so the bundle is byte-unchanged.
    try:
        from src import orwell_overseer_debug as _ovd
        if _ovd.overseer_debug_enabled():
            extras["overseerDebug"] = {
                "tier": _ovd.overseer_debug_tier(),
                "recent": _ovd.get_recent(100),
            }
    except Exception as e:
        extras["overseerDebug"] = {"error": f"{type(e).__name__}: {e}"}
    return extras


async def _producer_vault_section(user: str | None) -> dict:
    """DEBUG — the owner-ruled OVERRIDE of mandate #2, OPT-IN ONLY (the ``?vault=1`` debug bundle).

    UNLIKE every other helper in this module — which are Vault-free BY CONSTRUCTION — this one
    DELIBERATELY returns live Vault content. It is the same single sanctioned LIVE reveal the
    status-page "Producer's Vault — Unseal" button uses: it crosses the engine's out-of-band
    ``producerVault`` admin capability via ``orwell_engine.producer_vault()`` (NOT an advertised
    tool; admin/God-Mode channel only). It is reached ONLY when the route's explicit opt-in flag
    is set AND ``require_admin`` has already cleared — never on a player path, never always-on.

    Fail-soft like the rest of the bundle: an engine error / no active game reads as an
    ``{"error": ...}`` section, never a 500. Do NOT call this from the default bundle path."""
    try:
        dump = await orwell_engine.producer_vault(user=user)
    except Exception as e:
        return {"error": f"{type(e).__name__}: {e}"}
    if not isinstance(dump, dict) or not dump:
        return {"error": "no active game to unseal"}
    logger.info("[ops] admin UNSEALED the producer's vault into the debug bundle (opt-in override of mandate #2)")
    return dump


# ── #1599 WORK ITEMS 2 + 3: per-class/-tool health rollup + RED alarms ──────────────────────
#
# WI2 — a rolling, Vault-free FAILURE-RATE rollup keyed by class, built entirely from the existing
# in-process signals (the LLMIO / Engine-I/O / OVERSEER rings + the sync ledger). WI3 — the RED
# alarms for game-breaking signals, derived from that rollup + the snapshot's engine/embeddings/
# sandbox reads. Both ride on /api/admin/health (the 10s-polled status payload) so the operator sees
# them without opening the debug bundle. Nothing here reads game content or the Vault — only tool
# names, call classes, counts, timings, and the ok/degraded/circuit booleans.

_ROLLUP_WINDOW_S = 3600  # the rolling window (seconds) the rollup + alarms aggregate over

# Engine write-back / progression tools whose failure STORM is game-breaking (WI3).
_WRITEBACK_TOOLS = frozenset({
    "recordImageBeat", "recordInteraction", "recordCastProfile", "recordWorldSnapshot",
    "preSeedCast", "recordDeepProfile", "advanceGame", "submitDecision", "makeDeal",
    "createCharacter",
})
# The soft-failure class namespaces record_soft_failure emits (log_rings) — the rollup buckets
# OVERSEER-ring failures under these, distinct from ordinary 0079 overseer report entries.
_SOFT_FAIL_PREFIXES = ("overseer:", "faith:", "enrichment:", "sync:")
_STORM_THRESHOLD = 3  # N failures in the window ⇒ a RED "storm/burst" alarm


def _within_window(ts_ms, now_ms, window_s) -> bool:
    if ts_ms is None:
        return True  # entries predating the ts field still count (best-effort)
    try:
        return (now_ms - int(ts_ms)) <= window_s * 1000
    except (TypeError, ValueError):
        return True


def _norm_user(user) -> str:
    """Normalize a user key the SAME way the sync ledger (`orwell_sync_ledger._key`) and the rest
    of the relay do — a missing/blank user maps to the shared ``default`` bucket. Used to match an
    OVERSEER ring entry's ``user`` field against the REQUESTING user so the per-user rollup/alarms
    show only that user's soft-failures. Cross-user isolation is first-class alongside the Vault
    Wall: user A's soft-failure must NEVER light RED (or inflate the rollup) in user B's
    /api/admin/health."""
    try:
        return (user or "default").strip() or "default"
    except Exception:
        return "default"


def _llm_class_of(entry) -> str:
    """The call class for an LLMIO ring entry — the structured field if present (#1599 WI2 seeded
    it), else parsed from the ``kind[callClass]`` msg prefix, else the bare kind."""
    cls = entry.get("callClass")
    if cls:
        return str(cls)
    msg = str(entry.get("msg") or "")
    head = msg.split(" · ", 1)[0]
    if "[" in head and head.endswith("]"):
        return head[head.index("[") + 1:-1] or str(entry.get("kind") or "?")
    return str(entry.get("kind") or head or "?")


def _entry_failed(entry) -> bool:
    if entry.get("ok") is False:
        return True
    return str(entry.get("level") or "").upper() in ("ERROR", "CRITICAL")


# F7 (#1599 follow-on): a SEMANTIC no-op is an HTTP-ok LLM call whose OUTPUT was semantically
# dropped — the ok/failed axis can't see it, so the rollup reports 0 failures for a call that
# "applied nothing" (a reasoning-channel length-cut that left no usable body; the doubled-JSON
# identity parse). `record_llm_call` already flips a genuinely-EMPTY/timeout completion to
# ok:False (S6a), so the remaining blind spot is an ok record TRUNCATED by the output cap
# (finishReason == "length") — the classic reasoning-channel length-cut behind "genesis calls
# died to reasoning-channel length-cuts". Counted alongside `failed` so a clean-looking failure
# rate no longer hides a stream of dropped completions.
def _entry_semantic_noop(entry) -> bool:
    if _entry_failed(entry):
        return False  # already counted on the failed axis; don't double-count
    finish = str(entry.get("finishReason") or "").lower()
    if finish != "length":
        return False
    # A length-capped completion is a SEMANTIC no-op only when it ALSO dropped its body — an
    # ordinary capped-but-usable completion still carried text / tool output and DID apply
    # something (counting it would trip a false `semantic-noop-storm` RED alarm). The LLMIO ring
    # stores the (clipped) completion body under `result` (llm_trace._push_ring); empty/absent ⇒
    # nothing usable came back.
    return not str(entry.get("result") or "").strip()


def _is_auto_corrected(entry) -> bool:
    """A soft-failure OVERSEER entry that record_soft_failure marked auto-corrected (a belt/lever/
    floor stood): the ``lever`` carries the correction and the diagnosis carries the marker."""
    if entry.get("lever"):
        return True
    return log_rings.SOFT_FAIL_AUTOCORRECTED in str(entry.get("diagnosis") or "")


def _compute_health_rollup(window_s: int = _ROLLUP_WINDOW_S, now_ms=None,
                           user: str | None = None) -> dict:
    """WI2 — the per-class/-tool rolling failure-rate rollup. Reads the in-process rings only;
    best-effort and Vault-free. Structure::

      { windowSeconds,
        llm:    {<callClass>: {total, failed, failureRate, lastFailureAt,
                                semanticNoOps, lastSemanticNoOpAt,
                                emptyCompletions, lastEmptyCompletionAt}},
        tools:  {<engineTool>: {total, failed, failureRate, lastFailureAt}},
        guards: {<softFailClass>: {failed, autoCorrected, lastFailureAt}} }

    ALL THREE buckets are USER-SCOPED — every ring now carries a per-entry ``user`` (``record_llm_call``
    stamps LLMIO, ``record_io`` stamps IO, ``record_overseer`` stamps OVERSEER), so each is filtered to
    the REQUESTING user exactly as the snapshot's sibling reads (``sync_recent`` / ``belt_totals`` /
    ``sandbox_health``) are. Otherwise a failure in user A's sandbox — a narration 5xx, a failed
    ``recordInteraction``, a soft-failure — would inflate the rollup AND raise a RED alarm
    (``narration-failure`` / ``write-back storm`` / ``guard-judge-failure``) in user B's
    /api/admin/health, a cross-user isolation breach (first-class alongside the Vault Wall). A
    genuinely userless/system call maps to the shared ``default`` bucket, which never matches a NAMED
    user. (An explicitly operator-global panel, if ever wanted, must be a SEPARATE admin-gated path.)
    """
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    want_user = _norm_user(user)
    llm: dict = {}
    tools: dict = {}
    guards: dict = {}

    def _bump(bucket, key, failed, ts, *, semantic_noop=False, llm=False, empty=False):
        # The semantic-no-op / empty-completion fields are LLM-only: seed them in the default shape
        # ONLY for the LLM rollup so TOOL/guard buckets stay `{total, failed, lastFailureAt}` and
        # don't carry the LLM-only fields. LLM buckets keep all seven keys always.
        if llm:
            d = bucket.setdefault(
                key, {"total": 0, "failed": 0, "semanticNoOps": 0, "lastFailureAt": None,
                      "lastSemanticNoOpAt": None, "emptyCompletions": 0, "lastEmptyCompletionAt": None})
        else:
            d = bucket.setdefault(key, {"total": 0, "failed": 0, "lastFailureAt": None})
        d["total"] += 1
        if failed:
            d["failed"] += 1
            d["lastFailureAt"] = ts
        # F7: an ok-but-dropped completion. Counted separately from `failed` so an operator can see
        # "the calls are 200-ok but N of them applied nothing" — the silent semantic no-op.
        if semantic_noop:
            d["semanticNoOps"] = d.get("semanticNoOps", 0) + 1
            d["lastSemanticNoOpAt"] = ts
        # F8 (#1741): a `finishReason: None` / empty-completion (llm_trace's `failClass == "empty"`)
        # is a FIRST-CLASS telemetry class of its own — counted separately from the blunt `failed`
        # bucket (which also lumps in 4xx/5xx/timeout) so an operator can see "N of these were
        # specifically vanished/empty generations", the exact signal the 6/103-in-bundle finding
        # needed and the retry-on-empty guard (llm_core.py) is meant to be driving toward zero.
        if empty:
            d["emptyCompletions"] = d.get("emptyCompletions", 0) + 1
            d["lastEmptyCompletionAt"] = ts

    try:
        _, llm_lines = log_rings.LLMIO.since(0, limit=_BUNDLE_RING_LIMIT)
    except Exception:
        llm_lines = []
    for e in llm_lines:
        if not isinstance(e, dict) or not _within_window(e.get("ts"), now_ms, window_s):
            continue
        if _norm_user(e.get("user")) != want_user:
            continue  # cross-user isolation: this LLM call counts for THIS user only
        _bump(llm, _llm_class_of(e), _entry_failed(e), e.get("ts"),
              semantic_noop=_entry_semantic_noop(e), llm=True,
              empty=(str(e.get("failClass") or "") == "empty"))

    try:
        _, io_lines = log_rings.IO.since(0, limit=_BUNDLE_RING_LIMIT)
    except Exception:
        io_lines = []
    for e in io_lines:
        if not isinstance(e, dict) or not _within_window(e.get("ts"), now_ms, window_s):
            continue
        if _norm_user(e.get("user")) != want_user:
            continue  # cross-user isolation: this engine tool call counts for THIS user only
        _bump(tools, str(e.get("tool") or "?"), e.get("ok") is False, e.get("ts"))

    try:
        _, ov_lines = log_rings.OVERSEER.since(0, limit=_BUNDLE_RING_LIMIT)
    except Exception:
        ov_lines = []
    for e in ov_lines:
        if not isinstance(e, dict) or e.get("ok") is not False:
            continue
        # Cross-user isolation: this soft-failure counts for THIS user only. The OVERSEER ring is
        # global (one ring, every sandbox); scope it by the per-entry `user` the recorder stamps,
        # matching how sync_recent / belt_totals / sandbox_health are already user-scoped.
        if _norm_user(e.get("user")) != want_user:
            continue
        kind = str(e.get("kind") or "")
        if not kind.startswith(_SOFT_FAIL_PREFIXES):
            continue  # an ordinary 0079 overseer report, not a #1599 soft failure
        if not _within_window(e.get("ts"), now_ms, window_s):
            continue
        g = guards.setdefault(kind, {"failed": 0, "autoCorrected": 0, "lastFailureAt": None})
        g["failed"] += 1
        if _is_auto_corrected(e):
            g["autoCorrected"] += 1
        g["lastFailureAt"] = e.get("ts")

    for d in list(llm.values()) + list(tools.values()):
        d["failureRate"] = round(d["failed"] / d["total"], 3) if d["total"] else 0.0

    return {"windowSeconds": window_s, "llm": llm, "tools": tools, "guards": guards}


def _alarm(code, label, count, detail, *, auto_corrected=False) -> dict:
    return {"code": code, "severity": "red", "label": label, "count": int(count),
            "detail": detail, "autoCorrected": bool(auto_corrected)}


# S6d (#1599 item 4): a GUARD-DOWN (the guard/judge could not RUN — call-failed / timeout / gate
# error) is NOT the same event as an auto-corrected faith SLIP (the guard ran fine, detected an
# unfaithful narration, and the correction stood). The old ``guard-judge-failure`` alarm conflated
# them — a bundle's count:15 was 14 corrected slips + 1 real guard-down. Only a true guard-down is
# a coverage loss; the detected slips still surface RED via the ``auto-corrected`` alarm. The
# discriminator is the class token: a guard-down carries a run-failure marker, a slip is
# ``faith:<dimension>`` (persona / leak / omission …) with no such marker.
_GUARD_DOWN_MARKERS = ("call-failed", "judge-call-failed", "gate-error", "gate-failed",
                       "heuristic-error", "resolve-failed", "sync-in-async", "casting-gate-error",
                       "-error", "-failed", "timeout")


def _is_guard_down_class(kind: str) -> bool:
    """True iff a ``faith:``/``overseer:`` soft-failure class is a GUARD-DOWN (the guard/judge could
    not run) rather than a detected-and-corrected faith slip (``faith:<dimension>``)."""
    k = str(kind or "").lower()
    return any(m in k for m in _GUARD_DOWN_MARKERS)


def _compute_alarms(rollup: dict, *, embeddings=None, sync_recent=None, belt_totals=None,
                    sandbox=None, faithfulness=None, capability=None) -> list:
    """WI3 — derive the RED alarms for game-breaking signals from the rollup + the snapshot reads.
    Pure over its inputs (unit-testable): returns a list of ``{code, severity:'red', label, count,
    detail, autoCorrected}``. Vault-free — every input is a count / flag / class token."""
    alarms: list = []
    guards = (rollup or {}).get("guards") or {}
    llm = (rollup or {}).get("llm") or {}
    tools = (rollup or {}).get("tools") or {}

    # 1) A guard / judge class going DOWN (the guard/judge could not RUN). S6d: count ONLY true
    #    guard-downs — a detected-and-corrected faith slip is NOT a guard-down and must not inflate
    #    this alarm (it surfaces RED under `auto-corrected` instead).
    guard_classes = {k: v for k, v in guards.items() if k.startswith(("overseer:", "faith:"))}
    guard_down = {k: v for k, v in guard_classes.items() if _is_guard_down_class(k)}
    if guard_down:
        total = sum(int(v.get("failed", 0)) for v in guard_down.values())
        auto = sum(int(v.get("autoCorrected", 0)) for v in guard_down.values())
        if total:
            alarms.append(_alarm(
                "guard-judge-failure", "Guard/judge failure", total,
                "a grounding guard or overseer judge could not run ("
                + ", ".join(sorted(guard_down)) + ")",
                auto_corrected=(auto >= total)))

    # 2) Narration call failure (5xx / timeout / empty completion).
    nar = llm.get("narration")
    if isinstance(nar, dict) and nar.get("failed"):
        alarms.append(_alarm(
            "narration-failure", "Narration call failure", nar["failed"],
            "narration LLM failed (5xx / timeout / empty completion) — "
            f"{nar['failed']}/{nar.get('total', '?')} in-window"))

    # 2b) Semantic no-op STORM (F7). HTTP-ok LLM calls whose output was dropped (reasoning-channel
    #     length-cut / applied-nothing) — the ok/failed axis reports these clean, so without this the
    #     rollup showed 0 failures while a stream of completions applied nothing. Fires at the storm
    #     threshold so an occasional truncation is not alarming, but a burst surfaces.
    semantic = sum(int(v.get("semanticNoOps", 0)) for v in llm.values() if isinstance(v, dict))
    if semantic >= _STORM_THRESHOLD:
        worst = ", ".join(sorted(
            k for k, v in llm.items() if isinstance(v, dict) and v.get("semanticNoOps")))
        alarms.append(_alarm(
            "semantic-noop-storm", "Semantic no-op storm", semantic,
            f"{semantic} HTTP-ok LLM call(s) applied nothing (output dropped / length-cut) "
            f"in-window — class(es): {worst or '?'}"))

    # 2c) Empty-completion STORM (F8 / #1741). `finishReason: None` / vanished completions
    #     (llm_trace's `failClass == "empty"`) are already folded into the blunt `failed` axis
    #     (so `narration-failure` above still fires at threshold 1 for the player-facing class),
    #     but that axis can't tell an operator "N of these were SPECIFICALLY empty generations" —
    #     it reads identically to a 5xx or a timeout. This is the first-class count the #1741 audit
    #     asked for (6/103 stream records finished `finishReason: None` in the reviewed bundle):
    #     tracked per-class as `emptyCompletions`, and a burst across ANY class (not just narration
    #     — a silent empty utility/enrichment call is just as real a dropped turn) fires RED at the
    #     same storm threshold as the semantic-no-op burst above. `llm_core.py`'s empty-`stop` guard
    #     already retries a single empty completion like a failed attempt; this alarm is for when
    #     retries are ALSO failing (a genuine burst), not an occasional blip.
    empties = sum(int(v.get("emptyCompletions", 0)) for v in llm.values() if isinstance(v, dict))
    if empties >= _STORM_THRESHOLD:
        worst = ", ".join(sorted(
            k for k, v in llm.items() if isinstance(v, dict) and v.get("emptyCompletions")))
        alarms.append(_alarm(
            "empty-completion-storm", "Empty-completion storm", empties,
            f"{empties} vanished/empty LLM completion(s) (finishReason: None / empty 'stop') "
            f"in-window — class(es): {worst or '?'} — a dropped turn from the player's view"))

    # 3) Write-back / enrichment refusal STORM. The provider/runtime classes (search-provider /
    #    narrator-http / reasoning-misroute) have their OWN alarm (4c) and are excluded here so a
    #    provider outage isn't miscounted as an enrichment write-back storm.
    _provider_classes = ("enrichment:search-provider", "enrichment:narrator-http",
                         "enrichment:reasoning-misroute")
    wb = sum(int(v.get("failed", 0)) for t, v in tools.items() if t in _WRITEBACK_TOOLS)
    enr = sum(int(v.get("failed", 0)) for k, v in guards.items()
              if k.startswith("enrichment:") and k not in _provider_classes)
    if (wb + enr) >= _STORM_THRESHOLD:
        alarms.append(_alarm(
            "writeback-storm", "Write-back / enrichment failure storm", wb + enr,
            f"{wb} engine write-back failure(s) + {enr} enrichment failure(s) in-window "
            "(refused / failing writes)"))

    # 4) Desync / stale-beat burst.
    stale = 0
    desync = 0
    for e in (sync_recent or []):
        if not isinstance(e, dict):
            continue
        try:
            stale += int(e.get("staleRejections") or 0)
        except (TypeError, ValueError):
            pass
        if e.get("desyncDetected"):
            desync += 1
    if (stale + desync) >= _STORM_THRESHOLD:
        alarms.append(_alarm(
            "desync-burst", "Desync / stale-beat burst", stale + desync,
            f"{stale} stale-beat rejection(s) + {desync} desync(s) in recent turns"))

    # 4b) Dropped fold (S6b — the A-S3 latent). A fold-bearing write (recordInteraction / a deal /
    #     a trust belt) evaporated on a stale-beat 409, or an unaccounted beatSeq gap says the board
    #     moved without this FE recording the write. ONE lost consequence fold is game-affecting (a
    #     scene's only hidden-impact record gone), so this fires at threshold 1 — it was previously
    #     completely invisible (staleRejections showed 0 next to a beatSeq gap of 46).
    dropped = sum(int(v.get("failed", 0)) for k, v in guards.items() if k == "sync:dropped-fold")
    if dropped:
        alarms.append(_alarm(
            "dropped-fold", "Dropped consequence fold", dropped,
            f"{dropped} fold-bearing write(s) dropped on a stale-beat 409 / unaccounted beatSeq gap "
            "— a scene's only hidden-impact record was lost"))

    # 4c) Provider / runtime failure (S6c). A search-provider outage feeding enrichment, a narrator
    #     HTTP 4xx, or a reasoning-channel misroute — each recorded via enrichment_policy's runtime
    #     recorder. These were happening live but alarmed nowhere; fire at threshold 1.
    provider = sum(int(v.get("failed", 0)) for k, v in guards.items()
                   if k in ("enrichment:search-provider", "enrichment:narrator-http",
                            "enrichment:reasoning-misroute"))
    if provider:
        alarms.append(_alarm(
            "provider-failure", "Provider / runtime failure", provider,
            f"{provider} provider/runtime failure(s) in-window (search-provider down / narrator "
            "HTTP 4xx / reasoning-channel misroute)"))

    # 4d) Faithfulness judge DARK (F10 / BL-019). The operator enabled the anti-hallucination judge
    #     (shadow/active) but no model resolves, so it silently no-ops on every turn. An unconfigured
    #     guard the operator ASKED for is a coverage loss — fire at threshold 1 so it can never be an
    #     invisible no-op again.
    if isinstance(faithfulness, dict) and faithfulness.get("dark"):
        alarms.append(_alarm(
            "faithfulness-judge-dark", "Faithfulness judge unconfigured", 1,
            f"the faithfulness judge is '{faithfulness.get('mode')}' but no model resolves "
            "(faithfulness/utility/default all unset) — the anti-hallucination guard is a silent no-op"))

    # 4e) T0-4 — a provider CapabilityProfile probed RED (forced tool_choice honored under 50% of
    #     the time, or json-conformance under 50%). A red capability is exactly the F2/F3 failure
    #     class the playtest hit live — surface it as a standing alarm (not just the one-shot
    #     probe-time soft-failure event) for as long as the last probe reads red.
    if isinstance(capability, dict):
        red_endpoints = [eid for eid, profile in capability.items()
                         if isinstance(profile, dict) and profile.get("overallTier") == "red"]
        if red_endpoints:
            alarms.append(_alarm(
                "capability-red", "Provider capability probe: RED", len(red_endpoints),
                f"{len(red_endpoints)} endpoint(s) probed RED on forced tool_choice honoring "
                "and/or json conformance — narration on this provider can silently ignore a "
                "closed-set force or a structured-output request"))

    # 5) Embeddings degraded (semantic recall fell back).
    if isinstance(embeddings, dict) and embeddings.get("degraded"):
        alarms.append(_alarm(
            "embeddings-degraded", "Embeddings degraded", 1,
            "semantic recall fell back to the deterministic floor "
            f"(provider {embeddings.get('provider') or '?'})"))

    # 6) Integrity faults / circuit-open (the engine's fail-closed corruption alarm).
    if isinstance(sandbox, dict):
        faults = sandbox.get("faults") if isinstance(sandbox.get("faults"), list) else []
        state_faults = [f for f in faults
                        if isinstance(f, dict) and f.get("kind") != "persist-failure"]
        circuit_open = bool(sandbox.get("circuitOpen"))
        if circuit_open or state_faults or sandbox.get("lastIntegrity") == "fault":
            alarms.append(_alarm(
                "integrity-fault", "Integrity fault / circuit open",
                len(state_faults) or len(faults) or 1,
                ("corruption circuit OPEN — off-screen ticks are skipping this sandbox; "
                 if circuit_open else "")
                + f"{len(state_faults)} state-integrity fault(s) on record"))

    # 7) Auto-corrected faults (belts fired / floors stood) — RED-with-auto-corrected.
    #    A correction is NOT a cloak (owner ruling 2026-07-14): surface it RED, annotated.
    auto_soft = sum(int(v.get("autoCorrected", 0)) for v in guards.values())
    belt_n = 0
    for v in (belt_totals or {}).values():
        try:
            belt_n += int(v)
        except (TypeError, ValueError):
            pass
    if (auto_soft + belt_n) > 0:
        alarms.append(_alarm(
            "auto-corrected", "Auto-corrected fault(s)", auto_soft + belt_n,
            "a genuine fault was auto-corrected (a belt fired / a floor stood) — recorded RED, "
            "not silently cloaked", auto_corrected=True))

    return alarms


def _faithfulness_section(user: str | None) -> dict | None:
    """F10 / BL-019 — the faithfulness-judge health posture for the status page. Best-effort +
    Vault-free (mode / config-presence / resolvability booleans — never a secret). A DARK judge
    (enabled but no model resolves) surfaces here AND lights the ``faithfulness-judge-dark`` RED alarm,
    so an active-but-unconfigured anti-hallucination judge is never a silent no-op again."""
    try:
        from src import faithfulness as _f
        return _f.judge_health(user)
    except Exception:
        return None


async def _rollup_and_alarms(user: str | None, engine: dict,
                             faithfulness: dict | None = None,
                             capability: dict | None = None) -> tuple[dict, list]:
    """Assemble the WI2 rollup + the WI3 RED alarms for the health snapshot. Best-effort throughout
    (a broken read simply contributes nothing) — the 10s poll must never hard-fail."""
    try:
        rollup = _compute_health_rollup(user=user)
    except Exception:
        rollup = {}
    try:
        from src import orwell_sync_ledger as _sl
        sync_recent = _sl.get_recent(user, limit=50)
    except Exception:
        sync_recent = []
    try:
        from src import orwell_sync_ledger as _sl
        belt_totals = _sl.get_belt_totals(user)
    except Exception:
        belt_totals = {}
    sandbox = None
    try:
        if engine.get("ok"):
            sandbox = await orwell_engine.sandbox_health(user)
            if not isinstance(sandbox, dict):
                sandbox = None
    except Exception:
        sandbox = None
    try:
        alarms = _compute_alarms(rollup, embeddings=engine.get("embeddings"),
                                 sync_recent=sync_recent, belt_totals=belt_totals, sandbox=sandbox,
                                 faithfulness=faithfulness, capability=capability)
    except Exception:
        alarms = []
    return rollup, alarms


async def _health_snapshot(user: str | None) -> dict:
    """The aggregated health view both routes share."""
    detail = await orwell_engine.engine_health_detail()  # FE's view: ok + error + lastError
    raw, latency_ms = await _engine_raw_health()         # engine's self-report (G1 ring etc.)

    engine: dict = {
        "ok": bool(detail.get("ok")),
        "engineUrl": detail.get("engineUrl"),
        "latencyMs": latency_ms,
    }
    if detail.get("error"):
        engine["error"] = detail["error"]
    if raw:
        engine["uptimeSeconds"] = raw.get("uptimeSeconds")
        engine["toolCalls"] = raw.get("toolCalls")
        engine["recentFailures"] = raw.get("recentFailures") or []
        engine["embeddings"] = raw.get("embeddings")

    fe_last = detail.get("lastError")  # the FE's recent view of engine trouble (recency-gated)
    frontend = {"lastError": fe_last, "store": _store_stats()}
    if detail.get("integrityRefusal"):  # ORW-321: RED - the engine's integrity checkpoint is refusing turns (kinds + invariant NAME only)
        frontend["integrityRefusal"] = detail["integrityRefusal"]

    # Tiers AGREE when the engine self-reports healthy AND the FE's recent experience of it
    # concurs (no fresh transport failure on record). A disagreement is itself the signal —
    # e.g. the engine answers /health but every tool call times out at the FE tier.
    tiers_agree = bool(engine["ok"]) and raw is not None and not (
        isinstance(fe_last, dict) and fe_last.get("kind") == "unreachable"
    )

    # G20 made _image_state async (it awaits the engine's cast projection for the
    # portrait completeness counter). isawaitable-tolerant on purpose: existing tests
    # (and any future stub) may monkeypatch it with a plain sync callable.
    images = _image_state(user)
    if inspect.isawaitable(images):
        images = await images

    # Deep cast-authoring completeness ("did GLM enrich this cast, or did it all fall back to the
    # thin deterministic floor?"). Best-effort: a failure reads as None, never blocks the snapshot.
    try:
        cast_authoring = await _cast_authoring_state(user)
    except Exception:
        cast_authoring = None

    # Owner directive 2026-07-11 — the enrichment policy + its LOUD failure ledger (strict mode's
    # admin surface: every no-model refusal / retried-then-failed enrichment call lands here).
    # Best-effort + Vault-free (call-class names, reasons, timestamps — never content).
    try:
        from src import enrichment_policy as _enrichment
        enrichment = {"policy": _enrichment.current_policy(),
                      "failures": _enrichment.failures(user)}
    except Exception:
        enrichment = None

    # F10 / BL-019 — faithfulness-judge posture (mode + whether a model resolves). A DARK judge
    # (enabled but unconfigured) surfaces here AND lights the RED alarm below. Vault-free/best-effort.
    faithfulness = _faithfulness_section(user)

    # T0-4 (telemetry + probe arm) — every persisted per-endpoint CapabilityProfile (tool_choice
    # honoring / json conformance / reasoning-channel separation), Vault-free by construction
    # (capability_probe.py never stores a request/response body — counts, rates, short tier
    # tokens only). Best-effort: a broken read answers {} rather than blanking the whole page.
    try:
        from src import capability_probe as _cap
        capability = _cap.get_all_capability_profiles()
    except Exception:
        capability = {}

    # #1599 WI2/WI3 — the per-class/-tool failure-rate rollup + the RED alarms, both Vault-free and
    # best-effort (a broken read contributes nothing; the poll must never hard-fail).
    health_rollup, alarms = await _rollup_and_alarms(user, engine, faithfulness=faithfulness,
                                                      capability=capability)

    return {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "engine": engine,
        "frontend": frontend,
        "tiersAgree": tiers_agree,
        "images": images,
        "castAuthoring": cast_authoring,
        "enrichment": enrichment,
        # F10 / BL-019 — the faithfulness-judge health posture (dark ⇒ the RED alarm above fires).
        "faithfulness": faithfulness,
        # T0-4 — per-endpoint provider CapabilityProfiles (see src/capability_probe.py). A RED
        # overallTier on any profile also lights the `capability-red` alarm below.
        "capability": capability,
        # #1599 — the per-class/-tool rolling failure-rate rollup (WI2) and the RED game-breaking
        # alarms (WI3). Vault-free: counts / class tokens / booleans only.
        "healthRollup": health_rollup,
        "alarms": alarms,
        # Build + version (PR) for one-glance triage on the status page. version is the
        # PR-derived "vX.XX"; build is the deployed checkout's short commit SHA.
        "versions": _versions(),
    }


def setup_admin_health_routes() -> APIRouter:
    router = APIRouter(prefix="/api/admin", tags=["admin_health"])

    @router.get("/health")
    async def admin_health(request: Request):
        require_admin(request)
        user = None
        try:
            user = effective_user(request)
        except Exception:
            pass
        # P1: the status page polls this every 10s and depends on it NEVER hard-failing —
        # the recovery surface must stay reachable when the engine/DB is broken. The
        # snapshot helpers are already best-effort; this is the final belt-and-braces so
        # an unexpected error returns a 200 diagnostic, not a 500 that blanks the page.
        try:
            return await _health_snapshot(user)
        except Exception as e:
            logger.warning("admin health snapshot failed (degraded): %s", e)
            # Keep the response SHAPE consistent with the healthy snapshot even when degraded — the
            # top-level `faithfulness` key must be present. Build it fail-soft (a cheap best-effort
            # DB resolve); a safe static "unknown" posture if it raises. This branch must NEVER
            # raise: the status page polls it every 10s and depends on a 200.
            try:
                faithfulness = _faithfulness_section(user)
            except Exception:
                faithfulness = None
            if faithfulness is None:
                faithfulness = {"mode": "unknown", "enabled": False,
                                "modelResolvable": False, "dark": False}
            return {
                "generatedAt": datetime.now(timezone.utc).isoformat(),
                "engine": {"ok": False, "error": f"{type(e).__name__}: {e}"},
                "frontend": {"lastError": None, "store": {}},
                "tiersAgree": False,
                "images": {"available": False},
                "faithfulness": faithfulness,
                "healthRollup": {},
                "alarms": [],
                "versions": _versions(),  # build/PR is git-derived — still resolvable when the DB/engine is down
                "error": "health snapshot degraded — recovery actions remain available",
            }

    @router.get("/token-economy")
    async def admin_token_economy(request: Request, user: str | None = None):
        """ADR 0010 / feature 0069 — read-only token/cost view for a user (admin-gated).

        Query param ``user`` selects whose ledger to read (default: the current admin /
        "default"). Vault-free by construction — the ledger holds only numbers/ids; no
        message body, transcript, or engine secret can be returned. NOT exposed on any
        player route."""
        require_admin(request)
        target = user
        if not target:
            try:
                target = effective_user(request)
            except Exception:
                target = None
        return _token_economy(target)

    @router.get("/logs/sources")
    async def admin_log_sources(request: Request):
        """G1b: every selectable log stream — the two live rings + on-disk logs."""
        require_admin(request)
        sources = [
            {"id": "live", "label": "Front-end (live)"},
            {"id": "io", "label": "Engine I/O (live) — every tool call in/out"},
            {"id": "llmio", "label": "LLM I/O (live) — full prompt + response + reasoning"},
            {"id": "overseer", "label": "Overseer (live) — diagnoses & corrections"},
        ]
        for name in _log_files():
            sources.append({"id": f"file:{name}", "label": f"{name} (file)"})
        return {"sources": sources}

    @router.get("/logs")
    async def admin_logs(request: Request, source: str = "live", since: int = 0):
        """G1b: tail one source. Live rings use a seq cursor; files a byte offset."""
        require_admin(request)
        if source == "live":
            nxt, lines = log_rings.LIVE.since(since)
            return {"source": source, "next": nxt, "lines": lines}
        if source == "io":
            nxt, lines = log_rings.IO.since(since)
            return {"source": source, "next": nxt, "lines": lines}
        if source == "llmio":
            nxt, lines = log_rings.LLMIO.since(since)
            return {"source": source, "next": nxt, "lines": lines}
        if source == "overseer":
            nxt, lines = log_rings.OVERSEER.since(since)
            return {"source": source, "next": nxt, "lines": lines}
        if source.startswith("file:"):
            name = source[5:]
            if name not in _log_files():  # strict allowlist — no traversal, ever
                return Response(status_code=404)
            path = _log_path(name)         # FE app-data dir OR the deploy ops-*.log tree
            try:
                size = os.path.getsize(path)
                start = max(int(since), max(0, size - 65536) if since == 0 else 0)
                with open(path, "rb") as f:
                    f.seek(start)
                    chunk = f.read(min(65536, max(0, size - start)))
                text = chunk.decode("utf-8", "replace")
                lines = [{"seq": start + i, "ts": None, "level": "", "logger": name,
                          "msg": _pretty_log_line(name, l)}
                         for i, l in enumerate(text.splitlines())]
                return {"source": source, "next": size, "lines": lines[-500:]}
            except OSError:
                return Response(status_code=404)
        return Response(status_code=400)

    @router.get("/logs/retention")
    async def admin_logs_retention(request: Request):
        """The LLM I/O trace toggle + log-retention horizon + the live total-size
        readout (the universal logging setting on the status page). Best-effort."""
        require_admin(request)
        from src import llm_trace, overseer, faithfulness
        from src.settings import get_setting
        total = llm_trace.total_log_bytes()
        mode = overseer.overseer_mode()  # 0080: 'off' | 'shadow' | 'active'
        return {
            "traceEnabled": bool(get_setting("llm_trace_enabled", True)),
            # 0080: the 3-state mode is authoritative; overseerEnabled stays for back-compat
            # (true iff the mode is not 'off').
            "overseerMode": mode,
            "overseerEnabled": mode != "off",
            # 0081: the narration-faithfulness gate rides its OWN independent dial.
            "faithfulnessMode": faithfulness.faithfulness_mode(),
            "retentionDays": llm_trace.retention_days(),
            "choices": llm_trace.RETENTION_CHOICES,
            "totalBytes": total,
            "totalHuman": llm_trace.human_bytes(total),
            "files": llm_trace.log_inventory(),
        }

    @router.post("/logs/retention")
    async def admin_logs_retention_set(request: Request):
        """Persist the trace toggle and/or retention horizon. Lowering the horizon
        trims immediately so the freed space shows up at once."""
        require_admin(request)
        from src import llm_trace, overseer, faithfulness
        from src.settings import load_settings, save_settings
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        settings = load_settings()
        changed = False
        if "traceEnabled" in body:
            settings["llm_trace_enabled"] = bool(body["traceEnabled"])
            changed = True
        # 0080: the 3-state mode is the primary control. When set, it is authoritative — clear the
        # legacy binary key so it can never shadow the chosen mode in overseer_mode()'s resolution.
        if "overseerMode" in body:
            mode = body["overseerMode"]
            if isinstance(mode, str) and mode in overseer.OVERSEER_MODES:
                settings["overseer_mode"] = mode
                settings.pop("overseer_enabled", None)
                changed = True
        elif "overseerEnabled" in body:
            # Legacy binary toggle (back-compat): True -> shadow, False -> off, written through the
            # 3-state key so the new control reflects it.
            settings["overseer_mode"] = "shadow" if bool(body["overseerEnabled"]) else "off"
            settings.pop("overseer_enabled", None)
            changed = True
        # 0081: the faithfulness gate's OWN dial, independent of the overseer mode above.
        if "faithfulnessMode" in body:
            fmode = body["faithfulnessMode"]
            if isinstance(fmode, str) and fmode in faithfulness.FAITHFULNESS_MODES:
                settings["faithfulness_mode"] = fmode
                changed = True
        if "retentionDays" in body:
            try:
                d = int(body["retentionDays"])
                if d >= 0:
                    settings["log_retention_days"] = d
                    changed = True
            except (TypeError, ValueError):
                pass
        if changed:
            save_settings(settings)
        # Apply the (possibly new) horizon now so the size readout reflects it.
        result = llm_trace.trim_logs(None)
        mode = overseer.overseer_mode()  # 0080: resolved post-save (the source of truth)
        return {
            "traceEnabled": bool(settings.get("llm_trace_enabled", True)),
            "overseerMode": mode,
            "overseerEnabled": mode != "off",
            "faithfulnessMode": faithfulness.faithfulness_mode(),  # 0081: independent dial
            "retentionDays": llm_trace.retention_days(),
            "totalBytes": result["totalBytes"],
            "totalHuman": result["totalHuman"],
            "files": result["files"],
        }

    @router.post("/logs/trim")
    async def admin_logs_trim(request: Request):
        """Trim every managed logfile to the selected horizon NOW (the "Trim now"
        button). Body may carry {"days": N} to override the configured horizon for
        this run; absent ⇒ the configured retention."""
        require_admin(request)
        from src import llm_trace
        try:
            body = await request.json()
        except Exception:
            body = {}
        days = None
        if isinstance(body, dict) and "days" in body:
            try:
                days = int(body["days"])
            except (TypeError, ValueError):
                days = None
        result = llm_trace.trim_logs(days)
        result["removedHuman"] = llm_trace.human_bytes(result["removedBytes"])
        return result

    @router.get("/ops")
    async def admin_ops(request: Request):
        """G19a: the runnable allowlist + whether the update trigger is installed."""
        require_admin(request)
        return {
            "scripts": [{"id": k, "label": v[0], "log": v[3]} for k, v in _OPS_SCRIPTS.items()],
            "updateTrigger": {"installed": await asyncio.to_thread(_update_trigger_ready),   # installed AND active
                              "log": "ops-update.log"},
        }

    @router.post("/ops/run/{sid}")
    async def admin_ops_run(sid: str, request: Request):
        require_admin(request)
        if sid not in _OPS_SCRIPTS:   # fixed allowlist — the web tier picks an id, never a command
            return Response(status_code=404)
        return await _run_ops_script(sid)

    @router.post("/ops/trigger-update")
    async def admin_ops_update(request: Request):
        """G19a: write the flag the root-side path unit (G19b) watches. Content ignored."""
        await guard_root_op(request)
        # The trigger flag must land in the DEPLOY data dir where the root-side path unit watches
        # (frontend/data is a different tree the watcher never sees — that was the silent-no-op bug).
        ops_dir = os.path.join(_ops_data_dir(), "ops")
        if not os.path.isdir(ops_dir) or not await asyncio.to_thread(_update_trigger_ready):
            from routes.admin_update_routes import _watcher_unit_path
            return {"triggered": False, "installed": False,
                    "note": inactive_reason(_watcher_unit_path(), "run the update")}
        import datetime as _dt
        flag = os.path.join(ops_dir, "update-requested")
        with open(flag, "w", encoding="utf-8") as fh:
            fh.write(_dt.datetime.now(timezone.utc).isoformat() + "\n")
        logger.info("[ops] admin triggered the updater (flag written)")
        return {"triggered": True, "installed": True, "log": "ops-update.log"}

    @router.post("/ops/regenerate-portraits")
    async def admin_portraits_regenerate(request: Request):
        """G25 debug lever (the status-page button): discard EVERY stored cast portrait for
        THIS admin's game and regenerate the full active set through the standard pipeline —
        so a prompt/model change can be seen on the current cast without a season restart.

        Refuse-before-discard: the engine, an active game, and a usable image model are all
        verified FIRST — a refusal discards nothing (placeholders forever would be worse than
        stale photos). The kick is force=True (an explicit act, like the cast-window lever)
        and generation follows in portrait-log.jsonl, which this page's viewer can tail."""
        require_admin(request)
        user = None
        try:
            user = effective_user(request)
        except Exception:
            pass
        from src import orwell_engine, orwell_portraits
        from routes.orwell_routes import _roster_cards
        try:
            state = await orwell_engine.get_game_state(user=user)
        except Exception as e:
            return {"regenerated": False, "reason": f"engine unreachable: {e}"}
        if not isinstance(state, dict) or state.get("started") is False:
            return {"regenerated": False, "reason": "no active game"}
        try:
            available = orwell_portraits.image_generation_available(user)
        except Exception:
            available = False
        if not available:
            return {"regenerated": False, "reason": "no usable image model configured"}
        cards = _roster_cards(state, user)
        # Discard the ACTIVE set only (same filter as missing_portrait_ids): the backfill
        # never regenerates departed houseguests, so their photos must survive.
        active_ids = [c.get("id") for c in cards
                      if isinstance(c, dict) and (c.get("status") or "active") == "active" and c.get("id")]
        discarded = orwell_portraits.discard_portraits(user, active_ids)
        missing = orwell_portraits.missing_portrait_ids(user, cards)
        kicked = orwell_portraits.kickoff_backfill(missing, user, force=True)
        logger.info("[ops] admin portrait regeneration: discarded=%d queued=%d kicked=%s",
                    discarded, len(missing), kicked)
        return {"regenerated": True, "discarded": discarded, "queued": len(missing),
                "kicked": bool(kicked), "log": "portrait-log.jsonl"}

    @router.post("/ops/reauthor-cast")
    async def admin_reauthor_cast(request: Request):
        """Debug lever (the status-page button, NEXT TO regenerate-portraits): re-author every NPC
        still on the deterministic FLOOR for THIS admin's game — so a cast that started without a
        utility model (or whose authoring failed) gets its rich deep profiles without a season restart.

        Mirrors the portrait regenerate lever: an active game is verified FIRST (a refusal does
        nothing), the kick is force=True (an explicit act, bypassing the auto-poll debounce), and
        authoring follows in the background (a missing utility model is a silent no-op — the floor
        stands). Vault-free by construction: it reads only the engine's public roster + writes back
        via recordCastProfile (the engine validates / splits across the Vault Wall / re-seals)."""
        require_admin(request)
        user = None
        try:
            user = effective_user(request)
        except Exception:
            pass
        from src import orwell_engine, orwell_cast_authoring
        from routes.orwell_routes import _roster_cards
        try:
            state = await orwell_engine.get_game_state(user=user)
        except Exception as e:
            return {"reauthored": False, "reason": f"engine unreachable: {e}"}
        if not isinstance(state, dict) or state.get("started") is False:
            return {"reauthored": False, "reason": "no active game"}
        missing = orwell_cast_authoring.unauthored_ids(user, _roster_cards(state, user))
        kicked = orwell_cast_authoring.kickoff_authoring_backfill(missing, user, force=True)
        logger.info("[ops] admin cast re-authoring: queued=%d kicked=%s", len(missing), kicked)
        return {"reauthored": True, "queued": len(missing), "kicked": bool(kicked)}

    @router.post("/ops/advance-to-finale")
    async def admin_advance_to_finale(request: Request):
        """L38 debug lever (the status-page button, NEXT TO regenerate-portraits): fast-forward THIS
        admin's live season to a crowned winner so the post-season Vault retrospective (0048) unseals
        legitimately.

        The non-negotiable boundary (mandate #2 / 0016): God Mode reads NO Vault and reveals nothing
        hidden. This crosses the engine's ADMIN channel, which is Vault-free BY CONSTRUCTION — it only
        DRIVES the deterministic loop to the finished terminal state (auto-resolving the player's
        pendings with legal defaults). The engine returns ONLY a Vault-free summary (winner NAME, weeks
        played, the player's final placement); the retrospective still opens through its own gate. The
        season genuinely finishes — integrity is preserved (it is not a Vault bypass)."""
        require_admin(request)
        user = None
        try:
            user = effective_user(request)
        except Exception:
            pass
        from src import orwell_engine
        try:
            summary = await orwell_engine.advance_to_finale(user=user)
        except Exception as e:
            return {"finished": False, "reason": f"engine error: {e}"}
        if not isinstance(summary, dict):
            return {"finished": False, "reason": "engine returned no summary"}
        if summary.get("started") is False:
            return {"finished": False, "reason": "no active game"}
        logger.info("[ops] admin fast-forward to finale: finished=%s winner=%s weeks=%s placement=%s",
                    summary.get("finished"), summary.get("winnerName"),
                    summary.get("weeks"), summary.get("playerPlacement"))
        # Pass through only the Vault-free public summary fields (never anything else the engine adds).
        return {
            "finished": bool(summary.get("finished")),
            "winnerName": summary.get("winnerName"),
            "weeks": summary.get("weeks"),
            "playerPlacement": summary.get("playerPlacement"),
        }

    @router.post("/ops/producer-vault")
    async def admin_producer_vault(request: Request):
        """DEBUG — the owner-ruled OVERRIDE of mandate #2 (the status-page "Producer's Vault" unseal).

        UNSEALS THIS admin's LIVE hidden Vault layer for operator debugging. UNLIKE every other admin
        route, this one DELIBERATELY returns Vault content — it is the one sanctioned LIVE reveal,
        crossing the engine's out-of-band ``producerVault`` admin capability. It is gated three ways:
        ``require_vault_reveal`` here (SEC-4: a genuine authenticated admin — NOT the blanket
        ``AUTH_ENABLED=false`` bypass), the engine's separate admin token, and the explicit FE
        "unseal" the button demands. It NEVER touches a live game's integrity — it only READS the
        hidden layer."""
        require_vault_reveal(request)
        user = None
        try:
            user = effective_user(request)
        except Exception:
            pass
        from src import orwell_engine
        try:
            dump = await orwell_engine.producer_vault(user=user)
        except Exception as e:
            return {"ok": False, "reason": f"engine error: {e}"}
        if not isinstance(dump, dict):
            return {"ok": False, "reason": "no active game to unseal"}
        logger.info("[ops] admin UNSEALED the producer's vault (debug override of mandate #2)")
        # Pass the unsealed view straight through — this is the deliberate, sanctioned Vault reveal.
        return {"ok": True, "vault": dump}

    @router.get("/debug-bundle")
    async def debug_bundle(request: Request, vault: int = 0, include_vault: int = 0):
        require_admin(request)
        # ── TWO exports, ONE assembler (owner ruling 2026-07-13) ──
        # STANDARD (default): the complete schema-3 bundle, Vault-free. UNSEALED
        # (?vault=1 / ?include_vault=1): the IDENTICAL bundle PLUS the live Producer's
        # Vault — behind the SAME sanctioned, out-of-band producerVault unseal the
        # status-page "Unseal" button uses (admin/God-Mode only, never a player path,
        # never always-on, fired only from the explicit /admin/status spoiler
        # affordance). The flavors differ ONLY in the Vault section. DO NOT widen it.
        #
        # SEC-4: the unsealed export demands the STRICT gate — a genuine authenticated
        # admin, NOT the blanket AUTH_ENABLED=false bypass that require_admin (above)
        # honors for the Vault-FREE bundle. Refused BEFORE any assembly/Vault read.
        unsealed = bool(vault or include_vault)
        if unsealed:
            require_vault_reveal(request)
        user = None
        try:
            user = effective_user(request)
        except Exception:
            pass
        # P1: the bundle is the operator's last-resort diagnostic, so it must ALWAYS
        # assemble — never 500. Every section inside is individually fail-soft.
        bundle = await _assemble_bundle(user)
        if unsealed:
            # Self-identifying: a casually-shared file announces it carries spoilers.
            bundle["bundle"] = "orwell-debug-unsealed"
            bundle["_SPOILERS"] = (
                "Producer's Vault — live secret state (off-screen scheming, NPC confessionals, "
                "hidden ties, sealed twists, true eviction votes). Owner-ruled DEBUG override of "
                "mandate #2; do not share.")
            # Credential redaction still applies (Vault ≠ credentials) — but NOT the
            # secret-shaped-KEY redaction: the Vault's game "secrets" ARE the content
            # this export deliberately reveals.
            bundle["producerVault"] = _scrub_bundle(
                await _producer_vault_section(user), redact_keys=False)
            try:
                bundle["meta"]["sections"]["producerVault"] = {"present": True, "unsealed": True}
            except Exception:
                pass
        import json as _json
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        flavor = "unsealed-" if unsealed else ""
        return Response(
            content=_json.dumps(bundle, indent=2, ensure_ascii=False, default=str),
            media_type="application/json",
            headers={
                "Content-Disposition":
                    f'attachment; filename="orwell-debug-bundle-{flavor}{stamp}.json"',
                "Cache-Control": "no-store",
            },
        )

    @router.get("/ops/behavioral-flags")
    async def admin_behavioral_flags_get(request: Request):
        """B2 (gap-audit G6/#1840): the admin dial's READ side — the CURRENT resolved on/off
        state of every "living house" behavioral-fidelity layer for THIS admin's sandbox (env
        default or a prior override), so the status page can render truthfully. Vault-free;
        never hard-fails — an unreachable engine reads as every flag False (the deploy floor)."""
        require_admin(request)
        user = None
        try:
            user = effective_user(request)
        except Exception:
            pass
        try:
            flags = await orwell_engine.get_behavioral_flags(user=user)
        except Exception as e:
            logger.warning("[ops] behavioral-flags read failed: %s", e)
            flags = {}
        if not isinstance(flags, dict):
            flags = {}
        return {f: bool(flags.get(f)) for f in orwell_engine.BEHAVIORAL_FLAG_FIELDS}

    @router.post("/ops/behavioral-flags")
    async def admin_behavioral_flags_set(request: Request):
        """B2 (gap-audit G6/#1840): the admin dial's WRITE side — flip one or more "living
        house" behavioral-fidelity layers (campaigns/trajectories/triggers/secretPacing/
        juryHouse/seededTieSurfacing/mythMaking/showrunner) at runtime on THIS admin's sandbox,
        no engine restart. Body: `{<flag>: bool, ...}`, every field optional — an absent field
        leaves that layer's current setting untouched. Resets on engine restart (the env default
        stands again); this is a live-only operator convenience, not a persisted setting."""
        require_admin(request)
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        user = None
        try:
            user = effective_user(request)
        except Exception:
            pass
        try:
            result = await orwell_engine.set_behavioral_flags(body, user=user)
        except Exception as e:
            logger.warning("[ops] behavioral-flags write failed: %s", e)
            return {"ok": False, "reason": f"engine error: {e}"}
        if not isinstance(result, dict):
            return {"ok": False, "reason": "engine returned no state"}
        logger.info("[ops] admin set behavioral flags: %s",
                    {k: v for k, v in body.items() if k in orwell_engine.BEHAVIORAL_FLAG_FIELDS})
        return {"ok": True}

    return router


# ── G1b: the standalone status page ─────────────────────────────────────────
# "Can we offload the health and logs to a different status page" — yes, and an
# ops status page must be SELF-CONTAINED: zero dependency on the main app shell
# or its JS bundle, so it still renders when the front-end proper is broken.
# One inline document polling /api/admin/health every 10s. Admin-gated like
# everything else on this surface; the Settings card keeps a live summary and
# links here.
_STATUS_PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Orwell — status</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 24px; background: #15171c; color: #cfd8e3;
         font: 14px/1.5 ui-monospace, 'Fira Code', monospace; }
  h1 { font-size: 16px; letter-spacing: .04em; margin: 0 0 4px; }
  .sub { opacity: .55; font-size: 12px; margin-bottom: 18px; }
  .grid { display: grid; grid-template-columns: max-content 1fr; gap: 6px 18px;
          max-width: 760px; margin-bottom: 22px; }
  .k { opacity: .65; }
  .ok { color: #3cb46e; } .bad { color: #e55; } .warn { color: #e0a500; }
  table { border-collapse: collapse; width: 100%; max-width: 980px; font-size: 13px; }
  th, td { text-align: left; padding: 4px 14px 4px 0; border-bottom: 1px solid #262a33; }
  th { opacity: .55; font-weight: 600; }
  td.num { text-align: right; padding-right: 0; }
  /* wrap so the maintenance-button row (and the log-source / retention rows) reflow on a phone
     instead of forcing the layout viewport wider than the screen — this page is the recovery
     surface an operator may open on mobile when the app shell is broken. */
  .actions { margin: 18px 0; display: flex; gap: 12px; flex-wrap: wrap; }
  /* the log-source <select> has long option text ("LLM I/O (live) — full prompt + …"); cap it to
     the row so a wide native control can't push the page past the viewport on a phone. */
  .actions select { max-width: 100%; }
  .btn { color: #9cdef2; border: 1px solid #355a66; border-radius: 8px;
         padding: 6px 12px; text-decoration: none; cursor: pointer;
         background: transparent; font: inherit; display: inline-block; }
  .btn:hover { background: rgba(255,255,255,.06); }
  #err { color: #e55; margin-top: 10px; }
</style></head>
<body>
<h1>ORWELL · STATUS</h1>
<div class="sub">Self-contained ops page — renders even when the app shell is broken. Polls every 10s. <span id="ts"></span></div>
<!-- P1: the DEGRADED-boot banner. Shown only when the FE booted past a broken/inaccessible
     data store (init_db failed) — the operator's cue that the recovery actions below are the
     next step. Hidden when the store is healthy. -->
<div id="degraded" style="display:none;margin:0 0 14px;border:1px solid #7a3b3b;border-radius:8px;padding:10px 12px;background:#231414;max-width:760px;color:#f0a6a6"></div>
<!-- #1599 WI3 — the RED alarm banner. Hidden when clear. Each alarm is a genuine game-breaking
     signal (a guard/judge down, narration failing, a write-back / desync storm, embeddings
     degraded, an integrity fault / open circuit) — INCLUDING auto-corrected faults (a correction
     is not a cloak: still RED, annotated). Populated from the health payload's `alarms` array. -->
<div id="alarms" style="display:none;margin:0 0 14px;max-width:760px"></div>
<div class="grid" id="grid">Loading…</div>
<div class="actions">
  <a class="btn" href="/api/admin/debug-bundle" download>Download debug bundle</a>
  <!-- DEBUG · owner override of mandate #2: the SPOILER bundle. Same download as above PLUS the
       live Producer's Vault section (?vault=1), behind an explicit confirm. The plain link above
       stays Vault-free; this one deliberately includes secret state. -->
  <button type="button" class="btn" id="bundle-vault" style="border-color:#7a3b3b;color:#f0a6a6" title="DEBUG — download the debug bundle WITH the live Producer's Vault (off-screen scheming, NPC confessionals, hidden ties, sealed twists, the real eviction votes). SPOILERS — this deliberately includes your in-progress game's secrets (owner override of mandate #2).">Download debug bundle + Producer's Vault (SPOILERS)</button>
  <button type="button" class="btn" id="refresh-now">Refresh now</button>
  <button type="button" class="btn" id="update-orwell" title="Pull latest, rebuild the engine, refresh front-end deps, and restart both services. The app briefly goes down (~30–60s) and reconnects automatically.">Update Orwell (pull + rebuild + restart)</button>
  <button type="button" class="btn" id="regen-portraits" title="Discard every stored cast portrait for your game and regenerate the full set (debug)">Regenerate cast portraits (debug)</button>
  <button type="button" class="btn" id="ff-finale" title="Drive your live season to a crowned winner so the post-season retrospective unseals (debug; reads no Vault)">Fast-forward to finale (debug)</button>
  <button type="button" class="btn" id="producer-vault" style="border-color:#7a3b3b;color:#f0a6a6" title="DEBUG — UNSEAL the LIVE hidden Vault: off-screen scheming, NPC confessionals, secret ties, the sealed twists, and the real eviction votes. SPOILERS — this deliberately reveals your in-progress game's secrets (owner override of mandate #2). Hidden until you unseal.">Producer's Vault — Unseal (debug · SPOILERS)</button>
  <!-- BEGIN update-reset-combo lane button (self-contained; endpoint + logic live in routes/admin_update_reset_routes.py) -->
  <button type="button" class="btn" id="update-reset" style="border-color:#7a3b3b;color:#f0a6a6" title="DESTRUCTIVE — pulls latest, rebuilds, THEN resets to first-run OOBE: wipes ALL accounts, chats, memory, MCP configs, uploads, and every game. Keeps your API keys / LLM config so you don't re-enter them. Requires typing RESET.">Update + Reset (OOBE, keep API keys)</button>
  <!-- END update-reset-combo lane button -->
  <!-- BEGIN factory-oobe-reset lane button (self-contained; endpoint + logic live in routes/admin_reset_routes.py) -->
  <button type="button" class="btn" id="factory-reset" style="border-color:#7a3b3b;color:#f0a6a6" title="DESTRUCTIVE — wipe ALL accounts, chats, memory, MCP configs, uploads, and every game; return to first-run OOBE. Keeps your API-key/LLM config so you don't re-enter it. Requires typing RESET.">Factory Reset (OOBE)</button>
  <!-- END factory-oobe-reset lane button -->
</div>
<!-- DEBUG · owner override of mandate #2: the Producer's Vault unseal panel. HIDDEN by default
     (display:none) — the live hidden layer appears here ONLY after an explicit "unseal" click +
     spoiler confirm. This is the one place the admin surface deliberately shows Vault content. -->
<div id="pv-panel" style="display:none;margin-top:14px;border:1px solid #7a3b3b;border-radius:8px;padding:12px;background:rgba(122,59,59,.08)">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
    <strong style="color:#f0a6a6">PRODUCER'S VAULT — live secrets (debug)</strong>
    <button type="button" class="btn" id="pv-reseal" title="Hide the unsealed secrets again">Re-seal / hide</button>
  </div>
  <div id="pv-body" style="font-size:13px;line-height:1.5;white-space:pre-wrap"></div>
  <!-- ORW-313: the NPC agendas, one collapsible block per houseguest. Empty (and so invisible) until the explicit unseal fills it; cleared by Re-seal. -->
  <div id="pv-agendas" style="margin-top:10px;font-size:13px;line-height:1.5;word-break:break-word"></div>
</div>
<div id="update-msg" class="sub" style="margin:-6px 0 8px"></div>
<!-- BEGIN ops-progress lane: live step-by-step timeline for the running ops action (Update / -->
<!-- Factory Reset (OOBE) / Update+Reset). Hidden until an action is running or recently done; -->
<!-- the JS region below polls /api/admin/ops-status and survives the services restart. -->
<div id="ops-progress" style="display:none;margin:6px 0 14px;border:1px solid #2d3340;border-radius:8px;padding:10px 12px;background:#101218;max-width:760px">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
    <span id="ops-progress-spinner" style="display:inline-block;width:12px;height:12px;border:2px solid #355a66;border-top-color:#9cdef2;border-radius:50%;animation:opsspin 0.9s linear infinite"></span>
    <strong id="ops-progress-title" style="letter-spacing:.03em">Ops</strong>
    <span id="ops-progress-count" class="sub"></span>
  </div>
  <div id="ops-progress-bar-wrap" style="height:5px;background:#1b1f27;border-radius:3px;overflow:hidden;margin:6px 0 8px">
    <div id="ops-progress-bar" style="height:100%;width:0%;background:#3cb46e;transition:width .4s ease"></div>
  </div>
  <ol id="ops-progress-steps" style="list-style:none;margin:0;padding:0;font-size:12.5px;line-height:1.7"></ol>
  <div id="ops-progress-msg" class="sub" style="margin-top:6px"></div>
</div>
<style>@keyframes opsspin { to { transform: rotate(360deg); } }</style>
<!-- END ops-progress lane -->
<div id="failwrap"></div>
<!-- #1599 WI2 — the per-class/-tool rolling failure-rate rollup (LLM call classes + engine tools +
     guard/judge soft-failure classes). Populated from the health payload's `healthRollup`. -->
<h1 style="margin-top:26px">HEALTH ROLLUP</h1>
<div class="sub">Rolling failure rates over the last hour, by LLM call class, engine tool, and guard/judge class — the same signal the RED alarms above are derived from.</div>
<div id="rollupwrap"></div>
<h1 style="margin-top:26px">CAST AUTHORING &middot; ENRICHMENT</h1>
<div class="sub">The model-driven cast pipeline (genesis → identity → deep authoring → zeitgeist/texture): the runtime policy, the authoring run state, and every recorded per-class failure — a "no model wired" refusal lands here loudly instead of reading as in-fiction stalling.</div>
<div id="enrichwrap"></div>
<h1 style="margin-top:26px">LIVE LOG</h1>
<div class="sub">Every log stream in the program, selectable. Auto-follows the tail while you are at the bottom; scrolling up pauses the follow — scroll back down to resume.</div>
<div class="actions" style="margin:8px 0">
  <select id="logsrc" style="background:#1b1f27;color:#cfd8e3;border:1px solid #355a66;border-radius:8px;padding:5px 8px;font:inherit"></select>
  <span id="follow" class="sub"></span>
</div>
<div id="logpane" style="height:380px;overflow:auto;border:1px solid #262a33;border-radius:8px;padding:8px 10px;background:#101218;white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.45"></div>
<h1 style="margin-top:26px">OPS</h1>
<div class="sub">Run a maintenance script and watch it in the viewer above. Read-only scripts run in-process; the update goes through the root-side trigger (G19b) so the hardened web tier never holds privilege — the viewer follows <code>ops-update.log</code> live, across the restart. The destructive Factory Reset (OOBE) lives in the controls at the top and likewise goes through its own root-side trigger.</div>
<div class="actions" id="opsrow">Loading ops…</div>
<div id="opsmsg" class="sub"></div>
<h1 style="margin-top:26px">LOG RETENTION</h1>
<div class="sub">Full LLM I/O — system prompt + every message + the response, reasoning, tool calls and token usage — is captured to the <strong>LLM I/O (live)</strong> stream above and archived to <code>llm-io.jsonl</code> (also selectable above). Trim every logfile to a horizon to save disk — applied automatically and on demand. Secrets (auth headers / API keys) are never captured.</div>
<div class="grid" id="retgrid" style="margin:10px 0">Loading…</div>
<div class="actions" style="margin:8px 0;align-items:center;flex-wrap:wrap">
  <label class="sub" style="display:flex;align-items:center;gap:6px;cursor:pointer">
    <input type="checkbox" id="trace-toggle"> capture full LLM I/O trace
  </label>
  <label class="sub" style="display:flex;align-items:center;gap:6px">trim logs older than
    <select id="ret-days" style="background:#1b1f27;color:#cfd8e3;border:1px solid #355a66;border-radius:8px;padding:5px 8px;font:inherit"></select>
  </label>
  <button type="button" class="btn" id="trim-now" title="Trim every managed logfile to the selected horizon right now">Trim now</button>
  <span id="retmsg" class="sub"></span>
</div>
<div id="err"></div>
<script nonce="{{CSP_NONCE}}">
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const up = s => { s = Math.max(0, +s || 0); const d = (s/86400)|0, h = ((s%86400)/3600)|0, m = ((s%3600)/60)|0;
  return d ? d+"d "+h+"h" : h ? h+"h "+m+"m" : m ? m+"m" : (s|0)+"s"; };
const B = (ok, t) => '<span class="' + (ok ? "ok" : "bad") + '">' + esc(t) + "</span>";
function render(d) {
  const eng = d.engine || {}, emb = eng.embeddings || null, img = d.images || {},
        ca = d.castAuthoring || null,
        st = (d.frontend || {}).store || {}, tc = eng.toolCalls || {}, ver = d.versions || {};
  // The deployed build/PR version (vX.XX, X.XX = PR#/100) + short commit SHA — confirms WHICH
  // build is live and that an Update actually landed. (The payload already carries it; show it.)
  const build = (ver.frontend ? esc(ver.frontend) : "unknown") +
    (ver.build ? " · " + esc(ver.build) : "") +
    (ver.engine && ver.engine !== ver.frontend ? " · engine " + esc(ver.engine) : "");
  const rows = [
    ["Build", build],
    ["Engine", B(!!eng.ok, eng.ok ? "REACHABLE" : "DOWN") + (eng.latencyMs != null ? " · " + esc(eng.latencyMs) + " ms" : "") + (eng.uptimeSeconds != null ? " · up " + esc(up(eng.uptimeSeconds)) : "") + (eng.error ? " · " + esc(eng.error) : "")],
    ["Tiers agree", B(!!d.tiersAgree, d.tiersAgree ? "YES" : "NO")],
    ["Embeddings", emb ? esc(emb.provider || "?") + " " + B(!emb.degraded, emb.degraded ? "DEGRADED" : "OK") : B(false, "UNKNOWN")],
    ["Image generation", (img.available ? B(true, "AVAILABLE") : B(false, img.enabled ? "NO USABLE MODEL" : "DISABLED")) + (img.model ? " · " + esc(img.model) : "") + (img.portraits && img.portraits.total ? " · portraits " + (img.portraits.missing ? '<span class="warn">' : '<span class="ok">') + esc(img.portraits.present) + "/" + esc(img.portraits.total) + "</span>" : "") + (img.lastRun && img.lastRun.failing ? ' · <span class="warn">last run FAILED (0/' + esc(img.lastRun.attempted) + ' — provider not producing images)</span>' : "")],
    ["Cast authoring", (ca && ca.total ? (ca.missing ? '<span class="warn">' : '<span class="ok">') + esc(ca.authored) + "/" + esc(ca.total) + "</span> deep-authored" + (ca.missing ? " · " + esc(ca.missing) + " on floor" : "") : '<span class="sub">—</span>')],
    ["Tool calls", esc(tc.total ?? 0) + " total · " + esc(tc.failed ?? 0) + " failed"],
    ["Front-end store", (st.degraded ? B(false, "DEGRADED") + " · " : "") + esc(st.sessions ?? "?") + " session(s) · " + esc(st.messages ?? "?") + " message(s)" + (st.database_size_mb != null ? " · " + esc(st.database_size_mb) + " MB" : "")],
  ];
  document.getElementById("grid").innerHTML = rows.map(r => '<div class="k">' + esc(r[0]) + "</div><div>" + r[1] + "</div>").join("");
  // #1599 WI3 — the RED alarm banner: each game-breaking signal (or auto-corrected fault) as its
  // own red card. A correction is not a cloak — an auto-corrected alarm is still RED, tagged.
  const alarms = Array.isArray(d.alarms) ? d.alarms : [];
  // Null-guard the element like renderRollup (`if (!el) return;`) — a missing #alarms must never
  // throw and wedge the 10s status-page poll on "Loading…".
  const alarmsEl = document.getElementById("alarms");
  if (alarmsEl && alarms.length) {
    alarmsEl.style.display = "";
    alarmsEl.innerHTML = alarms.map(a =>
      '<div style="border:1px solid #7a3b3b;border-radius:8px;padding:8px 12px;margin:0 0 8px;background:#231414;color:#f0a6a6">' +
      '<strong>● ' + esc(a.label || a.code || "ALARM") + "</strong>" +
      (a.count != null ? ' <span class="sub" style="color:#f0a6a6">×' + esc(a.count) + "</span>" : "") +
      (a.autoCorrected ? ' <span style="border:1px solid #7a3b3b;border-radius:6px;padding:0 6px;font-size:11px">auto-corrected</span>' : "") +
      (a.detail ? '<div class="sub" style="color:#d79a9a;margin-top:3px">' + esc(a.detail) + "</div>" : "") +
      "</div>").join("");
  } else if (alarmsEl) {
    alarmsEl.style.display = "none";
    alarmsEl.innerHTML = "";
  }
  // #1599 WI2 — the per-class/-tool failure-rate rollup table (LLM classes, engine tools, guards).
  renderRollup(d.healthRollup || {});
  // P1: surface a clear DEGRADED-boot banner when the data store failed to initialize.
  // The app booted past it on purpose so this page stays reachable — point the operator at
  // the recovery actions above.
  const deg = document.getElementById("degraded");
  if (st.degraded) {
    deg.style.display = "";
    deg.innerHTML = "<strong>Data store DEGRADED.</strong> The front-end booted in recovery mode because the database could not be initialized" +
      (st.initError ? " — <code>" + esc(st.initError) + "</code>" : "") +
      ". The app is serving so you can act: use <strong>Update</strong> (if a fix is merged) or <strong>Factory Reset (OOBE)</strong> below to recover. Your API-key / LLM config is preserved by the reset.";
  } else {
    deg.style.display = "none";
  }
  const fails = (eng.recentFailures || []).slice().reverse();
  const feLast = (d.frontend || {}).lastError;
  const fmt = ms => { try { return new Date(ms).toISOString().slice(0, 19).replace("T", " "); } catch { return ""; } };
  document.getElementById("failwrap").innerHTML =
    "<table><thead><tr><th>Time (UTC)</th><th>Tool</th><th>Error</th><th style='text-align:right'>Duration</th></tr></thead><tbody>" +
    (fails.map(f => "<tr><td>" + esc(fmt(f.ts)) + "</td><td>" + esc(f.tool) + "</td><td>" + esc(f.errorClass) + "</td><td class='num'>" + esc(f.durationMs) + " ms</td></tr>").join("") ||
     "<tr><td colspan=4>No recent failures on record.</td></tr>") + "</tbody></table>" +
    (((d.frontend || {}).integrityRefusal) ? "<div class='fail' style='margin-top:8px;color:#c0392b;font-weight:600'>RED &mdash; the engine's integrity checkpoint is REFUSING turns (" + esc(((d.frontend || {}).integrityRefusal || {}).tool) + ", " + esc((((d.frontend || {}).integrityRefusal || {}).kinds || []).join(",")) + ", invariant " + esc(((d.frontend || {}).integrityRefusal || {}).invariant || "unknown") + ", " + esc(((d.frontend || {}).integrityRefusal || {}).count) + " refusal(s)). The game cannot advance; state is unchanged.</div>" : "") +
    (feLast ? "<div class='sub' style='margin-top:8px'>Front-end tier: " + esc(feLast.tool || "?") + " — " + esc(feLast.kind || "") + " — " + esc(feLast.error || "") + "</div>" : "");
  // CAST AUTHORING · ENRICHMENT (2026-07-12): the authoring run state + the per-class failure
  // ledger. Pre-game castAuthoring carries {pregame, givenUp, houseEntryHold}; in-game it carries
  // the completeness counters (also summarized in the grid row above). Vault-free throughout —
  // timestamps / call classes / reasons / houseguest IDS only, never cast content.
  const enr = d.enrichment || null;
  const eFails = ((enr && enr.failures) || []).slice().reverse().slice(0, 15);
  const gaveUp = (ca && ca.givenUp) || [];
  const hold = ca && ca.houseEntryHold;
  const runState =
    !ca ? '<span class="sub">unknown (engine unreachable)</span>' :
    ca.pregame ? ("pre-game (casting): authoring pipeline " +
                  (hold ? '<span class="warn">HOLDING house entry (' + esc(hold.state || "authoring") + ")</span>" : "runs during the interview") +
                  (gaveUp.length ? ' · <span class="warn">gave up on ' + esc(gaveUp.length) + " houseguest(s)</span>" : "")) :
    (ca.total ? esc(ca.authored) + "/" + esc(ca.total) + " deep-authored" +
                (ca.missing ? ' · <span class="warn">' + esc(ca.missing) + " on floor</span>" : "") +
                (gaveUp.length ? ' · <span class="warn">gave up on ' + esc(gaveUp.length) + "</span>" : "")
              : '<span class="sub">—</span>');
  document.getElementById("enrichwrap").innerHTML =
    "<div class='sub' style='margin:6px 0'>Policy: <strong>" + esc(enr ? enr.policy : "?") + "</strong>" +
    " · Run state: " + runState + "</div>" +
    "<table><thead><tr><th>Time (UTC)</th><th>Call class</th><th>Failure</th></tr></thead><tbody>" +
    (eFails.map(f => "<tr><td>" + esc(fmt((f.at || 0) * 1000)) + "</td><td>" + esc(f.callClass) + "</td><td>" +
                     esc(f.reason) + (f.detail ? " — " + esc(f.detail) : "") + "</td></tr>").join("") ||
     "<tr><td colspan=3>No enrichment failures on record.</td></tr>") + "</tbody></table>";
}
// #1599 WI2 — render the per-class/-tool failure-rate rollup as three small tables (LLM call
// classes, engine tools, guard/judge soft-failure classes). Vault-free: class tokens + counts.
function renderRollup(rl) {
  const el = document.getElementById("rollupwrap");
  if (!el) return;
  const rate = (f, t) => t ? '<span class="' + (f ? "warn" : "ok") + '">' + esc(f) + "/" + esc(t) +
    " (" + Math.round((f / t) * 100) + "%)</span>" : '<span class="sub">0/0</span>';
  const rows = (obj, cols) => {
    const keys = Object.keys(obj || {}).sort();
    if (!keys.length) return "<tr><td colspan=" + cols + " class='sub'>none in window</td></tr>";
    return keys.map(k => {
      const v = obj[k] || {};
      const gc = v.total == null;  // guards carry failed/autoCorrected, no total
      return "<tr><td>" + esc(k) + "</td><td class='num'>" +
        (gc ? '<span class="warn">' + esc(v.failed || 0) + "</span>" +
              (v.autoCorrected ? " <span class='sub'>(" + esc(v.autoCorrected) + " auto-corrected)</span>" : "")
            : rate(v.failed || 0, v.total || 0)) + "</td></tr>";
    }).join("");
  };
  // F8 (#1741): the LLM table gets its own row renderer with an extra "empty" column —
  // `finishReason: None` / vanished completions, a FIRST-CLASS count distinct from the blunt
  // failed/total (which also lumps in 4xx/5xx/timeout). Zero renders muted, any count warns.
  const llmRows = (obj) => {
    const keys = Object.keys(obj || {}).sort();
    if (!keys.length) return "<tr><td colspan=3 class='sub'>none in window</td></tr>";
    return keys.map(k => {
      const v = obj[k] || {};
      const empty = v.emptyCompletions || 0;
      return "<tr><td>" + esc(k) + "</td><td class='num'>" + rate(v.failed || 0, v.total || 0) +
        "</td><td class='num'>" + (empty ? '<span class="warn">' + esc(empty) + "</span>" : '<span class="sub">0</span>') +
        "</td></tr>";
    }).join("");
  };
  el.innerHTML =
    "<table style='margin-bottom:10px'><thead><tr><th>LLM call class</th><th style='text-align:right'>failed/total</th><th style='text-align:right'>empty completions</th></tr></thead><tbody>" +
    llmRows(rl.llm) + "</tbody></table>" +
    "<table style='margin-bottom:10px'><thead><tr><th>Engine tool</th><th style='text-align:right'>failed/total</th></tr></thead><tbody>" +
    rows(rl.tools, 2) + "</tbody></table>" +
    "<table><thead><tr><th>Guard / judge class</th><th style='text-align:right'>failures</th></tr></thead><tbody>" +
    rows(rl.guards, 2) + "</tbody></table>";
}
// ── update-awareness that SURVIVES the restart (localStorage) ──
// The Update button restarts BOTH tiers, including this page's own host. An in-memory reconnect
// loop dies if the page reloads mid-restart (browser auto-reload, or the admin refreshes) — and
// the regular health poll would then show a HARD "Health check failed" red during a perfectly
// normal ~60s bounce. A persisted flag (set when an update/restart begins, cleared when the tiers
// answer healthy) lets a fresh page load RESUME the soft "reconnecting…" state and recover quietly.
const UPDATING_KEY = "orwell-admin-updating";
const UPDATING_TTL_MS = 5 * 60 * 1000; // a stale flag (a crash mid-update) auto-expires after 5 min
// `const updMsg` is declared lower in this script; load() runs before it, so reach the node lazily
// (avoid a temporal-dead-zone ReferenceError on the resume-on-reload path).
const updMsgEl = () => document.getElementById("update-msg");
function markUpdating() { try { localStorage.setItem(UPDATING_KEY, String(Date.now())); } catch (e) {} }
function clearUpdating() { try { localStorage.removeItem(UPDATING_KEY); } catch (e) {} }
function isUpdating() {
  try {
    const v = localStorage.getItem(UPDATING_KEY);
    if (!v) return false;
    if (Date.now() - Number(v) > UPDATING_TTL_MS) { clearUpdating(); return false; }
    return true;
  } catch (e) { return false; }
}
async function load() {
  try {
    const r = await fetch("/api/admin/health", { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const d = await r.json();
    render(d);
    document.getElementById("err").textContent = "";
    document.getElementById("ts").textContent = "Last check: " + new Date().toLocaleTimeString();
    // The tiers answered healthy → any in-progress update/restart has landed; drop the soft state.
    if (d && d.engine && d.engine.ok && isUpdating()) { clearUpdating(); const m = updMsgEl(); if (m) m.textContent = ""; }
  } catch (e) {
    // During a known update/restart a failed probe is EXPECTED — show the soft "reconnecting" line,
    // not a hard red outage. Outside an update it is a genuine failure and reads as one.
    if (isUpdating()) {
      document.getElementById("err").textContent = "";
      const m = updMsgEl(); if (m) m.textContent = "Updating… the app is restarting, reconnecting…";
    } else {
      document.getElementById("err").textContent = "Health check failed: " + e.message;
    }
  }
}
load();
setInterval(load, 10000);
document.getElementById("refresh-now").addEventListener("click", load);
// On a fresh page load DURING a restart (the page's own host bounced and reloaded), resume the
// reconnecting loop instead of stranding the admin on a stale/error view.
if (isUpdating()) { const m = updMsgEl(); if (m) m.textContent = "Updating… reconnecting after the restart…"; waitForBack(); }

// ── the sticky-tail multi-source log viewer (G1b) ──
const pane = document.getElementById("logpane"), pill = document.getElementById("follow"),
      sel = document.getElementById("logsrc");
let logSrc = "live", cursor = 0, following = true, fresh = 0;
const atBottom = () => pane.scrollHeight - pane.scrollTop - pane.clientHeight < 8;
function updPill() {
  pill.innerHTML = following ? '<span class="ok">following</span>'
    : '<span class="warn">paused</span>' + (fresh ? " · " + fresh + " new — scroll down to resume" : "");
}
pane.addEventListener("scroll", () => {
  const b = atBottom();
  if (b && !following) { following = true; fresh = 0; }
  else if (!b) following = false;
  updPill();
});
const LV = { ERROR: "bad", WARNING: "warn", WARN: "warn", INFO: "", DEBUG: "" };
function lineHtml(l) {
  const t = l.ts ? new Date(l.ts).toISOString().slice(11, 19) + " " : "";
  let h = '<div><span class="sub">' + esc(t) + "</span>" +
    (l.level ? '<span class="' + (LV[l.level] ?? "") + '">' + esc(l.level) + "</span> " : "") +
    esc(l.msg);
  if (l.args !== undefined) h += '<div class="sub" style="margin-left:14px">→ ' + esc(l.args) +
    "</div><div class='sub' style='margin-left:14px'>← " + esc(l.result) + "</div>";
  return h + "</div>";
}
async function pollLogs() {
  try {
    const r = await fetch("/api/admin/logs?source=" + encodeURIComponent(logSrc) + "&since=" + cursor,
                          { credentials: "same-origin" });
    if (!r.ok) return;
    const d = await r.json();
    cursor = d.next;
    if (!d.lines.length) return;
    const stick = following || atBottom();
    pane.insertAdjacentHTML("beforeend", d.lines.map(lineHtml).join(""));
    while (pane.children.length > 2500) pane.removeChild(pane.firstChild);
    if (stick) { pane.scrollTop = pane.scrollHeight; following = true; fresh = 0; }
    else fresh += d.lines.length;
    updPill();
  } catch (e) { /* transient — the next poll retries */ }
}
async function loadSources() {
  try {
    const r = await fetch("/api/admin/logs/sources", { credentials: "same-origin" });
    const d = await r.json();
    sel.innerHTML = (d.sources || []).map(s => '<option value="' + esc(s.id) + '">' + esc(s.label) + "</option>").join("");
    sel.value = logSrc;
  } catch (e) {}
}
sel.addEventListener("change", () => {
  logSrc = sel.value; cursor = 0; following = true; fresh = 0;
  pane.innerHTML = ""; updPill(); pollLogs();
});
loadSources();
updPill();
pollLogs();
setInterval(pollLogs, 2000);

// ── G19a: ops buttons — run, then watch the matching log in the viewer ──
const opsRow = document.getElementById("opsrow"), opsMsg = document.getElementById("opsmsg");
async function watchLog(name) {
  await loadSources();                       // a fresh run may have created the file
  const id = "file:" + name;
  if ([...sel.options].some(o => o.value === id)) {
    sel.value = id; sel.dispatchEvent(new Event("change"));
  }
}
async function runOps(sid) {
  opsMsg.textContent = "Starting " + sid + "…";
  try {
    const r = await fetch("/api/admin/ops/run/" + encodeURIComponent(sid), { method: "POST", credentials: "same-origin" });
    const d = await r.json();
    if (d.started) { opsMsg.textContent = sid + " running — following its log."; setTimeout(() => watchLog(d.log), 600); }
    else opsMsg.textContent = sid + ": " + (d.error || "could not start");
  } catch (e) { opsMsg.textContent = "Request failed: " + e.message; }
}
async function triggerUpdate() {
  if (!confirm("Run the updater on this box now? The services will restart; this page keeps following the log.")) return;
  opsMsg.textContent = "Triggering the updater…";
  try {
    const r = await fetch("/api/admin/ops/trigger-update", { method: "POST", credentials: "same-origin" });
    const d = await r.json();
    opsMsg.textContent = d.triggered ? "Update triggered — following ops-update.log (the page rides through the restart)."
                                     : (d.note || "update trigger unavailable (watcher not installed or not running)");
    if (d.triggered) setTimeout(() => watchLog(d.log), 1500);
  } catch (e) { opsMsg.textContent = "Request failed: " + e.message; }
}
// ── G25: the debug regenerate lever — discard + regenerate every cast portrait ──
async function regenPortraits() {
  if (!confirm("Discard EVERY stored cast portrait for your game and regenerate the full set now? (Refused safely if the engine or image model is unavailable.)")) return;
  opsMsg.textContent = "Discarding portraits and queueing regeneration…";
  try {
    const r = await fetch("/api/admin/ops/regenerate-portraits", { method: "POST", credentials: "same-origin" });
    const d = await r.json();
    opsMsg.textContent = d.regenerated
      ? "Discarded " + d.discarded + " — regenerating " + d.queued + " in the background; following portrait-log.jsonl."
      : "Refused: " + (d.reason || "unknown") + " — nothing was discarded.";
    if (d.regenerated) setTimeout(() => watchLog(d.log), 1200);
  } catch (e) { opsMsg.textContent = "Request failed: " + e.message; }
}
document.getElementById("regen-portraits").addEventListener("click", regenPortraits);
// ── L38: the fast-forward lever — finish the season so the retrospective unseals (reads no Vault) ──
async function fastForwardFinale() {
  if (!confirm("Fast-forward your live season to a crowned winner now? This finishes the season (the player may lose) so the post-season Vault retrospective unseals. It reads no Vault — God Mode never sees the secrets in advance.")) return;
  opsMsg.textContent = "Driving the season to its finale…";
  try {
    const r = await fetch("/api/admin/ops/advance-to-finale", { method: "POST", credentials: "same-origin" });
    const d = await r.json();
    opsMsg.textContent = d.finished
      ? "Season finished — " + esc(d.winnerName || "the winner") + " crowned after " + esc(d.weeks) + " week(s); you placed " + esc(d.playerPlacement) + ". The retrospective is now reachable."
      : "Could not finish: " + esc(d.reason || "unknown") + ".";
  } catch (e) { opsMsg.textContent = "Request failed: " + e.message; }
}
document.getElementById("ff-finale").addEventListener("click", fastForwardFinale);
// ── DEBUG · owner override of mandate #2: the Producer's Vault unseal ─────────────────────────────
// HIDDEN by default. An explicit click + spoiler confirm UNSEALS the LIVE hidden layer into #pv-panel
// — the one place the admin surface deliberately shows Vault content. Re-seal hides it again.
// The dump is written into #pv-body via .textContent (a non-markup sink) below, so the lines
// MUST be the RAW strings — DON'T esc() them. textContent does not decode HTML entities, so an
// escaped apostrophe would render verbatim as "&#39;" (issue #851). It's also XSS-safe: textContent
// never interprets markup. (The one place this admin surface deliberately shows Vault content.)
function renderVault(v) {
  if (!v) return "No active game to unseal.";
  var out = [];
  if (v.winner) out.push("WINNER (so far): " + (v.winner.name || ""));
  var story = Array.isArray(v.hiddenStory) ? v.hiddenStory : [];
  out.push("\\nHIDDEN LAYER (" + story.length + " entr" + (story.length === 1 ? "y" : "ies") + "):");
  for (var i = 0; i < story.length; i++) out.push("  • [" + (story[i].type || "") + "] " + (story[i].content || ""));
  var tw = Array.isArray(v.twists) ? v.twists : [];
  if (tw.length) {
    out.push("\\nSEALED TWISTS:");
    for (var j = 0; j < tw.length; j++) out.push("  • " + (tw[j].kind || "") + (tw[j].firedWeek != null ? " — fired week " + tw[j].firedWeek : " — not fired"));
  }
  var ev = Array.isArray(v.evictionVotes) ? v.evictionVotes : [];
  if (ev.length) {
    out.push("\\nTRUE EVICTION VOTES:");
    for (var k = 0; k < ev.length; k++) {
      var w = ev[k];
      var lines = (w.votes || []).map(function (x) { return ((x.voter && x.voter.name) || "") + "→" + ((x.votedFor && x.votedFor.name) || ""); });
      out.push("  • Week " + w.week + " (out: " + ((w.evictee && w.evictee.name) || "") + "): " + lines.join(", "));
    }
  }
  return out.join("\\n");
}
// ORW-313: the NPC agendas (goals, reasons, history) from the unsealed dump, one collapsible <details> per houseguest. Built with createElement + textContent only (no markup sink, XSS-safe), and
// called ONLY from the explicit unseal below - never on page load.
function renderAgendas(box, list) {
  box.textContent = "";
  if (!Array.isArray(list) || !list.length) return;
  function line(parent, text, style) { var d = document.createElement("div"); d.style.cssText = style || ""; d.textContent = text; parent.appendChild(d); }
  function goalBlock(parent, g) {
    var wrap = document.createElement("div");
    wrap.style.cssText = "margin:6px 0 10px;padding-left:8px;border-left:2px solid #7a3b3b";
    line(wrap, "[" + (g.horizon || "") + "] " + (g.kind || "") + (g.target ? " -> " + g.target : "") + "  (" + (g.status || "") + ", commitment " + g.commitment + "%)", "font-weight:600");
    (g.why || []).forEach(function (w) { line(wrap, "because: " + w); });
    line(wrap, "worked if: " + (g.test || ""));
    line(wrap, "formed " + (g.formed || "") + (g.resolved ? ", resolved " + g.resolved : ""));
    if (g.endNote) line(wrap, "ended: " + g.endNote);
    parent.appendChild(wrap);
  }
  line(box, "AGENDAS (" + list.length + " houseguest" + (list.length === 1 ? "" : "s") + ")", "font-weight:700;margin:6px 0");
  list.forEach(function (a) {
    var d = document.createElement("details");
    d.style.cssText = "border:1px solid #4a3030;border-radius:6px;margin:6px 0;padding:0 10px";
    var sm = document.createElement("summary");
    sm.style.cssText = "cursor:pointer;padding:12px 0;font-weight:600";
    sm.textContent = (a.houseguest || "") + " - " + (a.goals || []).length + " active, " + (a.history || []).length + " resolved";
    d.appendChild(sm);
    (a.goals || []).forEach(function (g) { goalBlock(d, g); });
    if ((a.history || []).length) { line(d, "History (resolved, oldest first)", "font-weight:700;margin:8px 0 2px"); a.history.forEach(function (g) { goalBlock(d, g); }); }
    box.appendChild(d);
  });
}
async function unsealProducerVault() {
  if (!confirm("UNSEAL THE PRODUCER'S VAULT?\\n\\nThis deliberately reveals your LIVE game's SECRETS — off-screen scheming, NPC confessionals, hidden ties, the sealed twists, and the real eviction votes. It overrides the God-Mode Vault wall (mandate #2) for debugging.\\n\\nThis WILL spoil your in-progress game. Continue?")) return;
  var body = document.getElementById("pv-body");
  var panel = document.getElementById("pv-panel");
  body.textContent = "Unsealing…";
  panel.style.display = "block";
  try {
    const r = await fetch("/api/admin/ops/producer-vault", { method: "POST", credentials: "same-origin" });
    const d = await r.json();
    // textContent sink — write the RAW reason (don't esc(); the entity would render verbatim, #851).
    body.textContent = d.ok ? renderVault(d.vault) : ("Could not unseal: " + ((d && d.reason) || "unknown") + ".");
    renderAgendas(document.getElementById("pv-agendas"), d.ok && d.vault ? d.vault.agendas : null);
  } catch (e) { body.textContent = "Request failed: " + e.message; }
}
document.getElementById("producer-vault").addEventListener("click", unsealProducerVault);
document.getElementById("pv-reseal").addEventListener("click", function () {
  document.getElementById("pv-body").textContent = "";
  document.getElementById("pv-agendas").textContent = ""; // ORW-313: re-seal hides the agendas too
  document.getElementById("pv-panel").style.display = "none";
});
// ── DEBUG · owner override of mandate #2: the SPOILER bundle download ──────────────────────────────
// The plain "Download debug bundle" <a> above is Vault-free. This one navigates to ?vault=1 (the
// route's explicit opt-in) so the downloaded JSON ALSO carries the live Producer's Vault section —
// behind the same spoiler confirm as the unseal. The default download is untouched.
document.getElementById("bundle-vault").addEventListener("click", function () {
  if (!confirm("DOWNLOAD THE DEBUG BUNDLE WITH THE PRODUCER'S VAULT?\\n\\nThe downloaded file will deliberately INCLUDE your LIVE game's SECRETS — off-screen scheming, NPC confessionals, hidden ties, the sealed twists, and the real eviction votes. It overrides the God-Mode Vault wall (mandate #2) for debugging.\\n\\nThis file WILL spoil your in-progress game — do not share it. Continue?")) return;
  window.location.href = "/api/admin/debug-bundle?vault=1";
});
// ── BEGIN update-reset-combo lane: destructive Update + Reset (pull+rebuild THEN OOBE; type RESET) ──
// Pulls latest + rebuilds, THEN wipes everything to first-run OOBE — keeping the API-key/LLM config.
// Demands an explicit typed "RESET" (not just an OK), then posts to the admin-gated endpoint in
// routes/admin_update_reset_routes.py and rides the restart back to OOBE via waitForBack().
async function updateReset() {
  const typed = prompt(
    "UPDATE + RESET (OOBE)\\n\\n" +
    "First UPDATES: pulls latest, rebuilds the engine, refreshes front-end deps.\\n" +
    "Then RESETS to OOBE: PERMANENTLY deletes ALL accounts, chats, memory, MCP server configs, " +
    "uploads, every user setting, and every game — returning the app to first-run onboarding.\\n\\n" +
    "PRESERVED: your API keys / LLM provider configuration (so you don't re-enter them).\\n" +
    "If the update fails, the reset does NOT run and nothing is wiped.\\n\\n" +
    "Type RESET to confirm:");
  if (typed === null) return;                 // cancelled
  if (typed.trim() !== "RESET") { updMsg.innerHTML = '<span class="warn">Update + Reset cancelled — you must type RESET exactly.</span>'; return; }
  updMsg.textContent = "Starting update + reset…";
  try {
    // The server REQUIRES the typed phrase too (400 without it) — the prompt alone is not the check.
    const r = await fetch("/api/admin/update-reset", { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: typed.trim() }) });
    const d = await r.json();
    if (d && d.started) {
      updMsg.innerHTML = '<span class="warn">Updating + resetting… returning to OOBE. The app is restarting, reconnecting…</span>';
      waitForBack();
    } else {
      updMsg.textContent = "";
      const bad = document.createElement("span"); bad.className = "bad";   // a span, so the line keeps its own styling
      bad.textContent = "Could not start the update + reset" + ((d && (d.detail || d.error)) ? ": " + (d.detail || d.error) : ".");
      updMsg.appendChild(bad);
    }
  } catch (e) {
    // A dropped connection here can simply mean the restart already began — start reconnecting.
    updMsg.innerHTML = '<span class="warn">Update + reset requested (connection dropped — likely already restarting); reconnecting to OOBE…</span>';
    waitForBack();
  }
}
document.getElementById("update-reset").addEventListener("click", updateReset);
// ── END update-reset-combo lane ──
// ── BEGIN factory-oobe-reset lane: destructive OOBE reset (type RESET to confirm) ──
// Wipes ALL accounts/chats/memory/MCP/settings + every game; keeps the API-key/LLM config.
// Demands an explicit typed "RESET" (not just an OK), then posts to the admin-gated endpoint
// in routes/admin_reset_routes.py and rides the restart back to OOBE via waitForBack().
async function factoryReset() {
  const typed = prompt(
    "FACTORY RESET (OOBE)\\n\\n" +
    "This PERMANENTLY deletes ALL accounts, chats, memory, MCP server configs, uploads, every " +
    "user setting, and every game — returning the app to first-run onboarding.\\n\\n" +
    "PRESERVED: your API-key / LLM provider configuration (so you don't re-enter it).\\n\\n" +
    "Type RESET to confirm:");
  if (typed === null) return;                 // cancelled
  if (typed.trim() !== "RESET") { updMsg.innerHTML = '<span class="warn">Reset cancelled — you must type RESET exactly.</span>'; return; }
  updMsg.textContent = "Starting factory reset…";
  try {
    // The server REQUIRES the typed phrase too (400 without it) — the prompt alone is not the check.
    const r = await fetch("/api/admin/factory-reset", { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: typed.trim() }) });
    const d = await r.json();
    if (d && d.started) {
      updMsg.innerHTML = '<span class="warn">Resetting… returning to OOBE. The app is restarting, reconnecting…</span>';
      waitForBack();
    } else {
      updMsg.textContent = "";
      const bad = document.createElement("span"); bad.className = "bad";   // a span, so the line keeps its own styling
      bad.textContent = "Could not start the reset" + ((d && (d.detail || d.error)) ? ": " + (d.detail || d.error) : ".");
      updMsg.appendChild(bad);
    }
  } catch (e) {
    // A dropped connection here can simply mean the restart already began — start reconnecting.
    updMsg.innerHTML = '<span class="warn">Reset requested (connection dropped — likely already restarting); reconnecting to OOBE…</span>';
    waitForBack();
  }
}
document.getElementById("factory-reset").addEventListener("click", factoryReset);
// ── END factory-oobe-reset lane ──
// ── one-click Update: pull → rebuild → refresh FE deps → restart both, then reconnect ──
const updMsg = document.getElementById("update-msg");
function waitForBack() {
  // The services restart (this page's host included). Poll /api/admin/health until the engine
  // answers again, then reload. Generous attempts (~3 min) cover a cold npm ci + rebuild.
  let tries = 0;
  const tick = async () => {
    tries++;
    try {
      const r = await fetch("/api/admin/health", { credentials: "same-origin", cache: "no-store" });
      if (r.ok) {
        const d = await r.json();
        if (d && d.engine && d.engine.ok) {
          clearUpdating(); // the bounce landed — the persisted soft state has served its purpose
          updMsg.innerHTML = '<span class="ok">Back online — reloading…</span>';
          setTimeout(() => location.reload(), 800);
          return;
        }
      }
    } catch (e) { /* still down — keep polling */ }
    updMsg.textContent = "Updating… the app is restarting, reconnecting (" + tries + ")";
    if (tries < 90) setTimeout(tick, 2000);
    else updMsg.innerHTML = '<span class="warn">Still reconnecting — refresh the page manually in a moment.</span>';
  };
  setTimeout(tick, 4000); // give the restart a head start before the first probe
}
async function updateOrwell() {
  if (!confirm("Update Orwell now?\\n\\nThis pulls latest, rebuilds the engine, refreshes front-end deps, and restarts both services — the app will briefly go down (~30–60s) and reconnect automatically.")) return;
  // Persist the "updating" awareness BEFORE the restart can drop this page — so a reload mid-bounce
  // resumes the reconnecting state instead of showing a false hard outage.
  markUpdating();
  updMsg.textContent = "Starting the update…";
  try {
    const r = await fetch("/api/admin/update", { method: "POST", credentials: "same-origin" });
    const d = await r.json();
    if (d && d.started) {
      updMsg.textContent = "Update started — the app will restart, reconnecting…";
      waitForBack();
    } else {
      clearUpdating(); // the update never actually started — don't strand the page in soft state
      updMsg.innerHTML = '<span class="bad">Could not start the update.</span>';
    }
  } catch (e) {
    // A connection drop here can simply mean the restart already began — start reconnecting.
    updMsg.textContent = "Update requested (connection dropped — likely already restarting); reconnecting…";
    waitForBack();
  }
}
document.getElementById("update-orwell").addEventListener("click", updateOrwell);
// ── BEGIN ops-progress lane ──
// Poll /api/admin/ops-status and render a live timeline for whichever ops action is running
// (Update / Factory Reset (OOBE) / Update+Reset). Survives the services restart: the action being
// watched is persisted to localStorage and resumed after waitForBack() reloads the page; on
// completion it shows "done / updated / OOBE ready", on failure the error — so the old silent
// "triggered then nothing" can never recur.
const OPS_PROGRESS_KEY = "orwell.ops.watching";          // localStorage: the action we're tracking
const OPS_STEP_LABELS = {
  // FALLBACK phase names only — used to label a COMPLETED step that this page never observed live
  // (e.g. it was opened mid-run / after the restart). They must mirror the exact ops_progress_step()
  // messages in the deploy scripts so the fallback never invents a step the updater didn't run. The
  // server's live message is the source of truth for the current step and is what fills these in as
  // the run progresses; these are never used to PRE-LIST steps the updater hasn't reached yet.
  "update": ["fetching latest code", "rebuilding engine", "refreshing front-end deps", "restarting services", "updated"],
  "factory-reset": ["stopping services", "preserving API keys / LLM config", "wiping front-end store", "scrubbing game sandboxes", "restarting services", "OOBE ready"],
  // orwell-update-reset.sh emits exactly TWO steps (total=2) — the old 7-label list pre-populated
  // fabricated rows that never matched what the updater reported.
  "update-reset": ["updating (pull → rebuild → refresh deps)", "resetting to OOBE (keep API keys) + final restart"],
};
const OPS_TITLES = { "update": "Updating Orwell", "factory-reset": "Factory Reset (OOBE)", "update-reset": "Update + Reset" };
// This panel tracks ONLY the three top-of-page maintenance actions. public-deployment / tls also
// publish ops-status entries, but they have their OWN inline progress areas — surfacing them here
// would render a titleless, label-less panel ("extraneous data"). Restrict to what this panel owns.
const OPS_PANEL_ACTIONS = ["update", "factory-reset", "update-reset"];
// A finished/failed run is only "now" for a short window. After it lapses the panel hides instead
// of resurrecting a stale completion banner on every later page-load (the old d.latest behavior).
const OPS_FRESH_MS = 120000;
function opsFresh(s) { if (!s || !s.ts) return false; const t = Date.parse(s.ts); return isFinite(t) && (Date.now() - t) < OPS_FRESH_MS; }
function opsMarkWatching(action) { try { localStorage.setItem(OPS_PROGRESS_KEY, action); } catch (e) {} }
function opsClearWatching() { try { localStorage.removeItem(OPS_PROGRESS_KEY); } catch (e) {} }
function opsGetWatching() { try { return localStorage.getItem(OPS_PROGRESS_KEY); } catch (e) { return null; } }
const opsPanel = document.getElementById("ops-progress");
// Live, per-action record of the messages the updater HAS actually reported this session
// (step number → message), built up as we poll. Completed-step rows are labeled from what we
// genuinely observed — never a guess — and we only fall back to the static labels for a step we
// never saw (the page was opened mid-run / after the restart).
const opsSeen = {};
function renderOpsProgress(s) {
  // s = a normalized status object from /api/admin/ops-status (or null). Hide when nothing is live.
  if (!s) { opsPanel.style.display = "none"; return; }
  const action = s.action || "ops";
  // The SERVER is authoritative for the count — the updater's own ops_progress_init <total> — so we
  // never invent a step total from a client label list (that drifted: update-reset declares 2 steps,
  // the old map listed 7). step is the live current step, clamped into range.
  const total = s.total || 0;
  const step = Math.max(0, Math.min(s.step || 0, total || (s.step || 0)));
  const cleanMsg = (s.message || "").replace(/^FAILED:\\s*/, "").trim();
  // Record the live observation so a later render labels this completed step with what REALLY ran.
  if (step >= 1 && cleanMsg) { (opsSeen[action] = opsSeen[action] || {})[step] = cleanMsg; }
  const seen = opsSeen[action] || {};
  const fallback = OPS_STEP_LABELS[action] || [];
  const labelFor = i => seen[i] || fallback[i - 1] || ("step " + i);
  opsPanel.style.display = "block";
  document.getElementById("ops-progress-title").textContent = OPS_TITLES[action] || action;
  document.getElementById("ops-progress-count").textContent = total ? ("step " + step + " / " + total) : "";
  // Bar = steps actually COMPLETED, never ahead of the ✓ rows (a step merely in flight is not done).
  const completed = s.ok ? total : Math.max(0, step - 1);
  const pct = total ? Math.round(completed / total * 100) : (s.ok ? 100 : 0);
  const bar = document.getElementById("ops-progress-bar");
  bar.style.width = pct + "%";
  bar.style.background = s.error ? "#e55" : (s.ok ? "#3cb46e" : "#9cdef2");
  document.getElementById("ops-progress-spinner").style.display = s.running ? "inline-block" : "none";
  // Render ONLY the steps the updater has actually reached — completed (✓) plus the one in flight
  // (●, labeled with the LIVE server message) or the one that failed (✗). On success the whole set
  // is done. Future steps are NOT pre-listed, so the panel grows from real progress and shows no
  // fabricated rows before the updater gets there.
  const upto = s.ok ? total : step;   // step 0 (init) ⇒ no rows yet, just "starting…" below
  const rows = [];
  for (let i = 1; i <= upto; i++) {
    let mark, cls, label;
    if (s.error && i === step) { mark = "✗"; cls = "bad"; label = labelFor(i); }
    else if (s.ok || i < step) { mark = "✓"; cls = "ok"; label = labelFor(i); }
    else { mark = "●"; cls = ""; label = cleanMsg || labelFor(i); }   // current step — live message
    rows.push("<li><span class=\\"" + cls + "\\">" + mark + "</span> <span>" + esc(label) + "</span></li>");
  }
  document.getElementById("ops-progress-steps").innerHTML = rows.join("");
  // Message line carries only what the rows don't already say: a failure's detail (+ which log), or
  // the pre-first-step "starting…" note. The running step's live text already lives in its ● row and
  // the success message in its final ✓ row, so neither is echoed here.
  const msgEl = document.getElementById("ops-progress-msg");
  if (s.error) {
    msgEl.innerHTML = '<span class="bad">' + esc(s.message || ("FAILED: " + s.error)) + " — see " + esc(s.log || "the ops log") + "</span>";
  } else if (!s.ok && step === 0 && cleanMsg) {
    msgEl.innerHTML = '<span class="sub">' + esc(cleanMsg) + "</span>";
  } else {
    msgEl.textContent = "";
  }
}
async function pollOpsProgress() {
  try {
    const r = await fetch("/api/admin/ops-status", { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return;
    const d = await r.json();
    const acts = d.actions || {};
    const inPanel = a => OPS_PANEL_ACTIONS.indexOf(a) !== -1;
    const watching = opsGetWatching();
    // Decide what (if anything) is live RIGHT NOW, in priority order:
    //   1. a running panel action,
    //   2. the action we were told to watch (so a deliberate restart resumes its timeline),
    //   3. the freshest terminal panel action — but ONLY while still fresh.
    // Anything else (an old completed/failed run, or a tls/public-deployment entry) is NOT "now",
    // so the panel hides rather than resurrecting a stale banner.
    let action = (d.running && inPanel(d.running)) ? d.running : null;
    let fromWatch = false;
    if (!action && watching && inPanel(watching) && acts[watching]) { action = watching; fromWatch = true; }
    if (!action) {
      let best = null, bestTs = "";
      for (const a of OPS_PANEL_ACTIONS) { const st = acts[a]; if (st && st.ts && st.ts > bestTs) { bestTs = st.ts; best = a; } }
      if (best && opsFresh(acts[best])) action = best;
    }
    const s = action ? acts[action] : null;
    // A terminal state surfaced only via the freshness fallback must actually be fresh; a watched or
    // running action always shows (the watched terminal covers the post-restart reload, then clears).
    if (!s || (!s.running && !fromWatch && !opsFresh(s))) { renderOpsProgress(null); return; }
    renderOpsProgress(s);
    if (s.running) opsMarkWatching(action);          // keep tracking this one across the reload
    else if (fromWatch && (s.ok || s.error)) opsClearWatching();  // shown once post-restart; stop re-asserting
  } catch (e) { /* transient (likely the restart) — the next poll retries */ }
}
// Mark which action to track the moment its button is clicked, so the timeline resumes after the
// restart-triggered reload. Non-invasive: we ADD listeners to the existing buttons (their own
// lanes own the click→POST flow); these only set the localStorage breadcrumb the poller reads.
(function () {
  const u = document.getElementById("update-orwell");
  if (u) u.addEventListener("click", () => opsMarkWatching("update"));
  const ur = document.getElementById("update-reset");
  if (ur) ur.addEventListener("click", () => opsMarkWatching("update-reset"));
  const fr = document.getElementById("factory-reset");
  if (fr) fr.addEventListener("click", () => opsMarkWatching("factory-reset"));
})();
pollOpsProgress();
setInterval(pollOpsProgress, 2000);
// ── END ops-progress lane ──
async function loadOps() {
  try {
    const r = await fetch("/api/admin/ops", { credentials: "same-origin" });
    const d = await r.json();
    let h = (d.scripts || []).map(s => '<button type="button" class="btn" data-ops="' + esc(s.id) + '">' + esc(s.label) + "</button>").join("");
    const t = d.updateTrigger || {};
    h += t.installed
      ? '<button type="button" class="btn" id="ops-update">Run update (root trigger)</button>'
      : '<span class="sub">update trigger unavailable — the root watcher (orwell-ops-update.path) is not installed or not running; run the deploy updater, or: systemctl enable --now orwell-ops-update.path</span>';
    opsRow.innerHTML = h;
    opsRow.querySelectorAll("[data-ops]").forEach(b => b.addEventListener("click", () => runOps(b.dataset.ops)));
    const u = document.getElementById("ops-update");
    if (u) u.addEventListener("click", triggerUpdate);
  } catch (e) { opsRow.textContent = "ops unavailable"; }
}
loadOps();
// ── log retention + LLM I/O trace controls ──
const retGrid = document.getElementById("retgrid"), retDays = document.getElementById("ret-days"),
      traceToggle = document.getElementById("trace-toggle"), retMsg = document.getElementById("retmsg");
function retBytes(n) { n = Math.max(0, +n || 0); const u = ["B","KB","MB","GB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(1) : (n|0)) + " " + u[i]; }
function renderRetention(d) {
  const files = (d.files || []).slice().sort((a, b) => b.bytes - a.bytes);
  const rows = [
    ["Total log size", '<strong>' + esc(d.totalHuman || "0 B") + "</strong>"],
    ["LLM I/O trace", d.traceEnabled ? B(true, "ON") : B(false, "OFF")],
    ["Retention", d.retentionDays ? esc(d.retentionDays) + " day(s)" : "keep everything"],
  ];
  retGrid.innerHTML = rows.map(r => '<div class="k">' + esc(r[0]) + "</div><div>" + r[1] + "</div>").join("") +
    (files.length ? '<div class="k">Files</div><div class="sub">' +
      files.map(f => esc(f.name) + " — " + esc(retBytes(f.bytes))).join("<br>") + "</div>" : "");
}
async function loadRetention() {
  try {
    const r = await fetch("/api/admin/logs/retention", { credentials: "same-origin", cache: "no-store" });
    if (!r.ok) return;
    const d = await r.json();
    retDays.innerHTML = (d.choices || []).map(c => '<option value="' + esc(c.days) + '">' + esc(c.label) + "</option>").join("");
    retDays.value = String(d.retentionDays);
    traceToggle.checked = !!d.traceEnabled;
    renderRetention(d);
  } catch (e) {}
}
async function saveRetention(body, note) {
  retMsg.textContent = note || "saving…";
  try {
    const r = await fetch("/api/admin/logs/retention", { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    renderRetention(d);
    retMsg.textContent = "";
  } catch (e) { retMsg.innerHTML = '<span class="bad">save failed</span>'; }
}
traceToggle.addEventListener("change", () => saveRetention({ traceEnabled: traceToggle.checked }));
retDays.addEventListener("change", () => saveRetention({ retentionDays: +retDays.value }, "applying horizon…"));
document.getElementById("trim-now").addEventListener("click", async () => {
  retMsg.textContent = "trimming…";
  try {
    const r = await fetch("/api/admin/logs/trim", { method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days: +retDays.value }) });
    const d = await r.json();
    renderRetention(d);
    retMsg.innerHTML = '<span class="ok">freed ' + esc(d.removedHuman || "0 B") + " — now " + esc(d.totalHuman) + "</span>";
  } catch (e) { retMsg.innerHTML = '<span class="bad">trim failed</span>'; }
});
loadRetention();
setInterval(loadRetention, 15000);
</script>
</body></html>"""


# ── G19a: ops from the status page ──────────────────────────────────────────
# Allowlisted, read-only-by-construction script runs + the update TRIGGER.
# The web tier never chooses what executes: fixed ids → fixed argv. The update
# is not run here at all — the FE is the E85-hardened unit (no privileges, and
# a self-update would kill its own parent mid-run); it writes a flag file that
# a root-side systemd path unit (deploy/systemd/orwell-ops-update.*, G19b)
# watches, running the real updater and teeing to data/ops-update.log — which
# the viewer above tails live, ACROSS the restart (the page is self-contained).
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_OPS_SCRIPTS = {
    # id → (label, script, argv, log basename) — READ-ONLY modes only.
    "panel": ("Health panel (read-only)", "orwell-login-panel.sh", [], "ops-panel.log"),
    "doctor-status": ("Doctor — status only (read-only)", "orwell-doctor.sh", ["--status"], "ops-doctor.log"),
}
_OPS_RUNNING = {}

# L37 — size-cap the on-disk ops logs. Each run opens the file with "w" (so it never APPENDS across
# runs), but a single run can still capture an unbounded journal/diagnostic tail (the 2026-06-19
# incident, where an engine-down firehose ballooned the captured journal). After the run we cap the
# file to its last `_OPS_LOG_CAP_BYTES`, keeping the most-recent (most-useful) tail and prefixing a
# truncation marker — so the file the /admin/status viewer tails can never grow without bound.
_OPS_LOG_CAP_BYTES = 256 * 1024  # 256 KB — generous for a health/diagnostic tail, bounded for the disk


def _cap_log_file(path: str, cap: int = _OPS_LOG_CAP_BYTES) -> None:
    """Truncate `path` IN PLACE to AT MOST `cap` bytes total when it exceeds the cap, keeping the
    freshest tail and a one-line truncation marker (the marker counts toward the cap, so the result
    is genuinely bounded AND a second pass is a true no-op). Best-effort: any error is swallowed so a
    capping failure never breaks the reaper. A file already at/under the cap is left byte-identical."""
    try:
        if not os.path.isfile(path):
            return
        size = os.path.getsize(path)
        if size <= cap:
            return
        marker = (
            f"[ops] log truncated to the last {cap} bytes "
            f"(older output dropped to keep the on-disk log bounded)\n"
        ).encode("utf-8")
        tail_bytes = max(0, cap - len(marker))
        with open(path, "rb") as fh:
            fh.seek(size - tail_bytes)
            tail = fh.read()
        with open(path, "wb") as fh:
            fh.write(marker)
            fh.write(tail)
    except Exception:
        pass


def _ops_script_path(script: str) -> str:
    return os.path.join(_REPO_ROOT, "deploy", script)


async def _run_ops_script(sid: str) -> dict:
    label, script, argv, log_name = _OPS_SCRIPTS[sid]
    path = _ops_script_path(script)
    if not os.path.isfile(path):
        return {"started": False, "error": "script-missing"}
    if _OPS_RUNNING.get(sid):
        return {"started": False, "error": "already-running", "log": log_name}
    log_path = os.path.join(_data_dir(), log_name)
    os.makedirs(_data_dir(), exist_ok=True)
    logger.info("[ops] admin run: %s (%s)", sid, script)
    import datetime as _dt
    import subprocess
    import threading
    f = open(log_path, "w", encoding="utf-8")
    f.write(f"==== {label} · {_dt.datetime.now(timezone.utc).isoformat()} ====\n")
    f.flush()
    # A plain Popen + daemon-thread reaper, NOT an asyncio task: a task created
    # on the request loop dies with that loop (TestClient tears it down per
    # request, and uvicorn workers can recycle), which orphaned the exit marker
    # and leaked _OPS_RUNNING=True. The thread outlives any loop.
    proc = subprocess.Popen(["bash", path, *argv], cwd=_REPO_ROOT, stdout=f, stderr=f)
    _OPS_RUNNING[sid] = True

    def _reap():
        try:
            code = proc.wait()
            f.write(f"\n[ops] exit {code}\n")
        finally:
            f.close()
            _OPS_RUNNING[sid] = False
            _cap_log_file(log_path)  # L37: keep the on-disk log bounded (tail only)
    threading.Thread(target=_reap, name=f"ops-reap-{sid}", daemon=True).start()
    return {"started": True, "log": log_name}


def setup_admin_status_page() -> APIRouter:
    """The self-contained ops page at /admin/status (G1b) — its own router so the
    page lives outside the /api prefix; same require_admin contract."""
    router = APIRouter(tags=["admin_health"])

    @router.get("/admin/status")
    async def admin_status_page(request: Request):
        require_admin(request)
        # The page's inline <script> needs the per-request CSP nonce, exactly like
        # index.html's {{CSP_NONCE}} templating (core/middleware.py sets the strict
        # script-src 'nonce-…'); without it the poller is CSP-blocked and the page
        # sits at "Loading…" forever (regression fix).
        nonce = getattr(request.state, "csp_nonce", "")
        html = _STATUS_PAGE.replace("{{CSP_NONCE}}", nonce)
        return Response(content=html, media_type="text/html")

    return router
