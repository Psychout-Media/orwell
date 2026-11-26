"""Feature 0051 — in-character cast portraits (front-end half).

The engine builds a Vault-free portrait PROMPT per houseguest (from public appearance
facets + a per-season photorealistic style anchor) and returns them on `createCharacter`
as ``portraitPrompts``. This module is the FE pipeline that turns those prompts into
persisted images, looks them up for the roster + chat, and scrubs them on reset.

Discipline (from the spec, non-negotiable):
  • Graceful absence — no image-capable model configured ⇒ the game plays identically.
    Generation is best-effort; a failure NEVER surfaces an error to the player and never
    blocks game start. The roster falls back to name + status cards.
  • Vault-free — this module receives only the engine's already-Vault-free prompts and the
    Vault-free public projection. It never touches a stat, relationship, or hidden element.
  • Generate once per season — on restart the stored portrait is served from disk; a portrait
    that already exists is never regenerated (ADR 0003: augment, never replace; bounded cost).

Image config (the request SHAPE, all Vault-free — see the "Portrait image config" block):
  • Square (1:1) framing is asked of BOTH transports (OpenAI `size`, OpenRouter
    `image_config.aspect_ratio`), with per-model graceful degradation and a prompt-text cue
    as a belt-and-suspenders backstop.
  • One pinned square resolution (default 1024x1024) is sent on every provider path so the
    roster grid stays uniform and per-image cost is bounded.
  • Reference-image-on-regen — re-shooting an EXISTING portrait (the L17 look-alike re-roll, a
    facet-change re-shoot) feeds the current portrait back through the img2img edit path so the
    houseguest stays the SAME person; first-generation stays text-to-image.
  • Provider routing (issue #1153 / ADR 0016 §C) — `_generate_one` dispatches by the resolved
    endpoint: fal.ai Seedream (a reference-image model on a separate API surface; `image_urls`
    identity-carry — the #1140 fix) → `orwell_fal_image`; OpenRouter → /chat/completions image
    output; OpenAI/others → the Images API. fal is used only when explicitly configured as the
    image model; absent ⇒ the current Gemini/OpenAI paths stand (graceful fallback).

Storage: ``{frontend}/data/portraits/{user}/{houseguestId}.png`` plus a small
``manifest.json`` (houseguestId → filename + name). The whole tree lives under the
front-end data dir, so ``orwell-factory-reset.sh`` (which scrubs the FE store) already
removes it; ``orwell-game-reset.sh`` is taught to clear it too (a new season = a new cast).
"""

import asyncio
import contextvars
import weakref
import base64
import copy
import hashlib
import json
import logging
import os
import re
import secrets
import time
from pathlib import Path
from typing import Optional

from src.constants import DATA_DIR

logger = logging.getLogger(__name__)

# ── CI/operator image-spend KILL-SWITCH (belt-and-suspenders) ──────────────────────────────
# `ORWELL_DISABLE_IMAGE_GEN` is a HARD, environment-level off switch for ALL portrait/image
# generation. Set it in any context that holds a real, keyed image-capable provider but must
# PROVABLY never spend on images — the keyed nightly CI workflow (live-harness-nightly, which
# drives a full `createCharacter` casting flow) or an operator smoke run. When set,
# `image_generation_available` reports
# graceful absence (the roster/onboarding correctly expect no portraits — no error surface) AND
# every generation entry point early-returns a no-op BEFORE any settings read, catalog probe, or
# provider POST, so even a direct/forced call can't reach the image API (defense in depth).
# Fail-soft: an absent/malformed/empty value is treated as NOT set (normal behavior).
_IMAGE_GEN_KILL_SWITCH_TRUTHY = frozenset({"1", "true", "yes", "on"})


def image_gen_disabled() -> bool:
    """True when the ``ORWELL_DISABLE_IMAGE_GEN`` env kill-switch is set to a truthy value
    (``1``/``true``/``yes``/``on``, case-insensitive). Any other/absent/malformed value ⇒ False
    (normal behavior). This is the CI/operator image-spend kill-switch — see the block comment."""
    try:
        return os.environ.get("ORWELL_DISABLE_IMAGE_GEN", "").strip().lower() in _IMAGE_GEN_KILL_SWITCH_TRUTHY
    except Exception:  # pragma: no cover - defensive: an env read must never break a read path
        return False


# Base dir for all per-user portrait sets (co-located with the FE data store so the
# existing factory-reset scrub of data/ removes it; game-reset clears it explicitly).
PORTRAITS_DIR = Path(DATA_DIR) / "portraits"

# G27: the persistent USER AVATAR — the little circle profile pic attached to the account.
# Account-level, NOT per-season: it survives a new-season scrub (a game-reset clears the cast
# portraits, but your profile pic is you). It points at the CURRENT headshot.
AVATARS_DIR = Path(DATA_DIR) / "avatars"

# G30: the persistent HEADSHOT LIBRARY — every headshot the player has uploaded (exact) or
# selected from the AI studio, cached as a reusable option. Account-level (survives a
# new-season scrub), so at the start of each season the player can re-pick a past portrait,
# upload new, or AI-create new. The avatar/season-portrait is whichever one is "current".
HEADSHOTS_DIR = Path(DATA_DIR) / "headshots"
HEADSHOT_LIBRARY_MAX = 24  # keep the most recent N (oldest non-current evicted)

# ── G9 observability: the generation-attempt log ──────────────────────────────────────────
# Every generation attempt/outcome lands here as one JSON line — {ts, houseguestId, ok,
# errorClass, durationMs} — capped to the last PORTRAIT_LOG_MAX_ENTRIES so it can never
# grow unbounded. The logger.info lines stay; this file is the operator-visible record
# (served admin-gated via GET /api/orwell/portraits/log, picked up by the admin Health card).
PORTRAIT_LOG_PATH = Path(DATA_DIR) / "portrait-log.jsonl"
PORTRAIT_LOG_MAX_ENTRIES = 100

# ── L15 generation progress: a per-user LIVE record of a run in flight ─────────────────────
# Root cause of "all photos vanished + FE lost the backend": cast generation floods the engine's
# PER-USER serial queue (recordCastProfile ×15 + recordImageBeat ×16, each paying the O(events)
# commit), so the cast panel's getGameState poll stacks behind them and times out → the roster
# route used to fail open to an EMPTY roster (every face gone) and /state 502'd (the cast button
# vanished, looking like a dropped connection). The fix is threefold and all process-local:
#   (1) this progress record — generate_and_store stamps {total, done, active, startedAt, updatedAt}
#       as each face lands, so the roster route reports HONEST progress (driven by truth, not a
#       total>present heuristic) and the FE shows a live "Generating N of M…" instead of going dark;
#   (2) the engine writes the run makes (record_image_beat) are SPACED, not fired back-to-back, so
#       the per-user queue keeps draining the panel's polls between beats (PROGRESS, never starve);
#   (3) the roster route keeps a LAST-GOOD roster and serves it on a transient state-read timeout
#       (see routes/orwell_routes.py) so a busy engine never blanks the cast.
# Process-local on purpose (like the other portrait trackers): it describes THIS front-end's
# in-flight work and is never game state.
_GEN_PROGRESS: dict = {}

# The minimum gap between the engine writes a generation run fires (record_image_beat), so a long
# cast run leaves the per-user engine queue free to answer the panel's polls between beats instead
# of starving them. Small — it only has to interleave one poll, not pace the whole run.
IMAGE_BEAT_SPACING_S = 0.25

# ── S8 (RC8): FE-side per-turn image-beat budget PRE-CHECK ──────────────────────────────────
# The engine METERS a RE-generation of an already-portrayed houseguest against a per-turn cap
# (`IMAGE_BUDGET.perTurnCap` in src/engine/imageConstants.ts) and REFUSES a `recordImageBeat` past
# it with a typed `EngineRefusal`. The season-start MOVE-IN portrait (the FIRST image per
# houseguest) is EXEMPT. Before this pre-check a re-shoot burst (a facet-change re-shoot + the L17
# dedupe regens) fired every beat BLIND, so each metered beat past the cap came straight back as an
# EngineRefusal (the RC8 bundle: 3 extra straight into the cap, twice → 6 refusals). This pre-check
# bounds the METERED beats a single burst records to the remaining per-turn budget and SKIPS the
# rest (a RED-eligible 'image-budget-skip', #1599) instead of firing a call the engine will refuse.
# Exempt (move-in) beats are never budgeted. Mirrors the engine constant — do NOT change the cap;
# the fix only stops the front-end over-firing INTO it.
IMAGE_BEAT_PER_TURN_CAP = 3  # == IMAGE_BUDGET.perTurnCap (src/engine/imageConstants.ts)


def _image_beat_budget_remaining(user: Optional[str]) -> int:
    """The remaining METERED image-beat budget for a fresh generation burst — the engine's per-turn
    cap. A single burst may safely record up to this many RE-generation beats before the engine's
    per-turn cap starts refusing; move-in (first-image) beats are exempt and never counted. Kept a
    plain int (and a seam of its own) so the value stays trivially overridable in a unit test."""
    return IMAGE_BEAT_PER_TURN_CAP


def _note_image_budget_skip(user: Optional[str], houseguest_id: str) -> None:
    """#1599: record a RED-eligible 'image-budget-skip' — a metered image beat we deliberately did
    NOT fire because the per-turn budget was already spent (a PREVENTED `EngineRefusal`). It is
    auto-corrected (we stopped the over-fire) but still RED per the #1599 no-silent-fail-soft
    ruling — never a silent swallow. Best-effort: health logging must never break the run."""
    logger.info("[portraits] image-budget-skip: %s (per-turn cap %d reached) — skipping recordImageBeat",
                _safe_id(houseguest_id), IMAGE_BEAT_PER_TURN_CAP)
    try:
        from src import log_rings
        log_rings.record_soft_failure(
            "portraits:image-budget-skip",
            f"per-turn image budget ({IMAGE_BEAT_PER_TURN_CAP}) exhausted; skipped recordImageBeat "
            f"for {_safe_id(houseguest_id)} to avoid an EngineRefusal",
            corrected="image-budget-precheck",
            user=user,
        )
    except Exception:  # pragma: no cover — failsoft-ok: recorder-self (health logging must never break the run)
        pass


def _note_generation_failure(user: Optional[str], houseguest_id: str, reason: str,
                             *, corrected: str = "placeholder-fallback") -> None:
    """#1599: a portrait generation / persist FAILURE was the ORIGINAL silent-fail trigger — a
    houseguest quietly ends up with the initials placeholder. Record a RED-eligible health event so
    the failure shows RED on /admin/status (annotated auto-corrected: the placeholder floor stands),
    beside the existing portrait-log attempt row + the reconciler's retry-budget stamp. Also carries
    fal.ai transport failures — they surface UP through `_note_gen_error` to this terminal, so this is
    the ONE place a portrait failure is RED-recorded (no double-record). Best-effort: health logging
    must never break the run.

    ORW-397: a billing/auth failure (401/402/403) records ONE "credits/billing" soft failure per
    breaker trip instead of one per houseguest; a breaker-skipped houseguest records nothing."""
    if is_billing_error(reason):
        _record_billing_soft_failure(user)
        return
    try:
        from src import log_rings
        log_rings.record_soft_failure(
            "portraits:generation-failed",
            f"portrait generation failed for {_safe_id(houseguest_id)}: {reason}",
            corrected=corrected, user=user)
    except Exception:  # pragma: no cover — failsoft-ok: recorder-self (health logging must never break the run)
        pass

# ── L17 distinctness: detect look-alike faces and regenerate the offenders ─────────────────
# After the full cast generates, an automated pass scores how SIMILAR each houseguest's portrait
# PROMPT is to every other (the deterministic, Vault-free signal the engine already exposes —
# built from the structured `physicalCharacteristics` facet via portraitPrompts.ts). Two prompts
# whose physical-feature token sets overlap past LOOKALIKE_THRESHOLD read as "the same person";
# the higher-id offender of each clashing pair is re-prompted with an injected variety directive
# and regenerated, bounded by LOOKALIKE_MAX_REGENS so a flaky model can never loop. Pixel diffing
# is deliberately avoided (no extra deps / no decode cost): the structured facets ARE the cast's
# intended diversity signal, so a collision THERE is the right thing to correct.
LOOKALIKE_THRESHOLD = 0.62  # Jaccard over physical-feature tokens at/above this ⇒ a look-alike
LOOKALIKE_MAX_REGENS = 6     # cap on regenerations per pass (a bad model never loops the cast)
# Injected at the FRONT of an offender's prompt to force a visibly different face on re-roll. The
# image model reads it as a hard variety instruction; it carries no hidden state (pure styling).
_VARIETY_DIRECTIVE = (
    "IMPORTANT: make this person look CLEARLY DISTINCT from the rest of the cast — a different "
    "face shape, hairstyle, and overall look, unmistakably their own individual. "
)

# ── Portrait image config — square 1:1 framing at a pinned resolution ──────────────────────
# Every cast portrait is requested as a SQUARE headshot at ONE consistent resolution, so the
# roster grid is uniform and per-image cost is bounded (no surprise wide/tall renders). Both
# provider transports (OpenAI /images/{generations,edits} via `size`, OpenRouter
# /chat/completions via `image_config.aspect_ratio`) are asked for square; the prompt also
# carries a "square headshot framing" belt-and-suspenders cue. All of this is per-model with
# graceful degradation — a provider that ignores or rejects the hint never blocks generation.
PORTRAIT_ASPECT_RATIO = "1:1"
PORTRAIT_SIZE_DEFAULT = "1024x1024"
# The `image_quality` setting maps to a square OpenAI `size` string. We keep ONE square family
# (the grid stays uniform); quality only nudges the pixel budget / cost. Unknown values fall
# back to the default. dall-e-3 accepts only 1024x1024, so that is the safe shared square size
# across every provider — a single pinned resolution keeps the grid uniform and cost bounded.
_QUALITY_SIZE = {
    "low": "1024x1024",
    "medium": "1024x1024",
    "high": "1024x1024",
    "auto": "1024x1024",
}
# A short, Vault-free framing cue appended to a portrait prompt so a provider that ignores the
# structured size/aspect param still tends toward a square crop. Pure styling — no hidden state.
_SQUARE_FRAMING_CUE = " Square headshot framing, 1:1 aspect ratio, centered subject."


def _portrait_size(quality: Optional[str]) -> str:
    """The pinned SQUARE OpenAI `size` string for a quality setting (default 1024x1024)."""
    return _QUALITY_SIZE.get(str(quality or "").lower(), PORTRAIT_SIZE_DEFAULT)


def _progress_start(user: Optional[str], total: int) -> None:
    """Mark a generation run as STARTED for this user (idempotent per run)."""
    try:
        _GEN_PROGRESS[_safe_user(user)] = {
            "total": int(total), "done": 0, "active": True,
            "startedAt": time.time(), "updatedAt": time.time(),
        }
    except Exception:  # pragma: no cover - defensive
        pass


def _progress_tick(user: Optional[str], done_delta: int = 1) -> None:
    """One more face landed — bump the done count + the heartbeat."""
    rec = _GEN_PROGRESS.get(_safe_user(user))
    if not rec:
        return
    try:
        rec["done"] = int(rec.get("done", 0)) + int(done_delta)
        rec["updatedAt"] = time.time()
    except Exception:  # pragma: no cover - defensive
        pass


def _progress_finish(user: Optional[str]) -> None:
    """Mark the run complete — the panel can drop to the idle cadence."""
    rec = _GEN_PROGRESS.get(_safe_user(user))
    if not rec:
        return
    try:
        rec["active"] = False
        rec["updatedAt"] = time.time()
    except Exception:  # pragma: no cover - defensive
        pass


def _push_portrait_arrival(user: Optional[str]) -> None:
    """WS Phase-1 push edge (DORMANT behind ORWELL_WS_TRANSPORT) — a portrait just landed on the
    live roster, so fire the shared ``session_events`` "game-updated" ping the WS ``state``/``hud``
    bridge relays to ``orwell:gamechanged``. The cast panel (orwellCast.js) already LISTENS for that
    event and re-fetches the roster; under WS its adaptive roster poll STANDS DOWN (#1291), so this
    push becomes its arrival signal — closing the loop that #1291 opened (the poll was cancelled but
    portrait landing never published, unlike every sibling background write-back: cast-authoring /
    zeitgeist / off-screen texture all publish).

    Gated on ``ws_transport_enabled()``: when the flag is OFF this is a NO-OP, so production is
    byte-identical and the fast roster poll stays the sole (unchanged) update path — the permanent
    fallback. Best-effort/fail-soft: a publish failure must never perturb the generation run."""
    try:
        from src import settings
        if not settings.ws_transport_enabled():
            return  # flag off ⇒ zero production change; the roster poll is the permanent fallback
        from src import orwell_game_session
        orwell_game_session.publish_game_updated(user)
    except Exception:  # best-effort/fail-soft — never perturb the run; surface at debug for diagnosis
        logger.debug("[portraits] arrival push failed (best-effort)", exc_info=True)


# A run whose heartbeat is older than this is considered dead (the process crashed / the task was
# GC'd mid-flight) — `generation_progress` reports it as inactive so the panel never spins forever.
_GEN_PROGRESS_STALE_S = 120.0

# M1-9 (audit A9): the last COMPLETED run's honest verdict, per user. `image_generation_available`
# deliberately stays permissive (a configured endpoint is enough to TRY — the false-negative fix),
# so honesty lives HERE: a run that attempted portraits and landed ZERO flips the cast panel and
# the admin row to a failing message instead of an eternal "Generating…" spinner.
_LAST_RUN_OUTCOME: dict = {}


def _note_last_run(user: Optional[str], *, generated: int, skipped: int, total: int) -> None:
    attempted = max(0, int(total) - int(skipped))
    if attempted <= 0:
        return  # nothing genuinely attempted (all skipped/idempotent) — keep the prior verdict
    _LAST_RUN_OUTCOME[_safe_user(user)] = {
        "generated": int(generated), "attempted": attempted,
        "failing": int(generated) == 0,
    }


def last_run_outcome(user: Optional[str]) -> Optional[dict]:
    """``{generated, attempted, failing}`` for this user's last completed generation run, or
    None when no run has genuinely attempted anything (pre-game, all-idempotent, never ran)."""
    return _LAST_RUN_OUTCOME.get(_safe_user(user))


def generation_progress(user: Optional[str]) -> Optional[dict]:
    """The live generation-progress record for this user, or None when nothing is/was running.

    Shape: ``{total, done, active}``. ``active`` is True only while a run is genuinely in flight
    (its heartbeat is fresh) — a stale heartbeat (crash / GC) reads inactive so the panel stops
    polling fast. Vault-free: counts only, never a name or any game content."""
    rec = _GEN_PROGRESS.get(_safe_user(user))
    if not isinstance(rec, dict):
        return None
    active = bool(rec.get("active")) and (time.time() - float(rec.get("updatedAt", 0))) <= _GEN_PROGRESS_STALE_S
    total = int(rec.get("total", 0))
    done = int(rec.get("done", 0))
    # F11/BL-056 accounting guard: a retry / re-backfill can `_progress_tick` past the run's `total`,
    # so the raw counter could report `done > total` ("7 / 5") — nonsensical to the operator and a
    # progress bar that overshoots 100%. Clamp the REPORTED done to total (when total is known); the
    # internal counter is left untouched (it is a pure heartbeat).
    if total > 0:
        done = min(done, total)
    return {"total": total, "done": done, "active": active}


# ── G9 backfill debounce: at most ONE backfill attempt per user per process per window ────
# (a failing image provider must not be hammered by every roster poll / button mash).
BACKFILL_DEBOUNCE_S = 10 * 60
_LAST_BACKFILL_AT: dict = {}

# ── Per-photo retry queue (casting in the background, stage 1) ───────────────────────────────
# A face whose shot failed (a timeout, a provider hiccup, the in-flight-credits 402 that outlasted its requeues)
# retries ON ITS OWN with a growing wait, instead of waiting for the 10-minute lazy-backfill window or the 5-minute
# reconciler sweep. Those two stay as the safety net after the queue gives up. A real billing/auth refusal is NOT
# queued here: the billing breaker owns that wait. The retry goes through `backfill_missing`, so the ADR 0013
# authoring gate and the idempotent skip of a face already on disk both apply.
FACE_RETRY_WAITS_S = (5.0, 10.0, 20.0, 40.0, 120.0, 120.0, 120.0, 120.0)
_FACE_RETRY: dict = {}  # safe user -> {safe id: {"n": attempts so far, "task": the pending timer}}


def face_retry_pending(user: Optional[str]) -> list:
    """Safe ids with a retry timer waiting (introspection for the cast panel and tests)."""
    return sorted(k for k, v in _FACE_RETRY.get(_safe_user(user), {}).items() if v.get("task") is not None)


def _schedule_face_retry(user: Optional[str], hid, reason: Optional[str], detail: Optional[str] = None) -> bool:
    """Queue ONE retry of this face after its next backoff wait. Returns True when a timer was set."""
    try:
        if image_gen_disabled() or not hid or _safe_id(str(hid)) == PLAYER_PORTRAIT_ID:
            return False
        if is_billing_error(reason, detail) and not is_inflight_credit_error(reason, detail):
            return False  # out of credits / bad key: the breaker owns this wait, not a per-face timer
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return False
    safe, sid = _safe_user(user), _safe_id(str(hid))
    slot = _FACE_RETRY.setdefault(safe, {}).setdefault(sid, {"n": 0, "task": None})
    if slot["task"] is not None or slot["n"] >= len(FACE_RETRY_WAITS_S):
        return False  # one timer per face; a spent queue leaves the face to the reconciler and the lazy paths
    delay = FACE_RETRY_WAITS_S[slot["n"]]

    async def _run():
        await asyncio.sleep(delay)
        slot["task"] = None  # the shot below may fail and queue the next retry
        slot["n"] += 1
        if portrait_file(user, str(hid)) is not None:
            _FACE_RETRY.get(safe, {}).pop(sid, None)
            return
        try:
            await backfill_missing([str(hid)], user)
        except Exception as e:  # failsoft-ok: handled-by-terminal (backfill_missing records its own failures; the next timer or the reconciler retries)
            logger.info("[portraits] face retry for %s failed: %s", sid, e)
        if portrait_file(user, str(hid)) is not None:
            _FACE_RETRY.get(safe, {}).pop(sid, None)

    slot["task"] = loop.create_task(_run())
    logger.info("[portraits] face %s failed (%s): retry %d in %.0fs", sid, reason, slot["n"] + 1, delay)
    return True


def cancel_face_retries(user: Optional[str]) -> None:
    for v in _FACE_RETRY.pop(_safe_user(user), {}).values():
        t = v.get("task")
        if t is not None and not t.done():
            t.cancel()


# ── G20 reconciler: verify-and-retry until the cast portrait set is complete ──────────────
# The G9 backfill is LAZY (it fires only when someone views the roster) — if no model was
# available when the cast moved in and nobody opens the panel, the set stays incomplete
# forever. The reconciler is the autonomous half: one background task per process sweeps
# every RECONCILE_INTERVAL_S over the users seen by the roster/portrait routes this
# process-life, and for each with an active game AND a usable provider, retries the missing
# set THROUGH the standard pipeline — under a per-houseguest budget (after a failed attempt
# n it cools down ~2^n cycles; RECONCILE_MAX_ATTEMPTS real failures and the reconciler
# stands down for that houseguest, leaving the lazy roster backfill + the manual lever).
# Provider ABSENCE idles and never consumes the budget; absent→present resets all counters.
RECONCILE_INTERVAL_S = 5 * 60
RECONCILE_MAX_ATTEMPTS = 6
# A TRANSIENT/environmental failure (402 credits, 429, 5xx, transport — see `_is_transient_gen_error`)
# does NOT burn a permanent attempt: it re-arms the slot with this small cooldown so the NEXT
# eligible sweep retries it (bounded — one attempt per RECONCILE_INTERVAL_S, never a tight loop),
# leaving the cast to self-heal the moment the operator adds credits / the provider recovers.
RECONCILE_TRANSIENT_COOLDOWN = 1
# The budget sidecar, persisted next to the attempt log so a restart cannot forget how many
# real attempts a houseguest already burned: {safeUser: {safeId: {attempts, cooldown}}}.
RECONCILE_STATE_PATH = Path(DATA_DIR) / "portrait-reconcile.json"

# ── ADR 0013 (2026-07-13): the LAZY seams enforce "no photo without a model-authored identity" ──
# The prewarm/createCharacter seams already gate per-NPC (a face shoots only on its own authoring
# write-back), but the lazy seams — the roster backfill, the manual lever, the G20 reconciler —
# used to shoot ANY missing face from whatever the store held. On a box where authoring landed
# LATE (or was floored for hours), those seams shot the whole cast from the PRE-authoring seeded
# floor: exactly the identity-mismatch ADR 0013 forbids. `adr0013_allowed_ids` applies the SAME
# fork as the #1313 house-entry gate: a real authoring model resolves ⇒ an ACTIVE NPC shoots only
# once its deep profile is AUTHORED (the engine's Vault-free per-card flag); no model ⇒ the
# deterministic floor IS the final cast, so a floor face is legitimate and everything passes.
#
# The staleness self-heal re-shoots at most this many faces per reconciler sweep — mirrors the
# engine's IMAGE_BUDGET.perTurnCap (src/engine/imageConstants.ts) so an existing game's mismatched
# cast heals over a few sweeps instead of flooding the provider. The heal QUEUE is priority-ordered
# (bundle-audit fix 2026-07-13): name-mismatch faces (wrong PERSON — a dead cast's face still on
# disk) heal first, then unstamped reference-carries (wrong-identity DNA), then fingerprint drift
# (wrong wardrobe/composition) — see `_heal_stale_authored_faces`.
STALE_RESHOOT_PER_SWEEP = 3
# Per-user watermark: the ACTIVE-authored count the staleness pass last verified clean at. The
# fingerprint comparison needs one engine prompt-read per authored face, so it runs only when the
# watermark moves (authoring landed for someone new / first sweep of a process) — never per-sweep.
_STALE_AUTHORED_SEEN: dict = {}

# Users seen by the roster/portrait read helpers this process (safe key → the raw identity
# the routes asserted). The reconciler sweeps exactly these — per-user isolation holds; no
# cross-user enumeration is invented.
_SEEN_USERS: dict = {}
# Bundle-audit fix (2026-07-13): slots whose `no-prompt` outcome was ALREADY logged this process —
# {safeUser: {safeId}}. A missing engine prompt is a STATE, not an event: log it once, then quiesce
# until the state changes (a prompt appears for the slot / the slot is discarded / the set is
# scrubbed). The prod bundle showed 11 identical `{player, no-prompt}` rows crowding the capped
# attempt ring; the player is now exempt from prompt-fetching entirely, and any NPC no-prompt is
# once-only. Process-local like the sibling trackers (observability, never game state).
_NO_PROMPT_LOGGED: dict = {}
# Per-user last-observed provider availability (the absent→present transition resets the
# budget) and last-observed missing count — TRANSITION logging only (the A9 lesson: the
# reconciler never logs a line per idle cycle).
_PROVIDER_SEEN: dict = {}
_LAST_MISSING: dict = {}
_RECONCILER_TASK = None

# #998: in-flight generation claim — per `_safe_user`, the set of `_safe_id`s whose generation
# is CURRENTLY running (claimed but not yet written to disk). On-disk idempotency
# (`portrait_file(...) is None`) alone double-generates the not-yet-written tail when two
# concurrent `generate_and_store` runs (eager fall-through × /roster backfill × per-NPC warm)
# pick up the same id before either writes it. A run claims each id immediately BEFORE awaiting
# `_generate_one` and releases it in a `finally` after the write/failure, so an overlapping run
# sees the claim and skips. Single-process, asyncio single-threaded ⇒ a plain dict[str, set] with
# no lock is sufficient (claim/release straddle no awaits relative to each other for the SAME id).
_INFLIGHT: dict = {}

# ORW-389: the most recent _generate_one failure reason (+ an optional short detail, the provider's own
# error code/message on an HTTP failure), consumed by the attempt logger. ORW-378 runs portraits
# concurrently, so the reason is kept PER asyncio TASK (asyncio.gather wraps each portrait in its own
# Task): two simultaneous failures cannot swap reasons. Awaited helpers share their caller's task, so the
# note-then-consume pattern is unchanged. The module-level pair is the fallback for a reader in a
# different task than the writer (a sync caller / a test that drives each call separately).
# Best-effort observability, never game state.
_LAST_GEN_ERROR: Optional[str] = None
_LAST_GEN_DETAIL: Optional[str] = None
_TASK_GEN: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()


def _gen_task():
    try:
        return asyncio.current_task()
    except RuntimeError:
        return None


def _set_gen_state(error: Optional[str], detail: Optional[str]) -> None:
    global _LAST_GEN_ERROR, _LAST_GEN_DETAIL
    _LAST_GEN_ERROR, _LAST_GEN_DETAIL = error, detail
    t = _gen_task()
    if t is not None:
        _TASK_GEN[t] = (error, detail)


def _note_gen_error(error_class: str, detail: Optional[str] = None) -> None:
    _set_gen_state(error_class, detail or None)


def _peek_gen_error() -> tuple:
    t = _gen_task()
    if t is not None and t in _TASK_GEN:
        return _TASK_GEN[t]
    return (_LAST_GEN_ERROR, _LAST_GEN_DETAIL)


def _consume_gen_error() -> Optional[str]:
    e, d = _peek_gen_error()
    _set_gen_state(None, d)
    return e


def _consume_gen_detail() -> Optional[str]:
    e, d = _peek_gen_error()
    _set_gen_state(e, None)
    return d


# ORW-480: the dollar cost the provider returned for the image(s) and checks of the current task, summed, consumed by the
# attempt logger (the portrait log recorded no cost). Per asyncio task like the reasons above; None when no call returned one.
_TASK_COST: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
_LAST_COST: Optional[float] = None


def _note_gen_cost(cost) -> None:
    """Add a provider-returned dollar cost (a number; anything else is ignored) to the current task's running total."""
    global _LAST_COST
    if isinstance(cost, bool) or not isinstance(cost, (int, float)) or cost != cost or cost < 0:
        return
    t = _gen_task()
    if t is not None:
        _TASK_COST[t] = _TASK_COST.get(t, 0.0) + float(cost)
    else:
        _LAST_COST = (_LAST_COST or 0.0) + float(cost)


def _consume_gen_cost() -> Optional[float]:
    """The summed cost noted since the last consume (None when the provider returned none), then reset."""
    global _LAST_COST
    t = _gen_task()
    if t is not None and t in _TASK_COST:
        return round(_TASK_COST.pop(t), 6)
    c, _LAST_COST = _LAST_COST, None
    return None if c is None else round(c, 6)


# ORW-480: which provider and model made the image of the current task ("gpt-image" route, the Gemini fallback, a direct images API), recorded in the manifest
# entry and the attempt log, so a photo's origin is never a guess (a fallback image can carry a provider watermark).
_TASK_PROVIDER: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
_LAST_PROVIDER: Optional[dict] = None


def _note_gen_provider(model_id: str, route: str) -> None:
    global _LAST_PROVIDER
    rec = {"model": str(model_id or "")[:80], "route": route}
    _LAST_PROVIDER = rec          # the module-level copy serves a reader in another task (a sync caller, a test), like the generation reason
    t = _gen_task()
    if t is not None:
        _TASK_PROVIDER[t] = rec


def _peek_gen_provider() -> Optional[dict]:
    t = _gen_task()
    if t is not None:
        return _TASK_PROVIDER.get(t)          # inside a task only this task's own provider counts: another task's is never borrowed
    return _LAST_PROVIDER


def _set_gen_provider(rec: Optional[dict]) -> None:
    global _LAST_PROVIDER
    t = _gen_task()
    if t is not None:
        if rec is None:
            _TASK_PROVIDER.pop(t, None)
        else:
            _TASK_PROVIDER[t] = rec
    else:
        _LAST_PROVIDER = rec


def _usage_cost(data) -> Optional[float]:
    u = data.get("usage") if isinstance(data, dict) else None
    c = u.get("cost") if isinstance(u, dict) else None
    return float(c) if isinstance(c, (int, float)) and not isinstance(c, bool) else None


# ORW-389: the houseguest id the current task is shooting, so provider log lines can name them.
_CURRENT_HID: contextvars.ContextVar = contextvars.ContextVar("orwell_portrait_hid", default=None)


def _hid_tag() -> str:
    return str(_CURRENT_HID.get() or "-")


PORTRAIT_PARALLEL_DEFAULT = 3


def portrait_parallel(user: Optional[str] = None) -> int:
    """ORW-378: how many portraits may be generated at once (setting `portrait_parallel`, default 3,
    clamped 1-4; anything unreadable gives the default)."""
    try:
        from src.settings import get_setting
        n = int(get_setting("portrait_parallel", PORTRAIT_PARALLEL_DEFAULT))
    except Exception:  # failsoft-ok: expected-empty (a bad setting means the default)
        n = PORTRAIT_PARALLEL_DEFAULT
    return max(1, min(4, n))


def is_rate_limited(reason: Optional[str]) -> bool:
    """True when a failure reason is the provider's HTTP 429."""
    return bool(reason) and "429" in str(reason)


# ── Transient vs. genuine failure classification (image-provider errors) ────────────────────
# A generation failure is TRANSIENT/environmental when a retry AFTER the operator changes
# something OUT-OF-BAND (adds credits, the rate-limit window rolls over, the provider recovers,
# the network settles) would plausibly succeed: a credit error (402), auth (401/403), a
# rate-limit (429), a request-timeout (408), any 5xx, or a transport/network exception (surfaced
# as its class name — no HTTP response at all). Everything else — a genuine 400 bad-prompt, a 404
# model-/endpoint-not-found, an empty / no-image / undecodable response — is a per-CONTENT failure
# that a blind retry cannot fix. Two consumers: (1) `_generate_via_chat_completions` skips the
# nonsense tools-fallback (which would only mask the real cause with a 404) when #1 failed
# transiently; (2) the G20 reconciler keeps a transiently-failing houseguest's slot ELIGIBLE
# (never burning its permanent retry budget on an outage), while genuine content failures still
# consume the budget and eventually stand the reconciler down.
_TRANSIENT_TRANSPORT_MARKERS = (
    "timeout", "connecterror", "connecttimeout", "readtimeout", "writetimeout",
    "pooltimeout", "connectionerror", "networkerror", "protocolerror", "remoteprotocol",
    "transporterror", "proxyerror", "readerror", "writeerror",
    # #1599 (CodeRabbit finding c): a network FETCH of the provider-returned image URL that raised — a
    # host outage, distinct from an undecodable image ('image-decode-failed', permanent). Transient, so
    # the G20 reconciler spares its permanent per-content retry budget.
    "image-fetch-failed",
)
_TRANSIENT_HTTP_CODES = frozenset({401, 402, 403, 408, 429})


def _http_status_of(error_class: Optional[str]) -> Optional[int]:
    """The HTTP status embedded in an ``http-<n>`` / ``image-fetch-http-<n>`` error class, else
    None (a transport/JSON/sentinel reason carries no HTTP status)."""
    if not error_class:
        return None
    m = re.search(r"http-(\d{3})", str(error_class))
    return int(m.group(1)) if m else None


def _is_transient_gen_error(error_class: Optional[str]) -> bool:
    """True when ``error_class`` is a transient/environmental failure (see the block comment) —
    a credit/auth/rate-limit/timeout HTTP status, any 5xx, or a transport-exception class name."""
    if not error_class:
        return False
    status = _http_status_of(error_class)
    if status is not None:
        return status in _TRANSIENT_HTTP_CODES or 500 <= status <= 599
    low = str(error_class).strip().lower()
    return any(marker in low for marker in _TRANSIENT_TRANSPORT_MARKERS)


def _should_try_tools_fallback(status: Optional[int], reason: Optional[str]) -> bool:
    """Whether the ``openrouter:image_generation`` server-TOOL fallback can plausibly help after
    the native ``modalities`` attempt failed.

    It is a GENUINE fallback ONLY for "this model didn't accept modalities image-output" — a
    shape/param rejection (a 4xx such as 400/404) or a 200 that simply returned no image. It
    CANNOT help — and only elicits the misleading 404 'No endpoints found that support tool use',
    which would then MASK mechanism #1's real cause — when the modalities attempt failed for an
    environmental/definitive reason: a credit error (402), auth (401/403), a rate-limit (429), any
    5xx, or a transport error (no HTTP response at all). Conservative: skip on any doubt."""
    if _is_transient_gen_error(reason):
        return False  # credit / auth / rate-limit / 5xx / transport — tools can't fix it
    if status is None:
        return False  # no HTTP response ⇒ not a "modalities unsupported" shape rejection
    return True


# ── Per-(user, houseguest) last-failure class — the reconciler's transient signal ───────────
# `generate_and_store` stamps the last failure CLASS per (safeUser, safeId) here (cleared on a
# success) so the G20 reconciler's budget step can tell a TRANSIENT failure (which must NOT burn
# the permanent retry budget) from a genuine per-content one (which does). Keyed by user so ids
# reused across users (`npc:3`) never collide; process-local observability, never game state.
_LAST_GEN_ERROR_BY_ID: dict = {}


def _record_gen_result(user: Optional[str], houseguest_id: str, ok: bool,
                       error_class: Optional[str] = None) -> None:
    """Record one houseguest's generation outcome for the reconciler's budget decision. A success
    clears any prior failure class; a failure stamps its class. Best-effort, never raises."""
    try:
        slot = _LAST_GEN_ERROR_BY_ID.setdefault(_safe_user(user), {})
        sid = _safe_id(houseguest_id)
        if ok:
            slot.pop(sid, None)
        elif error_class:
            slot[sid] = str(error_class)
    except Exception:  # pragma: no cover - defensive
        pass


def last_gen_error_class(user: Optional[str], houseguest_id: str) -> Optional[str]:
    """The last recorded generation-failure class for this (user, houseguest), or None."""
    return _LAST_GEN_ERROR_BY_ID.get(_safe_user(user), {}).get(_safe_id(houseguest_id))


# Text→image model classification now lives in src.llm_core (the single source of truth
# shared with the chat-model selectors, so an image model can never resolve AS a chat model).
# Re-exported here under the historical names this module's callers/tests use. A non-image
# (chat) model resolves fine but can't generate: POSTing it to /images/generations 400s
# instantly, so `image_generation_available` and G20's reconciler gate on `_is_image_model`.
from src.llm_core import (  # noqa: E402
    is_image_model as _is_image_model,
    _IMAGE_MODEL_FAMILIES,
    _VISION_MARKERS,
)


def _provider_error_reason(resp) -> Optional[str]:
    """A short, SAFE hint from a non-200 image response — the provider's own error
    code/message (e.g. 'This model does not support image generation'), clipped, never
    our prompt. Best-effort; None when nothing useful parses out."""
    try:
        body = resp.json()
        if isinstance(body, dict):
            err = body.get("error")
            if isinstance(err, dict):
                msg = err.get("message") or err.get("code") or err.get("type")
                if msg:
                    return str(msg)[:140]
            elif isinstance(err, str) and err:
                return err[:140]
            msg = body.get("message")
            if msg:
                return str(msg)[:140]
    except Exception:
        pass
    return None


def log_attempt(houseguest_id: str, ok: bool, error_class: Optional[str] = None,
                duration_ms: int = 0, detail: Optional[str] = None,
                check: Optional[dict] = None, cost: Optional[float] = None, provider: Optional[dict] = None) -> None:
    """Append one generation attempt/outcome to the capped JSONL ring. Best-effort:
    a logging failure must never break the generation pipeline itself.

    `detail` (failures only) is a short provider-supplied reason — e.g. the body of an
    image-API 400 ('model does not support image generation') — so a failure is
    self-diagnosing without grepping the live log. Clipped; never carries our prompt."""
    entry = {
        "ts": time.time(),
        "houseguestId": str(houseguest_id),
        "ok": bool(ok),
        "errorClass": None if ok else (error_class or "unknown"),
        "durationMs": int(duration_ms),
    }
    if (not ok) and detail:
        entry["detail"] = str(detail)[:200]
    if isinstance(provider, dict) and provider.get("route"):
        entry["provider"] = {"model": str(provider.get("model") or "")[:80], "route": str(provider["route"])[:24]}   # ORW-480: who made the image
    if isinstance(cost, (int, float)) and not isinstance(cost, bool) and cost >= 0:
        entry["costUsd"] = round(float(cost), 6)  # ORW-480: only when the provider returned one (images, the check and any re-shoot)
    if isinstance(check, dict) and check.get("unverified"):  # the check was on but gave no verdict: recorded as unverified, never as passed
        entry["checkUnverified"] = True
    elif isinstance(check, dict):  # ORW-384: the photo-check verdict (codes only, never a prompt or image)
        entry["check"] = {k: v for k, v in check.items() if k in ("ok", "problems", "reshot", "first")}
    try:
        lines = []
        try:
            with open(PORTRAIT_LOG_PATH, "r", encoding="utf-8") as f:
                lines = [ln for ln in f.read().splitlines() if ln.strip()]
        except (FileNotFoundError, OSError):
            lines = []
        lines.append(json.dumps(entry))
        lines = lines[-PORTRAIT_LOG_MAX_ENTRIES:]
        PORTRAIT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = PORTRAIT_LOG_PATH.with_suffix(".jsonl.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        os.replace(tmp, PORTRAIT_LOG_PATH)
    except Exception as e:  # pragma: no cover - defensive
        logger.info("[portraits] attempt-log write failed: %s", e)


def read_attempt_log(limit: int = PORTRAIT_LOG_MAX_ENTRIES) -> list:
    """The last `limit` attempt entries, oldest first. Empty when none/unreadable."""
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        limit = PORTRAIT_LOG_MAX_ENTRIES
    if limit <= 0:
        return []
    try:
        with open(PORTRAIT_LOG_PATH, "r", encoding="utf-8") as f:
            lines = [ln for ln in f.read().splitlines() if ln.strip()]
    except (FileNotFoundError, OSError):
        return []
    out = []
    for ln in lines[-limit:]:
        try:
            entry = json.loads(ln)
            if isinstance(entry, dict):
                out.append(entry)
        except (ValueError, TypeError):
            continue
    return out

# A houseguest id is engine-supplied (e.g. "npc:3", "player"). Sanitize to a safe, stable
# filename stem so it can never escape the user's portrait dir.
_ID_SAFE_RE = re.compile(r"[^A-Za-z0-9_-]+")
# A username likewise sanitized for use as a directory name.
_USER_SAFE_RE = re.compile(r"[^A-Za-z0-9_.-]+")


def _safe_id(houseguest_id: str) -> str:
    stem = _ID_SAFE_RE.sub("_", str(houseguest_id or "").strip())
    return stem or "unknown"


def _safe_user(user: Optional[str]) -> str:
    u = _USER_SAFE_RE.sub("_", str(user or "").strip())
    return u or "default"


def note_user_seen(user: Optional[str]) -> None:
    """Register `user` for the G20 reconciler sweep (first-seen identity wins).

    Called from the per-user read helpers the roster/portrait routes already go through,
    so the reconciler only ever works for users who actually touched those surfaces this
    process. A pure dict write — it may never break a read path."""
    try:
        _SEEN_USERS.setdefault(_safe_user(user), user)
    except Exception:  # pragma: no cover - defensive
        pass


def user_portrait_dir(user: Optional[str]) -> Path:
    """The per-user portrait directory (created lazily by callers that write)."""
    return PORTRAITS_DIR / _safe_user(user)


def _manifest_path(user: Optional[str]) -> Path:
    return user_portrait_dir(user) / "manifest.json"


# ORW-166: the roster poll calls portrait_ref once per houseguest, and each call used to open + parse manifest.json (and cast.json) from disk ON THE EVENT LOOP - ~16 file reads per poll.
# Parsed JSON is cached per path and validated by a stat (inode, mtime_ns, size): _save_manifest / _save_cast_epoch write a temp file and os.replace it, which changes the inode, so a stale
# read is not possible; a missing file is never cached. Callers get a copy (several mutate the manifest and write it back). Bounded.
_JSON_CACHE: dict = {}
_JSON_CACHE_MAX = 256


def _read_json_cached(path):
    """Parsed JSON at `path`; raises FileNotFoundError / JSONDecodeError / OSError exactly like open + json.load. Re-parses only when the file changed."""
    st = os.stat(path)
    sig = (st.st_ino, st.st_mtime_ns, st.st_size)
    hit = _JSON_CACHE.get(str(path))
    if hit is not None and hit[0] == sig:
        return copy.deepcopy(hit[1])
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if len(_JSON_CACHE) >= _JSON_CACHE_MAX:
        _JSON_CACHE.clear()
    _JSON_CACHE[str(path)] = (sig, data)
    return copy.deepcopy(data)


def load_manifest(user: Optional[str]) -> dict:
    """The houseguestId → {file, name} map for this user (empty when none generated)."""
    try:
        data = _read_json_cached(_manifest_path(user))
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _save_manifest(user: Optional[str], manifest: dict) -> None:
    d = user_portrait_dir(user)
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "manifest.json.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    os.replace(tmp, _manifest_path(user))


# ── Cross-season cache-busting: the per-cast "epoch" version ────────────────────────────────
# Portraits are keyed by the engine's ROLE id (`npc:3`, `player`), which is byte-identical in
# EVERY season (src/domain/ids.ts: npc(n) -> "npc:N"). Without a version, season 2's `npc:3`
# reuses season 1's file AND its `/api/orwell/portrait/npc_3` URL — so a browser that cached the
# face for a day (Cache-Control: max-age=86400) keeps showing last season's houseguest on the new
# one, and "generate once" never overwrites it (root cause #1/#2). The cast epoch is a short
# token, persisted per cast, that (a) stamps every portrait URL (`?v=<epoch>`) so a NEW cast
# yields NEW URLs (cache miss → the new face), and (b) is rotated the moment a different cast is
# detected in the stored slots. It is STABLE within a season, so each houseguest keeps a single
# persisted image all season (generate-once still holds); it changes only when the cast does.
def _cast_meta_path(user: Optional[str]) -> Path:
    return user_portrait_dir(user) / "cast.json"


def _load_cast_epoch(user: Optional[str]) -> Optional[str]:
    try:
        data = _read_json_cached(_cast_meta_path(user))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    ep = data.get("epoch") if isinstance(data, dict) else None
    return str(ep) if ep else None


def _save_cast_epoch(user: Optional[str], epoch: str) -> None:
    d = user_portrait_dir(user)
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / "cast.json.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"epoch": str(epoch)}, f)
    os.replace(tmp, _cast_meta_path(user))


def _ensure_cast_epoch(user: Optional[str]) -> str:
    """The current cast's cache-busting version — minted + persisted on first use (and after a
    wipe), then stable for the life of the cast (so a season keeps one URL per houseguest)."""
    ep = _load_cast_epoch(user)
    if not ep:
        ep = secrets.token_hex(4)
        try:
            _save_cast_epoch(user, ep)
        except OSError as e:
            logger.info("[portraits] could not persist cast epoch for %s: %s", _safe_user(user), e)
    return ep


def _rotate_if_new_cast(prompts: list, user: Optional[str]) -> None:
    """Wipe last season's portraits when a DIFFERENT cast now occupies the stored slots.

    The engine reuses role ids (`npc:3`) every season, so a stored portrait whose NAME no longer
    matches the incoming prompt for the same id means a new cast inherited an old face — exactly
    what happens when a reset's portrait scrub was skipped or failed (root cause #1/#3). Wiping
    here both clears the stale file (so generate-once regenerates the slot) and drops the old
    epoch sidecar (so `_ensure_cast_epoch` mints a fresh URL version). A no-op for a fresh dir or
    a same-season backfill (matching names) — so a season's portraits are generated once and persist.
    """
    manifest = load_manifest(user)
    if not manifest:
        return
    for entry in prompts:
        if not isinstance(entry, dict):
            continue
        hid = entry.get("houseguestId") or entry.get("id")
        if not hid:
            continue
        sid = _safe_id(str(hid))
        if sid == PLAYER_PORTRAIT_ID:
            continue  # the player's portrait is account-level — never the rotation trigger
        prev = manifest.get(sid)
        if not isinstance(prev, dict):
            continue
        prev_name = str(prev.get("name") or "").strip().casefold()
        new_name = str(entry.get("name") or "").strip().casefold()
        if prev_name and new_name and prev_name != new_name:
            logger.info(
                "[portraits] new cast detected for %s (slot %s: %r -> %r) — wiping stale portraits",
                _safe_user(user), sid, prev.get("name"), entry.get("name"),
            )
            scrub_user(user)  # remove every stale face + manifest + the old epoch sidecar
            return


def portrait_ref(user: Optional[str], houseguest_id: str) -> Optional[str]:
    """The HTTP ref the browser uses for a stored portrait, or None if none is stored.

    Verifies the file actually exists on disk (a manifest entry whose file was scrubbed
    must not produce a broken <img>). The ref is served by GET /api/orwell/portrait/{id}.
    """
    note_user_seen(user)  # G20: a roster view enrolls this user in the reconciler sweep
    entry = load_manifest(user).get(_safe_id(houseguest_id))
    if not entry:
        return None
    fname = entry.get("file") if isinstance(entry, dict) else None
    if not fname:
        return None
    if not (user_portrait_dir(user) / fname).exists():
        return None
    ref = f"/api/orwell/portrait/{_safe_id(houseguest_id)}"
    # Stamp the per-cast version so a new season's reused id (`npc:3`) can never serve a
    # browser-cached face from the prior cast (root cause #1/#2). Stable within a season.
    epoch = _load_cast_epoch(user)
    return f"{ref}?v={epoch}" if epoch else ref


def portrait_file(user: Optional[str], houseguest_id: str) -> Optional[Path]:
    """The on-disk path for a stored portrait (for the serving route), or None."""
    note_user_seen(user)  # G20: a portrait fetch enrolls this user in the reconciler sweep
    entry = load_manifest(user).get(_safe_id(houseguest_id))
    if not isinstance(entry, dict):
        return None
    fname = entry.get("file")
    if not fname:
        return None
    # fname is a value we wrote ("{safe_id}.png"); re-derive defensively so a tampered
    # manifest can never point outside the user dir.
    safe_name = os.path.basename(str(fname))
    path = user_portrait_dir(user) / safe_name
    return path if path.exists() else None


# ── Image generation (mirrors mcp_servers/image_gen_server.py's proven path) ──────────────
# Kept self-contained so the portrait pipeline does not depend on the MCP/stdio server.
# Reads the SAME settings (image_gen_enabled / image_model / image_quality), per-user where
# those are per-user-eligible (settings._PER_USER_KEYS).

def _image_settings(user: Optional[str]) -> tuple:
    """(enabled, model_spec, quality) — per-user-resolved where allowed."""
    from src.settings import get_user_setting

    enabled = bool(get_user_setting("image_gen_enabled", owner=user or "", default=True))
    model_spec = (get_user_setting("image_model", owner=user or "", default="") or "").strip()
    quality = (get_user_setting("image_quality", owner=user or "", default="medium") or "medium")
    return enabled, model_spec, quality


def image_generation_available(user: Optional[str]) -> bool:
    """True only if image generation is enabled AND a usable image endpoint is configured.

    The roster + onboarding use this to know whether to expect portraits at all (graceful
    absence): when it's False the game proceeds with no portraits and no error surface.

    FALSE-NEGATIVE FIX: the gate is now resilient to a transient `/models` catalog probe.
    `_resolve_model` confirms a model by network-probing the provider's catalog (a 5s,
    blocking call that swallows every error into "not found"). When that probe is slow or
    momentarily fails — a cold provider, a blip, or simply the FIRST Generate press before any
    catalog is warm — `_resolve_model` raised and we reported "no image model configured",
    only to succeed seconds later on a retry (the observed false-negative → race-to-success).

    So: a successful catalog resolve still returns True immediately (the fast, certain path),
    but a resolve that DIDN'T confirm falls back to `has_image_capable_endpoint` — a pure DB
    read (no network) that answers "is there an enabled image-capable endpoint at all?". The
    real test of generation is the actual generate POST, which the pipeline runs best-effort;
    a configured endpoint is enough to TRY, so a transient catalog hiccup never false-negatives.
    We only report unavailable when generation is disabled or there is genuinely no usable
    endpoint.
    """
    # CI/operator image-spend kill-switch — checked FIRST, before any settings read or catalog
    # probe: a hard env off switch takes precedence over any settings/endpoint state, so keyed CI
    # reports graceful absence (the roster/onboarding correctly expect no portraits, no error).
    if image_gen_disabled():
        return False
    from src.ai_interaction import _resolve_model, has_image_capable_endpoint, IMAGE_AUTODETECT_CANDIDATES

    enabled, model_spec, _ = _image_settings(user)
    if not enabled:
        return False
    # A configured model only counts if it's an IMAGE model — a chat model resolves fine but
    # can't generate (it 400s), so a non-image pick falls through to the auto-detect image
    # candidates instead of reporting a false positive.
    candidates = []
    if model_spec and _is_image_model(model_spec):
        candidates.append(model_spec)
    candidates += list(IMAGE_AUTODETECT_CANDIDATES)
    for cand in candidates:
        if not cand:
            continue
        try:
            _resolve_model(cand, owner=user or None)
            return True
        except Exception:
            continue
    # No candidate confirmed via the catalog probe. Before reporting "no image model", check
    # whether an image-capable endpoint is even configured — if one is, the catalog probe was
    # the transient failure (not a genuine absence) and generation should be allowed to TRY.
    try:
        return bool(has_image_capable_endpoint(user or None))
    except Exception:  # failsoft-ok: capability-probe (unconfigured provider ⇒ unavailable; expected-empty)
        return False


def _extract_chat_image_url(data: dict) -> Optional[str]:
    """Pull a generated image's URL (a data: URL or an https: URL) out of a chat-completions
    response — OpenRouter returns images on the assistant message: as `message.images[]`
    (native image-output models, a data URL), as an image part in `message.content`, or as a
    URL embedded in text content (the openrouter:image_generation server tool). Best-effort."""
    try:
        msg = data["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        return None
    if not isinstance(msg, dict):
        return None

    def _url_of(obj):
        if not isinstance(obj, dict):
            return None
        iu = obj.get("image_url")
        if isinstance(iu, dict) and isinstance(iu.get("url"), str):
            return iu["url"]
        if isinstance(iu, str) and iu:
            return iu
        return obj.get("url") if isinstance(obj.get("url"), str) else None

    images = msg.get("images")
    if isinstance(images, list):
        for im in images:
            u = _url_of(im)
            if u:
                return u
    content = msg.get("content")
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and part.get("type") in ("image_url", "output_image", "image"):
                u = _url_of(part)
                if u:
                    return u
    if isinstance(content, str) and content:
        m = re.search(r'(data:image/[A-Za-z0-9.+\-]+;base64,[A-Za-z0-9+/=]+|https?://[^\s)"\']+)', content)
        if m:
            return m.group(1)
    return None


def _chat_text_hint(data: dict) -> Optional[str]:
    """A short clip of the assistant's text reply — useful when no image came back (the model
    may have explained why). Best-effort; never our prompt."""
    try:
        c = data["choices"][0]["message"].get("content")
        if isinstance(c, str) and c.strip():
            return c.strip()[:140]
    except Exception:
        pass
    return None


def _data_url_png(png: bytes) -> str:
    """A `data:image/png;base64,…` URL for a reference image part (G26)."""
    return "data:image/png;base64," + base64.b64encode(png).decode()


async def _image_bytes_from_url(client, url: str) -> "tuple[Optional[bytes], Optional[str]]":
    """Decode a data: URL or fetch an https: URL to raw image bytes. Returns ``(bytes, None)`` on
    success, else ``(None, reason)``.

    #1599 (CodeRabbit finding c): the reason DISTINGUISHES an UNDECODABLE inlined image
    ('image-decode-failed', a permanent per-content fault) from a TRANSIENT network FETCH failure
    ('image-fetch-failed' / 'image-fetch-http-<n>'), so an image-host outage never gets recorded as a
    permanent decode failure that burns the reconciler's retry budget."""
    if url.startswith("data:"):
        try:
            b64 = url.split(",", 1)[1] if "," in url else ""
            png = base64.b64decode(b64) if b64 else None
        except Exception:  # undecodable inlined base64 — a permanent decode fault
            return None, "image-decode-failed"
        return (png, None) if png else (None, "image-decode-failed")
    try:
        r = await client.get(url)
    except Exception:  # failsoft-ok: handled-by-caller (returns image-fetch-failed → caller records it at the terminal; a TRANSIENT reason, not image-decode-failed)
        return None, "image-fetch-failed"
    if r.status_code == 200:
        return r.content, None
    return None, f"image-fetch-http-{r.status_code}"


# G26: prepended to the portrait prompt in 'reference' mode — the player wants their own
# likeness, lightly restyled. Instructs the model toward minimal facial alteration ("as low
# adulteration as possible but still AI generated").
REFERENCE_PROMPT_PREFIX = (
    "Recreate the person in the provided photo as a reality-TV cast portrait. Preserve their "
    "facial identity, bone structure, skin tone, hair, and distinguishing features as "
    "faithfully as possible — keep the face clearly recognizable as the same person, with "
    "minimal alteration. Restyle only the lighting, framing, and background to match: "
)


async def _generate_via_images_edit(client, base_url: str, model_id: str, prompt: str,
                                    headers: dict, reference_png: bytes,
                                    quality: str) -> Optional[bytes]:
    """OpenAI gpt-image image-to-image via /images/edits (multipart). The reference image
    conditions the result. Best-effort: returns None and records a reason on failure."""
    edits_url = base_url + "/images/edits"
    # httpx sets the multipart Content-Type (with boundary) itself — drop any JSON one.
    h = {k: v for k, v in (headers or {}).items() if k.lower() != "content-type"}
    files = {"image": ("headshot.png", reference_png, "image/png")}
    # Pinned square size (per-quality, default 1024x1024) so the edited result matches the rest
    # of the cast grid; the prompt also carries the square-framing cue (belt-and-suspenders).
    data = {"model": model_id, "prompt": prompt, "size": _portrait_size(quality)}
    if quality in ("low", "medium", "high", "auto"):
        data["quality"] = quality
    try:
        resp = await client.post(edits_url, data=data, files=files, headers=h)
        if resp.status_code != 200:
            logger.info("[portraits] images/edits %s: %s", resp.status_code, resp.text[:200])
            _note_gen_error(f"http-{resp.status_code}", _provider_error_reason(resp))
            return None
        body = resp.json()
        imgs = body.get("data", []) if isinstance(body, dict) else []
        _note_gen_cost(_usage_cost(body))
        if imgs and imgs[0].get("b64_json"):
            _note_gen_provider(model_id, "images-edit")
            return base64.b64decode(imgs[0]["b64_json"])
        if imgs and imgs[0].get("url"):
            ir = await client.get(imgs[0]["url"])
            if ir.status_code == 200:
                _note_gen_provider(model_id, "images-edit")
            return ir.content if ir.status_code == 200 else None
        _note_gen_error("empty-response")
        return None
    except Exception as e:  # failsoft-ok: handled-by-terminal (_note_gen_error stashes the reason → the generate_and_store terminal records it RED via _note_generation_failure)
        logger.info("[portraits] images/edits failed: %s", e)
        _note_gen_error(type(e).__name__)
        return None


# ── ORW-397: per-provider billing breaker ───────────────────────────────────────────────────
# An out-of-credit (402) or unauthorised (401/403) image provider stays that way until an operator
# fixes the account, so retrying every houseguest (and falling back to a second chat call) only burns
# calls. On the first such status the provider's breaker opens: no further image call goes to that
# host until BILLING_REPROBE_S has passed, then ONE probe is let through; a probe that succeeds closes
# the breaker, one that fails re-opens it. In-memory only (a restart simply probes once).
BILLING_REPROBE_S = 60 * 60.0
BILLING_BREAKER_OPEN_REASON = "billing-breaker-open"
_BILLING_STATUSES = frozenset({401, 402, 403})
_BILLING_BREAKER: dict = {}  # host -> {"opened_at": monotonic, "recorded": bool}
_PROVIDER_PROVEN = {"ok": False}  # a call has succeeded since the last trip; until then calls go one at a time
_FIRST_CONTACT_LOCK: dict = {}  # event loop -> asyncio.Lock


INFLIGHT_RETRY_WAITS = (10.0, 25.0, 50.0)   # seconds before each re-ask of a refusal that only says other requests are in flight


def is_inflight_credit_refusal(reason: Optional[str], detail: Optional[str] = None) -> bool:
    """True for an HTTP 402 whose own words say the balance is fine until the requests in flight settle (a busy account, not an empty one)."""
    if _http_status_of(reason) != 402 and _http_status_of(detail) != 402:
        return False
    return "in-flight" in f"{reason or ''} {detail or ''}".lower()


def is_billing_error(reason: Optional[str], detail: Optional[str] = None) -> bool:
    """True for HTTP 401/402/403 from the image provider (credits/billing/auth) or the breaker's own
    skip reason."""
    if str(reason or "") == BILLING_BREAKER_OPEN_REASON:
        return True
    for text in (reason, detail):
        status = _http_status_of(text)
        if status in _BILLING_STATUSES:
            return True
    return False


def _provider_host(url: Optional[str]) -> str:
    from urllib.parse import urlparse
    return (urlparse(str(url or "")).hostname or "unknown").lower()


def _breakers_for(host: Optional[str]) -> list:
    """The breaker records to consult: the one for `host`, or every one when the host is unknown (None)."""
    if host:
        b = _BILLING_BREAKER.get(host)
        return [b] if b else []
    return list(_BILLING_BREAKER.values())


def billing_breaker_open(now: Optional[float] = None, host: Optional[str] = None) -> bool:
    """True while a provider breaker is open and its re-probe time has not come. `host` (ORW-437) narrows it to that
    provider host, so an outage on one provider never pauses a user whose images come from another."""
    now = time.monotonic() if now is None else now
    return any(now < b["opened_at"] + BILLING_REPROBE_S for b in _breakers_for(host))


def billing_breaker_probing(now: Optional[float] = None, host: Optional[str] = None) -> bool:
    """True when a breaker is open but its hour is up, so the next call is the single re-probe."""
    return bool(_breakers_for(host)) and not billing_breaker_open(now, host)


async def image_provider_host(user: Optional[str]) -> Optional[str]:
    """The provider host this user's next portrait would go to (their image model, else the first auto-detected one), or
    None when it cannot be resolved (callers then treat every breaker as relevant). Never raises."""
    try:
        from src.ai_interaction import _resolve_model, IMAGE_AUTODETECT_CANDIDATES
        _enabled, model_spec, _q = _image_settings(user)
        specs = [model_spec] if model_spec and _is_image_model(model_spec) else list(IMAGE_AUTODETECT_CANDIDATES)
        for spec in specs:
            try:
                url, _m, _h = await asyncio.to_thread(_resolve_model, spec, owner=user or None)
            except Exception:  # failsoft-ok: capability-probe (an unresolvable candidate is skipped)
                continue
            return _provider_host(url)
    except Exception:  # failsoft-ok: best-effort-gate (unknown host => the gate stays host-agnostic)
        return None
    return None


def _breaker_allows(host: str) -> bool:
    """Closed => True. Open and inside the window => False. Window elapsed => True for ONE caller
    (the window restarts, so a parallel caller is refused while the probe is in flight)."""
    b = _BILLING_BREAKER.get(host)
    if b is None:
        return True
    now = time.monotonic()
    if now < b["opened_at"] + BILLING_REPROBE_S:
        return False
    b["opened_at"] = now
    return True


def _trip_billing_breaker(host: str) -> None:
    b = _BILLING_BREAKER.get(host)
    _PROVIDER_PROVEN["ok"] = False
    _BILLING_BREAKER[host] = {"opened_at": time.monotonic(), "recorded": bool(b and b["recorded"]), "host": host}
    logger.info("[portraits] image provider %s refused billing/auth; breaker open for %.0fs", host, BILLING_REPROBE_S)


def _close_billing_breaker(host: str) -> None:
    if _BILLING_BREAKER.pop(host, None) is not None:
        logger.info("[portraits] image provider %s answered again; breaker closed", host)


def reset_billing_breaker() -> None:
    _BILLING_BREAKER.clear()
    _PROVIDER_PROVEN["ok"] = False
    _FIRST_CONTACT_LOCK.clear()


def _record_billing_soft_failure(user: Optional[str]) -> None:
    """ONE admin-visible soft failure per breaker trip, saying credits/billing."""
    open_ones = [b for b in _BILLING_BREAKER.values() if not b["recorded"]]
    if not open_ones:
        return
    for b in open_ones:
        b["recorded"] = True
    for b in open_ones:  # ORW-437: ONE soft failure per tripped host, never one alert for two hosts
        try:
            from src import log_rings
            log_rings.record_soft_failure(
                "portraits:provider-billing",
                f"image provider {b.get('host') or 'unknown'} refused the request (HTTP 401/402/403): out of credits or "
                "billing/auth problem. Portrait generation is paused and re-probes at most hourly; add credits or fix the key.",
                corrected="billing-breaker", user=user)
        except Exception:  # pragma: no cover — failsoft-ok: recorder-self (health logging must never break the run)
            pass


async def _generate_via_chat_completions(client, chat_url: str, model_id: str,
                                         prompt: str, headers: dict,
                                         reference_png: Optional[bytes] = None) -> Optional[bytes]:
    """OpenRouter (and compatible) image generation over /chat/completions.

    Two mechanisms: native image-output via `modalities: [image, text]` (mechanism #1 — the
    CORRECT path for an image-output model), and the `openrouter:image_generation` server tool
    (mechanism #2 — orchestration for a model that has no native image output). #1 runs first and
    its failure reason is AUTHORITATIVE. #2 runs ONLY as a genuine "modalities not supported"
    fallback and is SKIPPED when #1 failed for an environmental/definitive reason — a credit error
    (402), auth, a rate-limit (429), a 5xx, or a transport error — because retrying with tools
    there cannot help and only elicits the misleading 404 'No endpoints found that support tool
    use' that would then MASK #1's real cause (the bug this guards: an image-output model whose
    account was out of credits reported the tools-404 instead of the real 402). The image is
    extracted from the assistant message (data: or https:) and decoded. Best-effort: returns None
    and records the most informative reason on failure.

    G26: when `reference_png` is set (the player's uploaded headshot), it rides along as an
    image part in the user message — the model recreates THAT person in the requested style
    (image-to-image / likeness preservation), the prompt already carrying the identity-keep
    instruction."""
    if reference_png:
        content = [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": _data_url_png(reference_png)}},
        ]
    else:
        content = prompt
    base_msg = {"model": model_id, "messages": [{"role": "user", "content": content}]}
    # Request a SQUARE 1:1 portrait via OpenRouter's `image_config` hint. Per-model with graceful
    # degradation: a model/provider that rejects the param (a 400) is retried once WITHOUT it, so
    # the square ask never blocks generation. The prompt already carries the framing cue too.
    square_cfg = {"image_config": {"aspect_ratio": PORTRAIT_ASPECT_RATIO}}

    async def _attempt(payload):
        """Run ONE request shape (with the single `image_config`-strip degradation retry).
        Returns ``(png|None, reason|None, detail|None, status|None)`` — `status` is None for a
        transport/JSON-level failure (no usable HTTP status), else the response's HTTP status."""
        try:
            resp = await client.post(chat_url, json=payload, headers=headers)
        except Exception as e:  # transport error — no HTTP response at all; failsoft-ok: handled-by-caller (recorded at the terminal)
            return None, type(e).__name__, None, None
        if (resp.status_code != 200 and 400 <= resp.status_code < 500 and "image_config" in payload
                and not _is_transient_gen_error(f"http-{resp.status_code}")):
            # Graceful degradation: a 4xx may be the unrecognized `image_config` — retry the SAME
            # mechanism once with it stripped before giving up. Gated to NON-transient 4xx only: a
            # 402/credit, auth (401/403), or rate-limit (429) has nothing to do with the param, so a
            # stripped retry is wasted and (worse) would risk overwriting the real reason.
            logger.info("[portraits] openrouter chat %s with image_config — retrying square-free",
                        resp.status_code)
            stripped = {k: v for k, v in payload.items() if k != "image_config"}
            try:
                resp = await client.post(chat_url, json=stripped, headers=headers)
            except Exception as e:  # failsoft-ok: handled-by-caller (recorded at the terminal)
                return None, type(e).__name__, None, None
        if resp.status_code != 200:
            logger.info("[portraits] openrouter chat %s: %s", resp.status_code, resp.text[:200])
            return None, f"http-{resp.status_code}", _provider_error_reason(resp), resp.status_code
        try:
            data = resp.json()
        except Exception:
            return None, "bad-json", None, resp.status_code
        _note_gen_cost(_usage_cost(data))
        img_url = _extract_chat_image_url(data)
        if not img_url:
            return None, "no-image-in-response", _chat_text_hint(data), resp.status_code
        png, fetch_reason = await _image_bytes_from_url(client, img_url)
        if png:
            _note_gen_provider(model_id, "chat")
            return png, None, None, resp.status_code
        return None, fetch_reason or "image-decode-failed", None, resp.status_code

    # Mechanism #1 — native image output. Its reason is the recorded cause on any failure.
    png, reason1, detail1, status1 = await _attempt(
        {**base_msg, "modalities": ["image", "text"], **square_cfg})
    if png:
        return png
    reason, detail = reason1 or "no-image", detail1

    # Mechanism #2 — the server-tool fallback, ONLY when #1's failure looks like a genuine
    # "modalities image-output not supported" shape rejection (a 4xx/200-no-image), never on a
    # credit/auth/rate-limit/5xx/transport failure it cannot fix (and whose real reason it would
    # mask with the tools-404).
    if _should_try_tools_fallback(status1, reason1):
        png, reason2, detail2, _status2 = await _attempt(
            {**base_msg, "tools": [{"type": "openrouter:image_generation"}], **square_cfg})
        if png:
            return png
        # Prefer mechanism #1's reason: it is the correct native path and (given the gate above)
        # always failed with a real HTTP status to reach here, so it is the true cause — never let
        # #2's generic tools-404 clobber it. Fall through to #2 only if #1 produced no reason.
        if not reason1:
            reason, detail = reason2 or "no-image", detail2

    _note_gen_error(reason, detail)
    return None


async def _generate_via_openrouter_images(client, base_url: str, model_id: str, prompt: str,
                                          headers: dict, reference_png: Optional[bytes] = None,
                                          quality: Optional[str] = None,
                                          user: Optional[str] = None) -> Optional[bytes]:
    """ORW-362: OpenRouter's Image API (POST {base}/images) for OpenAI GPT Image models, which have
    no chat-completions image output. Returns PNG bytes, or None after recording the reason with
    `_note_gen_error("gpt-image-failed", reason)` (the caller then falls back to Gemini once).
    Spend goes to the token ledger (call class "portrait"). Never raises."""
    q = quality if quality in ("low", "medium", "high") else "medium"
    body = {"model": model_id, "prompt": prompt, "n": 1, "aspect_ratio": PORTRAIT_ASPECT_RATIO,
            "quality": q, "output_format": "png"}
    if reference_png:
        body["input_references"] = [{"type": "image_url", "image_url": {"url": _data_url_png(reference_png)}}]
    try:
        resp = await client.post(base_url.rstrip("/") + "/images", json=body, headers=headers)
        if resp.status_code != 200:
            logger.info("[portraits] openrouter images %s: %s", resp.status_code, (resp.text or "")[:200])
            if resp.status_code in _BILLING_STATUSES:  # ORW-397: keep the real status as the class
                _note_gen_error(f"http-{resp.status_code}", _provider_error_reason(resp))
                return None
            _note_gen_error("gpt-image-failed", f"http-{resp.status_code}: {_provider_error_reason(resp) or ''}".strip(": "))
            return None
        data = resp.json()
        items = data.get("data") if isinstance(data, dict) else None
        if not items:
            _note_gen_error("gpt-image-failed", "empty-data")
            return None
        b64 = (items[0] or {}).get("b64_json")
        if not b64:
            _note_gen_error("gpt-image-failed", "missing-b64")
            return None
        try:
            png = base64.b64decode(b64)
        except Exception:  # failsoft-ok: handled-by-caller (reason recorded, then the Gemini fallback)
            png = b""
        if not png:
            _note_gen_error("gpt-image-failed", "undecodable-b64")
            return None
        usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
        cost = usage.get("cost")
        _note_gen_cost(cost)
        try:
            from src import orwell_token_ledger
            orwell_token_ledger.record_turn(user, call_class="portrait",
                                            output_tokens=usage.get("completion_tokens") or 0,
                                            cost=cost or 0.0, provider="openrouter")
        except Exception:  # failsoft-ok: observability (ledgering must never fail a portrait)
            pass
        logger.info("[portraits] gpt-image %s cost %s for %s", model_id, cost, _hid_tag())
        _note_gen_provider(model_id, "gpt-image")
        return png
    except Exception as e:  # failsoft-ok: handled-by-caller (reason recorded, then the Gemini fallback)
        logger.info("[portraits] gpt-image failed: %s", e)
        _note_gen_error("gpt-image-failed", type(e).__name__)
        return None


# ORW-480: GPT Image is retried this many more times, with these waits in seconds, on a transient failure before anything else is tried.
GPT_RETRY_WAITS_S = (3.0, 9.0)


def _gpt_failure_retryable(err: tuple) -> bool:
    """A transient GPT Image failure: a 429, any 5xx, a 408, a timeout or a dropped connection, whether the class or the detail carries it. A 400, a 404, an empty
    response or an undecodable image is a failure of the content or the request that a blind retry cannot fix."""
    cls, detail = err
    if _is_transient_gen_error(cls) and not is_billing_error(cls, detail):
        return True
    if cls == "gpt-image-failed" and detail:
        status = _http_status_of(detail)
        if status is not None:
            return status in (408, 429) or 500 <= status <= 599
        return _is_transient_gen_error(str(detail).split(":")[0])
    return False


def gemini_fallback_enabled(user: Optional[str]) -> bool:
    """The setting `portrait_gemini_fallback` (default off): whether a portrait that GPT Image could not make may be made by the Gemini chat route instead."""
    try:
        from src.settings import get_user_setting
        v = get_user_setting("portrait_gemini_fallback", owner=user or "", default=False)
        if isinstance(v, str):
            return v.strip().lower() in ("true", "1", "on", "yes")
        return bool(v)
    except Exception:
        return False


async def _gpt_image_fallback(client, user: Optional[str], prompt: str,
                              reference_png: Optional[bytes], ctx: Optional[dict] = None) -> Optional[bytes]:
    """ORW-362: after a GPT Image failure, make this ONE portrait with the first resolvable
    IMAGE_AUTODETECT_CANDIDATES entry on the OpenRouter chat route. One attempt, no loop."""
    from src.ai_interaction import _resolve_model, IMAGE_AUTODETECT_CANDIDATES
    for cand in IMAGE_AUTODETECT_CANDIDATES:
        try:
            fb_url, fb_model, fb_headers = await asyncio.to_thread(_resolve_model, cand, owner=user or None)
        except Exception:  # failsoft-ok: capability-probe (an unresolvable candidate is skipped)
            continue
        if ctx is not None:
            ctx["host"] = _provider_host(fb_url)  # ORW-437: a billing answer here belongs to the FALLBACK's host breaker
            if not _breaker_allows(ctx["host"]):
                return None  # the fallback host's billing breaker is open: no paid call (the GPT reason stays the failure)
        png = await _generate_via_chat_completions(client, fb_url, fb_model, prompt, fb_headers,
                                                   reference_png=reference_png)
        if png:
            # ORW-389: the fallback made the photo, so the GPT Image reason is no longer a failure.
            _set_gen_state(None, None)
            logger.info("[portraits] fallback used for %s (after gpt-image failure): provider gemini chat route, the image may carry a provider watermark", _hid_tag())
            _note_gen_provider(fb_model, "gemini-fallback")
        return png
    return None


# ── One process-wide image queue ─────────────────────────────────────────────────────────────
# At most `portrait_parallel` (default 3) image generations are in flight PER PROCESS, whoever asks: every per-face
# backfill, reshoot and cast run goes through `_generate_one`, so thirteen faces asked for at once wait their turn
# instead of all hitting the provider together. OpenRouter counts in-flight cost against the credit balance and
# answers 402 "would exceed your available credits given your current in-flight requests": that is BACK-PRESSURE,
# not billing, so it requeues the face after a short wait and never opens the billing breaker.
INFLIGHT_RETRY_WAITS_S = (10.0, 15.0, 20.0, 20.0, 20.0, 20.0)
_INFLIGHT_402_RE = re.compile(r"in[\s-]?flight", re.IGNORECASE)


def is_inflight_credit_error(reason: Optional[str], detail: Optional[str] = None) -> bool:
    """True for the provider's HTTP 402 that says the account would exceed its credits GIVEN requests already in flight
    (back-pressure that clears as those finish), as opposed to a real out-of-credits or auth refusal."""
    return _http_status_of(reason) == 402 and bool(_INFLIGHT_402_RE.search(str(detail or "")) or _INFLIGHT_402_RE.search(str(reason or "")))


# Opening-scene faces first: the ids of the houseguests in the opening scene, per user. A waiting request for one of them
# is granted the next free slot ahead of every other waiting face (FIFO inside each group).
_OPENING_IDS: dict = {}


def set_opening_ids(user: Optional[str], ids) -> None:
    """Tell the queue which houseguests are in the opening scene, so their faces are shot first."""
    _OPENING_IDS[_safe_user(user)] = {_safe_id(str(h)) for h in (ids or []) if h}


def _face_priority(user: Optional[str], sid: Optional[str]) -> int:
    return 0 if (sid and sid in _OPENING_IDS.get(_safe_user(user), ())) else 1


# Back-pressure: OpenRouter refuses when the maximum possible cost of ALL in-flight requests would exceed the account
# balance, so when it says so the queue shrinks to ONE in flight (the refused face requeues) and stays shrunk until a
# shot succeeds or the window passes. This never opens the billing breaker.
BACKPRESSURE_WINDOW_S = 60.0
_BACKPRESSURE = {"until": 0.0}


def _note_backpressure() -> None:
    _BACKPRESSURE["until"] = time.monotonic() + BACKPRESSURE_WINDOW_S


def _clear_backpressure() -> None:
    _BACKPRESSURE["until"] = 0.0


def effective_image_parallel() -> int:
    return 1 if time.monotonic() < _BACKPRESSURE["until"] else portrait_parallel()


class _ImageGate:
    """The process-wide image queue: a counting gate whose limit is read at each grant (so the `portrait_parallel`
    setting stays live) and whose waiters are served opening-scene faces first, then in arrival order."""

    def __init__(self) -> None:
        self.live = 0
        self.max_live = 0
        self._waiters: list = []
        self._seq = 0

    def _grant(self) -> None:
        while self._waiters and self.live < effective_image_parallel():
            best = min(self._waiters, key=lambda w: (_face_priority(w[1], w[2]), w[0]))
            self._waiters.remove(best)
            if best[3].done():
                continue
            self.live += 1
            self.max_live = max(self.max_live, self.live)
            best[3].set_result(None)

    def slot(self, user: Optional[str] = None):
        return _GateSlot(self, user)


class _GateSlot:
    def __init__(self, gate: _ImageGate, user: Optional[str]) -> None:
        self.gate, self.user = gate, user

    async def __aenter__(self):
        g = self.gate
        fut = asyncio.get_running_loop().create_future()
        entry = (g._seq, self.user, _safe_id(str(_CURRENT_HID.get())) if _CURRENT_HID.get() else None, fut)
        g._seq += 1
        g._waiters.append(entry)
        g._grant()
        try:
            await fut
        except asyncio.CancelledError:
            if fut.done() and not fut.cancelled():
                g.live -= 1  # granted just as we were cancelled: hand the slot back
                g._grant()
            elif entry in g._waiters:
                g._waiters.remove(entry)
            raise
        return self

    async def __aexit__(self, *exc):
        self.gate.live -= 1
        self.gate._grant()
        return False


_IMAGE_GATES: dict = {}  # event loop -> gate (a gate is bound to the loop that created it)


def image_gate() -> _ImageGate:
    loop = asyncio.get_running_loop()
    g = _IMAGE_GATES.get(loop)
    if g is None:
        for dead in [k for k in _IMAGE_GATES if k.is_closed()]:
            _IMAGE_GATES.pop(dead, None)
        g = _IMAGE_GATES[loop] = _ImageGate()
    return g


async def _generate_one(prompt: str, user: Optional[str],
                        reference_png: Optional[bytes] = None,
                        keep_identity: bool = True) -> Optional[bytes]:
    """The process-wide image queue (see above) around `_generate_one_gated`: waits for a free slot, and requeues the
    face after a delay when the provider answers the in-flight-credits 402. The slot is released while it waits."""
    attempt = 0
    while True:
        async with image_gate().slot(user):
            png = await _generate_one_gated(prompt, user, reference_png, keep_identity)
        if png:
            _clear_backpressure()
            return png
        if not is_inflight_credit_error(*_peek_gen_error()):
            return png
        _note_backpressure()  # the queue drops to one in flight until a shot lands
        if attempt >= len(INFLIGHT_RETRY_WAITS_S):
            return png
        logger.info("[portraits] provider credits are held by in-flight requests for %s: requeue %d after %.0fs",
                    _hid_tag(), attempt + 1, INFLIGHT_RETRY_WAITS_S[attempt])
        await asyncio.sleep(INFLIGHT_RETRY_WAITS_S[attempt])
        attempt += 1


async def _generate_one_gated(prompt: str, user: Optional[str],
                              reference_png: Optional[bytes] = None,
                              keep_identity: bool = True) -> Optional[bytes]:
    """ORW-397 billing breaker around `_generate_one_inner` (see the breaker block above): no call
    while the provider's breaker is open; a 401/402/403 opens it; a success closes it. The in-flight-credits
    402 is back-pressure, not billing: it never opens the breaker."""
    ctx: dict = {}
    for attempt in range(len(INFLIGHT_RETRY_WAITS) + 1):
        ctx = {}
        if _PROVIDER_PROVEN["ok"]:
            png = await _generate_one_inner(prompt, user, reference_png, keep_identity, _ctx=ctx)
        else:
            # No success seen since start/the last trip: go one at a time, so a refused provider sees ONE
            # call (the breaker then blocks the callers queued behind it).
            lock = _FIRST_CONTACT_LOCK.setdefault(asyncio.get_running_loop(), asyncio.Lock())
            async with lock:
                png = await _generate_one_inner(prompt, user, reference_png, keep_identity, _ctx=ctx)
        # ORW-480: "would exceed your available credits given your current in-flight requests" is a busy
        # account, not an empty one (fifteen photos asked at once on a small balance): wait for the other
        # requests to settle and ask again, never an hour-long breaker for the whole cast.
        if png or ctx.get("skipped") or attempt >= len(INFLIGHT_RETRY_WAITS) or not is_inflight_credit_refusal(*_peek_gen_error()):
            break
        await asyncio.sleep(INFLIGHT_RETRY_WAITS[attempt])
    host = ctx.get("host")
    if host and not ctx.get("skipped"):
        if png:
            _PROVIDER_PROVEN["ok"] = True
            _close_billing_breaker(host)
        elif is_billing_error(*_peek_gen_error()) and not is_inflight_credit_error(*_peek_gen_error()):
            _trip_billing_breaker(host)
    return png


async def _generate_one_inner(prompt: str, user: Optional[str],
                              reference_png: Optional[bytes] = None,
                              keep_identity: bool = True, _ctx: Optional[dict] = None) -> Optional[bytes]:
    """Generate a single image from `prompt`; return PNG bytes, or None on any failure.

    Best-effort: every failure path returns None (never raises) so a flaky image API can
    never break game start or leak an error to the player. OpenRouter endpoints generate
    via /chat/completions (see _generate_via_chat_completions); others use the OpenAI
    Images API (/images/generations).

    G26: when `reference_png` is set (the player's uploaded headshot, 'reference' mode) the
    prompt is prefixed with an identity-preservation instruction and the image is sent to the
    provider's image-to-image path — OpenRouter chat with the image part, OpenAI /images/edits.
    A provider with no img2img path falls back to plain text-to-image (logged) so a portrait
    still lands; the likeness is best-effort, never a hard failure.

    L17 re-shoot: when REGENERATING an existing houseguest's portrait, the caller passes the
    current portrait as `reference_png` so the houseguest stays the SAME person across the
    re-roll. There the caller supplies its own framing (the variety directive) and sets
    `keep_identity=False` so the standard "minimal alteration" identity-keep prefix is NOT
    prepended (it would fight the variety directive) — the reference image alone carries the
    person, the variety directive carries the differentiation from the rest of the cast.
    """
    # CI/operator image-spend kill-switch — the DEEPEST defense: even a direct `_generate_one`
    # call (bypassing the availability gate and `generate_and_store`) makes NO provider POST when
    # set, so keyed CI can provably never spend on images. Checked before any provider resolve.
    if image_gen_disabled():
        return None
    import httpx
    from src.ai_interaction import _resolve_model, IMAGE_AUTODETECT_CANDIDATES, OPENROUTER_GPT_IMAGE_PREFIX

    enabled, model_spec, quality = _image_settings(user)
    if not enabled or not prompt:
        return None
    if reference_png and keep_identity:
        prompt = REFERENCE_PROMPT_PREFIX + prompt
    # Belt-and-suspenders square framing: every portrait carries the 1:1 cue in the prompt text
    # so a provider that ignores the structured size/aspect param still tends toward a square
    # crop. The structured params (size / image_config) below remain the primary control.
    prompt = prompt + _SQUARE_FRAMING_CUE

    # Ignore a configured CHAT model (it can't generate — it would 400) and fall back to
    # image auto-detect, mirroring image_generation_available so a stale/mis-set model never
    # 400-loops the pipeline.
    if model_spec and not _is_image_model(model_spec):
        logger.info("[portraits] configured image_model %r is not an image model — using auto-detect", model_spec)
        model_spec = ""

    if not model_spec:
        for candidate in IMAGE_AUTODETECT_CANDIDATES:
            try:
                await asyncio.to_thread(_resolve_model, candidate, owner=user or None)  # ORW-177: a /models probe (up to 5 s) must not run on the event loop
                model_spec = candidate
                break
            except Exception:  # failsoft-ok: capability-probe (a candidate that does not resolve is simply not configured ⇒ try the next; none ⇒ _note_gen_error("no-model") below)
                continue
    if not model_spec:
        _note_gen_error("no-model")
        return None

    try:
        url, model_id, headers = _resolve_model(model_spec, owner=user or None)
    except Exception as e:
        logger.info("[portraits] no image model resolved: %s", e)
        _note_gen_error("no-model")
        return None

    if _ctx is not None:
        _ctx["host"] = _provider_host(url)
        if not _breaker_allows(_ctx["host"]):
            _ctx["skipped"] = True
            _note_gen_error(BILLING_BREAKER_OPEN_REASON)
            return None

    # fal.ai Seedream (issue #1153 / ADR 0016 §C) — a reference-image (img2img) image provider on a
    # SEPARATE API surface. It has no OpenAI /images path and no chat path: POST the model slug
    # directly with `image_urls` for identity-carry. Detected by the resolved URL's host so it routes
    # to the fal client; everything else keeps its existing transport. When fal is NOT configured the
    # selected/auto-detected model is never a fal one, so this branch never fires (graceful fallback
    # to the current Gemini/OpenAI paths).
    from src.endpoint_resolver import is_fal_url
    is_openrouter = "openrouter.ai" in (url or "").lower()
    is_gpt_image = "gpt-image" in model_id.lower()
    base_url = url.replace("/chat/completions", "").replace("/v1/messages", "").rstrip("/")
    images_url = base_url + "/images/generations"

    # Pinned SQUARE size (per-quality, default 1024x1024) — one consistent resolution so the
    # roster grid is uniform and per-image cost is bounded.
    size = _portrait_size(quality)
    payload = {"model": model_id, "prompt": prompt, "n": 1, "size": size}
    if is_gpt_image:
        payload["quality"] = quality if quality in ("low", "medium", "high", "auto") else "medium"

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(connect=30.0, read=300.0, write=30.0, pool=30.0)
        ) as client:
            if is_fal_url(url):
                # fal Seedream: reference-image identity-carry. The reference (the canonical headshot
                # / the player's upload / the houseguest's current portrait on a re-shoot) rides in
                # `image_urls`; absent ⇒ a first-shoot text→image generation. The identity-keep prompt
                # prefix is already applied above when keep_identity is set.
                from src import orwell_fal_image
                png, reason, detail = await orwell_fal_image.generate_via_fal(
                    client, base_url, model_id, prompt, headers,
                    reference_pngs=[reference_png] if reference_png else None,
                )
                if not png:
                    _note_gen_error(reason or "fal-generation-failed", detail)
                return png
            if is_openrouter and model_id.lower().startswith(OPENROUTER_GPT_IMAGE_PREFIX):
                # ORW-362: GPT Image is served on OpenRouter's Image API only. On any failure make
                # this one portrait with Gemini on the chat route (one attempt, no loop).
                png = None
                for _attempt in range(1 + len(GPT_RETRY_WAITS_S)):
                    png = await _generate_via_openrouter_images(client, base_url, model_id, prompt,
                                                                headers, reference_png, quality, user=user)
                    if png:
                        return png
                    if is_billing_error(*_peek_gen_error()):
                        return None  # ORW-397: out of credits/auth: the chat fallback would only fail the same way
                    # ORW-480: a transient GPT Image failure (429, 5xx, a timeout, a dropped connection) is retried with a growing wait BEFORE any other provider is tried
                    if _attempt < len(GPT_RETRY_WAITS_S) and _gpt_failure_retryable(_peek_gen_error()):
                        logger.info("[portraits] gpt-image failed for %s (%s): retry %d after %.0fs", _hid_tag(), _peek_gen_error()[0], _attempt + 1, GPT_RETRY_WAITS_S[_attempt])
                        await asyncio.sleep(GPT_RETRY_WAITS_S[_attempt])
                        continue
                    break
                gpt_err = _peek_gen_error()  # ORW-437: the GPT class and detail are the primary cause
                if not gemini_fallback_enabled(user):
                    # ORW-480: no Gemini fallback by default: a fallback image can carry the provider's visible watermark. The failure is recorded (RED) and the
                    # reconciler shoots this person again later with GPT Image.
                    logger.info("[portraits] gpt-image failed for %s after %d tries (%s): no Gemini fallback (setting portrait_gemini_fallback is off)", _hid_tag(), 1 + len(GPT_RETRY_WAITS_S), gpt_err[0])
                    return None
                fb_png = await _gpt_image_fallback(client, user, prompt, reference_png, ctx=_ctx)
                fb_err = _peek_gen_error()
                if (not fb_png and gpt_err[0] and not is_billing_error(*fb_err)
                        and not _is_transient_gen_error(fb_err[0])):
                    # the fallback's own PERMANENT failure must not replace the GPT reason; a transient one (429, 5xx,
                    # a timeout) stays, so the retry reconciler sees an outage and spares the houseguest's budget
                    _note_gen_error(gpt_err[0], gpt_err[1])
                return fb_png
            if is_openrouter:
                # OpenRouter does image-to-image natively via the chat image part (G26).
                return await _generate_via_chat_completions(client, url, model_id, prompt,
                                                            headers, reference_png=reference_png)
            if reference_png:
                if is_gpt_image:
                    # OpenAI gpt-image edits: the reference image conditions the result.
                    return await _generate_via_images_edit(client, base_url, model_id, prompt,
                                                           headers, reference_png, quality)
                # No img2img path for this provider — render text-to-image so a portrait still
                # lands (likeness is best-effort), and say so in the log.
                logger.info("[portraits] reference mode unsupported by %s — text-to-image fallback", model_id)
            resp = await client.post(images_url, json=payload, headers=headers)
            if resp.status_code != 200:
                logger.info("[portraits] image API %s: %s", resp.status_code, resp.text[:200])
                _note_gen_error(f"http-{resp.status_code}", _provider_error_reason(resp))
                return None
            data = resp.json()
            _note_gen_cost(_usage_cost(data))
            images = data.get("data", [])
            if not images:
                _note_gen_error("empty-response")
                return None
            img = images[0]
            _note_gen_provider(model_id, "images-api")
            if img.get("b64_json"):
                return base64.b64decode(img["b64_json"])
            if img.get("url"):
                # Some providers return a URL instead of inline bytes — fetch them.
                ir = await client.get(img["url"])
                if ir.status_code == 200:
                    return ir.content
                _note_gen_error(f"image-fetch-http-{ir.status_code}")
                return None
            _note_gen_error("empty-response")
            return None
    except Exception as e:  # failsoft-ok: handled-by-terminal (_note_gen_error stashes the reason → the generate_and_store terminal records it RED via _note_generation_failure)
        logger.info("[portraits] generation failed: %s", e)
        _note_gen_error(type(e).__name__)
        return None


# ── 0065 follow-up: the facet FINGERPRINT — an intra-season re-shoot backstop ───────────────
# The cast EPOCH versions URLs across SEASONS (a new cast on reused role ids). But a houseguest's
# deep FACET can change WITHIN a season at the SAME id+name — e.g. the no-key→key path, or a
# seeded-floor portrait shot BEFORE LLM authoring lands the §3-depth physicalCharacteristics. The
# engine bakes the full facet into the deterministic portrait PROMPT string, so a stable hash of
# that prompt is a faithful change signal: same prompt ⇒ same face (generate-once holds); a changed
# prompt ⇒ the stored face is stale and must be re-shot. This is ADDITIONAL to the epoch (which it
# leaves intact) — it only guards a facet change at an unchanged id+name within the same season.
def _prompt_fingerprint(prompt: Optional[str]) -> Optional[str]:
    """A short, stable hex hash of the engine's portrait PROMPT string (the deterministic facet
    output). None for an empty prompt (no signal ⇒ never a re-shoot trigger)."""
    text = str(prompt or "")
    if not text:
        return None
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _look_fingerprint(entry) -> Optional[str]:
    """ORW-953: the staleness fingerprint of a face, taken from the engine's `lookKey` (the inputs that change how THIS person looks: age, presentation, heritage,
    physical description, job, hometown) and never from the whole prompt: the prompt also carries the shot and face cards, which are dealt across the whole cast, so one
    houseguest's repair moved other people's prompts and re-shot their faces. `entry` is an engine prompt entry or a `getPortraitPrompt` reply. Without a `lookKey` (an
    older engine) it falls back to the prompt hash, so a mixed deploy still compares like with like inside one process."""
    if not isinstance(entry, dict):
        return None
    key = entry.get("lookKey")
    if isinstance(key, str) and key:
        return _prompt_fingerprint("look|" + key)
    return _prompt_fingerprint(str(entry.get("enginePrompt") or entry.get("prompt") or ""))


# ORW-361: the version of the engine's portrait PROMPT wording. A stored entry shot under an older
# wording (promptVersion below this; missing counts as 1) is NEVER re-shot by the fingerprint path and
# keeps its old version: the new wording changes every fingerprint, so comparing them is meaningless.
# Only a portrait actually shot with the new prompt records PORTRAIT_PROMPT_VERSION (new seasons,
# missing faces, a forced single re-shoot). A background upgrader (ORW-369) walks `stale_portrait_ids`
# and re-shoots one houseguest at a time through `generate_and_store(..., force_ids=[id])`.
PORTRAIT_PROMPT_VERSION = 3  # ORW-380. ORW-480 (shot cards, v4) is NOT a version bump here: a bump re-shoots every live season; the owner decides when

# ORW-380: prepended to the prompt of a forced upgrade re-shoot (the ORW-369 upgrader) that carries the current
# portrait as the reference image: it keeps the person and lets the new brief change everything else.
UPGRADE_IDENTITY_PREFIX = (
    "The same person as in the reference photo: keep their face, skin tone and age. Everything else (hair "
    "styling, clothes, pose, setting and light) follows this brief, with clear even skin and no marks other "
    "than those named. ")


def _entry_prompt_version(entry) -> int:
    """The prompt version a manifest entry was shot under (missing or malformed ⇒ 1)."""
    return _safe_int(entry.get("promptVersion", 1), 1, floor=1) if isinstance(entry, dict) else 1


def _safe_int(v, default: int = 0, floor: int = 0) -> int:
    """A stored counter/version as an int: an int (or integral float / digit string) at or above `floor`; a bool, a
    fractional number such as 2.9 (int() would truncate it to 2), or anything else malformed gives `default`."""
    if isinstance(v, bool):
        return default
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")) or v != int(v):
            return default
        v = int(v)
    elif isinstance(v, str):
        if not v.strip().lstrip("+").isdigit():
            return default
        v = int(v.strip())
    elif not isinstance(v, int):
        return default
    return v if v >= floor else default


# ORW-480: the shot-card wording changes every engine prompt, so a face shot before it carries a fingerprint that is not comparable with today's prompt. The version above is NOT bumped
# (a bump lists every live face for the upgrader); instead only a face shot with this wording records it, and the fingerprint sweeps leave the others alone.
# ORW-953: 5 = the fingerprint is hashed from the engine's `lookKey` (see `_look_fingerprint`), no longer from the whole prompt. Every stored face shot before this has
# promptWording < 5, so `_wording_only_stale` re-baselines it quietly on its next sweep (image untouched, never re-shot): a deploy does not re-shoot any existing face.
PORTRAIT_WORDING = 5


def _wording_only_stale(entry) -> bool:
    """True for a face of the current version whose fingerprint predates the recorded wording: it is re-baselined quietly (never re-shot), not frozen."""
    return (isinstance(entry, dict) and not _entry_version_stale(entry) and entry.get("source") != "upload" and bool(entry.get("fingerprint"))
            and _safe_int(entry.get("promptWording", 0), 0) < PORTRAIT_WORDING)


def _rebaseline_fingerprint(user, hid, fp: Optional[str]) -> None:
    """Store today's engine fingerprint and the wording on a legacy face, image untouched, as the no-fingerprint backfill does: from the next sweep an edited
    look is compared with this baseline and re-shoots. A failed write only means the baseline is taken again next sweep."""
    if not fp:
        return
    try:
        sid = _safe_id(str(hid))
        manifest = load_manifest(user)
        e = manifest.get(sid)
        if isinstance(e, dict):
            e["fingerprint"] = fp
            e["promptWording"] = PORTRAIT_WORDING
            manifest[sid] = e
            _save_manifest(user, manifest)
    except Exception as ex:  # failsoft-ok: best-effort-metadata (the baseline is simply taken again on the next sweep)
        logger.info("[portraits] fingerprint baseline not saved: %s", type(ex).__name__)


def _fingerprint_not_comparable(entry) -> bool:
    """True when a stored face was shot under an older prompt wording or version: its fingerprint is never a re-shoot trigger."""
    if _entry_version_stale(entry):
        return True
    return isinstance(entry, dict) and entry.get("source") != "upload" and bool(entry.get("fingerprint")) and _safe_int(entry.get("promptWording", 0), 0) < PORTRAIT_WORDING


def _entry_version_stale(entry) -> bool:
    """True when the stored entry was shot under an older prompt wording than the current one."""
    return isinstance(entry, dict) and _entry_prompt_version(entry) < PORTRAIT_PROMPT_VERSION


def stale_portrait_ids(manifest: dict) -> list:
    """Houseguest ids (manifest keys, as stored) whose portrait was shot under an older prompt
    version. The player's own uploaded photo is never listed. Sorted, for a stable walk."""
    return sorted(
        str(k) for k, e in (manifest or {}).items()
        if _entry_version_stale(e) and e.get("source") != "upload")


def _stamp_version_one(user: Optional[str], sid: str) -> None:
    """Record promptVersion 1 explicitly on an old entry that lacks it (fingerprint, image untouched)."""
    manifest = load_manifest(user)
    stored = manifest.get(sid)
    if isinstance(stored, dict) and "promptVersion" not in stored:
        stored["promptVersion"] = 1
        manifest[sid] = stored
        try:
            _save_manifest(user, manifest)
        except Exception as e:  # failsoft-ok: best-effort-metadata (ORW-437: a legacy-entry stamp must never stop the cast run)
            logger.info("[portraits] version-1 stamp not saved: %s", type(e).__name__)


# ORW-431 D: a photo whose check still fails after the one re-shoot is kept (the one with fewer problem codes) and
# retried by the ORW-369 upgrader: at most this many upgrader passes per houseguest, each ONE new image (no in-pass
# re-shoot), so the extra spend is at most PHOTO_CHECK_RETRY_BOUND images (about 4.5 cents each) per affected houseguest.
PHOTO_CHECK_RETRY_BOUND = 2
# The setting `portrait_check_reshoot_cap` is the TOTAL number of check-driven re-shoots one face may get: the one
# in-pass re-shoot plus the upgrader passes. The default (3) is today's behaviour exactly (1 + PHOTO_CHECK_RETRY_BOUND);
# 1 keeps only the in-pass re-shoot, 0 turns check-driven re-shoots off (the owners have not chosen a different cap).
PHOTO_CHECK_RESHOOT_CAP_DEFAULT = 1 + PHOTO_CHECK_RETRY_BOUND


def check_reshoot_cap(user: Optional[str] = None) -> int:
    try:
        from src.settings import get_setting
        n = int(get_setting("portrait_check_reshoot_cap", PHOTO_CHECK_RESHOOT_CAP_DEFAULT))
    except Exception:  # failsoft-ok: expected-empty (a bad setting means today's default)
        n = PHOTO_CHECK_RESHOOT_CAP_DEFAULT
    return max(0, min(6, n))


def photo_check_retry_bound(user: Optional[str] = None) -> int:
    """The upgrader passes still allowed per face under the current cap (today: PHOTO_CHECK_RETRY_BOUND)."""
    return max(0, check_reshoot_cap(user) - 1)


def _check_retries(entry) -> int:
    """The upgrader passes already spent on a photo: 0 when the counter is missing, the whole bound when it is present
    but malformed (a corrupt "2.5" must never grant two more paid attempts; review of #2748)."""
    if not isinstance(entry, dict) or entry.get("checkRetries") is None:
        return 0
    return _safe_int(entry.get("checkRetries"), photo_check_retry_bound())


def check_retry_ids(manifest: dict) -> list:
    """Houseguest ids whose stored photo failed the automatic check and still have an upgrader retry left."""
    out = []
    for k, e in (manifest or {}).items():
        c = e.get("check") if isinstance(e, dict) else None
        if (isinstance(c, dict) and c.get("ok") is False and e.get("source") != "upload"
                and _check_retries(e) < photo_check_retry_bound()):
            out.append(str(k))
    return sorted(out)


async def _check_after_reshoot(png: bytes, facts: dict, user: Optional[str]):
    """ORW-953: the look at a RE-SHOT face. The re-shoot exists to fix a named fault, so a look that gave no verdict (a timeout, an empty answer) is tried ONE more time
    (bounded: two attempts in all). Still no verdict: None, and the photo is kept (the check stays fail-open)."""
    from src import orwell_portrait_check as C
    second = await C.check_portrait(png, facts, user)
    if second is None and C.check_enabled(user) and not image_gen_disabled():
        logger.info("[portraits] re-shot photo check for %s gave no verdict: trying once more", _hid_tag())
        second = await C.check_portrait(png, facts, user)
    return second


async def _portrait_check_pass(png: bytes, prompt: str, user: Optional[str], ref: Optional[bytes],
                               retry_of: Optional[dict] = None, upgrade: bool = False):
    """ORW-384: check a fresh NPC cast photo; on a fail re-shoot ONCE (same prompt + a fix line, same
    reference) and keep the second unless it has MORE problems. Returns (png, check_meta|None). Fail
    open: a skipped check returns the photo untouched with no meta; this never raises."""
    try:
        from src import orwell_portrait_check as C
        facts = C.facts_from_prompt(prompt)
        first = await C.check_portrait(png, facts, user)
        border = C.has_border(png) and C.check_enabled(user)   # ORW-480: the free edge test; only while the photo check is on
        if first is None and border:
            first = {"ok": False, "problems": ["frame-or-border"]}
        elif first is not None and border and "frame-or-border" not in first["problems"]:
            first = {"ok": False, "problems": list(first["problems"]) + ["frame-or-border"]}
        if first is None:
            if C.check_enabled(user) and not image_gen_disabled():
                # the check was on but gave no verdict (an empty answer, a timeout, an error): the photo is kept, but it is recorded as UNVERIFIED, never as passed
                logger.warning("[portraits] photo check for %s gave no verdict: kept unverified", _hid_tag())
                try:  # ORW-1025: counted per unverified photo (the doctor shows photos-unchecked)
                    from src import log_rings
                    log_rings.record_soft_failure("portraits:photo-unverified", "photo check gave no verdict",
                                                  corrected="kept-marked-unverified", user=user)
                except Exception:  # failsoft-ok: the health record must never break the portrait run
                    pass
                return png, {"unverified": True}
            return png, None
        logger.info("[portraits] photo check for %s: %s", _hid_tag(), "ok" if first["ok"] else "problems " + ",".join(map(str, first["problems"])))
        if first["ok"]:
            return png, {"ok": True, "problems": [], "reshot": False}
        if retry_of is not None:  # an upgrader retry is the extra attempt: no re-shoot inside it; keep the better photo
            prior = (retry_of.get("check") or {}).get("problems") or []
            if len(first["problems"]) > len(prior):
                old_png = portrait_file(user, _CURRENT_HID.get() or "")
                if old_png is not None:
                    return old_png.read_bytes(), {"ok": False, "problems": list(prior), "reshot": False}
            return png, {"ok": False, "problems": first["problems"], "reshot": False}
        if check_reshoot_cap(user) < 1:  # the owners' cap says no check-driven re-shoot: keep the photo, record the verdict
            return png, {"ok": False, "problems": first["problems"], "reshot": False}
        meta = {"ok": False, "problems": first["problems"], "reshot": True, "first": first["problems"]}
        prov_first = _peek_gen_provider()      # ORW-480: the provider of the first image, restored when the first photo is the one kept
        fix_prompt = prompt + " Fix in this version: " + C.problems_in_words(first["problems"]) + "."
        if "wrong-age" in first["problems"] and facts.get("age"):  # ORW-953: say the age as a number, plainly
            fix_prompt += f" The person is exactly {int(facts['age'])} years old."
        if upgrade:  # ORW-437: the re-shoot of a FORCED UPGRADE keeps the upgrade's identity-only prefix, never the generic one
            png2 = await _generate_one(UPGRADE_IDENTITY_PREFIX + fix_prompt, user, reference_png=ref, keep_identity=False)
        else:
            png2 = await _generate_one(fix_prompt, user, reference_png=ref)
        logger.info("[portraits] photo re-shoot for %s: %s", _hid_tag(), "made" if png2 else "failed")
        if not png2:
            meta["reshot"] = False
            _set_gen_provider(prov_first)
            return png, meta
        second = await _check_after_reshoot(png2, facts, user)
        if C.has_border(png2) and C.check_enabled(user):
            second = {"ok": False, "problems": (list(second["problems"]) if second else []) + (["frame-or-border"] if not second or "frame-or-border" not in second["problems"] else [])}
        if second is None:
            return png2, meta  # re-shot but the second look was skipped: keep the fix, verdict stays the first's
        meta["ok"], meta["problems"] = second["ok"], second["problems"]
        if len(second["problems"]) > len(first["problems"]):
            _set_gen_provider(prov_first)
            return png, {**meta, "ok": False, "problems": first["problems"]}
        return png2, meta
    except Exception as e:  # failsoft-ok: fail-open (the photo is kept as is)
        logger.info("[portraits] photo check skipped: %s", e)
        return png, None


def _write_portrait(user: Optional[str], houseguest_id: str, png: bytes, name: str,
                    source: str = "generated", fingerprint: Optional[str] = None,
                    ref_clean: Optional[bool] = None, check: Optional[dict] = None,
                    cast_look_reshot: bool = False, provider: Optional[dict] = None) -> str:
    """Persist one portrait + update the manifest; return its stored filename.

    `source` (G26) records HOW the portrait was made: 'generated' (text-to-image, the default),
    'reference' (image-to-image off the player's headshot — still AI, re-creatable), or 'upload'
    (the player's literal cropped photo — LOCKED: the regenerate lever never discards it).

    `fingerprint` (0065 follow-up) is a stable hash of the PROMPT string the face was shot from,
    stamped so a LATER facet change at the same id+name re-shoots a stale face (see
    `generate_and_store`). None when there is no prompt to fingerprint (e.g. an uploaded photo).

    `ref_clean` (bundle-audit fix 2026-07-13, 'reference' sources only): provenance of the img2img
    identity-carry — True means the reference image was itself of KNOWN-GOOD identity lineage (a
    fresh text-to-image shoot from the subject's current prompt, or a chain of such, or the
    player's own upload). A 'reference' entry WITHOUT this stamp is a legacy write that may carry
    pre-authoring wrong-face DNA (the prod bundle's npc:8–14, re-shot pre-#1559 with the old wrong
    face as reference) — the staleness heal treats those as re-shoot candidates once."""
    d = user_portrait_dir(user)
    d.mkdir(parents=True, exist_ok=True)
    _ensure_cast_epoch(user)  # the per-cast URL version exists the moment any portrait is persisted
    filename = f"{_safe_id(houseguest_id)}.png"
    target = d / filename
    # #531: detect an IN-PLACE byte replacement (a mid-season re-shoot off a changed facet —
    # `generate_and_store` overwrites the same id+name file). The `?v=<epoch>` URL is otherwise
    # byte-identical to the stale one, so with `Cache-Control: private, max-age=86400` a browser
    # that cached the old face keeps showing it while a fresh session fetches the re-shot one.
    replaced_in_place = target.exists()
    # ORW-369: an atomic swap (temp file + rename) so a reader never sees a half-written face while
    # the background upgrader replaces a live one.
    _tmp = d / f".{filename}.{secrets.token_hex(4)}.tmp"
    try:
        _tmp.write_bytes(png)
        os.replace(_tmp, target)
    finally:
        try:
            _tmp.unlink()
        except OSError:
            pass
    manifest = load_manifest(user)
    entry = {"file": filename, "name": name, "source": source}
    if fingerprint:
        entry["fingerprint"] = fingerprint
    if source != "upload":  # ORW-437: a literal upload was made by no prompt, so it carries no prompt version
        entry["promptVersion"] = PORTRAIT_PROMPT_VERSION
        entry["promptWording"] = PORTRAIT_WORDING
    if source == "reference" and ref_clean:
        entry["refClean"] = True
    if cast_look_reshot:  # ORW-480: this photo was re-shot once by the cast-level look; it is never sent back again
        entry["castLookReshot"] = True
    if isinstance(provider, dict) and provider.get("route"):  # ORW-480: which provider and route made this image (a Gemini fallback image can carry a watermark)
        entry["provider"] = {"model": str(provider.get("model") or "")[:80], "route": str(provider["route"])[:24]}
    if isinstance(check, dict) and check.get("unverified"):  # the check was on but gave no verdict: recorded as unverified, never as passed
        entry["checkUnverified"] = True
    elif isinstance(check, dict):  # ORW-384: {ok, problems, reshot} from the automatic photo check
        entry["check"] = {"ok": bool(check.get("ok")), "problems": list(check.get("problems") or []),
                          "reshot": bool(check.get("reshot"))}
        if check.get("retry") and not check.get("ok"):
            entry["checkRetries"] = int(check["retry"])
    manifest[_safe_id(houseguest_id)] = entry
    _save_manifest(user, manifest)
    if replaced_in_place:
        # Rotate the cast cache epoch so EVERY portrait URL changes (`?v=<new>`) and the re-shot
        # face is fetched fresh on every session/device. The other portraits' bytes are unchanged,
        # so this only costs a one-time cache miss — never a re-shoot (generate-once still holds).
        try:
            _save_cast_epoch(user, secrets.token_hex(4))
        except OSError as e:
            logger.info("[portraits] could not rotate cast epoch on re-shoot for %s: %s",
                        _safe_user(user), e)
    return filename


# ── G26: the player's own headshot — uploaded during casting, applied as their portrait ─────
# Two modes (player's choice): 'exact' = their cropped photo stored verbatim (no AI); 'reference'
# = an image-to-image studio portrait that keeps their likeness. The upload lives under the
# user's portrait dir so a new-season scrub clears it (casting re-asks); the source image
# PERSISTS so 'reference' mode can re-render on a regenerate.
PLAYER_PORTRAIT_ID = "player"


def _intake_dir(user: Optional[str]) -> Path:
    return user_portrait_dir(user) / "_intake"


def _normalize_upload(raw: bytes, *, square: bool) -> Optional[bytes]:
    """Decode an uploaded image, honor EXIF orientation, optionally center-square-crop (biased
    slightly up — faces sit high in a frame), bound the long edge to 1024, re-encode PNG.
    Returns PNG bytes, or None on any failure (a bad upload never raises)."""
    try:
        import io
        from PIL import Image, ImageOps

        im = Image.open(io.BytesIO(raw))
        im = ImageOps.exif_transpose(im)
        im = im.convert("RGB")
        if square:
            w, h = im.size
            s = min(w, h)
            left = (w - s) // 2
            top = max(0, (h - s) // 2 - int(h * 0.06))
            im = im.crop((left, top, left + s, top + s))
        im.thumbnail((1024, 1024), Image.LANCZOS)
        out = io.BytesIO()
        im.save(out, format="PNG")
        return out.getvalue()
    except Exception as e:
        logger.info("[portraits] upload normalize failed: %s", e)
        return None


def save_player_intake(user: Optional[str], raw_image: bytes, mode: str) -> Optional[dict]:
    """Store the player's uploaded headshot + chosen mode ('exact'|'reference'). The source is
    normalized to an oriented, bounded PNG; returns the saved meta, or None if it couldn't be
    read as an image."""
    mode = mode if mode in ("exact", "reference") else "reference"
    norm = _normalize_upload(raw_image, square=False)
    if not norm:
        return None
    d = _intake_dir(user)
    d.mkdir(parents=True, exist_ok=True)
    (d / "source.png").write_bytes(norm)
    meta = {"mode": mode, "ts": time.time()}
    try:
        (d / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    except OSError as e:
        logger.info("[portraits] intake meta write failed: %s", e)
        return None
    return meta


def load_player_intake(user: Optional[str]) -> Optional[dict]:
    """The player's pending headshot meta ({mode, ts}) when both meta + source exist, else None."""
    d = _intake_dir(user)
    try:
        meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        if isinstance(meta, dict) and (d / "source.png").exists():
            return meta
    except (OSError, ValueError):
        pass
    return None


def _read_intake_source(user: Optional[str]) -> Optional[bytes]:
    try:
        return (_intake_dir(user) / "source.png").read_bytes()
    except OSError:
        return None


def clear_player_intake(user: Optional[str]) -> None:
    import shutil
    try:
        shutil.rmtree(_intake_dir(user))
    except OSError:
        pass


# ── G27: the interactive headshot studio + the persistent account avatar ────────────────────
# The finalized headshot becomes the player's portrait AND the account's circle avatar. The
# studio lets the player generate 3 AI options at a time off their uploaded photo, pick one (or
# regenerate, indefinitely, or upload a new photo), then finalize.

def _intake_final_path(user: Optional[str]) -> Path:
    return _intake_dir(user) / "final.png"


def _candidate_path(user: Optional[str], i: int) -> Path:
    return _intake_dir(user) / f"cand-{int(i)}.png"


def _read_intake_final(user: Optional[str]) -> Optional[bytes]:
    try:
        return _intake_final_path(user).read_bytes()
    except OSError:
        return None


def _clear_candidates(user: Optional[str]) -> None:
    d = _intake_dir(user)
    try:
        for p in d.glob("cand-*.png"):
            p.unlink()
    except OSError:
        pass


def candidate_count(user: Optional[str]) -> int:
    try:
        return len(list(_intake_dir(user).glob("cand-*.png")))
    except OSError:
        return 0


def intake_status(user: Optional[str]) -> dict:
    """What the casting headshot control needs: is something uploaded, the mode, is it
    finalized, and how many studio candidates are waiting to be chosen."""
    meta = load_player_intake(user)
    return {
        "present": bool(meta),
        "mode": (meta or {}).get("mode"),
        "finalized": _intake_final_path(user).exists(),
        "candidates": candidate_count(user),
        "generating": studio_generating(user),  # ORW-950: a run in flight; the page shows "generating", not a half picker
    }


# --- the account avatar (the circle profile pic) — survives a new-season scrub ---

def user_avatar_path(user: Optional[str]) -> Optional[Path]:
    p = AVATARS_DIR / (_safe_user(user) + ".png")
    return p if p.exists() else None


def set_user_avatar(user: Optional[str], png: bytes) -> None:
    try:
        AVATARS_DIR.mkdir(parents=True, exist_ok=True)
        (AVATARS_DIR / (_safe_user(user) + ".png")).write_bytes(png)
    except OSError as e:
        logger.info("[portraits] set_user_avatar failed: %s", e)


def clear_user_avatar(user: Optional[str]) -> None:
    try:
        (AVATARS_DIR / (_safe_user(user) + ".png")).unlink()
    except OSError:
        pass


# --- G30: the persistent headshot library (cached, reusable options) ---

def _lib_dir(user: Optional[str]) -> Path:
    return HEADSHOTS_DIR / _safe_user(user)


def _lib_index_path(user: Optional[str]) -> Path:
    return _lib_dir(user) / "index.json"


def _load_lib_index(user: Optional[str]) -> list:
    try:
        data = json.loads(_lib_index_path(user).read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save_lib_index(user: Optional[str], items: list) -> None:
    d = _lib_dir(user)
    try:
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / "index.json.tmp"
        tmp.write_text(json.dumps(items), encoding="utf-8")
        os.replace(tmp, _lib_index_path(user))
    except OSError as e:
        logger.info("[portraits] library index write failed: %s", e)


def headshot_path(user: Optional[str], hid: str) -> Optional[Path]:
    p = _lib_dir(user) / f"{_safe_id(hid)}.png"
    return p if p.exists() else None


def add_headshot_to_library(user: Optional[str], png: bytes, kind: str = "studio") -> Optional[str]:
    """Cache a finalized headshot as a reusable option; return its id. Evicts the oldest
    NON-current entry past HEADSHOT_LIBRARY_MAX. Best-effort."""
    if not png:
        return None
    items = _load_lib_index(user)
    hid = f"{int(time.time() * 1000)}"
    # Guarantee a UNIQUE id even when two finalizes land in the same millisecond (the id is a ms
    # timestamp): bump past any existing collision so two cached headshots never share an id — a real
    # (if rare) production edge case, and a test-timing flake (g30).
    _existing = {str(i.get("id")) for i in items}
    if hid in _existing:
        _n = int(hid) + 1
        while str(_n) in _existing:
            _n += 1
        hid = str(_n)
    d = _lib_dir(user)
    try:
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{_safe_id(hid)}.png").write_bytes(png)
    except OSError as e:
        logger.info("[portraits] library write failed: %s", e)
        return None
    items.append({"id": hid, "ts": time.time(), "kind": kind if kind in ("upload", "studio") else "studio"})
    # Evict oldest non-current beyond the cap.
    while len(items) > HEADSHOT_LIBRARY_MAX:
        victim = next((i for i in items if not i.get("current")), items[0])
        items.remove(victim)
        try:
            vp = d / f"{_safe_id(victim['id'])}.png"
            if vp.exists():
                vp.unlink()
        except OSError:
            pass
    _save_lib_index(user, items)
    return hid


def list_headshots(user: Optional[str]) -> list:
    """The cached headshots, newest first: [{id, kind, current, ref}]."""
    items = [i for i in _load_lib_index(user) if headshot_path(user, i.get("id")) is not None]
    items.sort(key=lambda i: i.get("ts", 0), reverse=True)
    return [{"id": i["id"], "kind": i.get("kind", "studio"), "current": bool(i.get("current")),
             "ref": f"/api/orwell/portrait/library/{i['id']}"} for i in items]


def select_headshot(user: Optional[str], hid: str) -> bool:
    """Make a cached headshot CURRENT: it becomes the account avatar + the live game portrait,
    and the season-start intake. Returns True when the id resolves."""
    p = headshot_path(user, hid)
    if p is None:
        return False
    try:
        png = p.read_bytes()
    except OSError:
        return False
    set_user_avatar(user, png)
    try:
        _intake_dir(user).mkdir(parents=True, exist_ok=True)
        _intake_final_path(user).write_bytes(png)  # season-start seed (account avatar also seeds it)
    except OSError:
        pass
    try:
        _write_portrait(user, PLAYER_PORTRAIT_ID, png, "", source="upload")  # live portrait, locked
    except Exception as e:  # pragma: no cover - defensive
        # #1599: the account avatar landed but the live game portrait write failed — the chosen
        # headshot didn't fully apply. Surface it RED (the next reconcile retries).
        logger.info("[portraits] select live-portrait write failed: %s", e)
        _note_generation_failure(user, PLAYER_PORTRAIT_ID, f"select-live-portrait-write-failed: {e}")
    items = _load_lib_index(user)
    for i in items:
        i["current"] = (i.get("id") == hid)
    _save_lib_index(user, items)
    _clear_candidates(user)
    return True


def delete_headshot(user: Optional[str], hid: str) -> bool:
    items = _load_lib_index(user)
    keep = [i for i in items if i.get("id") != hid]
    if len(keep) == len(items):
        return False
    try:
        p = _lib_dir(user) / f"{_safe_id(hid)}.png"
        if p.exists():
            p.unlink()
    except OSError:
        pass
    _save_lib_index(user, keep)
    return True


def finalize_player_headshot(user: Optional[str], png: bytes, kind: str = "studio") -> bool:
    """A new chosen headshot: cache it in the library, then make it CURRENT (account avatar +
    live game portrait + season-start seed). Returns True on success. Best-effort: never raises."""
    if not png:
        return False
    hid = add_headshot_to_library(user, png, kind)
    if not hid:
        return False
    return select_headshot(user, hid)


# --- the studio: generate N image-to-image options off the uploaded photo ---
_STUDIO_BASE = ("photorealistic candid reality-TV cast portrait, natural skin, "
                "soft practical lighting, head-and-shoulders")
_STUDIO_VARIANTS = (
    "a natural easy smile, soft window light, looking at camera",
    "three-quarter angle, a relaxed confident look, warm practical light",
    "a candid mid-laugh, bright natural light, slightly off-center",
    "a thoughtful steady gaze, cooler even light, centered",
)


# ORW-950: one studio run per player at a time; a reload's second request joins it, not re-runs it.
_STUDIO_RUNS: dict = {}


def studio_generating(user: Optional[str]) -> bool:
    t = _STUDIO_RUNS.get(_safe_user(user))
    return bool(t is not None and not t.done())


async def generate_studio_candidates(user: Optional[str], n: int = 3) -> dict:
    """Single-flight wrapper (ORW-950): a second call for the same player awaits the run in flight."""
    k = _safe_user(user)
    task = _STUDIO_RUNS.get(k)
    if task is None or task.done():
        task = asyncio.ensure_future(_generate_studio_candidates(user, n))
        _STUDIO_RUNS[k] = task

        def _done(t, k=k):
            if _STUDIO_RUNS.get(k) is t:
                del _STUDIO_RUNS[k]
        task.add_done_callback(_done)
    # shield: an aborted request (page reload) must not cancel the shared run.
    return await asyncio.shield(task)


async def _generate_studio_candidates(user: Optional[str], n: int = 3) -> dict:
    """Generate up to `n` studio portrait OPTIONS off the player's uploaded photo (image-to-
    image, likeness-preserving). Writes cand-0…N-1; returns {generated, reason?}. The player
    picks one via finalize, or calls this again for a fresh set (back-and-forth, indefinitely)."""
    src = _read_intake_source(user)
    if not src:
        return {"generated": 0, "reason": "upload a photo first"}
    if not image_generation_available(user):
        return {"generated": 0, "reason": "no image model is configured"}
    made = 0
    for i in range(max(1, min(int(n), 4))):
        # _generate_one prepends the identity-keep instruction when a reference is set.
        prompt = _STUDIO_BASE + ". " + _STUDIO_VARIANTS[i % len(_STUDIO_VARIANTS)]
        _consume_gen_error(); _consume_gen_detail()
        _CURRENT_HID.set(PLAYER_PORTRAIT_ID)
        png = await _generate_one(prompt, user, reference_png=src)
        if png:
            try:
                if made == 0:
                    _clear_candidates(user)  # ORW-950: clear only once a new image exists, so a run that makes nothing keeps the old set
                _candidate_path(user, made).write_bytes(png)
                made += 1
                log_attempt("player:candidate", True, None, 0)
            except OSError as e:
                logger.info("[portraits] candidate write failed: %s", e)
        else:
            log_attempt("player:candidate", False, _consume_gen_error() or "generation-failed",
                        0, detail=_consume_gen_detail())
    return {"generated": made} if made else {"generated": 0, "reason": "generation failed — see the portrait log"}


async def generate_and_store(prompts: list, user: Optional[str], *, record_beats: bool = True,
                             force_ids: Optional[list] = None, silent: bool = False) -> dict:
    """Generate + persist a cast portrait set from the engine's `portraitPrompts`.

    `prompts` is the engine's ``[{houseguestId, name, prompt}]``. Returns a small summary
    ``{generated, skipped, total}``. Idempotent: a houseguest whose portrait already exists
    on disk is NOT regenerated (generate-once-per-season; served from disk on restart).

    `force_ids` (ORW-361, for the ORW-369 upgrader): houseguest ids to RE-SHOOT now even though a
    face is on disk, from the prompt passed for them. The old file is replaced only after the new
    image is generated successfully (a failed generation leaves it in place); the entry records the
    current PORTRAIT_PROMPT_VERSION. Example: ``await generate_and_store([entry], user, force_ids=["npc:3"])``.

    Best-effort throughout: never raises. When generation is unavailable (no model / disabled)
    it skips silently and the game is unaffected. After a portrait is shown for the first time
    we record it as a player-witnessed beat via the engine (recorded-or-it-didn't-happen),
    unless `record_beats` is False.

    `silent` (ORW-369, the background upgrader): a quiet single-face run. No L15 progress record (the
    cast panel's "generating" UI never lights), no last-run verdict, no look-alike pass; the swap
    still pushes the one WS arrival edge so open pages refetch the new face.
    """
    # ORW-480: per-person authored shot briefs (setting off by default): the engine's prompt is the floor when no brief is available.
    try:
        from src import orwell_photo_brief as _PB
        if _PB.brief_enabled(user) and isinstance(prompts, list) and prompts:
            prompts = await _PB.apply_briefs(prompts, user)
    except Exception as e:  # failsoft-ok: best-effort-enrichment (the engine's own prompts stand)
        logger.info("[portraits] photo briefs skipped: %s", type(e).__name__)
    if not isinstance(prompts, list) or not prompts:
        return {"generated": 0, "skipped": 0, "total": 0}

    # CI/operator image-spend kill-switch (belt-and-suspenders): a hard env off switch short-circuits
    # the whole pipeline BEFORE any settings read, availability probe, or provider POST — so even a
    # direct/forced call generates nothing and can never reach the image API. See `image_gen_disabled`.
    if image_gen_disabled():
        logger.info("[portraits] image generation disabled via ORWELL_DISABLE_IMAGE_GEN — no-op")
        total = len(prompts)
        return {"generated": 0, "skipped": total, "total": total}

    # Cross-season hygiene (root cause #1/#3): if a DIFFERENT cast now occupies this user's
    # portrait slots (the engine reuses role ids like `npc:3` every season), last season's
    # faces survived a reset — wipe them so no new houseguest inherits an old face and
    # generate-once regenerates the slot. A no-op for a same-season run, so each houseguest
    # keeps ONE persisted image all season (generate-once preserved). The cache-busting cast
    # epoch is minted lazily in `_write_portrait` (only once something is actually persisted,
    # so "no image model" stays a true no-op — no dir, no artifacts).
    _rotate_if_new_cast(prompts, user)

    generated = 0
    skipped = 0
    newly_shown = []  # (houseguestId, ref) for beat recording
    # S8: safe-ids the engine will METER at beat time (a re-generation of an already-portrayed
    # houseguest — a facet-change re-shoot or an L17 dedupe regen). Move-in first-shoots stay OUT
    # of this set (the engine exempts them), so only the metered beats are budget-gated below.
    reshoot_ids: set = set()
    # Ids the pre-pass already APPLIED + counted in `generated` (only ever the player). The main
    # loop below must not re-count these: the player rides a PROMPT-LESS entry, so it would fall
    # into the `not prompt` skip branch and double-count the one slot (generated=1 AND skipped=1
    # for total=1 — CodeRabbit #1564). Populated only on the pre-pass's write+count path.
    prepass_applied: set = set()

    # Player-portrait pre-pass (G26/G27): a player-chosen headshot needs NO provider — apply it
    # BEFORE the availability gate, so it works even with no image model. Priority: the finalized
    # studio/exact pick (final.png) → an 'exact' upload (cropped) → the persisted account avatar
    # (a returning player keeps their face). Any of these writes the player portrait locked.
    forced = {_safe_id(str(i)) for i in (force_ids or [])}

    def _sid_forced(hid, stored) -> bool:
        return (_safe_id(str(hid)) in forced and isinstance(stored, dict)
                and stored.get("source") != "upload")

    intake = load_player_intake(user)
    chosen = _read_intake_final(user)
    if not chosen and intake and intake.get("mode") == "exact":
        chosen = _normalize_upload(_read_intake_source(user) or b"", square=True)
    if not chosen:
        ap = user_avatar_path(user)
        if ap is not None:
            try:
                chosen = ap.read_bytes()
            except OSError:
                chosen = None
    if chosen:
        for entry in prompts:
            if not isinstance(entry, dict):
                continue
            hid = entry.get("houseguestId") or entry.get("id")
            if not hid or _safe_id(str(hid)) != PLAYER_PORTRAIT_ID:
                continue
            if portrait_file(user, hid) is not None:
                break  # already on disk (generate-once)
            try:
                _write_portrait(user, str(hid), chosen, str(entry.get("name") or ""), source="upload")
                log_attempt(str(hid), True, None, 0)
                generated += 1
                prepass_applied.add(_safe_id(str(hid)))  # counted here — the main loop must not re-count it
                newly_shown.append((str(hid), f"/api/orwell/portrait/{_safe_id(hid)}"))
            except Exception as e:
                # #1599 (CodeRabbit finding b): a broken chosen-headshot fallback must show RED on
                # /admin/status, not silently leave the player on a placeholder.
                logger.info("[portraits] failed to persist chosen headshot: %s", e)
                _note_generation_failure(user, str(hid), f"chosen-headshot-persist-failed: {e}")
            break

    # Graceful absence: don't even probe the API per houseguest if generation is off (the exact
    # player photo, if any, already landed above).
    if not image_generation_available(user):
        logger.info("[portraits] image generation unavailable — skipping cast portraits")
        if record_beats and newly_shown:
            await _record_image_beats(newly_shown, user)
        if generated:  # a player-chosen headshot landed with NO provider — still fire the WS push edge
            _push_portrait_arrival(user)
        total = len(prompts)
        return {"generated": generated, "skipped": total - generated, "total": total}

    # L15: count the faces this run will actually try to generate (provider on, not already on
    # disk) so the progress record reports honest "done of N" — and mark the run STARTED. The
    # panel reads this to show live progress and to stay on the fast cadence ONLY while a run is
    # genuinely in flight, instead of going dark when a state poll times out.
    to_generate = 0
    for entry in prompts:
        if not isinstance(entry, dict):
            continue
        hid = entry.get("houseguestId") or entry.get("id")
        if not hid or not entry.get("prompt"):
            continue
        if portrait_file(user, hid) is None:
            to_generate += 1
        else:
            # 0065 follow-up: a stored face whose fingerprint DIFFERS from the current facet's
            # prompt will be re-shot below — count it so the progress total stays honest. A
            # legacy entry with no stored fingerprint backfills (no re-shoot) ⇒ not counted.
            stored = load_manifest(user).get(_safe_id(str(hid)))
            stored_fp = stored.get("fingerprint") if isinstance(stored, dict) else None
            cur_fp = _look_fingerprint(entry)
            if _sid_forced(hid, stored):
                to_generate += 1
            elif (stored_fp and cur_fp and stored_fp != cur_fp
                    and not _fingerprint_not_comparable(stored)):
                to_generate += 1
    if to_generate and not silent:
        _progress_start(user, to_generate)

    # ORW-378: up to `portrait_parallel` portraits at once (Kevin 2026-11-14: "Why so much time to
    # generate"). Everything between the claim and the write is synchronous (no await), so the counters,
    # `newly_shown`, `reshoot_ids` and the manifest read-modify-write cannot interleave; the manifest
    # writes also take `manifest_lock` so that stays true if an await is ever added. One failure never
    # cancels the others. A provider 429 drops the REST of this run to one at a time.
    limit = portrait_parallel(user)
    sem = asyncio.Semaphore(limit)
    serial = asyncio.Lock()
    manifest_lock = asyncio.Lock()  # one manifest read-modify-write at a time
    run = {"rate_limited": False, "live": 0}

    async def _one(entry):
        nonlocal generated, skipped
        await _one_body(entry, run)

    async def _shoot(prompt_text, **kw):
        """The image slot covers ONLY the generation: it is released before the vision check runs (a check takes
        about as long as a shot, and holding the slot through it halved the throughput)."""
        async with sem:
            if run["rate_limited"]:
                async with serial:
                    while run["live"]:  # a provider 429: the rest go strictly ONE at a time, after any shot already in flight
                        await asyncio.sleep(0.005)
                    return await _timed_generate(prompt_text, **kw)
            return await _timed_generate(prompt_text, **kw)

    async def _timed_generate(prompt_text, **kw):
        run["live"] += 1
        try:
            png = await _generate_one(prompt_text, user, **kw)
        finally:
            run["live"] -= 1
        if not png and is_rate_limited(_peek_gen_error()[0]):
            run["rate_limited"] = True  # set before the slot is handed on, so the next waiter already sees it
        return png

    async def _one_body(entry, run):
        nonlocal generated, skipped
        if not isinstance(entry, dict):
            skipped += 1
            return
        hid = entry.get("houseguestId") or entry.get("id")
        prompt = entry.get("prompt")
        name = entry.get("name") or ""
        # The player pre-pass already applied + counted this id (a chosen headshot) — skip WITHOUT
        # counting `skipped`, else the one player slot is double-counted (it is prompt-less, so it
        # would otherwise fall into the `not prompt` branch below). CodeRabbit #1564.
        if hid and _safe_id(str(hid)) in prepass_applied:
            return
        if not hid or not prompt:
            skipped += 1
            return

        # The current facet's fingerprint (a stable hash of the engine's deterministic prompt).
        fp = _look_fingerprint({**entry, "prompt": prompt})   # ORW-953: the look key; ORW-480 fallback: the engine's own prompt (what the staleness sweeps compare), never the briefed one

        # #998: an overlapping run already CLAIMED this id and is mid-generation (claimed but not
        # yet written to disk, so the on-disk check below would not catch it) — skip, let that run
        # land the one image. Mirrors the on-disk generate-once guard for the in-flight window.
        sid = _safe_id(str(hid))
        if sid in _INFLIGHT.setdefault(_safe_user(user), set()):
            skipped += 1
            return

        # Generate-once: a stored portrait is never regenerated on restart — UNLESS the facet
        # changed. 0065 follow-up: compare the stored entry's fingerprint to the CURRENT prompt's.
        #   • stored fingerprint EXISTS and DIFFERS  ⇒ the stored face is stale → re-shoot (fall
        #     through to regenerate from the new prompt, overwriting it).
        #   • stored fingerprint EXISTS and MATCHES  ⇒ unchanged facet → skip (generate-once holds).
        #   • NO stored fingerprint (legacy/pre-this-change) ⇒ DON'T mass-re-shoot just for the
        #     missing field: BACKFILL the current fingerprint onto the entry without regenerating,
        #     so it self-heals quietly and only re-shoots on a FUTURE genuine facet change.
        if portrait_file(user, hid) is not None:
            stored = load_manifest(user).get(_safe_id(str(hid)))
            stored_fp = stored.get("fingerprint") if isinstance(stored, dict) else None
            if _sid_forced(hid, stored):
                # ORW-361: an explicit single re-shoot (the upgrader). Falls through to regenerate;
                # the file is replaced only after the new image succeeds, stamped with the new version.
                reshoot_ids.add(_safe_id(str(hid)))
            elif _wording_only_stale(stored):
                # ORW-480: a face shot before the shot-card wording is re-baselined quietly (today's engine fingerprint), never re-shot and never frozen
                _rebaseline_fingerprint(user, hid, fp)
                skipped += 1
                return
            elif _fingerprint_not_comparable(stored):
                # ORW-361: shot under an older prompt wording — its fingerprint is not comparable.
                # Leave it alone: no re-shoot, no fingerprint or version change (v1 recorded explicitly).
                _stamp_version_one(user, _safe_id(str(hid)))
                skipped += 1
                return
            elif stored_fp and fp and stored_fp != fp:
                # Facet changed → stale face → fall through and re-shoot from the new prompt. This
                # is a RE-generation, so the engine will METER its beat — mark it for the budget
                # pre-check (S8) so a re-shoot burst can never over-fire into the per-turn cap.
                reshoot_ids.add(_safe_id(str(hid)))
            else:
                if (not stored_fp) and fp and isinstance(stored, dict):
                    # Backfill quietly (no regeneration) so this self-heals and the NEXT genuine
                    # facet change re-shoots. The image bytes are untouched (generate-once preserved).
                    async with manifest_lock:
                        stored["fingerprint"] = fp
                        stored["promptWording"] = PORTRAIT_WORDING        # the fingerprint is of today's wording: comparable from now on
                        manifest = load_manifest(user)
                        manifest[_safe_id(str(hid))] = stored
                        _save_manifest(user, manifest)
                skipped += 1
                return

        # G26: the PLAYER may have chosen 'reference' mode — image-to-image off their headshot
        # (exact mode already landed in the pre-pass above). NPCs are text→image on FIRST shoot
        # (that establishes the canonical headshot), then carry identity on a RE-SHOOT.
        is_player = _safe_id(str(hid)) == PLAYER_PORTRAIT_ID
        ref = _read_intake_source(user) if (is_player and intake and intake.get("mode") == "reference") else None
        # The player's own upload is inherently the RIGHT person — a clean identity reference.
        ref_clean = ref is not None
        # #1153 identity-carry: if we reached here with a stored portrait on disk it's a RE-SHOOT
        # (a facet change fell through the generate-once guard above). Feed the houseguest's CURRENT
        # portrait back as the reference so a reference-image provider (fal Seedream) keeps the SAME
        # face + gender across the re-shoot instead of re-rolling from text (#1140). _generate_one's
        # default keep_identity=True reinforces it with the "minimal alteration" prompt prefix.
        # Harmless on text→image providers (they degrade to text→image inside _generate_one). First
        # shoots (no prior portrait) stay reference-free — that establishes the canonical headshot.
        if not ref:
            existing = portrait_file(user, str(hid))
            if existing is not None:
                try:
                    ref = existing.read_bytes()
                except OSError:
                    ref = None
                # Bundle-audit fix (2026-07-13): stamp the identity-carry's PROVENANCE. The carry is
                # clean iff the base face is itself of known-good lineage — a fresh text-to-image
                # shoot ('generated'), the player's literal photo ('upload'), or a carry already
                # verified clean (refClean). A legacy/unknown base leaves the new entry UNSTAMPED, so
                # the staleness heal can flag wrong-identity DNA instead of it riding forever.
                if ref is not None:
                    stored = load_manifest(user).get(sid)
                    ref_clean = isinstance(stored, dict) and (
                        stored.get("source") in ("generated", "upload") or stored.get("refClean") is True)
        source = "reference" if ref else "generated"

        _consume_gen_error(); _consume_gen_detail()  # clear any stale reason/detail
        _hid_token = _CURRENT_HID.set(sid)  # ORW-389: provider log lines name this houseguest (reset in the finally, ORW-437)
        # #998: CLAIM the id immediately before the (slow) generate, release in `finally` after the
        # write/failure — an overlapping run that reaches the in-flight check above now skips it,
        # so each id is generated exactly once even while its image is in flight (not yet on disk).
        _INFLIGHT.setdefault(_safe_user(user), set()).add(sid)
        try:
            t0 = time.monotonic()
            # ORW-380: an upgrader re-shoot (forced, with the current file as the reference) carries the
            # identity prefix instead of the generic "minimal alteration" one (keep_identity=False).
            _upgrade_ref = bool(ref and sid in reshoot_ids and entry.get("identityPrefix") is True
                                and _safe_id(str(hid)) in forced)
            if _upgrade_ref:
                png = await _shoot(UPGRADE_IDENTITY_PREFIX + str(prompt), reference_png=ref,
                                   keep_identity=False)
            else:
                png = await _shoot(str(prompt), reference_png=ref)
            duration_ms = int((time.monotonic() - t0) * 1000)
            if ref and not png:
                source = "generated"  # reference failed; the log carries the reason
            if not png:
                reason = _consume_gen_error() or "generation-failed"
                _detail = _consume_gen_detail()
                # ORW-437: the GPT Image class is bare ("gpt-image-failed") with its HTTP status in the detail; the
                # retry budget must see the status (a 429/5xx is transient and must not burn the permanent budget).
                if reason == "gpt-image-failed" and _detail and (_http_status_of(_detail) is not None
                                                                 or _is_transient_gen_error(_detail)):
                    reason = f"{reason}: {_detail}"
                if is_rate_limited(reason):
                    run["rate_limited"] = True  # ORW-378: the rest of this run goes one at a time
                log_attempt(str(hid), False, reason, duration_ms, detail=_detail, cost=_consume_gen_cost())
                # Stamp the failure class so the G20 reconciler can spare a TRANSIENT failure
                # (402 credits, 429, 5xx, transport) from the permanent retry budget.
                _record_gen_result(user, str(hid), False, reason)
                # #1599: surface the failure RED on /admin/status — a silent placeholder was the
                # original trigger; the initials floor stands (auto-corrected), still RED.
                _note_generation_failure(user, str(hid), reason)
                _schedule_face_retry(user, hid, reason, _detail)
                skipped += 1
                return
            check_meta = None
            if not is_player:  # ORW-384: NPC cast photos only (never the player's own photo)
                _prior = load_manifest(user).get(_safe_id(str(hid)))
                _retry_of = _prior if (isinstance(_prior, dict) and isinstance(_prior.get("check"), dict)
                                       and _prior["check"].get("ok") is False) else None
                png, check_meta = await _portrait_check_pass(png, str(prompt), user, ref, retry_of=_retry_of, upgrade=_upgrade_ref)
                if check_meta is not None and _retry_of is not None:
                    check_meta["retry"] = _check_retries(_retry_of) + 1
                duration_ms = int((time.monotonic() - t0) * 1000)  # ORW-437: the log's duration includes the check and any re-shoot
            try:
                async with manifest_lock:
                    _write_portrait(user, str(hid), png, str(name), source=source, fingerprint=fp,
                                    ref_clean=ref_clean, check=check_meta, provider=_peek_gen_provider())
                log_attempt(str(hid), True, None, duration_ms, check=check_meta, cost=_consume_gen_cost(), provider=_peek_gen_provider())
                _record_gen_result(user, str(hid), True)  # success clears any prior failure class
                generated += 1
                if not silent:
                    _progress_tick(user)  # L15: one more face landed — the panel sees the live count move
                _push_portrait_arrival(user)  # WS push edge: refresh the (poll-stood-down) cast panel now
                newly_shown.append((str(hid), f"/api/orwell/portrait/{_safe_id(hid)}"))
            except Exception as e:
                logger.info("[portraits] failed to persist %s: %s", hid, e)
                log_attempt(str(hid), False, "persist-failed", duration_ms)
                _record_gen_result(user, str(hid), False, "persist-failed")
                _note_generation_failure(user, str(hid), f"persist-failed: {e}")  # #1599: RED, not silent
                skipped += 1
        finally:
            _INFLIGHT.get(_safe_user(user), set()).discard(sid)
            try:
                _CURRENT_HID.reset(_hid_token)
            except (ValueError, RuntimeError):  # failsoft-ok: a token from another context; the value dies with the task
                pass

    results = await asyncio.gather(*[_one(e) for e in prompts], return_exceptions=True)
    for r in results:
        if isinstance(r, BaseException):
            skipped += 1
            logger.info("[portraits] one portrait task raised: %s", r)


    # L17: before the run is declared complete, run the automated look-alike / mistake pass —
    # detect near-duplicate faces across the cast (from the structured, Vault-free prompt facets)
    # and regenerate the offenders with enforced variety, bounded by a retry cap. Best-effort:
    # any failure leaves the as-generated set intact. Skipped when nothing new generated.
    if generated and not silent:
        try:
            dedup = await dedupe_lookalikes(prompts, user)
            if dedup.get("regenerated"):
                logger.info("[portraits] L17 distinctness pass for %s: %s", _safe_user(user), dedup)
                # The regenerated faces are new shows too — record them as beats below. A dedupe
                # regen is a RE-generation, so its beat is engine-METERED (S8): mark it so the
                # burst's budget pre-check gates it and never over-fires into the per-turn cap.
                for hid in dedup.get("regeneratedIds", []):
                    newly_shown.append((str(hid), f"/api/orwell/portrait/{_safe_id(hid)}"))
                    reshoot_ids.add(_safe_id(str(hid)))
        except Exception as e:  # failsoft-ok: best-effort-enrichment (the L17 distinctness pass is a refinement; the as-generated cast portraits stand)
            logger.info("[portraits] L17 distinctness pass failed: %s", e)

    # ORW-480: the cast-level look: ONE vision call over a contact sheet of the whole cast (look-alike pairs, a prop / pose / room /
    # light shown too often); a flagged photo is re-shot once with the reason. Fail open, bounded, logged with its cost.
    if generated and not silent:
        try:
            look = await cast_look_pass(prompts, user)
            for hid in look.get("reshotIds", []):
                newly_shown.append((str(hid), f"/api/orwell/portrait/{_safe_id(hid)}"))
                reshoot_ids.add(_safe_id(str(hid)))
        except Exception as e:  # failsoft-ok: best-effort-enrichment (the cast-level look is a refinement; the shot cast stands)
            logger.info("[portraits] cast look failed: %s", e)

    if not silent:
        _progress_finish(user)  # L15: the run is done — the panel drops to the idle cadence
    if generated and not silent:  # only when a visible run landed a face (a silent upgrade already pushed per entry, ORW-437)
        _push_portrait_arrival(user)  # WS push edge: final reconcile (dedupe regens + completion)
    # M1-9: stamp the run's honest verdict (a 0-of-N run flips the panel/admin to "failing").
    if not silent:
        _note_last_run(user, generated=generated, skipped=skipped, total=len(prompts))

    if record_beats and newly_shown:
        await _record_image_beats(newly_shown, user, metered_ids=reshoot_ids)

    logger.info("[portraits] cast set for %s: generated=%d skipped=%d", _safe_user(user), generated, skipped)
    return {"generated": generated, "skipped": skipped, "total": len(prompts)}


# ── L17: the look-alike / mistake detection + regeneration pass ───────────────────────────────

# Tokens that carry no distinguishing signal (style anchor / framing / generic filler) — stripped
# before the feature comparison so a shared SEASON ANCHOR never reads as two people looking alike.
_PHYS_STOPWORDS = frozenset({
    "and", "a", "an", "the", "with", "of", "in", "on", "to", "very", "quite", "slightly",
    "photorealistic", "candid", "production", "still", "reality", "tv", "show", "series",
    "frame", "headshot", "portrait", "subject", "years", "old", "expression", "framing",
    "setting", "presentation", "style", "physical", "appearance", "looking", "natural",
    "skin", "texture", "house", "interior", "backdrop", "background", "blurred", "behind",
    "soft", "light", "lighting", "camera", "head", "shoulders", "chest", "up", "image",
})


def _physical_signature(prompt: str) -> frozenset:
    """The look-alike feature set for one portrait prompt: the distinguishing word tokens of its
    "Physical appearance:" clause (and the presentation style), lower-cased, stop-worded.

    The prompt is engine-built (portraitPrompts.ts) from the PUBLIC `physicalCharacteristics`
    facet, so this signature is Vault-free by construction. Returns the EMPTY set when the prompt
    has no structured physical clause: the prose fallback is too coarse for a reliable collision
    call (it would flag two pre-0058 prompts that merely share filler words), so the distinctness
    pass only ever acts on the structured signal it can trust — an empty signature never collides
    (see `_similarity`)."""
    text = str(prompt or "").lower()
    # The engine joins clauses with ". " and labels them — pull the physical + style clauses.
    chunks = []
    for label in ("physical appearance:", "presentation style:"):
        i = text.find(label)
        if i != -1:
            j = text.find(". ", i)
            chunks.append(text[i + len(label): j if j != -1 else len(text)])
    if not chunks:
        return frozenset()  # no structured clause ⇒ no trustworthy look-alike signal
    tokens = re.findall(r"[a-z]+", " ".join(chunks))
    return frozenset(t for t in tokens if len(t) > 2 and t not in _PHYS_STOPWORDS)


def _similarity(a: frozenset, b: frozenset) -> float:
    """Jaccard overlap of two feature sets (0..1). Empty-vs-anything is 0 (no signal, no claim)."""
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def find_lookalikes(prompts: list, threshold: float = LOOKALIKE_THRESHOLD) -> list:
    """The houseguest ids whose portrait reads as a look-alike of an EARLIER one (so each clashing
    pair contributes exactly ONE offender — the later id — to regenerate). Deterministic in the
    engine's prompt order. Pure: no I/O, no model — just the structured feature signatures.

    The player is never an offender (their own face is locked / chosen, not engine-varied)."""
    entries = []
    for entry in prompts or []:
        if not isinstance(entry, dict):
            continue
        hid = entry.get("houseguestId") or entry.get("id")
        prompt = entry.get("prompt")
        if not hid or not prompt or _safe_id(str(hid)) == PLAYER_PORTRAIT_ID:
            continue
        entries.append((str(hid), _physical_signature(prompt), entry))
    offenders = []
    for i in range(len(entries)):
        hid_i, sig_i, _ = entries[i]
        for j in range(i):
            _, sig_j, _ = entries[j]
            if _similarity(sig_i, sig_j) >= threshold:
                offenders.append(hid_i)  # the LATER one yields; the earlier keeps its face
                break
    return offenders


async def dedupe_lookalikes(prompts: list, user: Optional[str],
                            max_regens: int = LOOKALIKE_MAX_REGENS) -> dict:
    """L17: detect look-alike / mistaken faces across the cast and REGENERATE the offenders with
    enforced variety, bounded by `max_regens`. Returns ``{regenerated, regeneratedIds, offenders}``.

    Drives distinctness from the structured `physicalCharacteristics` portrait prompts (the
    deterministic, Vault-free signal). Best-effort: a regeneration that fails leaves the original
    face in place. Idempotent enough to repeat — a successful re-roll changes the on-disk image but
    not the prompt, so a second pass would re-flag the same pair only if the model ignored the
    variety directive (the retry cap bounds that)."""
    offenders = find_lookalikes(prompts, LOOKALIKE_THRESHOLD)
    if not offenders or not image_generation_available(user):
        return {"regenerated": 0, "regeneratedIds": [], "offenders": offenders}

    by_id = {}
    for entry in prompts or []:
        if isinstance(entry, dict):
            hid = entry.get("houseguestId") or entry.get("id")
            if hid:
                by_id[str(hid)] = entry

    regenerated_ids = []
    for hid in offenders:
        if len(regenerated_ids) >= max_regens:
            break  # the cap — a flaky model never re-rolls the whole cast in a loop
        entry = by_id.get(hid)
        if not entry:
            continue
        base_prompt = str(entry.get("prompt") or "")
        name = str(entry.get("name") or "")
        if not base_prompt:
            continue
        # Re-prompt with the variety directive injected up front so the model produces a face
        # that is clearly distinct from the REST of the cast. Feed the houseguest's CURRENT
        # portrait back as a reference image (img2img) so they stay the SAME person across the
        # re-roll — only when a prior portrait exists; first-generation is always text-to-image.
        # keep_identity=False so the standard "minimal alteration" prefix is NOT prepended (it
        # would fight the variety directive); the reference image carries the person, the
        # directive carries the differentiation. A provider with no img2img path degrades to
        # plain text-to-image inside _generate_one (best-effort, never a hard failure).
        ref_png = None
        try:
            existing = portrait_file(user, str(hid))
            if existing:
                ref_png = existing.read_bytes()
        except Exception:  # failsoft-ok: expected-empty (the current portrait is an OPTIONAL img2img reference; None ⇒ the variety regen still runs as text-to-image)
            ref_png = None
        _consume_gen_error(); _consume_gen_detail()
        t0 = time.monotonic()
        png = await _generate_one(_VARIETY_DIRECTIVE + base_prompt, user,
                                  reference_png=ref_png, keep_identity=False)
        duration_ms = int((time.monotonic() - t0) * 1000)
        if not png:
            log_attempt(str(hid), False, (_consume_gen_error() or "lookalike-regen-failed"),
                        duration_ms, detail=_consume_gen_detail())
            continue
        try:
            _write_portrait(user, str(hid), png, name, source="generated", provider=_peek_gen_provider())
            log_attempt(str(hid), True, None, duration_ms, provider=_peek_gen_provider())
            regenerated_ids.append(str(hid))
        except Exception as e:
            # #1599 (CodeRabbit finding b): a broken look-alike regen persist must show RED — the
            # original face stands, but the distinctness fix silently failing is exactly the fail-soft
            # #1599 bans (no upstream records this persist path, so no double-record).
            logger.info("[portraits] L17 regen persist failed for %s: %s", hid, e)
            _note_generation_failure(user, str(hid), f"lookalike-regen-persist-failed: {e}")
    return {"regenerated": len(regenerated_ids), "regeneratedIds": regenerated_ids, "offenders": offenders}


async def cast_look_pass(prompts: list, user: Optional[str]) -> dict:
    """ORW-480: look at the whole cast at once (one vision call over a contact sheet) and re-shoot, once each and at most
    `CAST_RESHOOT_MAX` photos, the ones it names (the later of two look-alikes; a prop, pose, room or light shown too often).
    A photo already re-shot (by its own check or by an earlier cast look) is never sent back; the player's own photo is never
    in the sheet. Each image's provider cost is logged when the provider returns one. Never raises; a skipped look changes nothing.
    Returns ``{checked, flagged, reshotIds, cost?}``."""
    out: dict = {"checked": 0, "flagged": {}, "reshotIds": []}
    try:
        from src import orwell_portrait_check as C
        manifest = load_manifest(user)
        ids, pngs, by_id = [], [], {}
        for entry in prompts or []:
            if not isinstance(entry, dict):
                continue
            hid = entry.get("houseguestId") or entry.get("id")
            if not hid or not entry.get("prompt") or _safe_id(str(hid)) == PLAYER_PORTRAIT_ID:
                continue
            stored = manifest.get(_safe_id(str(hid)))
            f = portrait_file(user, str(hid))
            if f is None or (isinstance(stored, dict) and stored.get("source") == "upload"):
                continue
            ids.append(str(hid)); pngs.append(f.read_bytes()); by_id[str(hid)] = (entry, stored)
        out["checked"] = len(ids)
        result = await C.check_cast(pngs, user)
        if result is None:
            return out
        if result.get("cost") is not None:
            log_attempt("cast-look", True, None, 0, cost=result["cost"])
        spared = {h for h, (_e, m) in by_id.items() if isinstance(m, dict) and (
            m.get("castLookReshot") or (isinstance(m.get("check"), dict) and m["check"].get("reshot")))}
        sends = C.cast_sends_back(result, ids, spared)
        out["flagged"] = dict(sends)
        logger.info("[portraits] cast look for %s: pairs=%s repeats=%s sent back=%s", _safe_user(user), result.get("pairs"),
                    [(r["kind"], r["numbers"]) for r in result.get("repeats", [])], list(sends))
        for hid, reason in sends.items():
            entry, stored = by_id[hid]
            prompt = str(entry.get("prompt") or "")
            fix = prompt + " Fix in this version: " + reason + "."
            _consume_gen_error(); _consume_gen_detail(); _consume_gen_cost()
            t0 = time.monotonic()
            token = _CURRENT_HID.set(hid)
            try:
                png2 = await _generate_one(fix, user)  # no reference image: the reference would carry the face being replaced
                if not png2:
                    log_attempt(hid, False, (_consume_gen_error() or "cast-look-reshoot-failed"), int((time.monotonic() - t0) * 1000),
                                detail=_consume_gen_detail(), cost=_consume_gen_cost())
                    continue
                facts = C.facts_from_prompt(prompt)
                second = await _check_after_reshoot(png2, facts, user)
                old = ((stored or {}).get("check") or {}) if isinstance(stored, dict) else {}
                if second is not None and not second["ok"] and len(second["problems"]) > len(old.get("problems") or []) and old.get("ok") is not False:
                    log_attempt(hid, True, None, int((time.monotonic() - t0) * 1000), check={"ok": False, "problems": second["problems"], "reshot": True},
                                cost=_consume_gen_cost())  # the new image is worse than the old one: the old one stays, the spend is logged
                    continue
                meta = {"ok": True if second is None else second["ok"], "problems": [] if second is None else second["problems"], "reshot": True}
                _write_portrait(user, hid, png2, str((stored or {}).get("name") or entry.get("name") or ""), source="generated",
                                fingerprint=_look_fingerprint({**entry, "prompt": prompt}), check=meta, cast_look_reshot=True, provider=_peek_gen_provider())
                log_attempt(hid, True, None, int((time.monotonic() - t0) * 1000), check=meta, cost=_consume_gen_cost(), provider=_peek_gen_provider())
                out["reshotIds"].append(hid)
            finally:
                try:
                    _CURRENT_HID.reset(token)
                except (ValueError, RuntimeError):  # failsoft-ok: a token from another context; the value dies with the task
                    pass
    except Exception as e:  # failsoft-ok: fail-open (the cast stands as shot)
        logger.info("[portraits] cast look skipped: %s", type(e).__name__)
    return out


async def _record_image_beats(shown: list, user: Optional[str],
                              metered_ids: Optional[set] = None) -> None:
    """Record each shown portrait as a player-witnessed beat (best-effort).

    L15: the beats are SPACED by IMAGE_BEAT_SPACING_S, not fired back-to-back. Each
    record_image_beat is an engine WRITE that enqueues into the per-user serial queue and pays
    the O(events) commit; firing ~16 in a tight loop starved the cast panel's getGameState polls
    (the panel blanked, the connection looked dropped). A small inter-beat yield lets the queue
    answer a poll between beats — the run stays responsive.

    S8 (RC8): a RE-generation of an already-portrayed houseguest is METERED by the engine against
    the per-turn image budget and REFUSED past the cap (`EngineRefusal`). `metered_ids` names the
    beats the engine will meter (facet-change re-shoots + L17 dedupe regens); a move-in first-shoot
    is exempt and always fires. Before firing a metered beat we consult the remaining per-turn
    budget and SKIP it — logging a RED-eligible 'image-budget-skip' (#1599) — rather than fire a
    call the engine will refuse. This stops the over-fire the RC8 bundle showed (3 extra straight
    into the cap, twice)."""
    from src import orwell_engine

    metered = {_safe_id(str(h)) for h in (metered_ids or set())}
    # A fresh burst gets the full per-turn metered budget; recomputed only when it's needed.
    remaining = _image_beat_budget_remaining(user) if metered else 0

    # De-dupe by id (the L17 pass can append an already-shown id) so a face is recorded once.
    seen: set = set()
    ordered = [(h, r) for h, r in shown if not (h in seen or seen.add(h))]
    fired = 0
    for hid, ref in ordered:
        is_metered = _safe_id(str(hid)) in metered
        if is_metered and remaining <= 0:
            # Budget spent for this burst — do NOT fire a metered beat the engine will refuse.
            # #1599: a prevented `EngineRefusal` is still a RED-eligible fault, never silent.
            _note_image_budget_skip(user, str(hid))
            continue
        if fired and IMAGE_BEAT_SPACING_S > 0:
            try:
                await asyncio.sleep(IMAGE_BEAT_SPACING_S)
            except Exception:  # pragma: no cover — failsoft-ok: expected-empty (beat-spacing sleep; the real beat call below logs)
                pass
        try:
            await orwell_engine.record_image_beat(hid, ref, user=user)
        except Exception as e:
            # #1599: a budget REFUSAL is pre-checked above (_note_image_budget_skip), so a raise here is
            # a genuine engine/transport fault — the portrait shows but its player-witnessed beat was lost.
            # Surface it RED (not the raw IO tap's generic row — a classified beat-loss anomaly).
            logger.info("[portraits] record_image_beat(%s) failed: %s", hid, e)
            try:
                from src import log_rings
                log_rings.record_soft_failure("portraits:image-beat-record-failed", e,
                                              corrected="portrait-shown-beat-skipped", user=user)
            except Exception:  # pragma: no cover — failsoft-ok: recorder-self
                pass
        else:
            if is_metered:
                # Only a beat the engine ACCEPTED consumes the metered budget (matches the engine,
                # which increments its per-turn tally only on an accepted recordImageBeat).
                remaining -= 1
        fired += 1


def kickoff_generation(prompts: list, user: Optional[str]) -> None:
    """Fire-and-forget the cast portrait generation so game start never blocks on images.

    Schedules `generate_and_store` on the running event loop when one exists (the normal
    async request path); if called with no loop it runs synchronously to completion. Either
    way it is best-effort and swallows failures.
    """
    if not prompts:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None:
        task = loop.create_task(generate_and_store(prompts, user))

        # Keep a reference so the task isn't GC'd mid-flight; log any unexpected error.
        def _done(t):
            try:
                t.result()
            except Exception as e:  # pragma: no cover - defensive
                # #1599 (CodeRabbit): the NORMAL async path — generate_and_store records each
                # per-houseguest failure, but a raise OUT of the task is a whole-run crash that would
                # otherwise only log. Surface it RED (same reason as the sync path; mutually exclusive).
                logger.info("[portraits] background generation error: %s", e)
                try:
                    from src import log_rings
                    log_rings.record_soft_failure("portraits:generation-run-failed", e,
                                                  corrected="placeholder-floor", user=user)
                except Exception:  # pragma: no cover — failsoft-ok: recorder-self
                    pass

        task.add_done_callback(_done)
    else:  # pragma: no cover - non-async callers (tests call generate_and_store directly)
        try:
            __import__("src.llm_core", fromlist=["run_isolated"]).run_isolated(generate_and_store(prompts, user))
        except Exception as e:
            # #1599: generate_and_store records each per-houseguest failure itself; a raise OUT of it is
            # a whole-run crash that would otherwise leave the cast on placeholders silently — RED.
            logger.info("[portraits] sync generation error: %s", e)
            try:
                from src import log_rings
                log_rings.record_soft_failure("portraits:generation-run-failed", e,
                                              corrected="placeholder-floor", user=user)
            except Exception:  # pragma: no cover — failsoft-ok: recorder-self
                pass


# ── G9 backfill: portraits for seasons that predate 0051 (or whose generation failed) ─────
# Portrait generation originally kicked off ONLY from the createCharacter response, so any
# season created before 0051 merged (or before an image provider was configured) showed
# placeholders forever. The backfill closes that: when the roster is served (or the manual
# "Generate cast portraits" lever is pulled) and portraits are missing for active houseguests,
# fetch each missing houseguest's Vault-free prompt via the engine's live `getPortraitPrompt`
# player-channel tool and run it through the SAME generate+persist pipeline. No engine change.


def _is_player_card(card: dict) -> bool:
    """Is this roster card the player's? (isPlayer when the roster derivation set it, else the id.)"""
    return bool(card.get("isPlayer")) or _safe_id(str(card.get("id") or "")) == PLAYER_PORTRAIT_ID


def missing_portrait_ids(user: Optional[str], roster_cards: list) -> list:
    """Active PROMPT-SHOOTABLE houseguests (NPCs — never the player) with no stored portrait.

    THE one definition of "missing" — the roster's lazy backfill, the manual lever, the
    G20 reconciler, and the completeness counters all derive from this helper.

    Bundle-audit fix (2026-07-13): the PLAYER is exempt. Their face comes from the
    upload/casting-studio path (0050/G26/G27) — the engine emits NO portrait prompt for the
    player by design (#529: the human authors no look, so `getPortraitPrompt('player')` is
    null), so a prompt-shoot seam chasing the player can only ever burn attempts on a
    `no-prompt` loop (11× logged in the 2026-07-13 prod bundle). `player_awaiting_upload`
    tracks them separately; a stored player portrait still serves like any other."""
    note_user_seen(user)  # G20: a missing-set read enrolls this user in the reconciler sweep
    out = []
    for card in roster_cards or []:
        if not isinstance(card, dict):
            continue
        if (card.get("status") or "active") != "active":
            continue  # departed houseguests keep their placeholder — no late generation
        if _is_player_card(card):
            continue  # the player is never a prompt-shoot candidate (see docstring)
        hid = card.get("id")
        if hid and portrait_file(user, hid) is None:
            out.append(str(hid))
    return out


def player_awaiting_upload(user: Optional[str], roster_cards: list) -> bool:
    """True when the ACTIVE player has no stored portrait — i.e. their headshot upload / casting-
    studio pick (0050/G26/G27) hasn't landed. The player's separate track out of the prompt-shoot
    "missing" set (bundle-audit fix 2026-07-13): surfaces on the completeness payload so the
    operator/panel can say "upload your photo" instead of counting an eternally-missing portrait."""
    for card in roster_cards or []:
        if not isinstance(card, dict) or not _is_player_card(card):
            continue
        if (card.get("status") or "active") != "active":
            return False
        hid = card.get("id")
        return bool(hid) and portrait_file(user, hid) is None
    return False


def completeness(user: Optional[str], roster_cards: list) -> dict:
    """{total, present, missing, playerAwaitingUpload} over the ACTIVE cast — G20 visibility.

    `missing` comes straight from `missing_portrait_ids` (the one definition), so the
    Health card, the /admin/status page, and the roster counter can never disagree with
    what the backfill/reconciler would actually act on. The counters cover the
    PROMPT-SHOOTABLE cast (the NPCs); the player — whose face is uploaded/chosen, never
    prompt-shot — rides the separate `playerAwaitingUpload` flag instead of standing as
    an eternal "missing 1" (the 2026-07-13 bundle finding)."""
    active = [c for c in roster_cards or []
              if isinstance(c, dict) and (c.get("status") or "active") == "active" and c.get("id")
              and not _is_player_card(c)]
    missing = missing_portrait_ids(user, roster_cards)
    return {"total": len(active), "present": len(active) - len(missing), "missing": len(missing),
            "playerAwaitingUpload": player_awaiting_upload(user, roster_cards)}


async def portrait_completeness(user: Optional[str]) -> Optional[dict]:
    """{total, present, missing} for this user's active cast, or None pre-game/engine-down.

    Fetches the same Vault-free public projection the roster route serves and derives the
    cards with the SAME helper (`routes.orwell_routes._roster_cards`, imported lazily —
    routes import this module at load, so the cycle only resolves at call time). Used by
    the admin health surfaces (G20); best-effort — any failure reads as None, never a 500."""
    from src import orwell_engine

    try:
        state = await orwell_engine.get_game_state(user=user)
    except Exception:  # failsoft-ok: expected-empty (pre-game / engine-down ⇒ no completeness; also IO-recorded)
        return None
    if not isinstance(state, dict) or state.get("started") is False:
        return None
    try:
        from routes.orwell_routes import _roster_cards  # the one roster-card derivation (G9)
        return completeness(user, _roster_cards(state, user))
    except Exception:
        return None


def backfill_allowed(user: Optional[str]) -> bool:
    """True when this user's process-local backfill debounce window has elapsed."""
    last = _LAST_BACKFILL_AT.get(_safe_user(user))
    return last is None or (time.time() - last) >= BACKFILL_DEBOUNCE_S


async def adr0013_allowed_ids(ids: list, user: Optional[str]) -> list:
    """ADR 0013 filter for the lazy generation seams: the subset of `ids` whose faces may shoot NOW.

    When a real authoring model resolves (the #1313 house-entry gate would be ON), an ACTIVE NPC's
    face may only shoot once its deep profile is AUTHORED — the engine's Vault-free per-card
    `authored` flag is the truth. Held ids are NOT dropped forever: the per-NPC authored re-shoot
    (`kickoff_authored_reshoot`, fired from every authoring write-back seam) shoots them the moment
    authoring lands, and the roster backfill / reconciler retry on their own cadence.

    Fail-open by design (mirrors `house_entry_gate_active`'s own fail-soft posture): no model /
    gate-check trouble / state-read trouble ⇒ everything passes (the deterministic floor is then
    the final cast, so a floor face can never mismatch a later authored one). PRE-GAME (started is
    False) everything passes too — the only pre-game callers are the per-NPC authored-shoot paths,
    which fire only after that houseguest's write-back landed (the warm gates own ADR 0013 there).
    The PLAYER is never authoring-gated (their face is chosen/human-owned, not model-authored)."""
    ids = [str(h) for h in (ids or [])]
    if not ids:
        return ids
    try:
        from src import orwell_cast_authoring
        gate_on = await orwell_cast_authoring.house_entry_gate_active(user)
    except Exception:  # failsoft-ok: expected-empty (fail-open gate — a gate-check hiccup passes every id through; the ADR 0013 floor is then the final cast, never a mismatch)
        gate_on = False
    if not gate_on:
        return ids
    from src import orwell_engine
    try:
        state = await orwell_engine.get_game_state(user=user)
    except Exception:  # failsoft-ok: expected-empty (the filter is itself fail-open; unknown state ⇒ keep ids)
        return ids
    if not isinstance(state, dict) or state.get("started") is False:
        return ids
    authored = {}
    for hg in state.get("house") or []:
        if isinstance(hg, dict) and hg.get("id"):
            authored[str(hg["id"])] = hg.get("authored") is True
    out, held = [], []
    for hid in ids:
        if _safe_id(hid) == PLAYER_PORTRAIT_ID or hid not in authored or authored[hid]:
            out.append(hid)
        else:
            held.append(hid)
    if held:
        logger.info("[portraits] ADR 0013: holding %d un-authored face(s) for %s until authoring "
                    "lands: %s", len(held), _safe_user(user), held)
    return out


def kickoff_authored_reshoot(hid, user: Optional[str]) -> bool:
    """ADR 0013 — the per-NPC "authoring just landed" (re)shoot; returns True when a run was kicked.

    Fired from every authoring write-back seam (the prewarm portrait warm's per-NPC gate, the
    roster-driven / manual deep-authoring backfill). Two cases, one helper:
      • no face on disk ⇒ plain backfill — the FIRST shoot, from the now-authored prompt (fetched
        live via `getPortraitPrompt`, which pre-game serves the warmed pre-seed store);
      • a face on disk whose stored prompt FINGERPRINT differs from the current (authored) prompt ⇒
        the face was shot from a PRE-authoring identity the player was never given — it is
        DISCARDED first (fresh first-shoot semantics: the wrong face must never ride along as an
        img2img identity-carry reference), then regenerated from the authored prompt.
    A face whose fingerprint MATCHES the current prompt is left alone (generate-once holds — the
    backfill's own idempotency skips it). The player's literal uploaded photo is never touched
    (`discard_portraits` locks `source == "upload"`). Best-effort/fail-soft throughout."""
    if not hid:
        return False

    async def _heal():
        try:
            sid = _safe_id(str(hid))
            entry = load_manifest(user).get(sid)
            if (isinstance(entry, dict) and entry.get("source") != "upload"
                    and entry.get("fingerprint") and portrait_file(user, str(hid)) is not None):
                from src import orwell_engine
                try:
                    p = await orwell_engine.get_portrait_prompt(str(hid), user=user)
                except Exception:  # failsoft-ok: handled-by-terminal (orwell_engine._call already recorded record_io(ok=False) RED; this is only a staleness probe — None skips the discard optimization, backfill_missing below re-fetches)
                    p = None
                cur_fp = _look_fingerprint(p)
                if cur_fp and _wording_only_stale(entry):
                    _rebaseline_fingerprint(user, hid, cur_fp)      # ORW-480: a legacy face is re-baselined quietly on its first sweep
                elif cur_fp and _fingerprint_not_comparable(entry):
                    pass  # ORW-361: older prompt wording, never a fingerprint re-shoot (ORW-369 upgrades it)
                elif cur_fp and entry.get("fingerprint") != cur_fp:
                    logger.info("[portraits] ADR 0013: %s's stored face predates its authored "
                                "identity — discarding and re-shooting from the authored prompt", sid)
                    discard_portraits(user, [str(hid)])
            await backfill_missing([str(hid)], user)
        except Exception as e:  # pragma: no cover - defensive
            # #1599: backfill_missing records per-houseguest generation failures, but a raise BEFORE it
            # (e.g. discard_portraits) crashes the authored re-shoot with no record — surface it RED.
            logger.info("[portraits] authored re-shoot for %s failed: %s", hid, e)
            _note_generation_failure(user, str(hid), f"authored-reshoot-failed: {e}")

    # Stamp the lazy-path debounce like the other explicit kicks so an auto-poll seconds later
    # can't pile a second run onto the same provider.
    _LAST_BACKFILL_AT[_safe_user(user)] = time.time()
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None:
        task = loop.create_task(_heal())

        def _done(t):
            try:
                t.result()
            except Exception as e:  # pragma: no cover - defensive
                logger.info("[portraits] background authored re-shoot error: %s", e)

        task.add_done_callback(_done)
    else:  # non-async callers (tests drive the heal via the loop)
        try:
            __import__("src.llm_core", fromlist=["run_isolated"]).run_isolated(_heal())
        except Exception as e:
            logger.info("[portraits] sync authored re-shoot error: %s", e)
    return True


async def backfill_missing(missing_ids: list, user: Optional[str]) -> dict:
    """Fetch each missing houseguest's prompt from the engine and generate + persist it.

    Best-effort throughout (never raises): a houseguest whose prompt can't be fetched is
    logged to the attempt ring and skipped; the rest still generate. Reuses the standard
    `generate_and_store` pipeline (idempotent, beat-recording, availability-gated).

    ADR 0013 (2026-07-13): this is the ONE funnel every lazy seam routes through, so the
    authoring gate lives here — an un-authored ACTIVE NPC's id is held (not shot) while a real
    authoring model resolves; the authored re-shoot picks it up the moment its write-back lands.

    Bundle-audit fix (2026-07-13): the PLAYER id is never prompt-fetched — the engine emits no
    portrait prompt for the player by design (#529; their face is the upload/casting-studio path),
    so fetching could only log a `no-prompt` failure. A player id passed explicitly rides through
    as a PROMPT-LESS entry instead, so `generate_and_store`'s chosen-headshot pre-pass can still
    apply an available upload/avatar (silent no-op when none exists — zero provider calls). And a
    genuine NPC `no-prompt` is logged ONCE per houseguest, then quiesced until the engine state
    changes (a prompt appears / the slot is discarded/scrubbed) — never a per-sweep spam loop."""
    # CI/operator image-spend kill-switch (defense in depth): skip the whole funnel — no engine
    # prompt fetch, no generation — before any work when the env off switch is set.
    if image_gen_disabled():
        n = len(missing_ids or [])
        return {"generated": 0, "skipped": n, "total": n}
    from src import orwell_engine

    try:
        missing_ids = await adr0013_allowed_ids(missing_ids, user)
    except Exception as e:  # pragma: no cover - defensive; failsoft-ok: expected-empty (the ADR 0013 filter is fail-open — a filter hiccup proceeds unfiltered, never blocks a shoot)
        logger.info("[portraits] ADR 0013 filter failed (proceeding unfiltered): %s", e)

    safe = _safe_user(user)
    prompts = []
    for hid in missing_ids or []:
        if _safe_id(str(hid)) == PLAYER_PORTRAIT_ID:
            # The player: no engine prompt exists by design — ride a prompt-less entry so the
            # pre-pass can apply a chosen headshot; never a fetch, never a no-prompt log.
            prompts.append({"houseguestId": str(hid), "name": ""})
            continue
        try:
            p = await orwell_engine.get_portrait_prompt(str(hid), user=user)
        except Exception as e:  # failsoft-ok: handled-by-terminal (orwell_engine._call already recorded record_io(ok=False) RED for the failed getPortraitPrompt; also logged to the attempt ring — no double-record)
            logger.info("[portraits] backfill prompt fetch failed for %s: %s", hid, e)
            log_attempt(str(hid), False, "prompt-fetch-failed", 0)
            continue
        if isinstance(p, dict) and p.get("prompt"):
            # State changed for the better — re-arm the once-only no-prompt log for this slot.
            _NO_PROMPT_LOGGED.get(safe, set()).discard(_safe_id(str(hid)))
            prompts.append({
                "houseguestId": p.get("houseguestId") or str(hid),
                "name": p.get("name") or "",
                "prompt": p.get("prompt"),
                **({"lookKey": p["lookKey"]} if isinstance(p.get("lookKey"), str) else {}),
            })
        else:
            logged = _NO_PROMPT_LOGGED.setdefault(safe, set())
            if _safe_id(str(hid)) not in logged:
                logged.add(_safe_id(str(hid)))
                log_attempt(str(hid), False, "no-prompt", 0)
    if not prompts:
        return {"generated": 0, "skipped": 0, "total": 0}
    summary = await generate_and_store(prompts, user)
    logger.info("[portraits] backfill for %s: %s", _safe_user(user), summary)
    return summary


def kickoff_backfill(missing_ids: list, user: Optional[str], force: bool = False) -> bool:
    """Fire-and-forget backfill; returns True when a run was actually kicked.

    The AUTOMATIC roster-poll path is debounced (at most one attempt per user per process per
    BACKFILL_DEBOUNCE_S — a failing provider is never hammered). `force=True` is the EXPLICIT
    manual lever ("Generate cast portraits"): a deliberate click means "run now", so it
    bypasses the debounce window — but still STAMPS it, so an auto-poll seconds later can't
    pile on. Never blocks the caller: scheduled on the running loop like `kickoff_generation`."""
    if not missing_ids:
        return False
    if not force and not backfill_allowed(user):
        return False
    _LAST_BACKFILL_AT[_safe_user(user)] = time.time()

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None:
        task = loop.create_task(backfill_missing(list(missing_ids), user))

        def _done(t):
            try:
                t.result()
            except Exception as e:  # pragma: no cover - defensive
                # #1599 (CodeRabbit): the NORMAL async path — backfill_missing records per-houseguest
                # failures, but a raise OUT of the task is a whole-run crash that would otherwise only
                # log. Surface it RED (same reason as the sync path; mutually exclusive).
                logger.info("[portraits] background backfill error: %s", e)
                try:
                    from src import log_rings
                    log_rings.record_soft_failure("portraits:backfill-run-failed", e,
                                                  corrected="placeholder-floor", user=user)
                except Exception:  # pragma: no cover — failsoft-ok: recorder-self
                    pass

        task.add_done_callback(_done)
    else:  # non-async callers (tests drive backfill_missing directly)
        try:
            __import__("src.llm_core", fromlist=["run_isolated"]).run_isolated(backfill_missing(list(missing_ids), user))
        except Exception as e:
            # #1599: backfill_missing records per-houseguest failures itself; a raise OUT of it is a
            # whole-run crash that would silently leave portraits missing — surface it RED.
            logger.info("[portraits] sync backfill error: %s", e)
            try:
                from src import log_rings
                log_rings.record_soft_failure("portraits:backfill-run-failed", e,
                                              corrected="placeholder-floor", user=user)
            except Exception:  # pragma: no cover — failsoft-ok: recorder-self
                pass
    return True


async def _apply_player_headshot_if_available(user: Optional[str], cards: list) -> int:
    """Bundle-audit fix (2026-07-13): the player's ONE self-heal — apply an already-CHOSEN headshot
    (finalized studio pick / 'exact' upload / persisted account avatar) when the player portrait
    file is missing. Returns 1 when a portrait landed, else 0.

    The player is exempt from every prompt-shoot seam (no engine prompt exists for them, #529), so
    this is deliberately NOT a generation path: it rides a PROMPT-LESS entry through
    `generate_and_store`, whose G26/G27 pre-pass owns the chosen-source priority and writes the
    locked 'upload' portrait. No chosen source ⇒ silent no-op, zero provider calls, zero log spam —
    the awaiting state stays visible as `playerAwaitingUpload` on the completeness payload."""
    for card in cards or []:
        if not isinstance(card, dict) or not _is_player_card(card):
            continue
        if (card.get("status") or "active") != "active":
            return 0
        hid = str(card.get("id") or PLAYER_PORTRAIT_ID)
        if portrait_file(user, hid) is not None:
            return 0  # already on disk — nothing owed
        # Only proceed when a CHOSEN source actually exists (the same priority the pre-pass
        # applies: finalized studio pick → 'exact' upload → account avatar) — so the no-upload
        # sweep is a TRUE no-op: no generate_and_store call, no per-cycle log (the A9 lesson).
        intake = load_player_intake(user)
        has_chosen = (
            _intake_final_path(user).exists()
            or bool(intake and intake.get("mode") == "exact" and _read_intake_source(user))
            or user_avatar_path(user) is not None
        )
        if not has_chosen:
            return 0
        summary = await generate_and_store(
            [{"houseguestId": hid, "name": str(card.get("name") or "")}], user)
        return int(summary.get("generated") or 0)
    return 0


# ── G20: the portrait reconciler (the autonomous verify-and-retry loop) ───────────────────


def _load_reconcile_state() -> dict:
    """The persisted budget sidecar: {safeUser: {safeId: {attempts, cooldown}}}."""
    try:
        with open(RECONCILE_STATE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {}


def _save_reconcile_state(state: dict) -> None:
    """Best-effort atomic write (mirrors the attempt log) — never breaks a sweep."""
    try:
        RECONCILE_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = RECONCILE_STATE_PATH.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)
        os.replace(tmp, RECONCILE_STATE_PATH)
    except Exception as e:  # pragma: no cover - defensive
        logger.info("[portraits] reconcile-state write failed: %s", e)


def _clear_counters(safe_user: str) -> None:
    """Drop one user's budget counters (fresh provider / complete set / new season)."""
    sidecar = _load_reconcile_state()
    if safe_user in sidecar:
        sidecar.pop(safe_user, None)
        _save_reconcile_state(sidecar)


def reconcile_budget(user: Optional[str]) -> dict:
    """The G20 per-houseguest retry-budget counters for this user — ``{safeId: {attempts,
    cooldown}}`` (admin/debug-bundle visibility). Vault-free: ids + counts only; a
    missing/corrupt sidecar reads as an empty budget, never an error."""
    return _user_counters(_load_reconcile_state(), _safe_user(user))


def _user_counters(sidecar: dict, safe_user: str) -> dict:
    """One user's counters from the sidecar, shape-normalized (a tampered/corrupt file
    must degrade to a fresh budget, never crash the sweep)."""
    raw = sidecar.get(safe_user)
    out: dict = {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            if isinstance(v, dict):
                try:
                    out[str(k)] = {"attempts": int(v.get("attempts") or 0),
                                   "cooldown": int(v.get("cooldown") or 0)}
                except (TypeError, ValueError):
                    continue
    return out


async def _reconcile_user(user: Optional[str]) -> Optional[dict]:
    """One user's verify-and-retry pass: {missing, attempted}, or None when idling.

    The gates, cheapest first:
      (a) an active game exists — engine state, fail-open (engine trouble = idle quietly);
      (b) a provider is usable — ABSENCE idles and never consumes the retry budget; the
          absent→present transition resets every counter (a fresh provider = a fresh budget,
          because the burned attempts belonged to the old/missing one);
      (c) missing = the roster route's own card derivation + `missing_portrait_ids` (the
          shared helpers — never a second definition of "missing");
      (d) the per-houseguest budget picks the eligible subset: after failed attempt n a
          houseguest cools down ~2^n cycles; RECONCILE_MAX_ATTEMPTS real failures and the
          reconciler stands down for it (the lazy roster backfill + manual lever remain);
      (e) eligible ids retry THROUGH the standard pipeline (`backfill_missing`). Debounce
          coordination is deliberate: the reconciler BYPASSES the lazy-path window *read*
          — its per-houseguest budget is stricter and cycle-timed, and aliasing the 10-min
          blanket window against the 5-min cycle would make backoff timing arbitrary — but
          it WRITES the stamp, so a roster poll seconds after a reconciler attempt cannot
          immediately re-hammer the same failing provider;
      (f) outcomes: a landed portrait clears its counter (success resets); only a real
          failed attempt consumes budget.

    Logs TRANSITIONS only — started / complete / gave-up-per-budget / provider-appeared —
    never a line per idle cycle (the A9 lesson)."""
    from src import orwell_engine

    safe = _safe_user(user)

    # (a) an active game — cheap and fail-open.
    try:
        state = await orwell_engine.get_game_state(user=user)
    except Exception:  # failsoft-ok: expected-empty (engine-down ⇒ idle this cycle; also IO-recorded)
        return None
    if not isinstance(state, dict) or state.get("started") is False:
        return None

    # (a2) Bundle-audit fix (2026-07-13): the PLAYER is exempt from the prompt-shoot loop (the
    # engine emits no prompt for them by design — #529; their face is the upload/casting-studio
    # path), so `missing` below never contains them. The one thing the reconciler still owes the
    # player: if a CHOSEN headshot already exists (the finalized studio pick / an 'exact' upload /
    # the persisted account avatar) but the portrait file is gone (a crashed initial run), APPLY
    # it — `generate_and_store`'s pre-pass owns the priority, costs ZERO provider calls (so it
    # deliberately rides BEFORE the provider gate), and is a silent no-op when nothing is chosen
    # (the "please upload" state rides `playerAwaitingUpload` on the completeness payload).
    from routes.orwell_routes import _roster_cards  # lazy: routes import this module at load

    cards = _roster_cards(state, user)
    try:
        await _apply_player_headshot_if_available(user, cards)
    except Exception:  # pragma: no cover - defensive; failsoft-ok: best-effort-enrichment (player-headshot self-heal; the reconcile sweep continues and retries it next cycle, the existing portrait set stands)
        logger.debug("[portraits] player headshot apply failed (best-effort)", exc_info=True)

    # (b) the provider gate — absence idles WITHOUT consuming the budget.
    try:
        available = bool(image_generation_available(user))
    except Exception:  # failsoft-ok: expected-empty (an image-provider CAPABILITY probe; a probe hiccup ⇒ treat as unavailable and idle this cycle, never burning the retry budget)
        available = False
    was_available = _PROVIDER_SEEN.get(safe)
    _PROVIDER_SEEN[safe] = available
    if not available:
        return None
    if was_available is False:
        _clear_counters(safe)
        logger.info("[portraits] reconciler: image provider available for %s — retry budget reset", safe)

    # (c) what's missing — the SAME derivation the roster route serves (the cards from (a2)).

    # (c2) ADR 0013 staleness self-heal (2026-07-13): a face ON DISK that was shot BEFORE its
    # subject's authored identity landed (or before a portrait-prompt upgrade) re-shoots from the
    # CURRENT authored prompt — discarded first (never carried as an img2img reference), capped at
    # STALE_RESHOOT_PER_SWEEP per sweep so an existing game heals without flooding the provider.
    healed = 0
    try:
        healed = await _heal_stale_authored_faces(user, cards)
    except Exception as e:  # pragma: no cover - defensive; failsoft-ok: best-effort-enrichment (ADR 0013 staleness heal; the reconcile sweep continues and re-heals next sweep, the on-disk faces stand)
        logger.info("[portraits] staleness heal for %s failed: %s", safe, e)

    missing = missing_portrait_ids(user, cards)
    # ADR 0013: an un-authored ACTIVE NPC may not shoot while an authoring model resolves — hold
    # those out of the retry set entirely (their budget must not burn on faces that must WAIT; the
    # authored re-shoot owns them the moment their write-back lands).
    try:
        missing = await adr0013_allowed_ids(missing, user)
    except Exception:  # pragma: no cover — failsoft-ok: expected-empty (the filter is itself fail-open)
        pass
    prev_missing = _LAST_MISSING.get(safe)
    _LAST_MISSING[safe] = len(missing)
    if not missing:
        if prev_missing:
            done = completeness(user, cards)
            logger.info("[portraits] reconciler: portrait set complete for %s (%d/%d)",
                        safe, done["present"], done["total"])
        _clear_counters(safe)  # nothing to track when nothing is missing
        return {"missing": 0, "attempted": 0, "healed": healed}
    if not prev_missing:
        logger.info("[portraits] reconciler: %d portrait(s) missing for %s — verify-and-retry engaged",
                    len(missing), safe)

    # (d) the budget/backoff filter.
    sidecar = _load_reconcile_state()
    counters = _user_counters(sidecar, safe)
    live_ids = {_safe_id(h) for h in missing}
    counters = {k: v for k, v in counters.items() if k in live_ids}  # landed/departed: tidy
    eligible = []
    for hid in missing:
        sid = _safe_id(hid)
        entry = counters.get(sid) or {"attempts": 0, "cooldown": 0}
        if entry["attempts"] >= RECONCILE_MAX_ATTEMPTS:
            continue  # budget spent — the lazy/manual paths own this one now
        if entry["cooldown"] > 0:
            counters[sid] = {"attempts": entry["attempts"], "cooldown": entry["cooldown"] - 1}
            continue
        eligible.append(hid)
    if not eligible:
        sidecar[safe] = counters
        _save_reconcile_state(sidecar)
        return {"missing": len(missing), "attempted": 0, "healed": healed}

    # (e) retry through the standard pipeline; stamp the lazy-path debounce (see docstring).
    _LAST_BACKFILL_AT[safe] = time.time()
    await backfill_missing(list(eligible), user)

    # (f) outcomes — success resets; a genuine per-CONTENT failure consumes one budget unit; a
    # TRANSIENT/environmental failure (402 credits, 429, 5xx, transport) does NOT burn the
    # permanent budget — it only cools the slot one cycle and stays ELIGIBLE, so once the operator
    # adds credits / the provider recovers the next sweep retries it (bounded to one attempt per
    # sweep, never a tight hammer loop) instead of the cast staying permanently given-up.
    for hid in eligible:
        sid = _safe_id(hid)
        if portrait_file(user, hid) is not None:
            counters.pop(sid, None)
            continue
        prev = counters.get(sid) or {"attempts": 0}
        if _is_transient_gen_error(last_gen_error_class(user, hid)):
            # Re-arm: keep the attempt count, apply a one-cycle cooldown, never approach the cap.
            counters[sid] = {"attempts": int(prev.get("attempts", 0)),
                             "cooldown": RECONCILE_TRANSIENT_COOLDOWN}
            continue
        attempts = int(prev.get("attempts", 0)) + 1
        counters[sid] = {"attempts": attempts, "cooldown": 2 ** attempts}
        if attempts == RECONCILE_MAX_ATTEMPTS:
            logger.info("[portraits] reconciler: gave up on %s for %s after %d failed attempts — "
                        "the roster backfill and the manual lever still work", sid, safe, attempts)
    sidecar[safe] = counters
    _save_reconcile_state(sidecar)
    return {"missing": len(missing), "attempted": len(eligible), "healed": healed}


async def _heal_stale_authored_faces(user: Optional[str], cards: list) -> int:
    """The ADR 0013 staleness pass (2026-07-13): re-shoot faces that PREDATE their subject's
    current identity. Returns how many faces were re-shot this sweep (≤ STALE_RESHOOT_PER_SWEEP).

    THREE staleness classes, healed in PRIORITY order (bundle-audit fix 2026-07-13 — wrong person
    beats wrong DNA beats wrong wardrobe; the prod bundle had a dead pre-reset cast's face queued
    BEHIND fingerprint re-shoots):
      1. NAME MISMATCH (wrong person): the manifest entry's NAME differs from the current cast's
         name at the same slot — a face from a DEAD cast still on disk (a reset whose portrait
         scrub was skipped). Detected locally (manifest × cards, no engine read), authored or not
         (a wrong person is categorically wrong), every sweep.
      2. WRONG-IDENTITY DNA: an authored subject's face with `source: "reference"` and NO
         `refClean` provenance stamp — a legacy img2img re-shoot that may have carried a
         pre-authoring wrong face as its identity reference (the bundle's npc:8–14, re-shot
         pre-#1559 off the old wrong face). Also local; post-heal writes are stamped, so each
         face is flagged at most once.
      3. FINGERPRINT drift (wrong wardrobe/composition): the 0065 prompt-hash comparison — the
         stored face was shot from an older prompt (the pre-authoring floor, or an older prompt
         composition). Needs one engine prompt-read per authored face, so it stays gated behind
         the per-user WATERMARK (`_STALE_AUTHORED_SEEN` — re-checked only when the authored count
         moves / on the first sweep of a process, and re-armed while stale faces remain). A legacy
         entry with NO fingerprint is left alone (the quiet-backfill policy).

    Cost stays bounded by the per-sweep re-shoot cap (STALE_RESHOOT_PER_SWEEP — mirrors the
    engine's IMAGE_BUDGET.perTurnCap, so a full-cast heal spreads over a few sweeps instead of
    flooding the provider). Stale faces are DISCARDED before regeneration (fresh first-shoot
    semantics — the wrong face must never carry as an img2img identity reference)."""
    from src import orwell_engine

    safe = _safe_user(user)
    manifest = load_manifest(user)
    wrong_person: list = []   # class 1 — heals first
    wrong_dna: list = []      # class 2
    fp_candidates: list = []  # class 3 (engine-read gated below)
    authored_count = 0
    for card in cards or []:
        if not isinstance(card, dict):
            continue
        if (card.get("status") or "active") != "active":
            continue
        hid = card.get("id")
        if not hid or card.get("isPlayer") or _safe_id(str(hid)) == PLAYER_PORTRAIT_ID:
            continue
        authored = card.get("authored") is True
        if authored:
            authored_count += 1
        entry = manifest.get(_safe_id(str(hid)))
        if not isinstance(entry, dict) or entry.get("source") == "upload":
            continue
        if portrait_file(user, str(hid)) is None:
            continue
        # Class 1 — wrong person (name mismatch), authored or not: the face belongs to a dead cast.
        stored_name = str(entry.get("name") or "").strip().casefold()
        card_name = str(card.get("name") or "").strip().casefold()
        if stored_name and card_name and stored_name != card_name:
            wrong_person.append(str(hid))
            continue
        if not authored:
            continue  # classes 2–3 judge against the AUTHORED identity only
        # Class 2 — wrong-identity DNA: an unstamped legacy reference carry.
        if entry.get("source") == "reference" and entry.get("refClean") is not True:
            wrong_dna.append(str(hid))
            continue
        # Class 3 — fingerprint drift (verified against the engine's current prompt below).
        if entry.get("fingerprint"):
            fp_candidates.append((str(hid), entry["fingerprint"]))
    stale = wrong_person + wrong_dna
    # Class 3 runs only when the watermark moved (the per-face engine prompt-read is the cost).
    if fp_candidates and _STALE_AUTHORED_SEEN.get(safe) != authored_count:
        fp_stale = []
        engine_ok = True
        manifest_now = load_manifest(user)
        for hid, stored_fp in fp_candidates:
            try:
                p = await orwell_engine.get_portrait_prompt(hid, user=user)
            except Exception:  # failsoft-ok: handled-by-terminal (orwell_engine._call already recorded record_io(ok=False) RED; the staleness verify simply defers — verify nothing this sweep, retry next)
                engine_ok = False  # engine trouble — verify nothing this sweep, try again next
                break
            cur_fp = _look_fingerprint(p)
            if cur_fp and _wording_only_stale(manifest_now.get(_safe_id(str(hid)))):
                _rebaseline_fingerprint(user, hid, cur_fp)          # ORW-480: re-baselined quietly, compared from the next sweep on
                continue
            if cur_fp and _fingerprint_not_comparable(manifest_now.get(_safe_id(str(hid)))):
                continue  # ORW-361: older prompt wording, never a fingerprint re-shoot
            if cur_fp and cur_fp != stored_fp:
                fp_stale.append(hid)
        if engine_ok:
            if not fp_stale and not stale:
                _STALE_AUTHORED_SEEN[safe] = authored_count  # everything verified clean
            stale += fp_stale
    elif not fp_candidates and not stale:
        _STALE_AUTHORED_SEEN[safe] = authored_count
    if not stale:
        return 0
    batch = stale[:STALE_RESHOOT_PER_SWEEP]
    logger.info("[portraits] ADR 0013 staleness: %d face(s) predate their current identity for %s "
                "(wrong-person=%d, wrong-dna=%d) — re-shooting %d this sweep: %s",
                len(stale), safe, len(wrong_person), len(wrong_dna), len(batch), batch)
    discard_portraits(user, batch)
    await backfill_missing(batch, user)
    # Deliberately NOT stamping the watermark while stale faces remain — the next sweep continues
    # the heal (and re-verifies the just-shot batch, whose fingerprints now match).
    return len(batch)


async def reconcile_once() -> dict:
    """One sweep over every user seen this process: {safeUser: result-or-None}.

    Exposed for tests; the loop calls it on the interval. One user's trouble never
    starves another's pass (per-user isolation, like every other portrait surface)."""
    results: dict = {}
    for safe, raw in list(_SEEN_USERS.items()):
        try:
            results[safe] = await _reconcile_user(raw)
        except Exception as e:  # failsoft-ok: best-effort-enrichment (per-user reconcile isolation — a user's sweep crash retries next interval; its engine reads are IO-tapped RED and the on-disk portraits stand)
            logger.info("[portraits] reconcile for %s failed: %s", safe, e)
            results[safe] = None
    return results


async def _reconcile_loop() -> None:
    """The per-process G20 loop: sleep first (nothing is registered at startup), then
    sweep. A cycle error never kills the loop; cancellation passes through."""
    while True:
        await asyncio.sleep(RECONCILE_INTERVAL_S)
        try:
            await reconcile_once()
        except asyncio.CancelledError:  # pragma: no cover - loop teardown
            raise
        except Exception as e:  # pragma: no cover - defensive; failsoft-ok: best-effort-enrichment (reconcile-loop keepalive — reconcile_once already isolates+records per user; a cycle error is logged and the loop continues to the next sweep)
            logger.info("[portraits] reconcile sweep error: %s", e)


def ensure_reconciler_started() -> bool:
    """Start the reconcile loop on the running event loop (the app startup hook calls
    this; idempotent). Returns True only when this call actually created the task —
    a second start never double-runs (the single-task guard). A task whose loop died
    (test harnesses / reloads) is replaced rather than wedging the guard forever."""
    global _RECONCILER_TASK
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return False  # no loop (sync caller) — the startup hook always has one
    task = _RECONCILER_TASK
    if task is not None and not task.done():
        try:
            if task.get_loop() is loop:
                return False  # already running here
        except Exception:  # pragma: no cover - defensive
            pass
    _RECONCILER_TASK = loop.create_task(_reconcile_loop())
    return True


def discard_portraits(user: Optional[str], houseguest_ids: list) -> int:
    """Delete the stored portraits + manifest entries for THESE houseguests only (the G25
    debug-regenerate lever); returns how many files were removed.

    Selective on purpose — never the whole dir: the backfill regenerates ACTIVE houseguests
    only, so wiping a departed houseguest's photo would leave a placeholder forever. Clears
    the debounce stamp and the G20 retry budget so the regeneration can run immediately."""
    manifest = load_manifest(user)
    d = user_portrait_dir(user)
    removed = 0
    for hid in houseguest_ids or []:
        sid = _safe_id(hid)
        entry = manifest.get(sid)
        # G26: a player's LITERAL uploaded photo ('upload') is locked — regenerate never
        # discards it. 'reference' (still AI off their headshot) re-renders like any other.
        if isinstance(entry, dict) and entry.get("source") == "upload":
            continue
        entry = manifest.pop(sid, None)
        fname = entry.get("file") if isinstance(entry, dict) else None
        if not fname:
            continue
        try:
            p = d / os.path.basename(str(fname))
            if p.exists():
                p.unlink()
                removed += 1
        except OSError as e:
            logger.info("[portraits] discard of %s failed: %s", sid, e)
    try:
        _save_manifest(user, manifest)
    except OSError as e:
        logger.info("[portraits] discard manifest write failed: %s", e)
    _LAST_BACKFILL_AT.pop(_safe_user(user), None)
    _clear_counters(_safe_user(user))
    # A discarded slot is a state change — re-arm its once-only no-prompt log.
    logged = _NO_PROMPT_LOGGED.get(_safe_user(user))
    if logged:
        for hid in houseguest_ids or []:
            logged.discard(_safe_id(hid))
    return removed


def scrub_user(user: Optional[str]) -> None:
    """Delete one user's portrait set (used on a per-user new-season reset)."""
    import shutil

    # M1-9: a new season is a fresh verdict — never carry a "failing" flag across resets.
    _LAST_RUN_OUTCOME.pop(_safe_user(user), None)
    d = user_portrait_dir(user)
    try:
        if d.exists():
            shutil.rmtree(d)
    except OSError as e:
        logger.info("[portraits] scrub_user(%s) failed: %s", _safe_user(user), e)
    # A new season may backfill immediately — the old debounce stamp shouldn't gate it.
    _LAST_BACKFILL_AT.pop(_safe_user(user), None)
    # G20: a new season = a new cast — stale budget counters/trackers must not gate it.
    _clear_counters(_safe_user(user))
    _PROVIDER_SEEN.pop(_safe_user(user), None)
    _LAST_MISSING.pop(_safe_user(user), None)
    # ADR 0013: the staleness watermark describes the OLD cast — the new one verifies afresh.
    _STALE_AUTHORED_SEEN.pop(_safe_user(user), None)
    # A new season is a new prompt state — re-arm the once-only no-prompt logs.
    _NO_PROMPT_LOGGED.pop(_safe_user(user), None)
    # L15: a finished/old season's progress record must not linger into the new cast.
    _GEN_PROGRESS.pop(_safe_user(user), None)
    # The reconciler's transient-signal cache describes the OLD cast's ids.
    _LAST_GEN_ERROR_BY_ID.pop(_safe_user(user), None)
    cancel_face_retries(user)  # the per-photo retry timers belong to the OLD cast
    _OPENING_IDS.pop(_safe_user(user), None)


def scrub_all() -> None:
    """Delete every user's portraits (factory/game reset; mirrors the deploy scripts)."""
    import shutil

    try:
        if PORTRAITS_DIR.exists():
            shutil.rmtree(PORTRAITS_DIR)
    except OSError as e:
        logger.info("[portraits] scrub_all failed: %s", e)
    # G20: the budget sidecar and trackers describe casts that no longer exist.
    try:
        RECONCILE_STATE_PATH.unlink(missing_ok=True)
    except OSError:
        pass
    _PROVIDER_SEEN.clear()
    _LAST_MISSING.clear()
    _STALE_AUTHORED_SEEN.clear()  # ADR 0013: the watermarks describe casts that no longer exist
    _NO_PROMPT_LOGGED.clear()  # the once-only no-prompt logs describe casts that no longer exist
    _GEN_PROGRESS.clear()  # L15: no run is in flight after a wholesale scrub
    _LAST_GEN_ERROR_BY_ID.clear()  # the reconciler's transient-signal cache is per-cast
    for _u in list(_FACE_RETRY):
        cancel_face_retries(_u)
    _OPENING_IDS.clear()
