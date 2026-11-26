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
import itertools

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

# ── ORW-435: count FE-owned writes at the ONE engine dispatch seam (`orwell_engine._call`) ──
# ORW-150 counted two named writers (noteMessage, the E22 fallback fold) by hand at their call sites. Live play still fired
# `sync:dropped-fold` ~31 times in ~65 turns: the deferred scene fold settled at the start of a turn (a `recordInteraction`
# between two ledgered windows) was never counted, and nothing guarantees the next writer would be. `note_engine_write` is
# now called from the dispatch seam for EVERY engine call, so a writer is counted by construction unless it is known not to
# bump beatSeq. The window: a write inside a ledgered turn (`begin_turn` .. `record_turn`) is already inside that turn's
# beatSeqBefore->After movement and is NOT an allowance for the next gap.
# A user -> the set of OPEN turn tokens. A turn that raises or is cancelled still closes its token (agent_loop's `finally`), and
# overlapping turns for one user each hold their own token, so one finishing never reopens the between-turn counting for another.
_IN_TURN: dict[str, set[int]] = {}
_TURN_SEQ = itertools.count(1)

#: ORW-435 (review): the engine tools the FE dispatches that COMMIT (persist -> bump beatSeq). ONLY these are counted as an FE-owned
#: between-turn write. An unknown / unclassified tool is NOT counted (the safe failure is a false alarm, never a hidden dropped write),
#: and is logged once. tests/test_orw435 fails when a tool the FE can call through `_call` is in none of the three sets below.
BUMPING_WRITES = frozenset({
    "noteMessage", "recordInteraction", "moveTo", "moveHouseguest", "markHouseguestMet", "recordImageBeat", "makeDeal", "diaryRoom",
    "confide", "exposeSecret", "tradeSecret", "surfaceInformationTo", "turnIn", "advanceGame", "updateCasting", "resolvePlayerMove",
    "accuseTie", "callInFavor", "askToTalkAlone", "confront", "askJuror", "submitDecision", "hangOut", "nap", "requestSelfEviction", "cancelSelfEviction",
    "raiseSpectatorChoice", "formAlliance", "joinAlliance", "createCharacter", "preSeedCast", "recordCastGenesis", "advanceToFinale",
    "runCompetition",
})

#: Engine calls that are NOT reads but do not bump beatSeq: the "backgroundPersist" enrichments (durable save, no commit, no beatSeq
#: bump - GameSessionAdapter `backgroundPersist`), the admin / sandbox levers, and the non-PURE_READS read tools. A tool listed here is
#: classified (a decision was made) and is never counted.
NON_BUMPING_WRITES = frozenset({
    "recordRoomCanon", "recordNarrationUse", "recordOpenLedger", "resolveOpenLedger", "recordDaySummary", "recordLookExtras", "recordNpcTraits",
    "recordNpcReflections", "recordEpisodeTitles", "recordHouseCulture", "recordGroupIdentity", "recordAllianceName", "recordWorldSnapshot", "recordCastProfile", "recordCastIdentity",
    "recordProducerProfile", "recordCompetitionFiction", "recordOffscreenSceneTexture",
    # admin / sandbox levers and next-season warm-up: not turn-time writes, no beatSeq bump counted
    "configure", "overrideMechanic", "manageSandbox", "setTimeOfDay", "setBehavioralFlags", "preSeedNextSeason",
    # reads that are not in the read cache's PURE_READS
    "getOffscreenSceneSkeletons", "recordPromiseTerm", "dayLedger", "openLedgerHere", "groupsAwaitingWords", "allianceNameTickets", "recallSceneMemories", "seasonRetrospective", "sealedFromHouse",
    "knowledgeScopeManifest", "producerVault", "premiereIntros", "finaleView", "getPortraitPrompt", "sandboxHealth",
    "inspectNonVaultState", "getBehavioralFlags", "playerTagline", "worldSnapshotView", "endOfSessionSummary", "askProducers",
})

# ── ORW-1014: who made the turn's engine change - the narrator's tool call, or a belt? ──
# Prod 2026-11-26 (47 turns): the narrator called a game tool on 5, belts did the rest. A per-turn driver makes that rate a health number, not a feeling.
#: Belts that COMMIT an engine change the narrator did not make (the FE called the tool for it). Advisory belts (nudges, notes, steers, re-grounds,
#: strips) change no engine state and are not listed. `forced-tool-choice:*` is NOT here: the narrator made that call, the wire only demanded it.
ENGINE_CHANGE_BELT_PREFIXES = ("auto-", "forced-advance", "player-move-intent", "bedtime-turn-in-direct", "nap-direct", "casting-record-belt",
                               "pre-resolve-npc-ceremony")
#: A direct belt run is also logged as a tool event; it is the belt's call, not the narrator's. belt prefix -> the tool it runs.
_BELT_RUN_TOOLS = {"bedtime-turn-in-direct": "turnIn", "nap-direct": "nap"}
#: FE bookkeeping writes that are never the narrator's game act.
_NOT_A_NARRATOR_ACT = frozenset({"noteMessage"})


def classify_driver(tools_called: Any, belts_fired: Any) -> str:
    """'narrator' (a game tool call only), 'belt' (a belt-committed change only), 'both', or 'none' (no engine change this turn)."""
    belts = {str(n): c for n, c in (belts_fired or {}).items()} if isinstance(belts_fired, dict) else {}
    belt_names = [n for n in belts if n.startswith(ENGINE_CHANGE_BELT_PREFIXES)]
    belt_ran = {t for b, t in _BELT_RUN_TOOLS.items() if any(n.startswith(b) for n in belt_names)}
    tools = [t for t in (tools_called or []) if isinstance(t, str)]
    narrator = any(t in BUMPING_WRITES and t not in _NOT_A_NARRATOR_ACT and t not in belt_ran for t in tools)
    belt = bool(belt_names)
    return "both" if narrator and belt else "narrator" if narrator else "belt" if belt else "none"


_UNKNOWN_LOGGED: dict[str, float] = {}
_UNKNOWN_LOG_EVERY_S = 300.0

# ── ORW-439: which engine tools did this FE dispatch BETWEEN turns (counted or not)? ──
# Used only to explain a beatSeq gap: a bump caused by a tool the FE itself dispatched in the window is a COUNTING miss (a wrong list,
# a tool that bumps twice, a commit that lands after the call returned), not an unrecorded state change. Per user, tool NAME -> calls;
# drained at `record_turn` with the other between-turn buffers. Names only; bounded.
# SPAN: exactly the writes between the previous ledgered turn's end and this turn's start - the same span as the beatSeq gap it is
# compared against (`_LAST_BEAT_AFTER` -> this turn's beatSeqBefore). It is therefore reset everywhere the per-window counters
# (`_PENDING_FE_WRITES`) are reset: consumed at `record_turn`, dropped by `clear()` and `park_pending_unledgered_turn()`, and put
# back with them when a durable write fails. Writes inside a turn (`_IN_TURN`) are never recorded here.
_WINDOW_DISPATCHED: dict[str, dict[str, int]] = {}
#: A tool may legitimately commit twice in ONE call (e.g. a write plus its follow-up commit); more bumps than this per dispatch this
#: FE made are not explained by this FE's own calls, so the gap stays a red alarm.
MAX_BUMPS_PER_DISPATCH = 2
_OUTSIDE_A_TOOL_CALL = "outside-a-tool-call"  # the engine's cause label for a commit made with no tool call running
_MAX_GAP_BUMPS = 16

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
        # ORW-1014: who made this turn's engine change (narrator tool call / belt / both / none).
        "drivenBy": classify_driver(_clean_names(tools_called), _clean_belt_map(belts_fired)),
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


def begin_turn(user: str | None) -> int:
    """ORW-435 - mark the start of a ledgered live-game turn (call where the turn's beatSeqBefore baseline is read). Writes the FE
    dispatches until the turn closes are inside that turn's own beat movement and are not counted as between-turn writes. Returns this
    turn's token (0 on failure) for `end_turn` / `record_turn(turn_token=)`. Never raises."""
    try:
        token = next(_TURN_SEQ)
        with _LOCK:
            _IN_TURN.setdefault(_key(user), set()).add(token)
        return token
    except Exception:  # pragma: no cover - defence in depth
        return 0


def end_turn(user: str | None, token: int | None = None) -> None:
    """ORW-435 - close a turn window. Idempotent: closing a token twice (record_turn, then the loop's `finally`) is a no-op, and closing
    one token leaves any overlapping turn of the same user open. `token=None` closes every open window for the user. Never raises."""
    try:
        k = _key(user)
        with _LOCK:
            open_ = _IN_TURN.get(k)
            if open_ is None:
                return
            if token is None:
                open_.clear()
            else:
                open_.discard(token)
            if not open_:
                _IN_TURN.pop(k, None)
    except Exception:  # pragma: no cover - defence in depth
        pass


def _wrote(name: str, result: Any) -> bool:
    """Did this engine call commit (bump beatSeq)? A refused / no-op / duplicate answer committed nothing."""
    if name not in BUMPING_WRITES:
        return False
    if isinstance(result, dict):
        if result.get("accepted") is False:
            return False
        if result.get("duplicate") is True or result.get("replay") is True or result.get("replayed") is True:
            return False  # an idempotent mutator answering a repeat: the first call already bumped (review of #2743)
        if result.get("status") in ("noop", "illegal"):
            return False
        move = result.get("playerMove")
        if "playerMove" in result and not isinstance(move, dict):
            return False  # resolvePlayerMove found no clear move: nothing committed
    return True


def _note_unclassified(name: str) -> None:
    """A tool in none of BUMPING_WRITES / NON_BUMPING_WRITES / PURE_READS: not counted (safe), but visible - one INFO line per tool per window."""
    try:
        if name in BUMPING_WRITES or name in NON_BUMPING_WRITES:
            return
        from src import engine_read_cache as _erc
        if name in _erc.PURE_READS:
            return
        now = time.monotonic()
        with _LOCK:
            last = _UNKNOWN_LOGGED.get(name)
            if last is not None and now - last < _UNKNOWN_LOG_EVERY_S:
                return
            _UNKNOWN_LOGGED[name] = now
        logger.info("[orwell] sync-ledger: engine tool %r is not classified (bumping / non-bumping / read); not counted as a between-turn write", name)
    except Exception:  # failsoft-ok: observability-only
        pass


def _note_window_dispatch(user_key: str, name: str) -> None:
    """ORW-439: remember that this FE dispatched `name` between turns (name only; bounded)."""
    nm = _clean_names([name])
    if not nm:
        return
    with _LOCK:
        bucket = _WINDOW_DISPATCHED.setdefault(user_key, {})
        if nm[0] in bucket or len(bucket) < _MAX_NAMES:
            bucket[nm[0]] = bucket.get(nm[0], 0) + 1


def note_engine_write(user: str | None, name: str, result: Any = None) -> None:
    """ORW-435 - called from the ONE engine dispatch seam after a non-read engine call LANDED. Counts it as an FE-owned beatSeq
    write unless it is known not to bump (NON_BUMPING_WRITES), the engine reported it a no-op/refusal, or it ran inside a
    ledgered turn. Vault-free: only the tool NAME is looked at. Never raises."""
    try:
        k = _key(user)
        with _LOCK:
            if _IN_TURN.get(k):
                return
        _note_unclassified(str(name))
        _note_window_dispatch(k, str(name))
        if _wrote(str(name), result):
            note_fe_write(user)
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
        with _LOCK:
            _IN_TURN.pop(k, None)
        belts = _drain_pending_belts(k)
        forced = _drain_pending_forced(k)
        _drain_pending_stale(k)
        _drain_pending_fe_writes(k)
        with _LOCK:
            _WINDOW_DISPATCHED.pop(k, None)  # ORW-439: same span as the FE-write count it sits beside
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


def get_driver_totals(user: str | None) -> dict[str, Any]:
    """ORW-1014 - who drove the engine changes, over the retained ring: ``turns``, ``narratorToolTurns`` (a narrator game-tool call this turn),
    ``beltDrivenTurns`` (a belt committed a change this turn), the split ``narratorOnly`` / ``beltOnly`` / ``both`` / ``none``, and the two rates
    (0..1, None with no turns). Recomputed from each row's tools and belts, so rows written before the field existed count too."""
    k = _key(user)
    with _LOCK:
        bucket = _load().get(k)
    split = {"narrator": 0, "belt": 0, "both": 0, "none": 0}
    n = 0
    if isinstance(bucket, list):
        for e in bucket:
            if isinstance(e, dict):
                n += 1
                split[classify_driver(e.get("toolsCalled"), e.get("beltsFired"))] += 1
    nt = split["narrator"] + split["both"]
    bt = split["belt"] + split["both"]
    return {"turns": n, "narratorToolTurns": nt, "beltDrivenTurns": bt,
            "narratorOnly": split["narrator"], "beltOnly": split["belt"], "both": split["both"], "none": split["none"],
            "narratorToolRate": round(nt / n, 3) if n else None, "beltDrivenRate": round(bt / n, 3) if n else None}


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


def _unexplained_gap(last_after: Any, before: int, desync: bool, stale: int, fe_writes: int) -> int:
    """The beatSeq gap between turns that nothing counted explains (0 when there is none). ONE rule, shared by `record_turn`'s
    alarm and by `peek_unexplained_gap`, so the async caller asks about exactly the gap the alarm would report."""
    if not (isinstance(last_after, int) and last_after > 0 and before > 0) or desync:
        return 0
    gap = before - last_after
    return gap if gap > stale + fe_writes else 0  # ORW-150: FE-owned writes (noteMessage, E22 fallback) explain part of the gap


def peek_unexplained_gap(user: str | None, *, beat_seq_before: Any, stale_rejections: Any = 0,
                         desync_detected: Any = False) -> dict | None:
    """ORW-439 - would `record_turn` raise the dropped-fold alarm for this turn? Pure peek: drains nothing, records nothing.

    The ledger is synchronous, but asking the engine WHY the counter moved is an async network call, so the turn path asks here first
    and does the call itself. Returns ``{since, before, gap, dispatched, counted, counted_writes}`` (``dispatched``: tool name -> calls this FE made between
    turns; ``counted``: the allowance `_unexplained_gap` subtracted; ``counted_writes``: the FE-write part of it) when the alarm would fire, else None."""
    try:
        k = _key(user)
        before = _clean_int(beat_seq_before)
        with _LOCK:
            last_after = _LAST_BEAT_AFTER.get(k)
            stale = _clean_int(stale_rejections) + (_PENDING_STALE.get(k, 0) or 0)
            fe = _PENDING_FE_WRITES.get(k, 0) or 0
            dispatched = dict(_WINDOW_DISPATCHED.get(k, {}))
        gap = _unexplained_gap(last_after, before, bool(desync_detected), stale, fe)
        if not gap:
            return None
        return {"since": last_after, "before": before, "gap": before - last_after, "dispatched": dispatched,
                "counted": stale + fe, "counted_writes": fe}
    except Exception:  # failsoft-ok: observability-only peek; None leaves the alarm exactly as it was
        return None


def classify_gap(info: dict, beat_log: Any) -> dict | None:
    """ORW-439 - name the cause of each bump in the gap, from the engine's `beatLog` answer. Pure; Vault-free (tool names + counters).

    ``counting-miss``: the log is complete and EVERY bump in the gap was caused by a tool this FE dispatched in the window (it was not
    counted, or it bumps more than once, or it committed after its call returned) - a bookkeeping miss, not a lost change.
    ``unexplained``: anything else (an "outside-a-tool-call" bump, a tool this FE did not dispatch, a truncated or incomplete log).
    Returns None when `beat_log` is not a usable answer (the caller then leaves the alarm exactly as before)."""
    if not isinstance(beat_log, dict) or not isinstance(beat_log.get("bumps"), list):
        return None
    since, before = _clean_int(info.get("since")), _clean_int(info.get("before"))
    bumps: list[dict] = []
    for b in beat_log["bumps"]:
        if not isinstance(b, dict) or isinstance(b.get("seq"), bool) or not isinstance(b.get("seq"), int):
            continue
        if since < b["seq"] <= before:
            names = _clean_names([b.get("tool")])
            bumps.append({"seq": b["seq"], "tool": names[0] if names else "?"})
    tools: dict[str, int] = {}
    for b in bumps:
        tools[b["tool"]] = tools.get(b["tool"], 0) + 1
    dispatched = info.get("dispatched") if isinstance(info.get("dispatched"), dict) else {}
    complete = beat_log.get("truncated") is False and len(bumps) == before - since
    # The rule (deliberately conservative). Every tool T in the gap must be (a) NOT one the ledger already counts, (b) dispatched by
    # this FE in the window at least once, (c) within MAX_BUMPS_PER_DISPATCH bumps per dispatch. Bumps of counted tools are only
    # tolerated up to what the ledger counted (`counted_writes`) AND, per tool, up to the number of times this FE called that tool in
    # the window; the ledger's allowance plus the explained bumps must close the gap.
    problems: list[str] = []
    explained = 0
    counted_bumps = 0
    for t, n in sorted(tools.items()):
        calls = _clean_int(dispatched.get(t))
        if t in BUMPING_WRITES:
            counted_bumps += n
            # Per tool, not only in total: a counted write of THIS FE that landed without bumping must not lend its count to
            # a different counted tool that someone else sent (e.g. one noteMessage counted, a foreign moveTo in the gap).
            if n > calls:
                problems.append(f"{t} x{n}, this FE called it {calls} time(s) in the window")
        elif t == _OUTSIDE_A_TOOL_CALL or calls <= 0:
            problems.append(f"{t} x{n} (not dispatched by this FE in the window)")
        elif n > calls * MAX_BUMPS_PER_DISPATCH:
            problems.append(f"{t} x{n} from {calls} call(s) (more than {MAX_BUMPS_PER_DISPATCH} per call)")
        else:
            explained += n
    if counted_bumps > _clean_int(info.get("counted_writes")):
        problems.append(f"counted tool(s) bumped {counted_bumps}, the ledger counted {_clean_int(info.get('counted_writes'))}")
    if _clean_int(info.get("counted")) + explained < before - since:
        problems.append("the bumps the ledger counted plus the explained ones do not cover the gap")
    if complete and bumps and not problems:
        kind, note = "counting-miss", ""
    else:
        kind = "unexplained"
        note = ("the engine's log does not reach back that far" if beat_log.get("truncated") is not False
                else "the engine's log is missing bumps in the gap" if not complete
                else "not explained by this FE's own calls: " + "; ".join(problems))
    tools_out = {t: n for t, n in tools.items() if t not in BUMPING_WRITES}
    calls_out = {t: _clean_int(dispatched.get(t)) for t in tools_out}
    return {"kind": kind, "bumps": bumps[:_MAX_GAP_BUMPS], "tools": tools_out if kind == "counting-miss" else tools,
            "calls": calls_out, "note": note, **({"more": True} if len(bumps) > _MAX_GAP_BUMPS else {})}  # review of #2757: say when the list was cut


def _describe_causes(expl: dict) -> str:
    parts = [f"seq {b['seq']} {b['tool']}" for b in expl.get("bumps", [])]
    return "; ".join(parts) + ("; ..." if expl.get("more") else "")  # only when bumps were really cut: exactly 16 is not "and more"


def _clean_gap_explanation(v: Any) -> dict | None:
    """Coerce a gap explanation to its bounded stored shape (kind + names + ints only), or None."""
    if not isinstance(v, dict) or v.get("kind") not in ("counting-miss", "unexplained"):
        return None
    bumps = []
    for b in (v.get("bumps") or [])[:_MAX_GAP_BUMPS]:
        if isinstance(b, dict):
            names = _clean_names([b.get("tool")])
            bumps.append({"seq": _clean_int(b.get("seq")), "tool": names[0] if names else "?"})
    return {"kind": v["kind"], "bumps": bumps, "tools": _clean_belt_map(v.get("tools")), "calls": _clean_belt_map(v.get("calls")),
            **({"more": True} if v.get("more") is True or len(v.get("bumps") or []) > _MAX_GAP_BUMPS else {})}


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
    turn_token: int | None = None,
    gap_explanation: Any = None,
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
        end_turn(user, turn_token)  # ORW-435: the turn window closes here; later FE writes are between-turn writes
        # RC6 (write-durability): retain the DRAINED buffers so a failed durable write can RESTORE
        # them. `_drain_pending_belts` / `_drain_pending_stale` / `_drain_pending_forced` POP their
        # in-memory buffers here, but the persist below (`atomic_write_json`) can still raise — if it
        # does, these counts must go BACK into the buffers, not vanish, or the fold silently loses
        # this turn's belts/stale/forced-choice attempts.
        drained_belts = _drain_pending_belts(k)
        drained_stale = _drain_pending_stale(k)
        drained_forced = _drain_pending_forced(k)
        drained_fe_writes = _drain_pending_fe_writes(k)
        with _LOCK:
            drained_dispatch = _WINDOW_DISPATCHED.pop(k, None)  # ORW-439: the between-turn dispatch record is consumed with the other between-turn buffers
        expl = _clean_gap_explanation(gap_explanation)
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
        gap = _unexplained_gap(last_after, entry["beatSeqBefore"], entry["desyncDetected"],
                               entry["staleRejections"], drained_fe_writes)
        if gap:
            gap = entry["beatSeqBefore"] - last_after
            reason = ("an unaccounted beatSeq gap between turns — the board moved "
                      "without this FE recording the write or reconciling a cross-window "
                      "advance")
            if expl is not None and expl["kind"] == "counting-miss":
                # ORW-439: the engine says every bump in the gap came from a tool this FE dispatched in the window - a counting miss
                # (a wrong list, a tool that bumps more than once, a commit after the call returned), not a lost change. Not RED;
                # one WARNING names the tool(s) and how many bumps each, and the entry carries it so a developer sees which list to fix.
                entry["gapExplanation"] = expl
                logger.warning("[orwell] sync-ledger: counting miss - beatSeq moved %d between turns, all from tools this FE dispatched "
                               "but does not count (fix the BUMPING_WRITES / NON_BUMPING_WRITES list or the tool): %s", gap, "; ".join(f"{t}: {n} bumps from {expl.get('calls', {}).get(t, 0)} call(s)" for t, n in sorted(expl["tools"].items())))
            else:
                if expl is not None:
                    entry["gapExplanation"] = expl
                    reason += f" [engine bump causes: {_describe_causes(expl)}]"
                _emit_dropped_fold(user, reason, beat_gap=gap, stale=entry["staleRejections"])
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
                if drained_dispatch:  # ORW-439: the dispatch record goes back with the FE-write count it explains
                    rb = _WINDOW_DISPATCHED.setdefault(k, {})
                    for _n, _c in drained_dispatch.items():
                        rb[_n] = rb.get(_n, 0) + _c
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
        _WINDOW_DISPATCHED.pop(k, None)  # ORW-439
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
            "tools=[%s] nudges=%s backfills=%s desync=%s stale=%s idem=%s belts=[%s] forced=[%s] driver=%s",
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
            entry.get("drivenBy") or "-",
        )
    except Exception:  # pragma: no cover
        pass
