"""Feature 0069 / ADR 0010 (token economy) — the per-turn token/cost ledger.

The sibling of the 0065 sync ledger (``orwell_sync_ledger.py``): same store shape, same
locking / atomic-write / bounded-ring / error-swallowing discipline, same per-user
isolation. Where the sync ledger records *what the harness did to keep things synced*,
this one records *what each turn cost* — token counts (by class) and the dollar cost —
so the token economy (soft budget alerts, per-game cost totals, an admin cost view) has a
single, structured, body-free source of truth.

Each turn produces one entry::

    { ts, turnId, session, callClass, inputTokens, cachedTokens, reasoningTokens,
      outputTokens, appliedMaxTokens, finishReason, cost, costEstimated, contextPercent, provider }

``appliedMaxTokens`` is the OUTPUT cap that was actually sent on the wire for the turn (ADR 0010
follow-on #1 — the admin-editable per-class value), and ``finishReason`` is the provider's terminal
stop reason (``"length"`` ⇒ the reply was truncated by that cap). Both are admin/internal observability
only; like every other field they are coerced to a scalar / clipped id, so they can never carry a body.

Vault-free / body-free by construction (hard invariant)
-------------------------------------------------------
This ledger stores **only numbers, short ids, and one known call-class token** — *never*
a message body, narration, casting answer, prompt, response, or any engine secret. The
guarantee is **structural**: ``record_turn`` coerces every input to a small scalar / id
(counts via ``_clean_int``, cost / context-percent via ``_clean_float``, ids / provider /
call-class via the clipped ``_clean_id``) and there is no free-form text field anywhere in
the stored shape. A pathological caller cannot smuggle a body through any field. (The
function signature only accepts the documented kwargs, so an unexpected payload kwarg is
rejected at the call site too.)

Boundaries (mirrors the sync ledger)
------------------------------------
  * **Bounded.** Per-user retention is a ring (drop oldest beyond ``_MAX_PER_USER``).
  * **Per-user isolated.** Entries live under the user's key; ``get_recent`` /
    ``game_cost_total`` / ``check_soft_alert`` answer only that user's slice.
  * **Logging must never hurt the app.** The recorder swallows its own errors.
  * **Writing is off the caller's thread.** ``record_turn`` builds the entry (so the
    call-site / day context of the caller applies), then hands it to ONE daemon writer
    thread. Readers and ``clear`` drain the queue first (``drain_pending_writes``) so they never miss a
    just-recorded entry; an ``atexit`` hook drains it at shutdown.
"""

from __future__ import annotations

import atexit
import contextvars
import datetime as _dt
import json
import logging
import math
import queue
import sys
import threading
import time
from pathlib import Path
from typing import Any

from core.atomic_io import atomic_write_json
from src.constants import DATA_DIR

logger = logging.getLogger(__name__)

# A small JSON map {username: [entry, ...]}. Mirrors orwell_sync_ledger: a bounded,
# human-readable blob in the data dir, atomically written. The factory-reset scrub of
# ``data/`` takes it back to empty.
LEDGER_PATH = Path(DATA_DIR) / "orwell_token_ledger.json"

_LOCK = threading.Lock()

# Bounded retention: keep at most this many turn entries PER USER (drop oldest).
_MAX_PER_USER = 500

# Defence in depth on the id / call-class / provider fields. These are short identifiers;
# a pathological client can never write a body through them.
_MAX_ID_LEN = 80

# The per-call write runs on ONE daemon writer thread off a queue, so a model-call turn never
# pays for a read/append/trim/write of the (growing) store on its own thread. The entry is still
# BUILT on the caller's thread (call-site / played-day context lives there); only the locked
# load/append/rollup/write + the log line move to the writer. Readers and ``clear`` call ``drain_pending_writes``
# so they see everything recorded before them; ``atexit`` drains at shutdown.
_QUEUE: "queue.Queue[tuple[str, dict] | None]" = queue.Queue()
_WRITER_STARTED = False
_WRITER_START_LOCK = threading.Lock()
_FLUSH_POLL_SECONDS = 0.002


def _writer_loop() -> None:
    """Consume the queue: apply one entry per item, forever. Never raises — a failed write is
    logged at debug and the loop continues (ledgering must never hurt the app, nor die)."""
    while True:
        item = _QUEUE.get()
        try:
            if item is None:  # shutdown sentinel — drain done, exit the thread
                break
            user_key, entry = item
            try:
                _apply_entry(user_key, entry)
            except Exception as e:  # pragma: no cover - defence in depth
                try:
                    logger.debug("[orwell] token-ledger write failed: %s", e)
                except Exception:
                    pass
        finally:
            _QUEUE.task_done()


def _apply_entry(user_key: str, entry: dict) -> None:
    """The locked store work one queued entry needs: ring append + atomic write, roll-up fold +
    write, then the structured log line. Runs ONLY on the writer thread."""
    with _LOCK:
        data = _load()
        bucket = data.get(user_key)
        if not isinstance(bucket, list):
            bucket = []
        bucket.append(entry)
        if len(bucket) > _MAX_PER_USER:
            bucket = bucket[-_MAX_PER_USER:]  # bounded — drop oldest
        data[user_key] = bucket
        # Runs on every model call: compact JSON, no fsync (see _write_fast).
        _write_fast(LEDGER_PATH, data)
        roll = _load_rollup()
        _roll_up(roll, user_key, entry)
        _write_fast(_rollup_path(), roll)
    _log_line(user_key, entry)


def _ensure_writer() -> None:
    """Start the writer thread once, lazily (first record — never at import)."""
    global _WRITER_STARTED
    if _WRITER_STARTED:
        return
    with _WRITER_START_LOCK:
        if _WRITER_STARTED:
            return
        t = threading.Thread(target=_writer_loop, name="orwell-token-ledger-writer", daemon=True)
        t.start()
        _WRITER_STARTED = True


def drain_pending_writes(timeout: float = 5.0) -> bool:
    """Block until every entry queued SO FAR has been written; ``True`` when drained within
    ``timeout``. Cheap no-op when nothing is pending. Never raises."""
    try:
        try:
            limit = float(timeout)
        except (TypeError, ValueError):
            limit = 5.0
        deadline = time.monotonic() + max(0.0, limit)
        while True:
            with _QUEUE.mutex:  # the queue's own lock guards unfinished_tasks
                pending = _QUEUE.unfinished_tasks
            if pending <= 0:
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(_FLUSH_POLL_SECONDS)
    except Exception:  # pragma: no cover - defence in depth
        return False


def _atexit_flush() -> None:
    """Drain at shutdown so trailing entries are not lost (daemon threads die at interpreter exit)."""
    drain_pending_writes(5.0)


atexit.register(_atexit_flush)


def _key(user: str | None) -> str:
    # A missing user maps to the same "default" bucket the rest of the relay uses.
    return (user or "default").strip() or "default"


def _load() -> dict:
    try:
        data = json.loads(LEDGER_PATH.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception:
        # A corrupt store must never break the game: fall back to "no ledger".
        return {}


def _write_fast(path: Path, data: dict) -> None:
    """Atomic (temp file + rename) but WITHOUT fsync: this is telemetry written on every model call, on the event loop.
    A power cut can lose the last few entries; it can never leave a torn file, and it costs no disk flush per call."""
    import os

    os.makedirs(str(path.parent), exist_ok=True)
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(json.dumps(data, separators=(",", ":")))  # dumps uses the C encoder; dump(f) streams through the pure-Python one
    os.replace(tmp, str(path))


def _rollup_path() -> Path:
    """The roll-up's own file, beside the ledger (derived at call time, so a test that points LEDGER_PATH at a tmp dir moves both)."""
    return LEDGER_PATH.with_name(LEDGER_PATH.stem + "_rollup.json")


def _load_rollup() -> dict:
    try:
        data = json.loads(_rollup_path().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


# ── coercion (the Vault-free floor) ──────────────────────────────────────────────


def _clean_int(v: Any) -> int:
    """A non-negative integer count — anything unusable / negative ⇒ 0."""
    try:
        n = int(v)
    except (TypeError, ValueError):
        return 0
    return n if n >= 0 else 0


def _clean_float(v: Any) -> float:
    """A non-negative, finite float (cost / context-percent). NaN / inf / negative /
    unusable ⇒ 0.0 — a number can never carry text, and non-finite can never persist."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(f):  # reject NaN / +inf / -inf
        return 0.0
    return f if f >= 0.0 else 0.0


def _clean_id(v: Any) -> str:
    """A short identifier / known token — coerced to a clipped string (never a body)."""
    if v is None:
        return ""
    try:
        s = str(v)
    except Exception:
        return ""
    return s[:_MAX_ID_LEN]


def _entry(
    *,
    session: Any,
    turn_id: Any,
    call_class: Any,
    input_tokens: Any,
    cached_tokens: Any,
    reasoning_tokens: Any,
    output_tokens: Any,
    applied_max_tokens: Any,
    finish_reason: Any,
    cost: Any,
    context_percent: Any,
    provider: Any,
    cost_estimated: Any = False,
    call_site: Any = None,
    model: Any = None,
    cache_miss_tokens: Any = None,
    calls: Any = 1,
    day: Any = 0,
) -> dict:
    """Build the bounded, Vault-free entry. Every field is coerced to a number / id /
    known token; there is no path for a free-form body to land in the stored shape."""
    in_t = _clean_int(input_tokens)
    hit_t = _clean_int(cached_tokens)
    # ORW-554: DeepSeek reports prompt_cache_miss_tokens itself; when a caller has only input + hit, miss is the rest.
    miss_t = _clean_int(cache_miss_tokens) if cache_miss_tokens is not None else max(0, in_t - hit_t)
    return {
        "ts": int(time.time() * 1000),
        "turnId": _clean_id(turn_id),
        "session": _clean_id(session),
        "callClass": _clean_id(call_class),
        "inputTokens": _clean_int(input_tokens),
        "cachedTokens": _clean_int(cached_tokens),
        "reasoningTokens": _clean_int(reasoning_tokens),
        "outputTokens": _clean_int(output_tokens),
        # ADR 0010 follow-on #3: the output cap actually applied (count), and the terminal stop reason
        # (a short known token — "length" means the cap truncated the reply). Both Vault-free scalars.
        "appliedMaxTokens": _clean_int(applied_max_tokens),
        "finishReason": _clean_id(finish_reason),
        "cost": _clean_float(cost),
        # A-3: True when `cost` is the FE's estimate from published prices (DeepSeek returns no dollar cost),
        # not a provider-reported figure — so admin totals never present an estimate as authoritative.
        "costEstimated": bool(cost_estimated),
        "contextPercent": _clean_float(context_percent),
        "provider": _clean_id(provider),
        # ORW-554 (token-cost telemetry): WHICH site spent it, on WHICH model, how much of the prompt missed the cache,
        # how many provider calls the entry folds together (a narrator turn is several tool rounds), and the in-game day.
        # All short ids / counts; still no free-form text.
        "callSite": _clean_id(call_site) or _clean_id(call_class),
        "model": _clean_id(model),
        "cacheMissTokens": miss_t,
        "calls": max(1, _clean_int(calls)),
        "day": _clean_int(day),
    }



# ── ORW-554: call site, in-game day, and the daily roll-up ───────────────────────────
#
# The 500-entry ring above holds a few hours of traffic, far too little for a daily cost report. So every
# entry is ALSO folded into a small per-user roll-up (numbers only, keyed by UTC date + call site + model, and by
# played day). It lives in its OWN file (``_rollup_path()``), keyed by user, so a user name can never collide with
# it and the per-call ledger write stays small. Same lock, same atomic write.

_ROLLUP_DAYS = 90          # keep this many UTC dates per user
_ROLLUP_GAME_DAYS = 600    # keep this many (session, played day) rows per user

# The call site of the model call in progress. Explicit callers may set it (``call_site_scope``); otherwise
# ``infer_call_site`` reads it off the call stack.
_SITE: contextvars.ContextVar = contextvars.ContextVar("orwell_call_site", default="")


def current_call_site() -> str:
    try:
        return _SITE.get() or ""
    except Exception:  # pragma: no cover
        return ""


class call_site_scope:
    """``with call_site_scope("npc-minds"):`` tags every ledger entry recorded inside the block."""

    def __init__(self, site: str):
        self._site = _clean_id(site)
        self._tok = None

    def __enter__(self):
        self._tok = _SITE.set(self._site)
        return self

    def __exit__(self, *_exc):
        if self._tok is not None:
            _SITE.reset(self._tok)
        return False


# Module (file stem) -> call-site label, for the model-calling modules of the game. Modules not listed fall back to
# ``module.function`` for the big shared ones, so a new caller still shows up.
_SITE_BY_MODULE = {
    "orwell_day_condense": "day-condense",
    "orwell_cast_genesis": "cast-genesis",
    "orwell_cast_identity": "cast-identity",
    "orwell_gen_competitions": "competitions",
    "orwell_npc_minds_words": "npc-minds",
    "orwell_house_reflections": "house-reflections",
    "orwell_offscreen_texture": "offscreen-texture",
    "orwell_zeitgeist": "zeitgeist",
    "orwell_producer_authoring": "producer-authoring",
    "orwell_tagline": "tagline",
    "orwell_room_canon": "room-canon",
    "orwell_open_ledger": "open-ledger",
    "orwell_portrait_check": "photo-check",
    "orwell_portrait_upgrade": "portrait-upgrade",
    "orwell_portraits": "portrait",
    "orwell_cast_authoring": "cast-authoring",
    "faithfulness": "faithfulness",
}
# Frames that are plumbing, not a call site.
_SITE_SKIP_MODULES = {"llm_core", "orwell_token_ledger", "llm_trace", "asyncio", "contextlib", "threading",
                      "base_events", "events", "tasks", "futures", "runners"}
_SITE_SKIP_FUNCS = {"_once", "_fn", "_bounded_stream", "_llm_call_async_traced", "_meter", "llm_call_async",
                    "_bounded_impl_call", "_attempt", "_call", "record_turn", "infer_call_site"}


def infer_call_site(depth: int = 60) -> str:
    """Name the model call's site from the call stack (a coroutine's frames chain through its awaiters).
    ``""`` when nothing useful is found. Pure bookkeeping; never raises."""
    try:
        f = sys._getframe(1)
        n = 0
        while f is not None and n < depth:
            mod = (f.f_globals.get("__name__") or "").rsplit(".", 1)[-1]
            fn = f.f_code.co_name
            if mod and mod not in _SITE_SKIP_MODULES and fn not in _SITE_SKIP_FUNCS and not mod.startswith("test_"):
                label = _SITE_BY_MODULE.get(mod)
                if label:
                    return label
                if mod in ("agent_loop", "ai_interaction", "tool_execution", "tool_implementations"):
                    return _clean_id(f"{mod}.{fn.lstrip('_')}")
            f = f.f_back
            n += 1
    except Exception:  # pragma: no cover
        pass
    return ""


# The in-game day each user is on (set from the engine's day ledger / a turn-in); 0 when unknown.
_GAME_DAY: dict = {}


def note_game_day(user: str | None, day: Any) -> None:
    """Remember the played day ``user``'s game is on, so later entries carry it. Ignores junk."""
    d = _clean_int(day)
    if d > 0:
        _GAME_DAY[_key(user)] = d


def current_game_day(user: str | None) -> int:
    return _GAME_DAY.get(_key(user), 0)


def _utc_date(ts_ms: Any) -> str:
    try:
        return _dt.datetime.fromtimestamp(int(ts_ms) / 1000.0, _dt.timezone.utc).strftime("%Y-%m-%d")
    except Exception:
        return "unknown"


def _bump(row: dict, entry: dict) -> None:
    row["calls"] = row.get("calls", 0) + _clean_int(entry.get("calls") or 1)
    row["inputTokens"] = row.get("inputTokens", 0) + _clean_int(entry.get("inputTokens"))
    row["cacheHitTokens"] = row.get("cacheHitTokens", 0) + _clean_int(entry.get("cachedTokens"))
    row["cacheMissTokens"] = row.get("cacheMissTokens", 0) + _clean_int(entry.get("cacheMissTokens"))
    row["reasoningTokens"] = row.get("reasoningTokens", 0) + _clean_int(entry.get("reasoningTokens"))
    row["outputTokens"] = row.get("outputTokens", 0) + _clean_int(entry.get("outputTokens"))
    row["cost"] = round(row.get("cost", 0.0) + _clean_float(entry.get("cost")), 8)


def _row_part(v: Any) -> str:
    """One half of a roll-up row key: ``|`` separates site from model, so it can never appear inside either half."""
    return (str(v or "") or "-").replace("|", "/")


def _roll_up(roll: dict, user_key: str, entry: dict) -> None:
    """Fold one entry into ``roll`` (the roll-up file's dict; caller holds the lock and writes the file)."""
    u = roll.get(user_key)
    if not isinstance(u, dict):
        u = {}
    daily = u.get("daily") if isinstance(u.get("daily"), dict) else {}
    date = _utc_date(entry.get("ts"))
    day_rows = daily.get(date) if isinstance(daily.get(date), dict) else {}
    rk = f"{_row_part(entry.get('callSite'))}|{_row_part(entry.get('model'))}"
    row = day_rows.get(rk) if isinstance(day_rows.get(rk), dict) else {}
    _bump(row, entry)
    day_rows[rk] = row
    daily[date] = day_rows
    if len(daily) > _ROLLUP_DAYS:
        for old in sorted(daily)[: len(daily) - _ROLLUP_DAYS]:
            del daily[old]
    u["daily"] = daily
    if entry.get("day"):
        gd = u.get("gameDays") if isinstance(u.get("gameDays"), dict) else {}
        gk = f"{entry.get('session') or '-'}:{entry['day']}"
        grow = gd.get(gk) if isinstance(gd.get(gk), dict) else {}
        _bump(grow, entry)
        gd[gk] = grow
        while len(gd) > _ROLLUP_GAME_DAYS:
            del gd[next(iter(gd))]
        u["gameDays"] = gd
    roll[user_key] = u


def get_rollup(user: str | None) -> dict:
    """The user's roll-up ``{"daily": {date: {"site|model": counters}}, "gameDays": {"session:day": counters}}``."""
    drain_pending_writes()
    with _LOCK:
        roll = _load_rollup()
    u = roll.get(_key(user))
    return u if isinstance(u, dict) else {}


def cache_hit_rate(hit: Any, miss: Any) -> float | None:
    """Share of prompt tokens served from the provider's cache; None when there were no prompt tokens."""
    h, m = _clean_int(hit), _clean_int(miss)
    return (h / (h + m)) if (h + m) > 0 else None


# ── public API ───────────────────────────────────────────────────────────────────


def record_turn(
    user: str | None,
    *,
    session: Any = None,
    turn_id: Any = None,
    call_class: Any = None,
    input_tokens: Any = 0,
    cached_tokens: Any = 0,
    reasoning_tokens: Any = 0,
    output_tokens: Any = 0,
    applied_max_tokens: Any = 0,
    finish_reason: Any = None,
    cost: Any = 0.0,
    context_percent: Any = None,
    provider: Any = None,
    cost_estimated: Any = False,
    call_site: Any = None,
    model: Any = None,
    cache_miss_tokens: Any = None,
    calls: Any = 1,
    day: Any = None,
) -> None:
    """Append one Vault-free per-turn token/cost record for ``user`` (per-user scoped),
    bounded by a per-user ring, and emit one structured ``[orwell]`` log line.

    Every argument is coerced to a small number / id / known token; message bodies,
    narration, prompts, responses, casting answers, and any engine secret CANNOT be
    stored — that is a hard invariant, enforced by the coercion in ``_entry`` rather than
    by careful callers. Errors are swallowed: ledgering must never hurt the app.

    The entry is BUILT here (so the caller's call-site / played-day context applies) and the
    store write happens on the daemon writer thread; readers and ``clear`` drain via ``drain_pending_writes``."""
    try:
        entry = _entry(
            session=session,
            turn_id=turn_id,
            call_class=call_class,
            input_tokens=input_tokens,
            cached_tokens=cached_tokens,
            reasoning_tokens=reasoning_tokens,
            output_tokens=output_tokens,
            applied_max_tokens=applied_max_tokens,
            finish_reason=finish_reason,
            cost=cost,
            context_percent=context_percent,
            provider=provider,
            cost_estimated=cost_estimated,
            call_site=call_site or current_call_site() or infer_call_site(),
            model=model,
            cache_miss_tokens=cache_miss_tokens,
            calls=calls,
            day=day if day is not None else current_game_day(user),
        )
        _ensure_writer()
        _QUEUE.put((_key(user), entry))
    except Exception as e:  # pragma: no cover - defence in depth
        try:
            logger.debug("[orwell] token-ledger record failed: %s", e)
        except Exception:
            pass


def game_cost_total(user: str | None, session: Any) -> float:
    """Sum of ``cost`` over this user's entries for ``session`` (per-user scoped).
    A missing/corrupt store or an unknown session answers ``0.0``."""
    drain_pending_writes()
    sess = _clean_id(session)
    with _LOCK:
        bucket = _load().get(_key(user))
    if not isinstance(bucket, list):
        return 0.0
    total = 0.0
    for e in bucket:
        if isinstance(e, dict) and e.get("session") == sess:
            total += _clean_float(e.get("cost"))
    return total


def get_recent(user: str | None, limit: int = 50) -> list[dict]:
    """The user's most-recent ledger entries (newest last), capped at ``limit``.
    Strictly per-user: never returns another user's entries. A missing/corrupt store
    answers ``[]``."""
    drain_pending_writes()
    try:
        n = int(limit)
    except (TypeError, ValueError):
        n = 50
    if n <= 0:
        return []
    with _LOCK:
        bucket = _load().get(_key(user))
    if not isinstance(bucket, list):
        return []
    return [e for e in bucket if isinstance(e, dict)][-n:]


def check_soft_alert(user: str | None, session: Any, threshold_usd: Any) -> bool:
    """``True`` iff this user's running cost for ``session`` is strictly over
    ``threshold_usd``. A non-positive (or unusable) threshold ⇒ ``False`` (no alert)."""
    drain_pending_writes()
    try:
        threshold = float(threshold_usd)
    except (TypeError, ValueError):
        return False
    if not math.isfinite(threshold) or threshold <= 0:
        return False
    return game_cost_total(user, session) > threshold


def clear(user: str | None) -> None:
    """Drop the user's ledger (used by a full account/factory reset). Per-user scoped."""
    drain_pending_writes()
    k = _key(user)
    with _LOCK:
        data = _load()
        if data.pop(k, None) is not None:
            atomic_write_json(str(LEDGER_PATH), data, indent=2)
        roll = _load_rollup()
        if roll.pop(k, None) is not None:
            atomic_write_json(str(_rollup_path()), roll, indent=None)


# ORW-198: a turn whose model spent more than this many REASONING tokens is a slow-turn suspect (the DeepSeek route thinks on every round even with narration reasoning "off"; slow turns showed 4.3k-10k
# reasoning tokens vs <=1.6k on fast ones). Counts only - the alarm carries ids and numbers, never a body.
REASONING_ALARM_TOKENS = 3000


def reasoning_alarm(entry: dict) -> bool:
    """True iff this ledger entry's reasoning tokens exceed REASONING_ALARM_TOKENS (a slow-turn suspect)."""
    try:
        return int(entry.get("reasoningTokens") or 0) > REASONING_ALARM_TOKENS
    except (TypeError, ValueError):
        return False


def _log_line(user_key: str, entry: dict) -> None:
    """One structured ``[orwell]`` line per turn — picked up by the LIVE root-logger ring
    for the admin viewer. Counts + caps + finish + cost + class + ctx% only (no body)."""
    try:
        ctx = entry.get("contextPercent")
        (logger.warning if reasoning_alarm(entry) else logger.info)(
            "[orwell] token-ledger turn user=%s session=%s turn=%s class=%s "
            "in=%s cached=%s miss=%s reasoning=%s out=%s cap=%s finish=%s cost=%.6f ctx=%s%% provider=%s site=%s model=%s",
            user_key,
            entry.get("session") or "-",
            entry.get("turnId") or "-",
            entry.get("callClass") or "-",
            entry.get("inputTokens"),
            entry.get("cachedTokens"),
            entry.get("cacheMissTokens"),
            entry.get("reasoningTokens"),
            entry.get("outputTokens"),
            entry.get("appliedMaxTokens"),
            entry.get("finishReason") or "-",
            entry.get("cost") or 0.0,
            ("%.1f" % ctx) if isinstance(ctx, (int, float)) else "-",
            entry.get("provider") or "-",
            entry.get("callSite") or "-",
            entry.get("model") or "-",
        )
    except Exception:  # pragma: no cover
        pass
