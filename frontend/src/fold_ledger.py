"""Issue #1728 (B2) — the defer-fold-to-settle pending-fold ledger.

**The bug this closes (BB-Nerd F5/F6, reconciliation T3, joined):** the 0055 `_auto_record_scene`
belt (`src/agent_loop.py`) used to fold a scene's consequence into the hidden relationship/soul
layer *immediately*, mid-stream, the instant the extraction validated. A "Try again" regenerate
produces a brand-new take of the SAME turn and its OWN `_auto_record_scene` call — but the first
take's fold had already committed and can never be un-narrated. Net effect: every regenerate
permanently double-folded the hidden layer, sometimes with content from a take the player never
even saw kept (F6).

**The fix — DEFER-FOLD-TO-SETTLE (owner-ruled primary, per issue #1728).** A scene's fold is no
longer committed at proposal time. It is *staged* here — a small, Vault-free, in-memory, per-
(owner, session) **bounded FIFO queue** — and only actually applied ("settled") once the take that
produced it is confirmed to have survived, i.e. once a NEW turn begins for that same session
(`agent_loop._settle_pending_fold`, called before the new turn generates anything). A regenerate
truncates the superseded row BEFORE any new turn ever starts, and the truncate route
(`routes/history_routes.py::truncate_session`) discards every staged fold ANCHORED to a row that
truncate is about to remove — so a superseded take's fold can never reach the engine.

**Why a QUEUE, not a single slot (PR #1825 Greptile P1 fix #1).** A single-slot "stage always
overwrites" design has a real evaporation hole: if `_settle_pending_fold` hits a *transient*
engine error, it re-stages the PRIOR turn's still-valid fold for retry and lets the new turn
proceed — and if that new turn ALSO reaches `_auto_record_scene`, a plain overwrite would silently
clobber the still-unsettled prior entry, violating mandate #4 (a validated fold must never
evaporate). So `_PENDING[key]` is a small bounded FIFO list, not a single dict:

  * `stage_pending_fold` **appends** — it never overwrites another turn's still-pending entry.
  * Settle **drains oldest-first**, applying each entry's fold with ITS OWN preserved idempotency
    key. A failure re-queues that entry at the FRONT and settling STOPS for this call (never skips
    ahead to a newer entry out of order — the ledger's ordering is the turn ordering).
  * **Bounded** (`_MAX_QUEUE_LEN`, currently 8) — a pathological repeated-settle-failure loop drops
    the OLDEST entry (with a warning log) rather than growing without limit. In practice the queue
    is 0 or 1 entries deep essentially always (settle drains on every turn); depth > 1 only occurs
    across consecutive transient-failure turns, which is not expected to sustain.

**Why entries are ANCHORED to a real row, not just FIFO-ordered (PR #1825 Greptile P1 fix #2 — the
mirror-image bug).** The first queue fix made truncate discard only the TAIL entry. That is wrong
whenever `truncate_from_id` targets an OLDER assistant row: a truncate ALWAYS removes that row AND
every row after it (never just one row in isolation), so an older-row truncate can wipe out a
LATER take's row too — but a tail-only discard would leave that later take's queued fold sitting
in the ledger, and it would settle later as a PHANTOM hidden-layer fold for content the render log
no longer contains (a T-Rex-confirmed repro). The fix: every staged entry carries a `row_anchor`.

**The anchor is the row's IMMUTABLE DB id, never a derived position (PR #1825 Greptile P1 fix #3
— the SAME bug recurring one layer down).** Fix #2's first cut anchored to the row's 0-indexed
`seq`-order POSITION at attach time. Greptile (T-Rex-confirmed) found that positions are unstable
under deletion: `core/database.py`'s `ChatMessage.id` is a `String` primary key minted as
`str(uuid.uuid4())` everywhere it's created (`core/session_manager.py`) — **not** an autoincrement
integer, so **raw id order carries no session order** — but the deeper problem was comparing a
POSITION captured once against a COUNT read later. Delete an EARLIER row via a non-truncate path
(`edit-message`/`delete-messages`) and every later row's true position shifts left by one; an
entry's stored position does not, so `position < current_count` can go on reading "still there"
for a row that is now gone (a 3-row session, an entry anchored at position 1, the row at position
0 deleted → count drops to 2, and `1 < 2` is still true even though position 1 now holds a
DIFFERENT row than the one this fold was ever about). The fix removes positional arithmetic from
the anchor entirely — `row_anchor` is now the row's own DB id string, resolved to a position (for
truncate's ordering comparison) or checked for bare existence (for settle) fresh, every time,
never cached across a request boundary:

  * `attach_row_anchor` is called ONCE per turn, from `routes/chat_routes.py` right after the
    route persists that turn's assistant reply and gets back its real DB id — the SAME
    `dataset.dbId` seam #1751 already stamps client-side. It anchors the TAIL entry to that raw id
    (no DB round trip needed — the id was just handed to us by the very call that created the row)
    only if the tail is still unattached (a tail that already has an anchor belongs to an OLDER,
    re-queued turn and must never be relabeled with THIS turn's row). At stage time (mid-
    generation, before the row exists) the anchor is `None` — there is a genuinely unavoidable gap
    between "the extraction validated" and "the row has a real id," and this design accepts it
    rather than guess.
  * `discard_pending_fold(owner, session, keep_count)` resolves EVERY anchored entry's CURRENT
    `seq`-order position in ONE fresh query (`_resolve_positions_for_ids`, run at the exact moment
    of the truncate, against the CURRENT row set) and discards any entry whose row is no longer
    found at all, OR whose resolved position is `>= keep_count` — the full set of rows this
    truncate is removing. Because the position is resolved fresh against the SAME DB read that
    `keep_count` itself came from (both happen synchronously within the one truncate request, no
    await between), there is no staleness window for the comparison to go wrong in.
  * **FAIL-SAFE, deliberately asymmetric:** an entry whose anchor is still `None` (missing/
    unresolved — the attach step never got a chance to run, an exceedingly narrow race) OR whose
    anchored row id no longer resolves to ANY row (already removed by an earlier operation) is
    ALWAYS discarded by a truncate, regardless of `keep_count`. A lost validated fold is a bounded
    mandate-#4 sadness (it can, at worst, evaporate — the SAME risk every deferred design already
    accepts); a phantom fold surviving into the hidden layer for content no longer in the render
    log is exactly the corruption this entire feature exists to prevent, and the two are not
    symmetric risks — when genuinely uncertain, always resolve toward "never fold," never toward
    "maybe fold something that isn't there anymore."
  * **Settle's own last-line belt (`entry_exists_at_settle`)** is a plain SELECT-by-id — the row
    either exists or it does not, no positional arithmetic anywhere, so it cannot suffer the shift
    bug fix #3 closes. An entry that is anchored but whose row id no longer exists (some
    non-truncate deletion path — `edit-message`/`delete-messages`/`merge-last-assistant` — removed
    it without ever calling `discard_pending_fold`) is dropped (with a warning), never applied nor
    re-queued (nothing to retry — the row is just gone). A MISSING anchor at settle time is
    treated as "no evidence either way" and settle proceeds normally — the deliberate opposite of
    truncate's fail-safe: settle is not reacting to an active delete event, so there is no matching
    urgency to assume the worst; discarding every never-anchored entry on principle would silently
    regress every turn (which, absent a genuine attach-step outage, is expected to have a real
    anchor by the time the NEXT turn's settle runs — attach happens synchronously within the SAME
    request that staged the fold, long before a client could ever send the next one).

**SINGLE CUSTODY — an anchored fold lives in EXACTLY ONE queue (PR #1825 Greptile P1 fix #4 — the
custody leak, T-Rex-confirmed).** `frontend/src/agent_loop.py`'s `_backfill_with_cas` has its OWN
opportunistic retry queue for fold-bearing back-fills — `routes/chat_helpers.py`'s
`_DEFERRED_FOLDS` (CON-11): on a SECOND consecutive stale-beat 409, a call made with
`defer_fold=True` self-enqueues there rather than dropping the fold. That queue predates this
module and is the right safety net for belts with NO anchored ledger of their own
(`_auto_record_deal`/`_auto_confide`/`_auto_expose_secret`/`_auto_trade_secret`, and the
`session_id=None` faithfulness retro-adopt path) — but it is keyed ONLY by owner and carries no
session_id/row_anchor at all. If a fold staged HERE (in this anchored ledger) were ever allowed to
self-enqueue there on a settle failure, a later truncate on this session could not see it sitting
in that other queue — it would drain later, opportunistically, on the owner's next UNRELATED
back-fill call, and fold content the render log no longer contains: a phantom fold via a side
door the anchor-aware truncate/settle checks never look at.

**The ruling: an anchored entry must live in EXACTLY ONE queue — this one — from the moment it is
staged until it either commits or is discarded.** `agent_loop._settle_pending_fold` enforces this
by calling `_backfill_with_cas` with `defer_fold=False` — DELIBERATELY the one fold-bearing call
site in the file that does NOT pass `defer_fold=True`. With `defer_fold=False`, a double
stale-beat conflict reconciles and returns `None` WITHOUT touching `_DEFERRED_FOLDS` at all (the
exact same shape `_auto_move_player`'s positional `moveTo` belt already relies on — see
`tests/test_0065_backfill_cas.py::test_move_backfill_stale_twice_still_drops_no_defer`), and the
settle loop re-queues the entry at the FRONT of THIS ledger instead — the retry horizon stays
entirely inside the anchor-aware machinery, where truncate can always find and discard it. No
other change was needed: `_ch._defer_fold` (the only function that ever writes to
`_DEFERRED_FOLDS`) has exactly one call site, gated on `defer_fold`, so `defer_fold=False`
provably closes the escape path completely — there is no remaining route by which a fold staged
here can reach the un-anchored queue.

**Idempotency (AC #5).** Each entry's idempotency key is minted ONCE, at stage time, and carried
unchanged through to the engine `recordInteraction` call at settle time (0065 Part B — the engine
dedups a repeated key and returns the prior eventId without re-folding) — so a retried settle, or
a settle that re-applies an already-applied entry, can never double-fold.

**T9 doctrine — the FALLBACK not built here.** The issue also specs a compensating-retract path
(commit immediately, then issue an "un-fold" if the take turns out to have been superseded) as a
fallback for a seam where deferral proves infeasible. No such seam exists on this issue's build
surface (staging is a plain in-process list append with nowhere it can fail before the engine is
ever touched), so retract is NOT implemented — only documented here per the T9 doctrine ("if you
implement deferral, note the retract design as the designated fallback, don't build both"). Were
it ever needed, the shape would be: `record_interaction` grows an explicit `retract` verb/flag
keyed by the ORIGINAL `idempotencyKey` (already unique per scene), which the engine resolves to
the exact prior fold and reverses it via the SAME bounded/seeded magnitude math it applied
forward — never a raw-number roll-back the FE could game. Do not build this unless a real seam
forces it (e.g. a settle point that can only run AFTER the engine has already committed).

**Vault-free / in-memory (mirrors `routes/chat_helpers.py`'s `_DEFERRED_FOLDS`/`_LAST_BEAT_SEQ`,
the established pattern for exactly this class of short-lived, per-owner FE bookkeeping).** The
staged payload is the SAME open-set descriptor `_auto_record_scene` already validates before it
ever reaches here (roster-checked ids, closed-enum kind/direction/emphasis, truncated content) —
nothing secret, nothing engine-authoritative; the engine still owns the fold magnitude at settle
time exactly as it always has. `attach_row_anchor` / `entry_exists_at_settle` do a plain,
Vault-free `ChatMessage` row read (id/`seq` only) — the same table the render log itself lives in,
never the Vault. Process-restart loses unsettled entries (the same tradeoff `_DEFERRED_FOLDS`
already accepts) — acceptable here because the settle window is one HTTP round trip at most, far
shorter than that queue's multi-turn retry horizon.
"""

from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)

# (owner, session_id) -> FIFO list of staged fold payloads, oldest first. A key is never present
# with an empty list — an empty queue is represented by the key's absence. See module docstring.
_PENDING: dict[tuple, list] = {}

# A pathological repeated-settle-failure loop must not grow the queue without bound — drop the
# OLDEST entry (with a warning) past this depth. In normal operation the queue is 0-1 deep.
_MAX_QUEUE_LEN = 8


def _key(owner: Optional[str], session_id: Optional[str]) -> tuple:
    return (owner, session_id)


def _make_entry(*, content: str, with_ids: list, kind: str, consequence: Optional[dict],
                 felt_minutes: Optional[int], idempotency_key: str,
                 row_anchor: Optional[str] = None, assurance: Optional[dict] = None,
                 heard_about_me: Optional[dict] = None) -> dict:
    return {
        "content": content,
        "with_ids": with_ids,
        "kind": kind,
        "consequence": consequence,
        "felt_minutes": felt_minutes,
        "assurance": assurance,
        "heard_about_me": heard_about_me,
        "idempotency_key": idempotency_key,
        # The IMMUTABLE DB row id (a UUID string, per `core/database.py`/`core/session_manager.py`
        # — never an orderable integer) of the assistant row this fold belongs to. Unknown (None)
        # until `attach_row_anchor` fills it in once the row is actually persisted — see the
        # module docstring's "Why entries are ANCHORED" / PR #1825 fix #3 sections. Deliberately
        # NOT a position — a position captured once goes stale the instant an earlier row is
        # deleted and later rows shift; an id never does.
        "row_anchor": row_anchor,
    }


def stage_pending_fold(owner: Optional[str], session_id: Optional[str], *, content: str,
                        with_ids: list, kind: str, consequence: Optional[dict],
                        felt_minutes: Optional[int], idempotency_key: str,
                        assurance: Optional[dict] = None, heard_about_me: Optional[dict] = None) -> None:
    """Append a validated scene-fold payload to this (owner, session)'s queue, UNANCHORED
    (`row_anchor=None` — the turn's own row does not exist yet at stage time). Never overwrites an
    existing unsettled entry (PR #1825 fix #1) — a re-queued (settle-failure) entry from an
    earlier turn stays intact and simply settles before this new one (FIFO order). Call
    `attach_row_anchor` once the row is actually persisted."""
    key = _key(owner, session_id)
    q = _PENDING.setdefault(key, [])
    q.append(_make_entry(content=content, with_ids=with_ids, kind=kind, consequence=consequence,
                         felt_minutes=felt_minutes, idempotency_key=idempotency_key,
                         assurance=assurance, heard_about_me=heard_about_me))
    if len(q) > _MAX_QUEUE_LEN:
        dropped = q.pop(0)
        logger.warning(
            f"[orwell] fold_ledger: pending queue for session={session_id!r} exceeded "
            f"{_MAX_QUEUE_LEN} entries — dropping the OLDEST staged fold (kind={dropped.get('kind')}) "
            f"to bound the queue; this is a real (if bounded) fold loss and should not happen under "
            f"normal settle-drains-every-turn operation")


def attach_row_anchor(owner: Optional[str], session_id: Optional[str], saved_row_id: str) -> bool:
    """#1728 (B2, PR #1825 fix #2/#3) — attach the REAL persisted row's IMMUTABLE DB id to the
    TAIL entry, but ONLY if the tail is still unanchored (i.e. it was staged THIS turn, before its
    own row existed) — an already-anchored tail belongs to an OLDER, re-queued turn and must never
    be relabeled. Called once, right after the route persists the assistant reply and gets back
    its real DB id (`routes/chat_routes.py`, mirroring the #1751 `dataset.dbId` client stamp).

    Stores the raw id verbatim — no DB round trip needed here at all (the id was just handed to
    us by the very call that created the row), and no positional arithmetic to go stale later
    (fix #3: a stored POSITION drifts out of sync the instant an earlier row is deleted and later
    rows shift; an id never does — see the module docstring).

    Returns True iff an anchor was actually attached."""
    key = _key(owner, session_id)
    q = _PENDING.get(key)
    if not q or q[-1]["row_anchor"] is not None:
        return False
    q[-1]["row_anchor"] = saved_row_id
    return True


def _resolve_positions_for_ids(session_id: str, ids) -> dict:
    """0-indexed seq-order positions for the given row ids within `session_id`, resolved in ONE
    fresh query against the CURRENT row set — an id missing from the returned dict no longer
    exists in this session at all. Mirrors `core.session_manager.SessionManager
    .keep_count_before_message`'s query/ordering exactly, generalized to look up several ids at
    once (used by `discard_pending_fold`, which may need to resolve a handful of queued anchors
    in a single truncate call) as a free function, so this module needs only the DB the route
    already depends on — not a `SessionManager` instance. Deliberately NOT cached — always run
    fresh, against the current row set, at the exact moment of the comparison it feeds (fix #3:
    a position resolved once and compared against a LATER state is exactly the bug this closes)."""
    wanted = set(ids)
    if not wanted:
        return {}
    from core.database import ChatMessage as DbChatMessage
    from core.database import SessionLocal
    db = SessionLocal()
    try:
        rows = (db.query(DbChatMessage)
                  .filter(DbChatMessage.session_id == session_id)
                  .order_by(DbChatMessage.seq)
                  .all())
        return {row.id: i for i, row in enumerate(rows) if row.id in wanted}
    finally:
        db.close()


def entry_exists_at_settle(session_id: Optional[str], row_anchor: Optional[str]) -> bool:
    """#1728 (B2, PR #1825 fix #2/#3, item 4) — settle's last-line belt: does the row `row_anchor`
    (an immutable DB id) still exist in `session_id`'s render log? A plain SELECT-by-id — the row
    either exists or it does not, with NO positional arithmetic anywhere, so this check cannot
    suffer the "a deletion shifts everything else" bug fix #3 closes. Good enough as defense-in-
    depth against a non-truncate deletion path (`edit-message` / `delete-messages` /
    `merge-last-assistant`) that bypassed `discard_pending_fold` entirely.

    `row_anchor=None` returns True (the entry is allowed to settle) — deliberately the OPPOSITE
    of `discard_pending_fold`'s fail-safe: settle isn't reacting to an active delete event, a
    missing anchor here is not evidence of anything, and treating it as "gone" would silently
    regress every ordinary turn (see the module docstring)."""
    if row_anchor is None:
        return True
    if not session_id:
        return True
    from core.database import ChatMessage as DbChatMessage
    from core.database import SessionLocal
    db = SessionLocal()
    try:
        row = (db.query(DbChatMessage)
                 .filter(DbChatMessage.session_id == session_id, DbChatMessage.id == row_anchor)
                 .first())
        return row is not None
    finally:
        db.close()


def pop_oldest_pending_fold(owner: Optional[str], session_id: Optional[str]) -> Optional[dict]:
    """Remove and return the OLDEST staged fold for this (owner, session) (FIFO), or None if the
    queue is empty. The caller (settle) owns re-queuing on a failed commit — this module never
    retries on its own."""
    key = _key(owner, session_id)
    q = _PENDING.get(key)
    if not q:
        return None
    entry = q.pop(0)
    if not q:
        del _PENDING[key]
    return entry


def requeue_pending_fold_front(owner: Optional[str], session_id: Optional[str], entry: dict) -> None:
    """Push `entry` back onto the FRONT of this (owner, session)'s queue — used when a settle
    attempt fails on a transient (non-stale-beat) error, so the entry is retried FIRST at the next
    settle opportunity rather than lost or reordered behind a newer entry."""
    key = _key(owner, session_id)
    _PENDING.setdefault(key, []).insert(0, entry)


def discard_pending_fold(owner: Optional[str], session_id: Optional[str], keep_count: int) -> int:
    """#1728 (B2, PR #1825 fix #2/#3) — the supersede-cancel half of defer-fold-to-settle: called
    from the truncate route with the SAME `keep_count` it already resolved from `truncate_from_id`
    (rows at seq-order position `< keep_count` survive; `>= keep_count` are removed).

    Resolves every ANCHORED entry's row id to its CURRENT seq-order position in ONE fresh query
    (`_resolve_positions_for_ids`, run against the row set as it stands at THIS instant — the same
    moment the caller's own `keep_count` was computed from, so the two never desync) and discards
    every entry whose row is no longer found at all, OR whose resolved position is `>= keep_count`
    — the full set of rows this truncate is removing. Not just the newest: a truncate targeting an
    OLDER row removes that row AND every later one, so a queued fold anchored to a later row must
    not survive to settle as a phantom fold for content the render log no longer contains (the
    second Greptile P1 on PR #1825, T-Rex-confirmed).

    FAIL-SAFE: an entry with a missing/unresolved anchor (`row_anchor is None`, OR a row id that
    no longer resolves to any row at all) is ALSO discarded on ANY truncate, regardless of
    `keep_count` — see the module docstring's "deliberately asymmetric" note. Entries anchored
    to a row below `keep_count` (an older, already-accepted turn's re-queued fold) survive
    untouched.

    Returns the number of entries actually discarded (0 if none)."""
    key = _key(owner, session_id)
    q = _PENDING.get(key)
    if not q:
        return 0
    anchored_ids = [e["row_anchor"] for e in q if e["row_anchor"] is not None]
    positions = _resolve_positions_for_ids(session_id, anchored_ids) if anchored_ids else {}
    survivors = []
    discarded_unanchored = 0
    discarded_vanished = 0
    for e in q:
        anchor = e["row_anchor"]
        if anchor is None:
            discarded_unanchored += 1
            continue
        pos = positions.get(anchor)
        if pos is None:
            discarded_vanished += 1
            continue
        if pos < keep_count:
            survivors.append(e)
        # else: pos >= keep_count — this row is being truncated; discard silently (normal case).
    discarded_count = len(q) - len(survivors)
    if discarded_unanchored:
        logger.warning(
            f"[orwell] fold_ledger: discarding {discarded_unanchored} staged fold(s) with a "
            f"missing/unresolved row anchor on truncate (session={session_id!r}) — fail-safe: an "
            f"unanchored entry is never kept across a truncate, even though it MIGHT have "
            f"belonged to a surviving row, because a phantom fold is worse than a lost one "
            f"(mandate #4 vs. the F5 corruption this feature exists to prevent)")
    if discarded_vanished:
        logger.warning(
            f"[orwell] fold_ledger: discarding {discarded_vanished} staged fold(s) whose anchored "
            f"row id no longer resolves to any row (session={session_id!r}) — already removed by "
            f"an earlier operation; fail-safe applies the same as a missing anchor")
    if survivors:
        _PENDING[key] = survivors
    else:
        _PENDING.pop(key, None)
    return discarded_count


def has_pending_fold(owner: Optional[str], session_id: Optional[str]) -> bool:
    return bool(_PENDING.get(_key(owner, session_id)))


def pending_fold_count(owner: Optional[str], session_id: Optional[str]) -> int:
    return len(_PENDING.get(_key(owner, session_id), ()))


# ORW-26: the turn's scene belt (`_auto_record_scene`) concluded there is NO recordable scene among the houseguests actually present (every
# proposed participant was off-scene per the engine's whereabouts). The E22 fallback must not run the SAME extraction a second time (run 0348:
# 14 turns paid two identical utility calls that dropped the same ids twice). One flag per (owner, session), set by the belt, consumed (popped)
# once by the next E22 guard pass, so it can never leak into a later turn.
_BELT_DECLINED: set = set()


def note_belt_declined(owner: Optional[str], session_id: Optional[str]) -> None:
    _BELT_DECLINED.add(_key(owner, session_id))


def clear_belt_declined(owner: Optional[str], session_id: Optional[str]) -> None:
    _BELT_DECLINED.discard(_key(owner, session_id))


def consume_belt_declined(owner: Optional[str], session_id: Optional[str]) -> bool:
    k = _key(owner, session_id)
    hit = k in _BELT_DECLINED
    _BELT_DECLINED.discard(k)
    return hit


def clear_all() -> None:
    """Test-only reset."""
    _PENDING.clear()
    _BELT_DECLINED.clear()
