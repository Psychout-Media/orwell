"""Feature 0065 — cast pre-warm orchestration (FE side).

The owner ruling: the player must start the actual game with a FULLY WARMED AUTHORSHIP before any
portrait is ever generated.

* **Author warm** fires at the earliest opportunity (a model is selectable, before the season begins):
  the engine pre-seeds the player-INDEPENDENT cast and the FE deeply authors it in the background,
  writing each profile back to the engine (``recordCastProfile``).
* **Portrait warm** is HELD until the first interview turn and, when it runs, WAITS for author warm to
  fully finish before generating any face — so portraits always read a finished, deeply authored store.

Both are idempotent per user and best-effort: with no model configured, author warm no-ops and portrait
warm declines (``createCharacter``'s own fallback then owns portraits). The author-done gate is released
on authoring completion *whether it succeeded or failed*, so portrait warm can never hang.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Portrait warm waits at most this long for author warm before shooting anyway. The seeded floor is still
# a complete cast, and a later store change is caught by the portrait re-shoot backstop — so an authoring
# run that overruns the budget never strands the player without faces. Generous: 15 sequential authoring
# LLM calls can take minutes, and the casting interview usually outlasts them.
_AUTHOR_WARM_TIMEOUT = 15 * 60.0

# ── NEXT-SEASON char-data warm (the finale-day trigger) ───────────────────────────────────────
# TRUE advance-warm (the engine now supports it directly): when the CURRENT season's finale day begins,
# the FE fires `preSeedNextSeason`, which warms the NEXT season's cast off a NEW seed into a per-user
# HOLDING STORE (engine registry level + a durable mirror) that survives the sandbox rotation — WITHOUT
# touching the active season. The FE then deeply authors the held cast in the background (write-back onto
# the holding store), releasing the author-done gate Phase-2 portraits gate off. The confirmed cutover
# ADOPTS the held cast. No FE poll-until-the-one-game-sandbox-frees-up is needed any longer; this is a
# single real warm fired as a fire-and-forget background task. Best-effort, idempotent, fail-soft: no
# model/provider ⇒ the engine still warms the deterministic floor and the gate releases on it.


def _prompt_id(entry) -> Optional[str]:
    """The houseguest id a portrait prompt belongs to (the gating key)."""
    if not isinstance(entry, dict):
        return None
    hid = entry.get("houseguestId") or entry.get("id")
    return str(hid) if hid else None


class _Warm:
    __slots__ = ("seed", "prompts", "author_done", "author_started", "portraits_started",
                 "npc_authored", "attempts", "retry_task", "kick", "interview_over", "ok",
                 "identity_applied", "deps")

    def __init__(self) -> None:
        self.seed = None
        self.prompts: list = []
        self.author_done = asyncio.Event()  # whole-cast done (success OR failure) — the fallback gate
        self.author_started = False
        self.portraits_started = False
        # Per-NPC completion gates (#7): an Event per houseguest id, set the moment THAT NPC's
        # authoring write-back lands, so its portrait shoots as soon as it is authored — never before.
        self.npc_authored: dict[str, asyncio.Event] = {}
        # Self-healing (stage 0): a warm that ended failed is retried with backoff until it succeeds or
        # the interview ends. `kick` skips the current wait (a later prewarm call / a finalize refusal).
        self.attempts = 0
        self.retry_task = None
        self.kick: Optional[asyncio.Event] = None
        self.interview_over = False
        self.ok = False
        self.identity_applied = False
        self.deps: dict = {}

    def npc_event(self, hid: str) -> asyncio.Event:
        ev = self.npc_authored.get(hid)
        if ev is None:
            ev = asyncio.Event()
            self.npc_authored[hid] = ev
        return ev


_STATE: dict[str, _Warm] = {}

# The finale-day next-season warm runs a background poll TASK per user (it must outlive the
# per-season `_Warm` reset that fires at next-season confirm — the poll is what RE-warms the fresh
# cast right after the sandbox rotates). Kept in its own registry so `reset()` (a per-season gate
# drop) never cancels an in-flight finale-day warm; only an explicit `cancel_next_season` / a global
# reset tears it down.
_NEXT_SEASON_TASKS: dict[str, "asyncio.Task"] = {}


def _key(user: Optional[str]) -> str:
    return user or "default"


def _state(user: Optional[str]) -> _Warm:
    k = _key(user)
    st = _STATE.get(k)
    if st is None:
        st = _Warm()
        _STATE[k] = st
    return st


def cancel_next_season(user: Optional[str] = None) -> None:
    """Tear down a user's armed finale-day next-season warm poll (``user=None`` cancels everyone).
    Best-effort: a completed/absent task is a no-op."""
    keys = list(_NEXT_SEASON_TASKS) if user is None else [_key(user)]
    for k in keys:
        task = _NEXT_SEASON_TASKS.pop(k, None)
        if task is not None and not task.done():
            try:
                task.cancel()
            except Exception:  # pragma: no cover - defensive
                pass


def reset(user: Optional[str] = None) -> None:
    """Drop a user's per-season warm GATE (a new game / season / factory reset) so the next OOBE warms
    afresh. ``user=None`` clears everyone (a global reset).

    Note: this clears only the per-season `_Warm` gate, NOT an armed finale-day next-season poll — that
    poll deliberately OUTLIVES the confirm-time reset so it can re-warm the fresh cast once the sandbox
    rotates. A GLOBAL reset (``user=None``) does cancel the polls too, since nothing should survive a
    process-wide wipe."""
    if user is None:
        for _st in list(_STATE.values()):
            _cancel_retry(_st)
        _STATE.clear()
        cancel_next_season(None)
    else:
        _old = _STATE.pop(_key(user), None)
        if _old is not None:
            _cancel_retry(_old)


def reset_user_season(user: Optional[str]) -> None:
    """Drop the per-user cast-warm state a NEW season replaces: scrub the prior portrait set (0051),
    reset the authoring give-up ledger (M1-10), and drop the cast pre-warm gate (0065 belt-and-
    suspenders — prewarm self-resets on seed change too). Each sub-step is independently fail-soft:
    one failing must never abort the others, and none of it may block the season start. Called from
    every season-reset route."""
    from src import orwell_portraits, orwell_cast_authoring  # lazy: avoid an import cycle
    # A new season = a new cast: scrub the prior portrait set before generating (0051).
    try:
        orwell_portraits.scrub_user(user)
    except Exception as e:
        logger.info("[prewarm] reset_user_season: scrub_user failed: %s", e)
    try:  # M1-10: new season ⇒ the authoring give-up ledger resets with the cast
        orwell_cast_authoring.reset_attempts(user)
    except Exception as e:
        logger.info("[prewarm] reset_user_season: reset_attempts failed: %s", e)
    try:  # strict enrichment policy: a new season scrubs the prior season's failure ledger too
        from src import enrichment_policy
        enrichment_policy.clear_failures(user)
    except Exception as e:
        logger.info("[prewarm] reset_user_season: clear_failures failed: %s", e)
    try:  # 0116: a new season clears the cast-genesis strict-failed latch (the pre-finalize gate)
        from src import orwell_cast_genesis
        orwell_cast_genesis.reset_state(user)
    except Exception as e:
        logger.info("[prewarm] reset_user_season: genesis reset failed: %s", e)
    try:  # ORW-260: ... and the deeper-backstory (cast-authoring) strict-failed latch
        from src import orwell_cast_authoring
        orwell_cast_authoring.clear_strict_failed(user)
    except Exception as e:
        logger.info("[prewarm] reset_user_season: authoring latch reset failed: %s", e)
    try:
        reset(user)
    except Exception as e:
        logger.info("[prewarm] reset_user_season: reset failed: %s", e)


async def prewarm_cast(user: Optional[str] = None, *, engine=None, authoring=None, identity=None,
                       genesis=None, server_portraits: bool = True) -> dict:
    """AUTHOR WARM (earliest): pre-seed the cast in the engine, model-author its SKELETON (0116 genesis),
    AI-seed its descriptive identity (#544), then deeply author it in the background.

    Idempotent per user (a second call is a no-op that reports the in-flight warm). Releases the
    author-done gate when authoring finishes — success OR failure — so portrait warm never hangs.
    Returns ``{warmed, count, alreadyWarmed?, refused?}``.

    Pipeline order (0116): SKELETON → identity → author → shoot. The ``genesis`` dep (default: the real
    ``orwell_cast_genesis`` module) model-authors the whole cast skeleton FIRST — a PRE-GAME operation
    (``recordCastGenesis`` is refused once the season runs), so it rides THIS pre-warm during the casting
    interview. The ``identity`` dep (default: ``orwell_cast_identity``) then seeds the AI-driven cast
    identity before authoring, so the authored look + portraits read the engine-validated heritage. Both
    are injected for tests; a missing model makes each a silent no-op (the engine's deterministic floor
    stands byte-identically).
    """
    if engine is None:
        from src import orwell_engine as engine
    if authoring is None:
        from src import orwell_cast_authoring as authoring
    # Always poll the engine (the pre-seed is idempotent + cheap when already warmed) so the warm
    # state self-resets across seasons: a NEW season mints a NEW seed, and a seed change here triggers a
    # fresh author warm with a fresh gate — no per-route reset plumbing needed.
    try:
        res = await engine.pre_seed_cast(user=user)
    except Exception as e:  # best-effort: a pre-seed failure must never block onboarding
        logger.info("[prewarm] pre_seed_cast failed: %s", e)
        # STRICT enrichment policy (owner directive 2026-07-11): the failed warm is LOUD — an ERROR +
        # an admin-visible ledger entry. Soft: the legacy info line only, byte-identical.
        try:
            from src import enrichment_policy
            if enrichment_policy.is_strict():
                enrichment_policy.record_failure(
                    user, "cast-prewarm", "the engine cast pre-seed failed", detail=str(e))
        except Exception:
            pass
        return {"warmed": False, "count": 0}
    if not isinstance(res, dict) or not res.get("warmed"):
        return {"warmed": False, "count": 0, "refused": (res or {}).get("refused")}
    seed = res.get("seed")
    st = _state(user)
    if st.author_started and st.seed == seed:
        if st.ok or st.interview_over or not _warm_failed(user, st):
            return {"warmed": True, "alreadyWarmed": True, "count": len(st.prompts)}
        # A warm that FAILED (a provider 402, a timeout) is not a permanent no-op: this call restarts
        # it now instead of waiting out the backoff.
        _ensure_retry(user, st, immediate=True)
        return {"warmed": True, "restarted": True, "count": len(st.prompts)}
    if st.author_started and st.seed != seed:
        _cancel_retry(st)
        reset(user)  # a fresh cast (new season): drop the stale gate + prompts and re-warm
        st = _state(user)
    st.seed = seed
    st.prompts = res.get("portraitPrompts") or []
    cast = res.get("house") or []
    st.author_started = True
    st.deps = {"engine": engine, "authoring": authoring, "identity": identity, "genesis": genesis,
               "server_portraits": server_portraits}
    await _run_stages(user, st, seed, cast)
    return {"warmed": True, "count": len(st.prompts)}


# Backoff between self-healing attempts of a failed cast warm (seconds). The last value repeats until the
# warm succeeds or the interview ends; one loud admin alert is raised when the schedule is first exhausted.
_RETRY_BACKOFF_S = (10.0, 30.0, 90.0, 300.0)


def _warm_failed(user: Optional[str], st: "_Warm") -> bool:
    """Whether the cast warm for this user has ENDED in failure: the whole-cast authoring finished (success or not)
    and the strict failure latches (genesis, deeper backstories) say a required step did not land. Soft policy never
    latches, so a soft-policy warm is never retried (the floor is the legacy, accepted outcome there)."""
    if not st.author_done.is_set():
        return False  # still running
    for key in ("authoring", "genesis"):
        mod = st.deps.get(key)
        fn = getattr(mod, "strict_failed", None)
        if fn is None:
            continue
        try:
            if fn(user):
                return True
        except Exception:  # failsoft-ok: observability (a latch read must never break the warm)
            continue
    return False


def _cancel_retry(st: "_Warm") -> None:
    task = st.retry_task
    st.retry_task = None
    if task is not None and not task.done():
        try:
            task.cancel()
        except Exception:  # pragma: no cover - defensive
            pass


def interview_ended(user: Optional[str] = None) -> None:
    """The casting interview is over (the engine committed the player): stop the backoff retries. From here the
    house-entry gate and the portrait queue own the rest."""
    st = _STATE.get(_key(user))
    if st is None:
        return
    st.interview_over = True
    _cancel_retry(st)


def _ensure_retry(user: Optional[str], st: "_Warm", *, immediate: bool = False) -> bool:
    """Make sure ONE retry loop is running for this warm; `immediate` skips the current backoff wait. Returns whether a
    loop is (now) running."""
    if st.interview_over or st.ok or not st.deps:
        return False
    task = st.retry_task
    if task is not None and not task.done():
        if immediate and st.kick is not None:
            st.kick.set()
        return True
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return False
    st.kick = asyncio.Event()
    if immediate:
        st.kick.set()
    st.retry_task = loop.create_task(_retry_loop(user, st))
    return True


async def _sleep_or_kick(st: "_Warm", delay: float) -> None:
    try:
        await asyncio.wait_for(st.kick.wait(), timeout=delay)
    except asyncio.TimeoutError:
        pass
    st.kick.clear()


async def _retry_loop(user: Optional[str], st: "_Warm") -> None:
    """Re-run a failed warm with backoff until it succeeds, the interview ends, or the warm is replaced (a new
    season). Never raises; never blocks other work (it is its own task)."""
    n = 0
    alerted = False
    try:
        while True:
            delay = 0.0 if (st.kick is not None and st.kick.is_set()) else _RETRY_BACKOFF_S[min(n, len(_RETRY_BACKOFF_S) - 1)]
            await _sleep_or_kick(st, delay)
            if _STATE.get(_key(user)) is not st or st.interview_over or st.ok:
                return
            n += 1
            st.attempts += 1
            try:
                eng = st.deps["engine"]
                res = await eng.pre_seed_cast(user=user)
                if not isinstance(res, dict) or not res.get("warmed") or res.get("seed") != st.seed:
                    return  # a different season took over (or the engine refused): nothing of ours to heal
                cast = res.get("house") or []
                st.prompts = res.get("portraitPrompts") or st.prompts
                logger.info("[prewarm] cast warm retry %d for %s", st.attempts, _key(user))
                await _run_stages(user, st, st.seed, cast, retry=True)
                await st.author_done.wait()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # a retry attempt must never kill the loop
                logger.info("[prewarm] cast warm retry failed: %s", e)
                st.author_done.set()
            if not _warm_failed(user, st):
                st.ok = True
                return
            if n >= len(_RETRY_BACKOFF_S) and not alerted:
                alerted = True
                try:
                    from src import enrichment_policy
                    enrichment_policy.record_failure(
                        user, "cast-prewarm", "the cast warm is still failing after repeated retries",
                        detail=f"{st.attempts} retries so far; it keeps retrying until the interview ends")
                except Exception:  # failsoft-ok: observability
                    pass
    finally:
        if st.retry_task is asyncio.current_task():
            st.retry_task = None


async def restart_warm(user: Optional[str] = None) -> dict:
    """Start (or hurry) the cast warm NOW: a finalize refusal calls this so nothing is left idle. Safe to call at any
    time; returns ``{restarted, reason?}``."""
    st = _STATE.get(_key(user))
    if st is None or not st.author_started or not st.deps:
        try:
            res = await prewarm_cast(user)
            return {"restarted": bool(res.get("warmed")), "fresh": True}
        except Exception as e:  # failsoft-ok: best-effort
            logger.info("[prewarm] restart_warm failed: %s", e)
            return {"restarted": False, "reason": "prewarm-failed"}
    if st.interview_over:
        st.interview_over = False  # the caller is still casting: the retries own the warm again
    st.ok = False
    if not st.author_done.is_set():
        return {"restarted": False, "reason": "still-running"}
    return {"restarted": _ensure_retry(user, st, immediate=True)}


def _start_portraits(user: Optional[str], st: "_Warm") -> None:
    """Server-owned portrait start: the portrait warm no longer hangs on one browser call. Idempotent and safe next to
    the browser's own call (the shots dedupe on the in-flight claim and the on-disk check)."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    st.portraits_started = False  # a retried warm re-opens the gate for the faces its retry authored
    task = loop.create_task(warm_portraits(user))

    def _done(t):
        try:
            t.result()
        except Exception as e:  # pragma: no cover - defensive
            logger.info("[prewarm] server portrait start failed: %s", e)

    task.add_done_callback(_done)


async def _run_stages(user: Optional[str], st: "_Warm", seed, cast: list, *, retry: bool = False) -> None:
    engine = st.deps["engine"]
    authoring = st.deps["authoring"]
    identity = st.deps.get("identity")
    genesis = st.deps.get("genesis")
    st.author_done.clear()

    # 0116 - model-authored cast GENESIS runs FIRST (skeleton BEFORE identity + depth): player-blind, a PRE-GAME
    # operation (recordCastGenesis is refused once the season runs), so it rides this pre-warm during the casting
    # interview. Best-effort + fail-soft: a failure latches the strict gate (the retry loop re-runs it). When it
    # committed a skeleton, RE-FETCH the warmed roster so identity + authoring read the committed ground truth.
    try:
        if genesis is None:
            from src import orwell_cast_genesis as genesis
            st.deps["genesis"] = genesis
        gres = await genesis.run_genesis(cast, seed, user)
        if isinstance(gres, dict) and gres.get("committed"):
            again = await engine.pre_seed_cast(user=user)
            if isinstance(again, dict) and again.get("house"):
                cast = again.get("house") or cast
                st.prompts = again.get("portraitPrompts") or st.prompts
    except Exception as e:  # genesis must never block onboarding
        logger.info("[prewarm] cast-genesis skipped: %s", e)

    # ORW-509 - the season's HOUSE is authored at this same setup moment (one bounded call from the season brief);
    # a refusal leaves the plain room labels. Fail-soft, never blocks onboarding.
    try:
        from src import orwell_house_authoring
        await orwell_house_authoring.run_house(seed, user)
    except Exception as e:
        logger.info("[prewarm] house authoring skipped: %s", e)

    # #544 - the AI-driven IDENTITY seed runs BEFORE deep authoring, so authoring reads the engine-validated
    # heritage. Best-effort + fail-soft; once applied it is not repeated by a retry.
    if not st.identity_applied:
        try:
            if identity is None:
                from src import orwell_cast_identity as identity
                st.deps["identity"] = identity
            import inspect
            _takes_seed = "seed" in inspect.signature(identity.run_identity).parameters  # an injected dependency may not take the season seed
            applied = await (identity.run_identity(cast, user, seed=seed) if _takes_seed else identity.run_identity(cast, user))
            if applied:
                st.identity_applied = True
                again = await engine.pre_seed_cast(user=user)
                if isinstance(again, dict) and again.get("house"):
                    cast = again.get("house") or cast
                    st.prompts = again.get("portraitPrompts") or st.prompts
        except Exception as e:  # identity seeding must never block onboarding
            logger.info("[prewarm] cast-identity seed skipped: %s", e)

    # Pre-create a per-NPC gate for every houseguest that has a portrait prompt (#7), so portrait warm can wait on
    # the SAME Event objects the authoring callback sets - even if authoring is slow to start.
    for entry in st.prompts:
        hid = _prompt_id(entry)
        if hid:
            st.npc_event(hid)

    def _on_authored(hid: str) -> None:
        # THIS NPC's write-back landed -> open its gate so its portrait shoots now (never before).
        st.npc_event(str(hid)).set()

    def _on_done() -> None:
        # Whole-cast authoring finished (success OR failure): release the fallback gate. ADR 0013 - never force-open
        # a per-NPC gate that never fired: an NPC the model could not author gets NO photo until its authoring lands.
        st.author_done.set()
        if _STATE.get(_key(user)) is not st:
            return
        if _warm_failed(user, st):
            _ensure_retry(user, st)  # self-healing: retry with backoff until it lands or the interview ends
        else:
            st.ok = True
        if st.deps.get("server_portraits", True):
            _start_portraits(user, st)  # the server owns the portrait start (the browser call is a harmless duplicate)

    # A retry re-authors only the houseguests still on the floor (a partial run is never redone from zero).
    todo = cast
    if retry:
        pending = [c for c in cast if isinstance(c, dict) and c.get("authored") is not True]
        todo = pending or cast
    # T0-6: thread the season `seed` so the FacetLedger mints.
    authoring.kickoff_authoring(todo, user, then=_on_done, on_authored=_on_authored, seed=seed)

async def warm_next_season(user: Optional[str] = None, *, engine=None, authoring=None) -> dict:
    """The REAL mid-season next-season warm (the engine now supports it directly).

    Calls the engine's ``preSeedNextSeason`` — which warms the NEXT season's cast off a NEW seed into a
    per-user HOLDING STORE that survives the cutover rotation, WITHOUT touching the active season — then
    deeply authors the held cast in the BACKGROUND. The authoring write-back is routed through
    ``pre_seed_next_season(profile=…)`` so each profile lands on the HOLDING store, never the live cast
    (mid-season, ``record_cast_profile`` would author the running house — the wrong cast). Releases the
    SAME per-season author-done gate Phase-2 portrait warm (at the next-season confirm) gates off, exactly
    as the startup warm gates portraits off cast authoring.

    Best-effort, idempotent, fail-soft. No model/provider ⇒ the engine still warms the deterministic
    floor (the cast is warmed); authoring simply no-ops and the gate releases on the seeded store.
    Returns ``{warmed, count, refused?}``."""
    if engine is None:
        from src import orwell_engine as engine
    if authoring is None:
        from src import orwell_cast_authoring as authoring
    try:
        res = await engine.pre_seed_next_season(user=user)
    except Exception as e:  # best-effort: a warm failure must never disturb the finale
        logger.info("[prewarm] pre_seed_next_season failed: %s", e)
        # STRICT enrichment policy: loud + ledgered (the finale is never disturbed either way).
        try:
            from src import enrichment_policy
            if enrichment_policy.is_strict():
                enrichment_policy.record_failure(
                    user, "cast-prewarm", "the engine next-season pre-seed failed", detail=str(e))
        except Exception:
            pass
        return {"warmed": False, "count": 0}
    if not isinstance(res, dict) or not res.get("warmed"):
        return {"warmed": False, "count": 0, "refused": (res or {}).get("refused")}

    seed = res.get("seed")
    st = _state(user)
    # A NEW next-season seed: drop any stale per-season gate/prompts and warm afresh (the next season's
    # cast differs from the one we just left). An identical seed already armed ⇒ idempotent no-op.
    if st.author_started and st.seed == seed:
        return {"warmed": True, "alreadyWarmed": True, "count": len(st.prompts)}
    if st.author_started and st.seed != seed:
        reset(user)
        st = _state(user)
    st.seed = seed
    st.prompts = res.get("portraitPrompts") or []
    cast = res.get("house") or []
    st.author_started = True
    for entry in st.prompts:
        hid = _prompt_id(entry)
        if hid:
            st.npc_event(hid)

    def _on_authored(hid: str) -> None:
        st.npc_event(str(hid)).set()

    def _on_done() -> None:
        # ADR 0013 — release the whole-cast gate ONLY; never force-open an un-authored NPC's gate
        # (no photo without model authoring — the backfill shoots it once authoring lands).
        st.author_done.set()

    # The next-season authoring write-back sink: route each authored profile through
    # `pre_seed_next_season(profile=…)` so it lands on the HOLDING store (NOT the live `record_cast_profile`
    # path, which mid-season would author the running house).
    async def _write_next_season(profile: dict) -> dict:
        return await engine.pre_seed_next_season(profile=profile, user=user)

    authoring.kickoff_authoring(cast, user, then=_on_done, on_authored=_on_authored,
                                write=_write_next_season, seed=seed)
    return {"warmed": True, "count": len(st.prompts)}


def prewarm_next_season(user: Optional[str] = None, *, engine=None, authoring=None) -> dict:
    """PHASE 1 — next-season char-data warm, triggered when the CURRENT season's FINALE DAY begins.

    Fires the REAL mid-season warm (`warm_next_season`) as a best-effort, idempotent, fail-soft BACKGROUND
    task: the engine warms the NEXT season's cast off a NEW seed into a per-user HOLDING STORE that
    survives the cutover, the FE deeply authors it in the background (write-back onto the holding store),
    and the per-season author-done gate Phase-2 portraits read is populated — landing the deep cast data
    truly IN ADVANCE of when it's needed. Images are a SEPARATE Phase-2 warm fired at the next-season
    confirm, gated off this one.

    Idempotent per user: a second finale-day call while a warm task is in flight is a no-op. The held
    cast lives at the ENGINE registry level (it survives the sandbox rotation) + a durable mirror, so the
    cutover adopts it even across an engine restart — no FE poll-until-the-sandbox-frees-up is needed any
    longer. No model/provider ⇒ the engine still warms the deterministic floor. Returns ``{armed}``."""
    if engine is None:
        from src import orwell_engine as engine
    if authoring is None:
        from src import orwell_cast_authoring as authoring
    k = _key(user)
    existing = _NEXT_SEASON_TASKS.get(k)
    if existing is not None and not existing.done():
        return {"armed": True, "alreadyArmed": True}

    async def _runner():
        try:
            await warm_next_season(user, engine=engine, authoring=authoring)
        except asyncio.CancelledError:  # a global reset / explicit cancel tore the warm down
            raise
        except Exception as e:  # pragma: no cover - defensive; warm_next_season already swallows
            logger.info("[prewarm] next-season warm runner failed: %s", e)
        finally:
            # Self-deregister so a later finale (a future season) can arm a fresh warm.
            if _NEXT_SEASON_TASKS.get(k) is task_ref[0]:
                _NEXT_SEASON_TASKS.pop(k, None)

    task_ref: list = [None]
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # No RUNNING loop (a sync caller / a test driving the loop itself via run_until_complete).
        try:
            loop = asyncio.get_event_loop()
        except Exception:
            return {"armed": False, "reason": "no-loop"}
    task = loop.create_task(_runner())
    task_ref[0] = task
    _NEXT_SEASON_TASKS[k] = task
    return {"armed": True}


async def warm_portraits(user: Optional[str] = None, *, portraits=None,
                         timeout: float = _AUTHOR_WARM_TIMEOUT) -> dict:
    """PORTRAIT WARM (held until the first interview turn): generate the cast portraits in the background
    — but ONLY after author warm has fully finished. A fully warmed authorship before any photo, ever.

    Idempotent per user. If no author warm ran (no model at casting open), declines so it never shoots
    from a thin store — ``createCharacter``'s fallback owns portraits in that case. Returns ``{started}``.
    """
    st = _state(user)
    if st.portraits_started:
        return {"started": True, "alreadyStarted": True}
    if not st.author_started:
        return {"started": False, "reason": "author-warm-not-started"}
    if portraits is None:
        from src import orwell_portraits as portraits
    st.portraits_started = True

    async def _shoot_one(entry, gate: asyncio.Event) -> None:
        # ADR 0013 — a face shoots ONLY when its houseguest is actually MODEL-AUTHORED (its own gate
        # fires via _on_authored). If whole-cast authoring ends without THIS NPC authored, do NOT
        # shoot: a seeded/un-authored identity must never get a photo (it would mismatch the real,
        # authored text later). No photo now; the portrait backfill shoots it if/when authoring lands.
        if gate is st.author_done:
            # An id-less prompt has no per-NPC authoring signal — keep the whole-cast gate, but a pure
            # timeout (a total authoring hang) is still NO photo, never a mismatched one.
            try:
                await asyncio.wait_for(gate.wait(), timeout=timeout)
            except asyncio.TimeoutError:
                return
            portraits.kickoff_generation([entry], user)
            return
        # Per-NPC: race THIS NPC's authoring gate against whole-cast-done; shoot ONLY if it authored.
        done_wait = asyncio.ensure_future(st.author_done.wait())
        mine_wait = asyncio.ensure_future(gate.wait())
        try:
            await asyncio.wait({done_wait, mine_wait}, timeout=timeout,
                               return_when=asyncio.FIRST_COMPLETED)
        finally:
            done_wait.cancel()
            mine_wait.cancel()
        if gate.is_set():
            # 2026-07-13 (the stale-snapshot fix): shoot from the LIVE store, not the entry captured
            # at pre-seed time. The gate fires only after THIS NPC's authoring write-back landed —
            # which MUTATED the store (richer physical facet, vocation, identity), so the captured
            # prompt predates the identity the face must match. `kickoff_authored_reshoot` re-fetches
            # the CURRENT prompt via `getPortraitPrompt` (which pre-game serves the warmed pre-seed
            # store) and shoots from that — ADR 0013's "photos always match authored identities" now
            # holds for the prompt CONTENT, not just the shoot ORDER.
            portraits.kickoff_authored_reshoot(_prompt_id(entry), user)
        # else: whole-cast done (or a hang) without THIS NPC authored — intentionally NO photo (ADR 0013).

    async def _run() -> None:
        tasks = []
        for entry in st.prompts:
            hid = _prompt_id(entry)
            # A prompt with a known houseguest waits on that NPC's gate; an id-less prompt (no per-NPC
            # signal possible) falls back to the whole-cast gate so it still shoots once authoring ends.
            gate = st.npc_event(hid) if hid else st.author_done
            tasks.append(asyncio.create_task(_shoot_one(entry, gate)))
        if tasks:
            await asyncio.gather(*tasks)

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_run())
    except RuntimeError:  # pragma: no cover - non-async callers (tests await _run via the loop)
        __import__("src.llm_core", fromlist=["run_isolated"]).run_isolated(_run())
    return {"started": True}


def next_season_armed(user: Optional[str] = None) -> bool:
    """Whether a finale-day next-season char-data warm poll is currently armed for this user."""
    task = _NEXT_SEASON_TASKS.get(_key(user))
    return task is not None and not task.done()


def warm_state(user: Optional[str] = None) -> dict:
    """Vault-free introspection for tests / health: whether author + portrait warm have started and
    whether authoring has finished, plus whether a finale-day next-season warm is armed. No cast
    content crosses — counts and flags only."""
    armed = next_season_armed(user)
    st = _STATE.get(_key(user))
    if st is None:
        return {"authorStarted": False, "portraitsStarted": False, "authorDone": False,
                "promptCount": 0, "nextSeasonArmed": armed}
    return {
        "authorStarted": st.author_started,
        "portraitsStarted": st.portraits_started,
        "authorDone": st.author_done.is_set(),
        "promptCount": len(st.prompts),
        "nextSeasonArmed": armed,
    }
