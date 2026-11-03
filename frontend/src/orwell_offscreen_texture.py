"""Feature 0070 — off-screen society texture enrichment (FE lane).

The engine records off-screen NPC-to-NPC scenes with a deterministic id-slug template (e.g.
``npc:3 gossiped about the house with npc:7``). This module is the FE-owned model-voiced
prose layer: it fans out in parallel (the hermes subagent pattern), voices each scene's
SKELETON (Vault-free — public participant ids + nature only) as a short, vivid in-character
prose beat, and writes each voiced beat back to the engine (``recordOffscreenSceneTexture``).

Hard rules (0070 §§3-6):
- CONTENT ONLY — the write-back cannot alter the witness set, flip the hidden flag, or carry
  any relationship number. The engine enforces this at the MCP boundary.
- FAIL-SOFT — no model OR no usable output ⇒ the deterministic template content simply stands;
  the game advance is never blocked.
- NOT a model lever — the GM-facing manifest does not list these tools; they are FE/infra only.
- OFF by default (#1936, `offscreen_texture_enrichment`): the prose has no player-visible surface yet, so the
  paid calls are not made until (a) lands.
- Never surfaces enriched prose directly to the player — the existing overhear/gossip pathways
  remain the only route from a hidden scene to the player's knowledge.
- Budget-capped — at most ``MAX_SCENES_PER_TICK`` scenes voiced per tick; skeletons beyond
  that budget retain their deterministic template.
- Idempotent — writing the same texture twice is harmless; the last write wins.

0062 zeitgeist consumer (BE-103 close-out — the G5 gap): docs/features/0062-world-snapshot-zeitgeist.md
§5 requires off-screen society/gossip prompts to also receive the frozen move-in zeitgeist, so two
houseguests' off-screen scene reads from the SAME shared world the player does. ``run_enrich`` fetches
``worldSnapshotView().offscreenPrompt`` ONCE per tick (fail-soft: any failure or ``None`` snapshot ⇒ ""),
and every scene voiced that tick is handed the same block. Flavor only — never a game input, never
persisted anywhere but the voiced prose itself (§6).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

def enrichment_enabled() -> bool:
    """#1936 — the enrichment is OFF by default: its prose is never shown to the player, so the paid calls
    buy nothing (option (b) of the audit). Flip `offscreen_texture_enrichment` on only once the voiced
    prose is routed into a player-visible overhear/gossip surface. Fail-closed on any settings hiccup."""
    try:
        from src.settings import get_setting
        return bool(get_setting("offscreen_texture_enrichment", False))
    except Exception:
        return False


# Hard cap: voice at most this many scenes per off-screen tick. Each voicing is one LLM call;
# the parallel fan-out keeps latency low but we bound the total call count per tick.
MAX_SCENES_PER_TICK = 6

LlmFn = Callable[[list], Awaitable[str]]           # messages -> completion text ("" on failure)
GetSkeletonsFn = Callable[[], Awaitable[list]]      # () -> list[OffscreenSceneSkeleton]
WriteFn = Callable[[str, str], Awaitable[dict]]     # (eventId, content) -> { ok: bool }
GetZeitgeistFn = Callable[[], Awaitable[str]]       # () -> the offscreen-channel zeitgeist block ("" if none)


# ── Prompt helpers ────────────────────────────────────────────────────────────────────────────────

def _voicing_messages(nature: str, participants: list[str], template: str, zeitgeist: str = "") -> list[dict]:
    """Build a tight LLM prompt to voice one off-screen scene skeleton as vivid in-character prose.
    The prompt is Vault-free: it only receives the PUBLIC nature + participant ids + the existing
    template + the optional shared move-in zeitgeist block (0062 §5) — no relationship numbers, no
    hidden attributes, no soul data. ``zeitgeist`` is the engine's already-rendered, already-Vault-free
    off-screen-channel block; an empty string (no snapshot captured, or the fail-soft path) omits the
    section entirely — byte-identical to the pre-0062-wiring prompt."""
    part_str = " and ".join(f"houseguest {p}" for p in participants[:2])
    system = (
        "You are voicing a short behind-the-scenes beat from a reality-TV social game. "
        "You are given two houseguests, the nature of their off-screen interaction, and a bare "
        "template phrase. Your job: expand it into ONE vivid, in-character prose sentence (30–70 words) "
        "describing what this scene LOOKED and FELT like — the physical setting, tone, and subtext — "
        "without revealing any hidden intent or relationship number. Stay ambiguous about who 'won' the "
        "exchange. No names: refer to participants only as 'the two houseguests', 'one of them', 'the other'. "
        "Output ONLY the one sentence, no preamble, no quotes."
    )
    user = (
        f"Scene nature: {nature}\n"
        f"Participants: {part_str}\n"
        f"Template: {template}\n"
    )
    if zeitgeist:
        user += (
            f"\nThe world they moved in with (optional color — reach for it only if it fits naturally, "
            f"never force it):\n{zeitgeist}\n"
        )
    user += "\nWrite one vivid prose sentence for this off-screen moment:"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _sanitize_prose(text: str, max_chars: int = 400) -> str:
    """Collapse whitespace and cap length — the same C8 pattern used throughout the engine seams."""
    import re
    return re.sub(r'\s+', ' ', (text or "")).strip()[:max_chars]


# ── Core orchestrator ─────────────────────────────────────────────────────────────────────────────

async def voice_scene(sk: dict, llm_fn: LlmFn, write_fn: WriteFn, zeitgeist: str = "") -> bool:
    """Voice one off-screen scene skeleton and write the result back. Returns True if the write-back
    was accepted. Fail-soft: any error returns False (the template content stands). ``zeitgeist`` is
    the shared move-in world block (0062 §5) — optional, empty when no snapshot was ever captured."""
    try:
        msgs = _voicing_messages(
            nature=sk.get("nature", "conversation"),
            participants=sk.get("participants", []),
            template=sk.get("templateContent", ""),
            zeitgeist=zeitgeist,
        )
        raw = await llm_fn(msgs)
        prose = _sanitize_prose(raw or "")
        if not prose:
            return False
        result = await write_fn(sk["eventId"], prose)
        return bool(result.get("ok"))
    except Exception as exc:  # failsoft-ok: handled-by-terminal (per-scene fault returned as False; run_enrich AGGREGATES the failed count and RED-records ONCE per tick when failed>0 — one record per tick, not per scene; the deterministic template stands)
        logger.debug("[offscreen-texture] voice_scene failed for %s: %s", sk.get("eventId"), exc)
        return False


async def enrich_tick(get_skeletons_fn: GetSkeletonsFn, llm_fn: LlmFn, write_fn: WriteFn,
                       get_zeitgeist_fn: Optional[GetZeitgeistFn] = None) -> dict:
    """Fan out: read skeletons for the current tick, voice each in parallel (budget-capped), write
    them back. Returns a summary dict. Never raises — any failure is logged and skipped.

    ``get_zeitgeist_fn``, if given, is called ONCE per tick to fetch the shared move-in world block
    (0062 §5, the G5 close-out) and every scene voiced this tick receives the SAME block — fail-soft:
    any error or falsy result resolves to "" (byte-identical to omitting the arg)."""
    try:
        skeletons = await get_skeletons_fn()
    except Exception as exc:
        # #1599: a skeleton READ that RAISES is a genuine engine/transport fault (an empty roster
        # returns [], not a raise) — surface it RED; the deterministic templates stand. enrich_tick
        # swallows-and-returns here (run_enrich's terminal only ledgers a RAISE), so record directly.
        logger.warning("[offscreen-texture] getOffscreenSceneSkeletons failed: %s", exc)
        try:
            from src import log_rings
            log_rings.record_soft_failure("offscreen-texture:skeletons-read-failed", exc,
                                          corrected="deterministic-templates")
        except Exception:  # pragma: no cover — failsoft-ok: recorder-self
            pass
        return {"voiced": 0, "total": 0, "error": str(exc)}

    if not isinstance(skeletons, list) or not skeletons:
        return {"voiced": 0, "total": 0}

    # Budget-cap: take the first MAX_SCENES_PER_TICK skeletons only.
    batch = skeletons[:MAX_SCENES_PER_TICK]
    total = len(batch)

    zeitgeist = ""
    if get_zeitgeist_fn is not None:
        try:
            zeitgeist = await get_zeitgeist_fn() or ""
        except Exception as exc:  # failsoft-ok: flavor-only (0062 §6) — never blocks voicing
            logger.debug("[offscreen-texture] zeitgeist fetch failed: %s", exc)
            zeitgeist = ""

    tasks = [voice_scene(sk, llm_fn, write_fn, zeitgeist=zeitgeist) for sk in batch]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    voiced = sum(1 for r in results if r is True)

    logger.debug("[offscreen-texture] tick voiced %d/%d scenes", voiced, total)
    return {"voiced": voiced, "total": total}


# ── Live wiring (best-effort; graceful no-op when no model) ──────────────────────────────────────

async def run_enrich(owner: Optional[str] = None) -> dict:
    """Resolve the live deps and enrich the current tick's off-screen scenes. Silent no-op (not
    voiced) when no model resolves — the engine's deterministic template content stands.

    Called from the FE after each off-screen tick (via :func:`kickoff_enrich` from ``do_advance_game``).
    Best-effort + background — never blocks the game advance. Uses the SAME proven plumbing as the
    other FE-driven write-backs: the shared utility-LLM resolver (``orwell_cast_authoring``) and the
    engine player-channel client (``orwell_engine``).

    #1936: a no-op unless `offscreen_texture_enrichment` is on — checked FIRST, before any model resolve, so
    no LLM call is made and the strict enrichment policy records no "unwired class" failure for it."""
    if not enrichment_enabled():
        return {"voiced": 0, "total": 0, "reason": "disabled"}
    strict = False
    try:
        from src import enrichment_policy
        strict = enrichment_policy.is_strict()
    except Exception:
        strict = False
    try:
        from src.orwell_cast_authoring import _resolve_llm_fn  # the shared background-utility completion
    except Exception:
        return {"voiced": 0, "total": 0, "reason": "no-model"}

    llm_fn = await _resolve_llm_fn(owner)
    if llm_fn is None:
        # STRICT enrichment policy (owner directive 2026-07-11): an unwired class is a LOUD failure —
        # an ERROR + an admin-visible ledger entry. Soft: the legacy silent debug line, byte-identical.
        if strict:
            enrichment_policy.record_failure(
                owner, "offscreen-texture", "no model resolved for the off-screen-texture call class",
                detail="the deterministic templates must not stand silently under the strict policy")
        else:
            logger.debug("[offscreen-texture] no utility model — keeping the deterministic templates")
        return {"voiced": 0, "total": 0, "reason": "no-model"}

    from src import orwell_engine

    async def get_skeletons() -> list:
        return await orwell_engine.get_offscreen_scene_skeletons(user=owner)

    async def write_back(event_id: str, content: str) -> dict:
        return await orwell_engine.record_offscreen_scene_texture(event_id, content, user=owner)

    # G5 close-out (BE-103): read the frozen move-in zeitgeist's off-screen-channel block (0062 §5) so
    # off-screen society/gossip prose is colored by the SAME shared world the player's own scenes are.
    # Fail-soft + flavor-only (§6) — a read failure or an absent snapshot just yields "" (byte-identical
    # to the pre-wiring prompt); it never blocks voicing.
    async def get_zeitgeist() -> str:
        try:
            view = await orwell_engine.world_snapshot_view(user=owner)
        except Exception as exc:
            # #1599 loud fail-soft: a genuine worldSnapshotView read fault is a real error on a
            # risk surface — record it RED-eligible (WARNING) rather than swallow it, matching the
            # skeletons-read/enrich-run siblings. Flavor-only ⇒ auto-corrected to the un-colored
            # prompt (byte-identical to pre-wiring); it never blocks voicing.
            logger.warning("[offscreen-texture] worldSnapshotView failed: %s", exc)
            try:
                from src import log_rings
                log_rings.record_soft_failure("offscreen-texture:zeitgeist-read-failed", str(exc),
                                              corrected="uncolored-prompt", user=owner)
            except Exception:  # pragma: no cover — failsoft-ok: recorder-self
                pass
            return ""
        if not isinstance(view, dict):
            return ""
        return view.get("offscreenPrompt") or ""

    try:
        result = await enrich_tick(get_skeletons, llm_fn, write_back, get_zeitgeist_fn=get_zeitgeist)
    except Exception as exc:
        # #1599 (CodeRabbit): a whole-tick enrichment CRASH must show RED regardless of policy. The
        # strict branch already RED-records via enrichment_policy.record_failure → record_overseer(ok=False);
        # under the DEFAULT (non-strict) policy the crash would otherwise only LOG, so record it RED here.
        # Split by policy (exactly one RED record per policy — never a double). enrich_tick's OWN skeleton-read
        # failure is already recorded inside it and returns a dict WITHOUT raising, so it never reaches here.
        logger.warning("[offscreen-texture] run_enrich failed: %s", exc)
        if strict:
            enrichment_policy.record_failure(
                owner, "offscreen-texture", "off-screen texture enrichment failed", detail=str(exc))
        else:
            try:
                from src import log_rings
                log_rings.record_soft_failure("offscreen-texture:enrich-run-failed", str(exc),
                                              corrected="deterministic-templates", user=owner)
            except Exception:  # pragma: no cover — failsoft-ok: recorder-self
                pass
        return {"voiced": 0, "total": 0, "error": str(exc)}
    # #1599 (Greptile P1): ANY per-scene voicing fault must show RED — voice_scene absorbs each LLM/write
    # fault as False, so a PARTIAL run (some voiced, some failed) would otherwise reach no recorder. Record
    # ONE RED per tick when failed>0 (aggregated, not per-scene); this SUBSUMES the 0/N complete-failure
    # case (voiced==0 ⇒ failed==total). RED-but-auto-corrected: the deterministic templates stand. The
    # except/crash path above returns total=0 ⇒ failed=0, so it stays covered there (no double-record).
    failed = 0
    if isinstance(result, dict):
        failed = int(result.get("total") or 0) - int(result.get("voiced") or 0)
    if failed > 0:
        try:
            from src import log_rings
            log_rings.record_soft_failure(
                "offscreen-texture:enrich-run-failed",
                f"{failed} of {result.get('total')} off-screen scene(s) failed to voice this tick",
                corrected="deterministic-templates", user=owner)
        except Exception:  # pragma: no cover — failsoft-ok: recorder-self
            pass
    # #617: voiced texture landed on the live game — push a server-side "game-updated" so open
    # pages reconcile now instead of waiting for the next poll. Best-effort/fail-soft.
    if isinstance(result, dict) and result.get("voiced"):
        try:
            from src import orwell_game_session
            orwell_game_session.publish_game_updated(owner)
        except Exception:
            pass
    return result


# Per-user in-flight guard: prevents a second advance from launching an overlapping enrichment run
# for the same user while one is still voicing. Cleared in `finally`, so the NEXT tick runs normally.
_IN_FLIGHT: set[str] = set()


def _key(owner: Optional[str]) -> str:
    return owner or "default"


def kickoff_enrich(owner: Optional[str] = None) -> None:
    """Fire-and-forget the off-screen texture enrichment in the background after an advance tick.
    Never blocks the advance; never raises into the caller. A per-user in-flight guard drops a second
    overlapping run for the same user (the next tick, after this one finishes, runs normally)."""
    if not enrichment_enabled():  # #1936 — don't even schedule a task (no model resolve, no engine read)
        return
    k = _key(owner)
    if k in _IN_FLIGHT:
        return
    _IN_FLIGHT.add(k)

    async def _runner():
        try:
            await run_enrich(owner)
        except Exception as e:  # pragma: no cover - defensive
            # #1599: run_enrich records its own failures but its resolver call is un-wrapped; a raise
            # here means the whole tick silently degraded with no record — surface it RED. Templates stand.
            logger.warning("[offscreen-texture] background enrichment failed: %s", e)
            try:
                from src import log_rings
                log_rings.record_soft_failure("offscreen-texture:background-run-failed", e,
                                              corrected="deterministic-templates", user=owner)
            except Exception:  # pragma: no cover — failsoft-ok: recorder-self
                pass
        finally:
            _IN_FLIGHT.discard(k)

    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_runner())
    except RuntimeError:
        # No running loop (a sync caller / test) — run to completion synchronously.
        try:
            asyncio.run(_runner())
        except Exception:  # pragma: no cover - defensive
            _IN_FLIGHT.discard(k)
