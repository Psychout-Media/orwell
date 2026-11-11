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
    must never break the run."""
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

# The most recent _generate_one failure reason (+ an optional short detail — the provider's
# own error code/message on an HTTP failure), consumed by the attempt logger. Module-level is
# adequate: generate_and_store awaits each generation sequentially, and the log is best-effort
# observability, never game state.
_LAST_GEN_ERROR: Optional[str] = None
_LAST_GEN_DETAIL: Optional[str] = None


def _note_gen_error(error_class: str, detail: Optional[str] = None) -> None:
    global _LAST_GEN_ERROR, _LAST_GEN_DETAIL
    _LAST_GEN_ERROR = error_class
    _LAST_GEN_DETAIL = detail or None


def _consume_gen_error() -> Optional[str]:
    global _LAST_GEN_ERROR
    e = _LAST_GEN_ERROR
    _LAST_GEN_ERROR = None
    return e


def _consume_gen_detail() -> Optional[str]:
    global _LAST_GEN_DETAIL
    d = _LAST_GEN_DETAIL
    _LAST_GEN_DETAIL = None
    return d


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
                duration_ms: int = 0, detail: Optional[str] = None) -> None:
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
        if imgs and imgs[0].get("b64_json"):
            return base64.b64decode(imgs[0]["b64_json"])
        if imgs and imgs[0].get("url"):
            ir = await client.get(imgs[0]["url"])
            return ir.content if ir.status_code == 200 else None
        _note_gen_error("empty-response")
        return None
    except Exception as e:  # failsoft-ok: handled-by-terminal (_note_gen_error stashes the reason → the generate_and_store terminal records it RED via _note_generation_failure)
        logger.info("[portraits] images/edits failed: %s", e)
        _note_gen_error(type(e).__name__)
        return None


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
        img_url = _extract_chat_image_url(data)
        if not img_url:
            return None, "no-image-in-response", _chat_text_hint(data), resp.status_code
        png, fetch_reason = await _image_bytes_from_url(client, img_url)
        if png:
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


async def _generate_one(prompt: str, user: Optional[str],
                        reference_png: Optional[bytes] = None,
                        keep_identity: bool = True) -> Optional[bytes]:
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
    from src.ai_interaction import _resolve_model, IMAGE_AUTODETECT_CANDIDATES

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
                _resolve_model(candidate, owner=user or None)
                model_spec = candidate
                break
            except Exception:
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
            images = data.get("data", [])
            if not images:
                _note_gen_error("empty-response")
                return None
            img = images[0]
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


def _write_portrait(user: Optional[str], houseguest_id: str, png: bytes, name: str,
                    source: str = "generated", fingerprint: Optional[str] = None,
                    ref_clean: Optional[bool] = None) -> str:
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
    target.write_bytes(png)
    manifest = load_manifest(user)
    entry = {"file": filename, "name": name, "source": source}
    if fingerprint:
        entry["fingerprint"] = fingerprint
    if source == "reference" and ref_clean:
        entry["refClean"] = True
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
_STUDIO_BASE = ("photorealistic candid reality-TV cast portrait, natural unretouched skin "
                "texture, soft practical lighting, head-and-shoulders")
_STUDIO_VARIANTS = (
    "a natural easy smile, soft window light, looking at camera",
    "three-quarter angle, a relaxed confident look, warm practical light",
    "a candid mid-laugh, bright natural light, slightly off-center",
    "a thoughtful steady gaze, cooler even light, centered",
)


async def generate_studio_candidates(user: Optional[str], n: int = 3) -> dict:
    """Generate up to `n` studio portrait OPTIONS off the player's uploaded photo (image-to-
    image, likeness-preserving). Writes cand-0…N-1; returns {generated, reason?}. The player
    picks one via finalize, or calls this again for a fresh set (back-and-forth, indefinitely)."""
    src = _read_intake_source(user)
    if not src:
        return {"generated": 0, "reason": "upload a photo first"}
    if not image_generation_available(user):
        return {"generated": 0, "reason": "no image model is configured"}
    _clear_candidates(user)
    made = 0
    for i in range(max(1, min(int(n), 4))):
        # _generate_one prepends the identity-keep instruction when a reference is set.
        prompt = _STUDIO_BASE + ". " + _STUDIO_VARIANTS[i % len(_STUDIO_VARIANTS)]
        _consume_gen_error(); _consume_gen_detail()
        png = await _generate_one(prompt, user, reference_png=src)
        if png:
            try:
                _candidate_path(user, made).write_bytes(png)
                made += 1
                log_attempt("player:candidate", True, None, 0)
            except OSError as e:
                logger.info("[portraits] candidate write failed: %s", e)
        else:
            log_attempt("player:candidate", False, _consume_gen_error() or "generation-failed",
                        0, detail=_consume_gen_detail())
    return {"generated": made} if made else {"generated": 0, "reason": "generation failed — see the portrait log"}


async def generate_and_store(prompts: list, user: Optional[str], *, record_beats: bool = True) -> dict:
    """Generate + persist a cast portrait set from the engine's `portraitPrompts`.

    `prompts` is the engine's ``[{houseguestId, name, prompt}]``. Returns a small summary
    ``{generated, skipped, total}``. Idempotent: a houseguest whose portrait already exists
    on disk is NOT regenerated (generate-once-per-season; served from disk on restart).

    Best-effort throughout: never raises. When generation is unavailable (no model / disabled)
    it skips silently and the game is unaffected. After a portrait is shown for the first time
    we record it as a player-witnessed beat via the engine (recorded-or-it-didn't-happen),
    unless `record_beats` is False.
    """
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
            cur_fp = _prompt_fingerprint(str(entry.get("prompt")))
            if stored_fp and cur_fp and stored_fp != cur_fp:
                to_generate += 1
    if to_generate:
        _progress_start(user, to_generate)

    for entry in prompts:
        if not isinstance(entry, dict):
            skipped += 1
            continue
        hid = entry.get("houseguestId") or entry.get("id")
        prompt = entry.get("prompt")
        name = entry.get("name") or ""
        # The player pre-pass already applied + counted this id (a chosen headshot) — skip WITHOUT
        # counting `skipped`, else the one player slot is double-counted (it is prompt-less, so it
        # would otherwise fall into the `not prompt` branch below). CodeRabbit #1564.
        if hid and _safe_id(str(hid)) in prepass_applied:
            continue
        if not hid or not prompt:
            skipped += 1
            continue

        # The current facet's fingerprint (a stable hash of the engine's deterministic prompt).
        fp = _prompt_fingerprint(str(prompt))

        # #998: an overlapping run already CLAIMED this id and is mid-generation (claimed but not
        # yet written to disk, so the on-disk check below would not catch it) — skip, let that run
        # land the one image. Mirrors the on-disk generate-once guard for the in-flight window.
        sid = _safe_id(str(hid))
        if sid in _INFLIGHT.setdefault(_safe_user(user), set()):
            skipped += 1
            continue

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
            if stored_fp and fp and stored_fp != fp:
                # Facet changed → stale face → fall through and re-shoot from the new prompt. This
                # is a RE-generation, so the engine will METER its beat — mark it for the budget
                # pre-check (S8) so a re-shoot burst can never over-fire into the per-turn cap.
                reshoot_ids.add(_safe_id(str(hid)))
            else:
                if (not stored_fp) and fp and isinstance(stored, dict):
                    # Backfill quietly (no regeneration) so this self-heals and the NEXT genuine
                    # facet change re-shoots. The image bytes are untouched (generate-once preserved).
                    stored["fingerprint"] = fp
                    manifest = load_manifest(user)
                    manifest[_safe_id(str(hid))] = stored
                    _save_manifest(user, manifest)
                skipped += 1
                continue

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
        # #998: CLAIM the id immediately before the (slow) generate, release in `finally` after the
        # write/failure — an overlapping run that reaches the in-flight check above now skips it,
        # so each id is generated exactly once even while its image is in flight (not yet on disk).
        _INFLIGHT.setdefault(_safe_user(user), set()).add(sid)
        try:
            t0 = time.monotonic()
            png = await _generate_one(str(prompt), user, reference_png=ref)
            duration_ms = int((time.monotonic() - t0) * 1000)
            if ref and not png:
                source = "generated"  # reference failed; the log carries the reason
            if not png:
                reason = _consume_gen_error() or "generation-failed"
                log_attempt(str(hid), False, reason, duration_ms, detail=_consume_gen_detail())
                # Stamp the failure class so the G20 reconciler can spare a TRANSIENT failure
                # (402 credits, 429, 5xx, transport) from the permanent retry budget.
                _record_gen_result(user, str(hid), False, reason)
                # #1599: surface the failure RED on /admin/status — a silent placeholder was the
                # original trigger; the initials floor stands (auto-corrected), still RED.
                _note_generation_failure(user, str(hid), reason)
                skipped += 1
                continue
            try:
                _write_portrait(user, str(hid), png, str(name), source=source, fingerprint=fp,
                                ref_clean=ref_clean)
                log_attempt(str(hid), True, None, duration_ms)
                _record_gen_result(user, str(hid), True)  # success clears any prior failure class
                generated += 1
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

    # L17: before the run is declared complete, run the automated look-alike / mistake pass —
    # detect near-duplicate faces across the cast (from the structured, Vault-free prompt facets)
    # and regenerate the offenders with enforced variety, bounded by a retry cap. Best-effort:
    # any failure leaves the as-generated set intact. Skipped when nothing new generated.
    if generated:
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

    _progress_finish(user)  # L15: the run is done — the panel drops to the idle cadence
    if generated:  # only when the run actually landed a face — no spurious cast-panel refetch
        _push_portrait_arrival(user)  # WS push edge: final reconcile (dedupe regens + completion)
    # M1-9: stamp the run's honest verdict (a 0-of-N run flips the panel/admin to "failing").
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
            _write_portrait(user, str(hid), png, name, source="generated")
            log_attempt(str(hid), True, None, duration_ms)
            regenerated_ids.append(str(hid))
        except Exception as e:
            # #1599 (CodeRabbit finding b): a broken look-alike regen persist must show RED — the
            # original face stands, but the distinctness fix silently failing is exactly the fail-soft
            # #1599 bans (no upstream records this persist path, so no double-record).
            logger.info("[portraits] L17 regen persist failed for %s: %s", hid, e)
            _note_generation_failure(user, str(hid), f"lookalike-regen-persist-failed: {e}")
    return {"regenerated": len(regenerated_ids), "regeneratedIds": regenerated_ids, "offenders": offenders}


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
                cur_fp = _prompt_fingerprint(p.get("prompt")) if isinstance(p, dict) else None
                if cur_fp and entry.get("fingerprint") != cur_fp:
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
        for hid, stored_fp in fp_candidates:
            try:
                p = await orwell_engine.get_portrait_prompt(hid, user=user)
            except Exception:  # failsoft-ok: handled-by-terminal (orwell_engine._call already recorded record_io(ok=False) RED; the staleness verify simply defers — verify nothing this sweep, retry next)
                engine_ok = False  # engine trouble — verify nothing this sweep, try again next
                break
            cur_fp = _prompt_fingerprint(p.get("prompt")) if isinstance(p, dict) else None
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
