"""Feature 0065 (Part D) — the per-turn LLM↔engine sync/divergence ledger.

The 0065 spine makes the *closed set* (facts, outcomes, bookkeeping) rigorously synced
between the narration LLM and the deterministic engine. Part D is its **observability**
slice: a single, structured, per-turn record of *what the harness did to keep things
synced* — so "I have to debug the harness a lot" stops meaning grepping scattered ad-hoc
``logger.info`` lines.

Each turn produces one entry::

    { turnId, session, beatSeqBefore, beatSeqAfter, toolsCalled, nudgesFired,
      autoBackfills, desyncDetected, staleRejections, idempotencyHits }

Dedup decision vs. PR #406 (REQUIRED by the spec) — SIBLING, not an extension
--------------------------------------------------------------------------------
PR #406 shipped ``src/llm_trace.py`` + the ``log_rings.LLMIO`` ring: a **full LLM I/O
trace** — every model call recorded with the *full request* (system prompt + every
message + tool schemas + sampling params) and the *full response* (assistant text +
reasoning + tool calls + usage). It is:

  * **payload-bearing** (it exists precisely to capture prompt/response *bodies*),
  * **global / not user-scoped** (one ``data/llm-io.jsonl`` archive + one in-memory ring,
    keyed by call, with horizon-days retention + a "Trim now" button), and
  * **per model-call**, not per game turn.

This ledger is deliberately the **inverse**: it is **Vault-free and body-free by
construction** (ids / counts / event NAMES / small booleans only — *never* a message
body, narration, casting answer, or any engine secret), it is **per-``_current_user``
scoped and isolated** (one user can never read another's entries), and it aggregates at
the **turn** grain (counts of nudges / back-fills / stale rejections, the beatSeq
before→after). Folding turn-grain closed-set counters into #406's full-payload,
global, retention-governed archive would either (a) dilute that archive's "everything
in/out of the LLM" purpose, or (b) require re-introducing user scoping and a body-free
discipline that #406 explicitly does not have. So the non-duplicative path is a
**small sibling store** that mirrors the existing per-user FE stores
(``orwell_seasons.py`` / ``orwell_layout.py`` — a bounded JSON map in ``DATA_DIR``,
atomically written, ``_current_user``-keyed) and emits **one structured ``[orwell]``
log line per turn** through the project logger (which the #406 ``log_rings.LIVE`` root
handler already taps for the admin viewer — so the turn line is visible there *without*
this module ever touching #406's payload archive).

Boundaries
----------
  * **Vault-free by construction (hard invariant).** ``record_turn`` coerces every input
    to a small scalar / id / name and drops anything else; no free-form text field is
    ever stored. The closed-set counters carry no game secret.
  * **Bounded.** Per-user retention is a ring (drop oldest beyond the cap).
  * **Per-user isolated.** Entries live under the user's key; ``get_recent`` answers only
    that user's slice.
  * **Logging must never hurt the app.** The recorder swallows its own errors.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from pathlib import Path
from typing import Any, Iterable

from core.atomic_io import atomic_write_json
from src.constants import DATA_DIR

logger = logging.getLogger(__name__)

# A small JSON map {username: [entry, ...]}. Mirrors orwell_seasons / orwell_layout: a
# bounded, human-readable blob in the data dir, atomically written. The factory-reset
# scrub of ``data/`` takes it back to empty.
LEDGER_PATH = Path(DATA_DIR) / "orwell_sync_ledger.json"

_LOCK = threading.Lock()

# Bounded retention: keep at most this many turn entries PER USER (drop oldest).
_MAX_PER_USER = 200

# Defence in depth on the name/id fields a turn may carry. Tool / event names are short
# identifiers; a pathological client can never write a body through them.
_MAX_NAMES = 64
_MAX_NAME_LEN = 80

# The exact field set an entry may hold. NOTHING outside this is ever persisted — the
# Vault-free guarantee is structural, not a matter of careful callers.
_INT_FIELDS = (
    "beatSeqBefore",
    "beatSeqAfter",
    "nudgesFired",
    "autoBackfills",
    "staleRejections",
    "idempotencyHits",
)
_BOOL_FIELDS = ("desyncDetected",)
_ID_FIELDS = ("turnId", "session")  # short identifiers (never a body)
_NAME_LIST_FIELDS = ("toolsCalled",)  # lists of tool/event NAMES only
_NAME_MAP_FIELDS = ("beltsFired",)  # {beltName: count} maps — names + small ints only

# ── Belt-fire telemetry (product gap #3 — docs/design/undercall-seam-structural.md §5) ──
# Every FE guardrail belt that error-corrects a model under-call calls `note_belt_fire`
# when it FIRES. Fires buffer in memory per user and are drained into the next
# `record_turn` entry's `beltsFired` map, so playtests can MEASURE belt reliance
# (`get_belt_totals`) instead of feeling it. Belt names are short FE-authored tokens
# (the registry lives in the design doc); the same coercion floor applies — a body can
# never pass through a belt name.
_PENDING_BELTS: dict[str, dict[str, int]] = {}

# ── T0-4 (telemetry + probe arm): ATTEMPT-counted forced-tool_choice outcome telemetry ──
# The success-gated `beltsFired["forced-tool-choice:<tool>"]` counter above answers "how many
# forced calls landed" but is BLIND to the denominator — a live playtest logged 20 forced
# selections against only 7 honored belt-fires, and the ledger had no record of the other 13 at
# all (an ATTEMPT the model ignored left no trace anywhere). This is an ADDITIVE dimension, not a
# redefinition: `note_belt_fire` / `beltsFired` / `get_belt_totals` keep their existing
# success-gated contract (a count still means an APPLIED correction) — `note_forced_choice` /
# `forcedChoice` / `get_forced_choice_totals` are a SIBLING counter recording every attempt with
# its outcome (honored | ignored), so `attempted = honored + ignored` is always visible. Same
# Vault-free floor: tool NAMES + small ints only, never a body.
_PENDING_FORCED: dict[str, dict[str, dict[str, int]]] = {}
_MAX_FORCED_TOOLS = 32

# ── S6b (#1599 item 3): count ALL StaleBeatErrors + a beat-continuity dropped-fold check ──
# Today only the advance path's `_handle_stale_beat` bumped a process-global counter that the agent
# loop folded into the turn's `staleRejections`. A `recordInteraction` fold that got dropped on a
# double stale-409 (the A-S3 latent) reconciled OUTSIDE that window, so its ledger row showed
# `staleRejections:0` even though the board had moved 46 beats under it — a lost consequence fold
# that was completely invisible. `note_stale_rejection` gives EVERY stale-handling path (advance
# AND recordInteraction/makeDeal/the trust belts) a per-user buffer that drains into the next
# `record_turn`, and a fold-bearing drop additionally emits a RED-eligible `sync:dropped-fold`
# health event. The beat-continuity check in `record_turn` is the safety net: an unaccounted
# beatSeq gap (the board moved by more than this turn's counted stale rejections explain) emits the
# same RED event even when nothing called `note_stale_rejection` at all.
_PENDING_STALE: dict[str, int] = {}
# The last recorded `beatSeqAfter` per user — the baseline the next turn's `beatSeqBefore` is
# checked against for continuity. In-process only (a restart re-derives from the next live turn).
_LAST_BEAT_AFTER: dict[str, int] = {}

# ── ORW-150: FE-OWNED engine writes that move beatSeq OUTSIDE a ledgered turn ──
# The per-player-message `noteMessage` (+1 each) and the E22 fallback `recordInteraction` run between turns
# (before the next turn's baseline read / after the last turn's record), so the between-turn gap check used to
# read them as "the board moved without this FE recording the write" (48 false `sync:dropped-fold` in one night).
# Each such write is counted here, per user, and drained into the next `record_turn` where it is subtracted
# from the unexplained gap. A genuinely unrecorded move still exceeds the allowance and still fires.
_PENDING_FE_WRITES: dict[str, int] = {}

# ── ORW-186: belt telemetry from turns that are never ledgered (casting) ──
# Belt / forced-choice counts buffer per user and drain at the next `record_turn`. Casting turns are never
# ledgered, so their counts (a casting-record belt, a voiced re-ground) landed on the FIRST GAME turn's row and
# sent investigators to a turn where nothing fired. `park_pending_unledgered_turn` moves them here instead:
# they stay in the playtest totals (`get_belt_totals` / `get_forced_choice_totals`) but never on a game-turn row.
_PARKED_BELTS: dict[str, dict[str, int]] = {}
_PARKED_FORCED: dict[str, dict[str, dict[str, int]]] = {}


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
    try:
        n = int(v)
    except (TypeError, ValueError):
        return 0
    return n if n >= 0 else 0


def _clean_id(v: Any) -> str:
    """A short identifier — coerced to a clipped string (never a body)."""
    if v is None:
        return ""
    try:
        s = str(v)
    except Exception:
        return ""
    return s[:_MAX_NAME_LEN]


def _clean_names(v: Any) -> list[str]:
    """A list of tool/event NAMES — short tokens only, deduped-by-position, bounded.
    A single string is treated as a one-element list; anything unusable ⇒ []."""
    if v is None:
        return []
    if isinstance(v, str):
        items: Iterable[Any] = [v]
    elif isinstance(v, (list, tuple)):
        items = v
    else:
        return []
    out: list[str] = []
    for item in items:
        if len(out) >= _MAX_NAMES:
            break
        try:
            s = str(item).strip()
        except Exception:
            continue
        if s:
            out.append(s[:_MAX_NAME_LEN])
    return out


def _clean_belt_map(v: Any) -> dict[str, int]:
    """A {beltName: count} map — short name tokens to positive ints only, bounded.
    Anything unusable ⇒ {}. The Vault-free floor: a body can never ride a belt name."""
    if not isinstance(v, dict):
        return {}
    out: dict[str, int] = {}
    for name, count in v.items():
        if len(out) >= _MAX_NAMES:
            break
        try:
            s = str(name).strip()
        except Exception:
            continue
        n = _clean_int(count)
        if s and n > 0:
            out[s[:_MAX_NAME_LEN]] = n
    return out


def _clean_forced_map(v: Any) -> dict[str, dict[str, int]]:
    """A ``{tool: {"honored": n, "ignored": n}}`` map — short name tokens to non-negative
    outcome counts only, bounded. Anything unusable ⇒ {}. The same Vault-free floor as
    ``_clean_belt_map``: a body can never ride a tool name or a count."""
    if not isinstance(v, dict):
        return {}
    out: dict[str, dict[str, int]] = {}
    for name, counts in v.items():
        if len(out) >= _MAX_FORCED_TOOLS:
            break
        try:
            s = str(name).strip()
        except Exception:
            continue
        if not s or not isinstance(counts, dict):
            continue
        honored = _clean_int(counts.get("honored"))
        ignored = _clean_int(counts.get("ignored"))
        if honored or ignored:
            out[s[:_MAX_NAME_LEN]] = {"honored": honored, "ignored": ignored}
    return out


def _entry(
    *,
    session: Any,
    turn_id: Any,
    beat_seq_before: Any,
    beat_seq_after: Any,
    tools_called: Any,
    nudges_fired: Any,
    auto_backfills: Any,
    desync_detected: Any,
    stale_rejections: Any,
    idempotency_hits: Any,
    belts_fired: Any = None,
    forced_choice: Any = None,
) -> dict:
    """Build the bounded, Vault-free entry. Every field is coerced to a scalar / id /
    name; there is no path for a free-form body to land in the stored shape."""
    return {
        "ts": int(time.time() * 1000),
        "turnId": _clean_id(turn_id),
        "session": _clean_id(session),
        "beatSeqBefore": _clean_int(beat_seq_before),
        "beatSeqAfter": _clean_int(beat_seq_after),
        "toolsCalled": _clean_names(tools_called),
        "nudgesFired": _clean_int(nudges_fired),
        "autoBackfills": _clean_int(auto_backfills),
        "desyncDetected": bool(desync_detected),
        "staleRejections": _clean_int(stale_rejections),
        "idempotencyHits": _clean_int(idempotency_hits),
        "beltsFired": _clean_belt_map(belts_fired),
        # T0-4: attempt-counted forced-tool_choice outcomes, sibling to beltsFired above.
        "forcedChoice": _clean_forced_map(forced_choice),
    }


# ── public API ───────────────────────────────────────────────────────────────────


def note_belt_fire(user: str | None, belt: Any, n: Any = 1) -> None:
    """Count one guardrail-belt firing for ``user`` (gap #3 belt-fire telemetry).

    Fail-soft and cheap: the fire lands in an in-memory per-user buffer (belt NAMES +
    small counts only — the same Vault-free coercion floor as every ledger field) and is
    drained into the next ``record_turn`` entry's ``beltsFired`` map. ``get_belt_totals``
    reads buffered fires too, so pre-turn / pre-game belts are measurable even before a
    live turn records. Never raises; telemetry must never hurt the app."""
    try:
        try:
            name = str(belt).strip()[:_MAX_NAME_LEN]
        except Exception:
            return
        count = _clean_int(n)
        if not name or count <= 0:
            return
        k = _key(user)
        with _LOCK:
            bucket = _PENDING_BELTS.setdefault(k, {})
            if name not in bucket and len(bucket) >= _MAX_NAMES:
                return  # bounded: never grow past the name cap
            bucket[name] = bucket.get(name, 0) + count
    except Exception:  # pragma: no cover - defence in depth
        pass


def _emit_dropped_fold(user: str | None, reason: str, *, beat_gap: Any = None,
                       stale: Any = None) -> None:
    """Emit ONE RED-eligible ``sync:dropped-fold`` health event (the A-S3 latent, made visible).

    A dropped fold is a scene's only record of a hidden relationship impact evaporating — a real,
    already-happened play lost (mandate #4 / I4). It is UNCORRECTED (the fold did not land), so it
    surfaces RED, never cloaked. Fail-soft: telemetry must never hurt the app."""
    try:
        from src import log_rings as _lr
        _gap = _clean_int(beat_gap) if beat_gap is not None else None
        detail = reason
        if _gap:
            detail += f" (beatSeq gap {_gap}"
            if stale is not None:
                detail += f", {_clean_int(stale)} stale-rejection(s) counted"
            detail += ")"
        _lr.record_soft_failure("sync:dropped-fold", detail, corrected=None, user=user)
    except Exception:  # pragma: no cover - defence in depth
        pass


#: RC6: the default dropped-fold cause when a caller passes none (back-compat: the stale-beat 409 path).
_DEFAULT_DROP_CAUSE = "a fold-bearing recordInteraction/deal write was dropped on a stale-beat 409"


def note_stale_rejection(user: str | None, n: Any = 1, *, dropped_fold: bool = False,
                         beat_gap: Any = None, cause: Any = None) -> None:
    """Count StaleBeatError 409s this FE reconciled (0065 Part A) — for EVERY stale-handling path,
    not just the advance path. The count buffers per user and drains into the next ``record_turn``
    entry's ``staleRejections`` (mirroring ``note_belt_fire``), so a ``recordInteraction`` stale-drop
    can no longer show ``staleRejections:0``.

    ``dropped_fold=True`` marks that a FOLD-BEARING call's stale-409 ended with the fold DROPPED (the
    A-S3 latent): a RED-eligible ``sync:dropped-fold`` health event is emitted immediately so the lost
    consequence is never invisible. ``cause`` (RC6, bounded short slug) overrides the default drop
    forensic — the hardcoded ``stale-409`` cause was misleading for the non-stale drop sites (a queue
    overflow, a terminal non-stale retry failure); default keeps the stale-409 wording for back-compat.
    Never raises; telemetry must never hurt the app."""
    try:
        count = _clean_int(n)
        if count <= 0:
            count = 1
        k = _key(user)
        with _LOCK:
            _PENDING_STALE[k] = _PENDING_STALE.get(k, 0) + count
        if dropped_fold:
            reason = (str(cause).strip()[:_MAX_NAME_LEN] if cause else "") or _DEFAULT_DROP_CAUSE
            _emit_dropped_fold(user, reason, beat_gap=beat_gap, stale=count)
    except Exception:  # pragma: no cover - defence in depth
        pass


def _drain_pending_stale(user_key: str) -> int:
    """Pop (and return) the user's buffered stale-rejection count. Caller holds no lock."""
    with _LOCK:
        return _PENDING_STALE.pop(user_key, 0) or 0


def note_fe_write(user: str | None, n: Any = 1) -> None:
    """ORW-150 - count FE-owned engine write(s) (a `noteMessage`, an E22 fallback fold) that moved the engine's beatSeq
    outside a ledgered turn window. Drains into the next `record_turn`'s gap allowance. Never raises."""
    try:
        count = _clean_int(n)
        if count <= 0:
            return
        k = _key(user)
        with _LOCK:
            _PENDING_FE_WRITES[k] = _PENDING_FE_WRITES.get(k, 0) + count
    except Exception:  # pragma: no cover - defence in depth
        pass


def _drain_pending_fe_writes(user_key: str) -> int:
    with _LOCK:
        return _PENDING_FE_WRITES.pop(user_key, 0) or 0


def park_pending_unledgered_turn(user: str | None) -> None:
    """ORW-186 - call at the end of a turn that is never ledgered (casting). Moves the user's buffered belt / forced-choice
    counts into the parked totals (still visible in `get_belt_totals` / `get_forced_choice_totals`) so the next LEDGERED game
    turn's row does not inherit them. Also drops the buffered stale/FE-write counts: their gap baseline does not exist yet.
    Never raises."""
    try:
        k = _key(user)
        belts = _drain_pending_belts(k)
        forced = _drain_pending_forced(k)
        _drain_pending_stale(k)
        _drain_pending_fe_writes(k)
        with _LOCK:
            if belts:
                pb = _PARKED_BELTS.setdefault(k, {})
                for name, count in belts.items():
                    pb[name] = pb.get(name, 0) + count
            if forced:
                pf = _PARKED_FORCED.setdefault(k, {})
                for name, counts in forced.items():
                    e = pf.setdefault(name, {"honored": 0, "ignored": 0})
                    e["honored"] += counts.get("honored", 0)
                    e["ignored"] += counts.get("ignored", 0)
    except Exception:  # pragma: no cover - defence in depth
        pass


def note_belt(user: str | None, belt: Any, n: Any = 1) -> None:
    """The thin never-raises convenience wrapper over :func:`note_belt_fire` for belt call
    sites OUTSIDE this module (chat_helpers / tool_implementations / the agent loop) — one
    name to call instead of the 4x-duplicated inline try/except blocks. Identical semantics;
    belt-fire telemetry must never hurt the app."""
    try:
        note_belt_fire(user, belt, n)
    except Exception:  # pragma: no cover - defence in depth (note_belt_fire already swallows)
        pass


def note_forced_choice(user: str | None, tool: Any, *, honored: bool) -> None:
    """T0-4 — count one forced-``tool_choice`` ATTEMPT for ``user``, with its outcome.

    Unlike ``note_belt_fire`` (success-gated: a count means the correction landed),
    this fires for EVERY resolved attempt — call it exactly once per forced selection,
    after the round has resolved whether the forced tool actually landed
    (``honored=True``) or was silently ignored (``honored=False``). Buffers per-user in
    memory (same shape/discipline as the belt buffer) and drains into the next
    ``record_turn``'s ``forcedChoice`` map. Never raises; telemetry must never hurt the
    app."""
    try:
        try:
            name = str(tool).strip()[:_MAX_NAME_LEN]
        except Exception:
            return
        if not name:
            return
        k = _key(user)
        with _LOCK:
            bucket = _PENDING_FORCED.setdefault(k, {})
            if name not in bucket and len(bucket) >= _MAX_FORCED_TOOLS:
                return  # bounded: never grow past the tool-name cap
            entry = bucket.setdefault(name, {"honored": 0, "ignored": 0})
            entry["honored" if honored else "ignored"] += 1
    except Exception:  # pragma: no cover - defence in depth
        pass


def _drain_pending_forced(user_key: str) -> dict[str, dict[str, int]]:
    """Pop (and return) the user's buffered forced-choice attempts. Caller holds no lock."""
    with _LOCK:
        return _PENDING_FORCED.pop(user_key, {}) or {}


def get_forced_choice_totals(user: str | None) -> dict[str, dict[str, int]]:
    """Aggregate ``{tool: {"attempted", "honored", "ignored"}}`` for ``user`` — the T0-4
    attempt-counted forced-``tool_choice`` telemetry: the retained ring PLUS any still-buffered
    attempts, per-user scoped. A missing/corrupt store answers {}."""
    k = _key(user)
    totals: dict[str, dict[str, int]] = {}

    def _fold(m: Any) -> None:
        for name, counts in _clean_forced_map(m).items():
            e = totals.setdefault(name, {"honored": 0, "ignored": 0})
            e["honored"] += counts["honored"]
            e["ignored"] += counts["ignored"]

    with _LOCK:
        bucket = _load().get(k)
        pending = {t: dict(c) for t, c in (_PENDING_FORCED.get(k) or {}).items()}
        parked_f = {t: dict(c) for t, c in (_PARKED_FORCED.get(k) or {}).items()}
    if isinstance(bucket, list):
        for e in bucket:
            if isinstance(e, dict):
                _fold(e.get("forcedChoice"))
    _fold(pending)
    _fold(parked_f)
    for counts in totals.values():
        counts["attempted"] = counts["honored"] + counts["ignored"]
    return totals


def _drain_pending_belts(user_key: str) -> dict[str, int]:
    """Pop (and return) the user's buffered belt fires. Caller holds no lock."""
    with _LOCK:
        return _PENDING_BELTS.pop(user_key, {}) or {}


def get_belt_totals(user: str | None) -> dict[str, int]:
    """Aggregate belt-fire counts for ``user``: the sum of ``beltsFired`` across the
    retained ring PLUS any still-buffered fires — the playtest-facing "how belt-reliant
    was this session" read. Per-user scoped; a missing/corrupt store answers {}."""
    k = _key(user)
    totals: dict[str, int] = {}
    with _LOCK:
        bucket = _load().get(k)
        pending = dict(_PENDING_BELTS.get(k) or {})
        parked_b = dict(_PARKED_BELTS.get(k) or {})
    if isinstance(bucket, list):
        for e in bucket:
            if not isinstance(e, dict):
                continue
            for name, count in _clean_belt_map(e.get("beltsFired")).items():
                totals[name] = totals.get(name, 0) + count
    for name, count in _clean_belt_map(pending).items():
        totals[name] = totals.get(name, 0) + count
    for name, count in _clean_belt_map(parked_b).items():
        totals[name] = totals.get(name, 0) + count
    return totals


def record_turn(
    user: str | None,
    *,
    session: Any = None,
    turn_id: Any = None,
    beat_seq_before: Any = 0,
    beat_seq_after: Any = 0,
    tools_called: Any = None,
    nudges_fired: Any = 0,
    auto_backfills: Any = 0,
    desync_detected: Any = False,
    stale_rejections: Any = 0,
    idempotency_hits: Any = 0,
    belts_fired: Any = None,
    forced_choice: Any = None,
) -> None:
    """Append one Vault-free per-turn sync record for ``user`` (``_current_user``-scoped),
    bounded by a per-user ring, and emit one structured ``[orwell]`` log line.

    Every argument is coerced to a small scalar / id / tool-name; message bodies,
    narration, casting answers, and any engine secret CANNOT be stored — that is a hard
    invariant, enforced by the coercion in ``_entry`` rather than by careful callers.
    Buffered ``note_belt_fire`` counts for the user are drained into the entry's
    ``beltsFired`` map (merged with any explicit ``belts_fired`` argument); buffered
    ``note_forced_choice`` attempts drain the same way into ``forcedChoice`` (T0-4).
    Errors are swallowed: ledgering must never hurt the app."""
    try:
        k = _key(user)
        # RC6 (write-durability): retain the DRAINED buffers so a failed durable write can RESTORE
        # them. `_drain_pending_belts` / `_drain_pending_stale` / `_drain_pending_forced` POP their
        # in-memory buffers here, but the persist below (`atomic_write_json`) can still raise — if it
        # does, these counts must go BACK into the buffers, not vanish, or the fold silently loses
        # this turn's belts/stale/forced-choice attempts.
        drained_belts = _drain_pending_belts(k)
        drained_stale = _drain_pending_stale(k)
        drained_forced = _drain_pending_forced(k)
        drained_fe_writes = _drain_pending_fe_writes(k)
        merged_belts = _clean_belt_map(belts_fired)
        for name, count in drained_belts.items():
            merged_belts[name] = merged_belts.get(name, 0) + count
        merged_forced = _clean_forced_map(forced_choice)
        for name, counts in drained_forced.items():
            e = merged_forced.setdefault(name, {"honored": 0, "ignored": 0})
            e["honored"] += counts.get("honored", 0)
            e["ignored"] += counts.get("ignored", 0)
        # S6b: fold every buffered `note_stale_rejection` into this turn's staleRejections so a
        # recordInteraction stale-drop is COUNTED here, not lost (it used to show staleRejections:0).
        eff_stale = _clean_int(stale_rejections) + drained_stale
        entry = _entry(
            session=session,
            turn_id=turn_id,
            beat_seq_before=beat_seq_before,
            beat_seq_after=beat_seq_after,
            tools_called=tools_called,
            nudges_fired=nudges_fired,
            auto_backfills=auto_backfills,
            desync_detected=desync_detected,
            stale_rejections=eff_stale,
            idempotency_hits=idempotency_hits,
            belts_fired=merged_belts,
            forced_choice=merged_forced,
        )
        # S6b beat-continuity check: the board must not move MORE than this turn's counted stale
        # rejections explain. `beatSeqBefore` should pick up where the last turn's `beatSeqAfter`
        # left off; a positive gap beyond `staleRejections` is an UNACCOUNTED board move — a fold
        # dropped without being counted (the A-S3 latent). Emit the same RED-eligible dropped-fold.
        # RC6 (write-durability): READ the baseline for the gap check, but DO NOT advance it yet — the
        # `_LAST_BEAT_AFTER` update moves to AFTER a confirmed durable write, or a write failure would
        # corrupt the next turn's baseline comparison (the board would look to have moved backwards).
        with _LOCK:
            last_after = _LAST_BEAT_AFTER.get(k)
        # Fire only when BOTH ends are real tracked beats (>0), so a 0/0 turn can neither raise a
        # false gap nor be measured against one. A positive gap beyond the counted stale rejections
        # is an unaccounted board move — the invisible dropped fold.
        #
        # RC6 verify fix (#1599): a between-turns gap is NOT proof of a dropped fold on THIS session. A
        # legitimate concurrent multi-window advance (another window/device drives the SAME game between
        # this window's turns — expected under ADR 0008/0012) moves the board with no fold lost here, and
        # the FE FLAGS that reconcile: it either counts the stale-beat 409(s) (`staleRejections`) or
        # stashes a re-ground (`desyncDetected`). So the gap is only "unaccounted" — a truly invisible
        # drop on this session's own turn — when the move was NEITHER counted NOR reconciled. Suppressing
        # on `desyncDetected` removes the cross-window false positive while still catching the genuine
        # A-S3 latent (an invisible drop leaves no stale count AND no desync signal). A real fold-bearing
        # drop still surfaces RED directly via `note_stale_rejection(dropped_fold=True)` at the drop site.
        if (isinstance(last_after, int) and last_after > 0 and entry["beatSeqBefore"] > 0
                and not entry["desyncDetected"]):
            gap = entry["beatSeqBefore"] - last_after
            if gap > entry["staleRejections"] + drained_fe_writes:  # ORW-150: FE-owned writes (noteMessage, E22 fallback) explain part of the gap
                _emit_dropped_fold(user, "an unaccounted beatSeq gap between turns — the board moved "
                                   "without this FE recording the write or reconciling a cross-window "
                                   "advance", beat_gap=gap, stale=entry["staleRejections"])
        try:
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
        except Exception:
            # RC6 (write-durability): the durable write failed — RESTORE the drained belts + stale so
            # they fold into the NEXT turn instead of vanishing, and leave `_LAST_BEAT_AFTER` un-advanced
            # (the baseline stays at the last COMMITTED turn). Merge back (other threads may have buffered
            # new fires meanwhile). Then re-raise for the outer fail-soft handler to log-and-swallow.
            with _LOCK:
                if drained_fe_writes:
                    _PENDING_FE_WRITES[k] = _PENDING_FE_WRITES.get(k, 0) + drained_fe_writes
                if drained_stale:
                    _PENDING_STALE[k] = _PENDING_STALE.get(k, 0) + drained_stale
                if drained_belts:
                    bucket = _PENDING_BELTS.setdefault(k, {})
                    for name, count in drained_belts.items():
                        bucket[name] = bucket.get(name, 0) + count
                if drained_forced:
                    fbucket = _PENDING_FORCED.setdefault(k, {})
                    for name, counts in drained_forced.items():
                        e = fbucket.setdefault(name, {"honored": 0, "ignored": 0})
                        e["honored"] += counts.get("honored", 0)
                        e["ignored"] += counts.get("ignored", 0)
            raise
        # RC6 (write-durability): the write COMMITTED — now it is safe to advance the beat baseline.
        # Only baseline off a real (tracked, non-zero) beat — an untracked 0/0 turn (the inert spine
        # posture) must never seed a phantom gap for the next real turn.
        if entry["beatSeqAfter"] > 0:
            with _LOCK:
                _LAST_BEAT_AFTER[k] = entry["beatSeqAfter"]
        _log_line(k, entry)
    except Exception as e:  # pragma: no cover - defence in depth
        try:
            logger.debug("[orwell] sync-ledger record failed: %s", e)
        except Exception:
            pass


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


def clear(user: str | None) -> None:
    """Drop the user's ledger (used by a full account/factory reset). Per-user scoped."""
    k = _key(user)
    with _LOCK:
        _PENDING_BELTS.pop(k, None)
        _PENDING_STALE.pop(k, None)
        _PENDING_FORCED.pop(k, None)
        _PENDING_FE_WRITES.pop(k, None)
        _PARKED_BELTS.pop(k, None)
        _PARKED_FORCED.pop(k, None)
        _LAST_BEAT_AFTER.pop(k, None)
        data = _load()
        if k in data:
            del data[k]
            atomic_write_json(str(LEDGER_PATH), data, indent=2)


def _log_line(user_key: str, entry: dict) -> None:
    """One structured ``[orwell]`` line per turn — picked up by the #406 LIVE root-logger
    ring for the admin viewer. Counts + ids + tool names only (no body)."""
    try:
        tools = ",".join(entry.get("toolsCalled") or []) or "-"
        belts = ",".join(f"{n}:{c}" for n, c in (entry.get("beltsFired") or {}).items()) or "-"
        # T0-4: attempt-counted forced-tool_choice outcomes, e.g. "advanceGame:h2/i1".
        forced = ",".join(
            f"{n}:h{c.get('honored', 0)}/i{c.get('ignored', 0)}"
            for n, c in (entry.get("forcedChoice") or {}).items()
        ) or "-"
        logger.info(
            "[orwell] sync-ledger turn user=%s session=%s turn=%s beat=%s→%s "
            "tools=[%s] nudges=%s backfills=%s desync=%s stale=%s idem=%s belts=[%s] forced=[%s]",
            user_key,
            entry.get("session") or "-",
            entry.get("turnId") or "-",
            entry.get("beatSeqBefore"),
            entry.get("beatSeqAfter"),
            tools,
            entry.get("nudgesFired"),
            entry.get("autoBackfills"),
            entry.get("desyncDetected"),
            entry.get("staleRejections"),
            entry.get("idempotencyHits"),
            belts,
            forced,
        )
    except Exception:  # pragma: no cover
        pass
