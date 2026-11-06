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
"""

from __future__ import annotations

import json
import logging
import math
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
) -> dict:
    """Build the bounded, Vault-free entry. Every field is coerced to a number / id /
    known token; there is no path for a free-form body to land in the stored shape."""
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
    }


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
) -> None:
    """Append one Vault-free per-turn token/cost record for ``user`` (per-user scoped),
    bounded by a per-user ring, and emit one structured ``[orwell]`` log line.

    Every argument is coerced to a small number / id / known token; message bodies,
    narration, prompts, responses, casting answers, and any engine secret CANNOT be
    stored — that is a hard invariant, enforced by the coercion in ``_entry`` rather than
    by careful callers. Errors are swallowed: ledgering must never hurt the app."""
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
        )
        k = _key(user)
        with _LOCK:
            data = _load()
            bucket = data.get(k)
            if not isinstance(bucket, list):
                bucket = []
            bucket.append(entry)
            if len(bucket) > _MAX_PER_USER:
                bucket = bucket[-_MAX_PER_USER:]  # bounded — drop oldest
            data[k] = bucket
            atomic_write_json(str(LEDGER_PATH), data, indent=2)
        _log_line(k, entry)
    except Exception as e:  # pragma: no cover - defence in depth
        try:
            logger.debug("[orwell] token-ledger record failed: %s", e)
        except Exception:
            pass


def game_cost_total(user: str | None, session: Any) -> float:
    """Sum of ``cost`` over this user's entries for ``session`` (per-user scoped).
    A missing/corrupt store or an unknown session answers ``0.0``."""
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
    try:
        threshold = float(threshold_usd)
    except (TypeError, ValueError):
        return False
    if not math.isfinite(threshold) or threshold <= 0:
        return False
    return game_cost_total(user, session) > threshold


def clear(user: str | None) -> None:
    """Drop the user's ledger (used by a full account/factory reset). Per-user scoped."""
    k = _key(user)
    with _LOCK:
        data = _load()
        if k in data:
            del data[k]
            atomic_write_json(str(LEDGER_PATH), data, indent=2)


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
            "in=%s cached=%s reasoning=%s out=%s cap=%s finish=%s cost=%.6f ctx=%s%% provider=%s",
            user_key,
            entry.get("session") or "-",
            entry.get("turnId") or "-",
            entry.get("callClass") or "-",
            entry.get("inputTokens"),
            entry.get("cachedTokens"),
            entry.get("reasoningTokens"),
            entry.get("outputTokens"),
            entry.get("appliedMaxTokens"),
            entry.get("finishReason") or "-",
            entry.get("cost") or 0.0,
            ("%.1f" % ctx) if isinstance(ctx, (int, float)) else "-",
            entry.get("provider") or "-",
        )
    except Exception:  # pragma: no cover
        pass
