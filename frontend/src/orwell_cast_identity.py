"""Issue #544 — the AI-driven half of the 0063 diversity floor (the 2026-06-23 owner ruling). The FE
producer-LLM PROPOSES each houseguest's DESCRIPTIVE identity facets — heritage/ethnicity, gender
presentation, orientation, disclosure, age — targeting real U.S.-population minority rates, and writes
them BACK to the engine. The ENGINE validates + REPAIRS the whole-cast proposal against the proportional
targets already in `diversityConstants.ts`, so even a lazy/biased/monochrome model can never skew the cast.

    engine pre-seeds the player-INDEPENDENT cast + returns the Vault-free roster (preSeedCast)
      → THIS module: the producer-LLM proposes the cast's identity facets to U.S. rates (cohering with
        each houseguest's name / hometown / vocation / age)
      → recordCastIdentity writes them back; the engine VALIDATES/REPAIRS/FOLDS them (re-grounding skin
        tone from the final heritage) — the engine stays the source of truth
      → only THEN does deep authoring (orwell_cast_authoring) run, so the authored look + secrets read the
        AI-seeded heritage; and portraits read the finished store. (pipeline order: identity → author → shoot.)

THE HARD BOUNDARY (anti-sycophancy #3): this proposes ONLY descriptive identity — NEVER a hidden game
weight. Each NPC's seeded Day-1 read of the player + competition leans stay engine-owned (the juryReach
calibration depends on the engine's net-zero-balanced seed). AI drives WHO the houseguests are; the engine
drives the MATH of how they play.

Design: the orchestrator (`seed_cast_identity`) takes INJECTED `llm_fn` + `write_fn`, so the whole pipeline
is unit-testable without a live model or engine. `kickoff_identity` wires the real deps and runs it in the
BACKGROUND — game start never blocks on it, and a missing/failed model is a silent no-op (the engine's
deterministic weighted floor, PR #527, simply stands — graceful degradation). This module never seals
anything; the engine owns the wall + the guarantee.
"""
from __future__ import annotations

import json
import re
from typing import Awaitable, Callable, Optional

try:  # the structured logger if present; a no-op stand-in keeps this importable in isolation
    from loguru import logger
except Exception:  # pragma: no cover
    class _L:  # minimal fallback
        def info(self, *a, **k): pass
        def warning(self, *a, **k): pass
        def debug(self, *a, **k): pass
    logger = _L()


# ── the recognized facet vocabulary (mirrors src/engine/diversityConstants.ts) ─────────────────────────
# The ENGINE is the authority — it ignores anything it doesn't recognize and repairs the distribution — so
# this vocabulary only shapes the prompt + a light FE pre-filter. Keep it in sync with the engine pools.
_HERITAGES = (
    # BIPOC (the engine grounds skin tone from these)
    "Black American", "Nigerian American", "Caribbean American", "Mexican American", "Puerto Rican",
    "Dominican American", "Chinese American", "Filipino American", "Korean American",
    "South Asian American", "Vietnamese American", "Native American", "Middle Eastern American",
    "multiracial",
    # non-BIPOC
    "Irish American", "Italian American", "Polish American", "German American", "Greek American",
    "Scandinavian American",
)
_GENDERS = ("man", "woman", "nonbinary")
_ORIENTATIONS = ("straight", "gay", "lesbian", "bisexual", "queer", "pansexual")

_MIN_AGE = 21  # the engine's AGE_ELIGIBILITY_FLOOR; a sub-floor age is dropped (engine keeps the seeded age)


# ── the producer-framed identity prompt (descriptive identity ONLY — never a game weight) ──────────────
#
# We tell the model to MATCH actual U.S.-population minority rates across race/ethnicity, gender, sex, and
# sexuality (the owner's words), and to make each houseguest's identity COHERE with their name, hometown,
# vocation, and age. The engine repairs the distribution regardless, but a good seed makes the cast vary
# game-to-game and read as real people. NOTHING about hidden weights / the player is in this prompt.
_SYSTEM = (
    "You are a Big Brother CASTING PRODUCER assigning each houseguest's real-life DESCRIPTIVE IDENTITY so "
    "the cast reflects the actual United States. Output STRICT JSON only (no prose around it): an object "
    "mapping each houseguest's id to an object with these OPTIONAL keys:\n"
    '  "ethnicity": their heritage / cultural background, chosen from this list EXACTLY: '
    + ", ".join(_HERITAGES) + ".\n"
    '  "genderPresentation": one of "man", "woman", "nonbinary".\n'
    '  "orientation": one of "straight", "gay", "lesbian", "bisexual", "queer", "pansexual".\n'
    '  "out": true if their orientation is publicly known, false if they hold it privately (only matters '
    "for a non-straight orientation).\n"
    f'  "age": an integer age, at least {_MIN_AGE}.\n'
    "MATCH REAL U.S. POPULATION RATES across the WHOLE cast — race/ethnicity, gender, sex, and sexuality: "
    "the cast should be majority non-BIPOC but with a realistic minority of Black, Hispanic/Latino, Asian, "
    "and other heritages (about 40% BIPOC overall); roughly balanced men and women with at most one "
    "nonbinary houseguest; mostly straight with a realistic LGBTQ+ minority (a young reality cast skews a "
    "bit queerer than the national average); and a spread of ages (mostly 20s-30s with a genuine handful "
    "in their 40s+). Do NOT make a monochrome or quota cast — make it look like a real American crew.\n"
    "COHERE each houseguest's identity with their NAME, HOMETOWN, VOCATION, and AGE in the roster (a name, "
    "a region, a job, a life-stage that fit the heritage and the person). Vary it widely across the cast. "
    "Assign every houseguest in the roster. JSON only."
)


def build_identity_messages(cast: list[dict]) -> list[dict]:
    """The producer prompt for the WHOLE cast. Seeds the LLM with each houseguest's PUBLIC roster facets
    (id + name + the public origin facts) and NOTHING about the player — the cast identity is proposed
    independently of the player (anti-sycophancy, mandate #3). Returns chat messages for the utility model."""
    roster = []
    for n in (cast or []):
        hid = n.get("id")
        if not hid or hid == "player":
            continue
        roster.append({
            k: n.get(k)
            for k in ("id", "name", "age", "vocation", "hometown", "archetype", "demeanor")
            if n.get(k) is not None
        })
    user = (
        "Assign descriptive identity to this cast so it reflects the real United States. Build FROM each "
        "roster entry (name / hometown / vocation / age) — never contradict it.\n"
        f"Roster: {json.dumps(roster, ensure_ascii=False)}\n"
        "Return the id->facets JSON now (match U.S. population rates across the whole cast)."
    )
    return [{"role": "system", "content": _SYSTEM}, {"role": "user", "content": user}]


def _first_json_object(s: str) -> Optional[dict]:
    """Decode the FIRST COMPLETE (balanced) JSON object in ``s``, scanning from the first ``{`` with
    ``raw_decode`` (which decodes exactly ONE value and STOPS at its end). This is the fix for the
    gender-drop bug: the identity utility model sometimes emits its object TWICE (``{obj}{obj}``), and
    the old brittle first-``{``→last-``}`` SLICE spliced that into ``{obj}{obj}`` — invalid JSON — so
    ``json.loads`` raised, the whole parse collapsed to ``None`` → ``{}``, ``recordCastIdentity`` was
    never called, and the engine's post-genesis gender re-cohere (#1140) never ran, shipping the stale
    floor gender for 8/15 houseguests. ``raw_decode`` from the first ``{`` yields the FIRST object of a
    ``{obj}{obj}`` reply. Chatter/garbage that fails to decode at a ``{`` is skipped by advancing to the
    next ``{`` and retrying."""
    decoder = json.JSONDecoder()
    idx = s.find("{")
    while idx != -1:
        try:
            obj, _end = decoder.raw_decode(s, idx)
        except ValueError:
            idx = s.find("{", idx + 1)
            continue
        if isinstance(obj, dict):
            return obj
        # Decoded a valid non-object value at this `{` (unreachable — `{` opens an object) — keep looking.
        idx = s.find("{", idx + 1)
    return None


def _extract_json(text: str) -> Optional[dict]:
    """Pull the first COMPLETE JSON object out of the model's reply (tolerant of ```json fences, leading/
    trailing chatter, AND a model that emits its object twice — ``{obj}{obj}``). Prefers a fenced block
    when present, else scans the whole reply. Robust by construction — never a first-``{``→last-``}`` slice
    (which corrupts a doubled/concatenated object into invalid JSON; see ``_first_json_object``)."""
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    if fenced:
        obj = _first_json_object(fenced.group(1))
        if obj is not None:
            return obj
    return _first_json_object(text)


def parse_identity_facets(text: str, valid_ids: set[str]) -> dict:
    """Parse the LLM reply into a recordCastIdentity ``facets`` map, keeping ONLY recognized values for
    KNOWN houseguest ids. A light FE pre-filter mirroring the engine's validation (the engine repairs the
    distribution regardless, so this is best-effort): an unknown heritage/orientation/gender, a sub-floor
    age, or an unknown id is dropped. Returns ``{}`` when nothing usable was proposed (the floor stands)."""
    obj = _extract_json(text)
    if obj is None:
        return {}
    out: dict = {}
    for raw_id, raw in obj.items():
        hid = str(raw_id)
        if hid not in valid_ids or hid == "player" or not isinstance(raw, dict):
            continue
        one: dict = {}
        eth = raw.get("ethnicity")
        if isinstance(eth, str) and eth.strip() in _HERITAGES:
            one["ethnicity"] = eth.strip()
        gp = raw.get("genderPresentation")
        if isinstance(gp, str) and gp.strip() in _GENDERS:
            one["genderPresentation"] = gp.strip()
        orientation = raw.get("orientation")
        if isinstance(orientation, str) and orientation.strip() in _ORIENTATIONS:
            one["orientation"] = orientation.strip()
        if isinstance(raw.get("out"), bool):
            one["out"] = raw["out"]
        age = raw.get("age")
        if isinstance(age, (int, float)) and not isinstance(age, bool) and int(age) >= _MIN_AGE:
            one["age"] = int(age)
        if one:
            out[hid] = one
    return out


# ── the orchestrator (injectable — fully unit-testable) ────────────────────────

LlmFn = Callable[[list[dict]], Awaitable[str]]
WriteFn = Callable[[dict], Awaitable[dict]]


async def seed_cast_identity(cast: list[dict], llm_fn: LlmFn, write_fn: WriteFn) -> int:
    """Propose the WHOLE cast's identity in ONE call → parse → write back (recordCastIdentity). Best-effort:
    any failure leaves the engine's deterministic weighted floor in place (graceful degradation). Returns
    how many houseguests had a facet applied (per the engine's Vault-free ``applied`` count), or 0.

    The PLAYER is skipped (only the player's profile is human-authored). The engine owns the wall + the
    realism GUARANTEE (validate/repair); this only proposes + forwards. No player identity is threaded in —
    the cast identity is proposed player-independently (anti-sycophancy, mandate #3)."""
    valid_ids = {str(n.get("id")) for n in (cast or []) if n.get("id") and n.get("id") != "player"}
    if not valid_ids:
        return 0
    try:
        text = await llm_fn(build_identity_messages(cast))
    except Exception as e:  # failsoft-ok: handled-by-terminal (run_identity records the seeded-nothing failure via enrichment_policy.record_failure RED under the default strict policy)
        logger.warning(f"[cast-identity] llm failed: {e}")
        return 0
    facets = parse_identity_facets(text or "", valid_ids)
    if not facets:
        logger.debug("[cast-identity] nothing usable proposed — keeping the seeded floor")
        return 0
    try:
        res = await write_fn(facets)
    except Exception as e:  # failsoft-ok: handled-by-terminal (run_identity records the seeded-nothing failure via enrichment_policy.record_failure RED under the default strict policy)
        logger.warning(f"[cast-identity] write-back failed: {e}")
        return 0
    if not (isinstance(res, dict) and res.get("accepted")):
        _reason = res.get("reason") if isinstance(res, dict) else f"non-dict result ({type(res).__name__})"
        logger.warning(f"[cast-identity] write-back not accepted: {_reason or 'accepted=false'}")
        return 0
    applied = int(res.get("applied") or 0)
    logger.info(f"[cast-identity] seeded identity for {applied} houseguest(s)")
    return applied


# ── the live wiring (best-effort, background; graceful no-op when no model) ─────

async def _resolve_llm_fn(owner: Optional[str]) -> Optional[LlmFn]:
    """Reuse the shared utility-LLM resolver (background-safe, image-model-filtered, token-metered) the
    cast-authoring driver uses. Returns None when no usable text model resolves — identity seeding then
    silently no-ops and the engine's deterministic floor stands."""
    try:
        from src.orwell_cast_authoring import _resolve_llm_fn as _shared
    except Exception:
        return None
    return await _shared(owner)


async def run_identity(cast: list[dict], owner: Optional[str], *,
                       write: Optional[WriteFn] = None) -> int:
    """Resolve the live deps and seed the cast's identity. Under the `soft` enrichment policy a
    missing model / failed seed is the legacy silent no-op (returns 0) — the engine's deterministic
    floor stands byte-identically. Under the DEFAULT `strict` policy (owner directive 2026-07-11)
    the failure is LOUD: an ERROR + an admin-visible failure-ledger entry. No player identity is
    threaded in — the cast identity is proposed player-independently."""
    strict = False
    try:
        from src import enrichment_policy
        strict = enrichment_policy.is_strict()
    except Exception:
        strict = False
    llm_fn = await _resolve_llm_fn(owner)
    if llm_fn is None:
        if strict:
            enrichment_policy.record_failure(
                owner, "cast-identity", "no model resolved for the cast-identity call class",
                detail="the deterministic identity floor must not stand silently under the strict policy")
        else:
            logger.debug("[cast-identity] no utility model — keeping the seeded floor")
        return 0
    from src import orwell_engine

    async def _write(facets: dict) -> dict:
        return await orwell_engine.record_cast_identity(facets, user=owner)

    applied = await seed_cast_identity(cast, llm_fn, write or _write)
    # STRICT: a run that seeded NOTHING (llm failure / nothing usable / refused write-back — all
    # already logged inside seed_cast_identity) is ledgered loudly. Soft: byte-identical legacy.
    if strict and not applied and cast:
        enrichment_policy.record_failure(
            owner, "cast-identity", "cast-identity seeding applied nothing (model or write-back failed)",
            detail="the engine's deterministic identity floor stands, but the failure is loud + ledgered")
    return applied


def kickoff_identity(cast: list[dict], owner: Optional[str],
                     then: Optional[Callable[[], None]] = None,
                     write: Optional[WriteFn] = None) -> None:
    """Fire-and-forget: seed the cast's AI-driven identity in the background BEFORE deep authoring (so the
    authored look + secrets read the AI-seeded heritage, and the engine has re-grounded skin tone), then
    call `then` (e.g. the authoring kickoff) REGARDLESS of success — so authoring + portraits still run from
    the engine's deterministic floor if the model was unavailable. Never blocks game start; never raises.

    Synchronous from the engine's perspective: identity → author → shoot is the pipeline ORDER, but each
    stage is best-effort and the engine's floor makes every stage degrade gracefully on a missing model."""
    import asyncio

    async def _runner():
        try:
            await run_identity(cast, owner, write=write)
        except Exception as e:  # pragma: no cover - defensive
            # #1599: run_identity records its OWN failures + never expects to raise; if it DID
            # (an un-wrapped resolver raise), the whole cast-identity seed silently degraded with
            # no record — surface it RED. The engine's deterministic identity floor stands.
            logger.warning(f"[cast-identity] background run failed: {e}")
            try:
                from src import log_rings
                log_rings.record_soft_failure("cast-identity:background-run-failed", e,
                                              corrected="seeded-identity-floor", user=owner)
            except Exception:  # pragma: no cover — failsoft-ok: recorder-self
                pass
        finally:
            if then is not None:
                try:
                    then()
                except Exception:
                    pass
    try:
        loop = asyncio.get_running_loop()
        loop.create_task(_runner())
    except RuntimeError:
        # No running loop (e.g. a sync caller / test) — run to completion synchronously, then chain.
        try:
            __import__("src.llm_core", fromlist=["run_isolated"]).run_isolated(_runner())
        except Exception:
            if then is not None:
                then()
