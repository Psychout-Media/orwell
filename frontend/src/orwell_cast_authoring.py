"""Feature 0058 / ledger L28b — the producer-LLM authors each NPC's rich backstory, written BACK
to the engine (the airtight source of truth). Mirrors the 0051 portrait handshake:

    engine seeds the deterministic floor + returns the Vault-free cast
      → the FE producer-LLM authors each houseguest's §3-depth profile (endless variety)
      → the FE writes it back via recordCastProfile (the engine validates / splits across the
        Vault Wall / re-derives threads / re-seals) — the engine is now the source of truth
      → only THEN do the authored physical facets feed the portrait prompts (pipeline order).

Design: the orchestrator (`author_cast`) takes INJECTED `llm_fn` + `write_fn`, so the whole
pipeline is unit-testable without a live model or engine. `kickoff_authoring` wires the real
deps (the AUTHORING model — narration-first by default since the 2026-07-11 owner directive, with
the utility chain as the explicit fallback; see `resolve_authoring_llm_fn`) and runs it in the
BACKGROUND — game start never blocks on it. Under the `soft` enrichment policy a missing/failed
model is a silent no-op (the seeded floor stays authoritative, exactly like portraits degrade
gracefully); under the DEFAULT `strict` policy the failure is LOUD (see `src.enrichment_policy`:
game creation refuses on an unwired class, and every failure lands in the admin failure ledger).

The HARD guarantees are the engine's (it validates non-player-mirroring, splits PUBLIC↔HIDDEN,
never echoes a hidden value). This module only authors + forwards; it never seals anything.
"""
from __future__ import annotations

import asyncio
import contextlib
import contextvars
import json
import os
import re
import time
from typing import Awaitable, Callable, Optional, Union

try:  # the structured logger if present; a no-op stand-in keeps this importable in isolation
    from loguru import logger
except Exception:  # pragma: no cover
    class _L:  # minimal fallback
        def info(self, *a, **k): pass
        def warning(self, *a, **k): pass
        def error(self, *a, **k): pass
        def debug(self, *a, **k): pass
    logger = _L()

from src import orwell_cast_rules as R  # ORW-956: the one table of rules the prompt and the checks are built from
from src.orwell_cast_gate import BIO_ASK_CHARS  # ORW-952: the prompt states the length the gate checks


# ── ORW-380: the PHOTO SHEET instruction, shared by every writer ──────────────────────────────
#
# One text, used by new-cast authoring (`_SYSTEM`) and by the running-season upgrader / the new-cast
# de-duplication pass (`PHOTO_SHEET_SYSTEM`). The checker below (`look_problems`) enforces the same rules.
_ONCAMERA_BANNED_WORDS = R.ONCAMERA_BANNED_WORDS  # ORW-956: the word lists live in the rules table, which prints them in the prompt
_PHOTOHAIR_BANNED_WORDS = R.PHOTOHAIR_BANNED_WORDS
# ORW-956: the example clauses of the rule sentences stay here (the short-list guard allowlists example lines in this file only).
_RULE_EXAMPLES = {
    "ex:main-piece": ', for example "leather jacket" or "flannel shirt"',
    "ex:photohair": (' (for example "sleek neat braid over one shoulder", "glossy waves swept into a high ponytail", '
                     '"buzzed close with a clean line-up")'),
    "ex:build": " (for example broad-shouldered with willowy)",
    "ex:posture": ' (not "He stands", "She stands", "He leans")',
}
# ORW-956: every rule sentence below is printed from the ONE table of rules (orwell_cast_rules.SENTENCES), the same table the checks
# (`look_problems` and the gate) take their thresholds and codes from.
_PHOTO_SHEET_TEMPLATE = (
    "PHOTO SHEET: three optional fields that say how this person looks on the day of the cast photo "
    "shoot. They are public and describe only what a camera sees. Use the houseguest's name and "
    "genderPresentation from the input: pronouns in every line must match it (man: he/him; woman: "
    "she/her; nonbinary: they/them), and the clothes fit how this person presents. "
    "[[rule:pronouns]]"
    "[[rule:wardrobe-shape]][[rule:wardrobe-garment]][[rule:wardrobe-real]][[rule:wardrobe-taken]]"
    "[[rule:wardrobe-pieces]][[rule:style-family]][[rule:label-leak]]"
    "[[rule:photohair]]"
    "[[rule:oncamera]]"
    "[[rule:signature]]"
    "Colour follows the person too, not a default of black, charcoal or navy: no colour family on more than 3 of 15 main pieces, "
    "and about a third of the cast wears a pattern (stripes, plaid, a floral), a plain graphic with no words, or visible wear (faded, worn-in). "
    "When the input carries castingType, the moment, the clothes and the hair styling should make this "
    "person read as their casting type at a glance, without naming the type."
)
PHOTO_SHEET_RULES = R.render(_PHOTO_SHEET_TEMPLATE, _RULE_EXAMPLES)
PHOTO_SHEET_SYSTEM = (
    "You write the PHOTO SHEET for one reality-show houseguest from their PUBLIC profile only. "
    + PHOTO_SHEET_RULES +
    " Reply with ONLY a JSON object: {\"wardrobe\": [...], \"photoHair\": \"...\", \"onCamera\": \"...\"}."
)


# ── the producer-framed authoring prompt ──────────────────────────────────────
#
# ANTI-SYCOPHANCY (mandate #3): an NPC's STORYLINE is authored as if the player does not exist.
# Each houseguest is one of sixteen with their OWN life, rivalries, secrets, and arcs — most of the
# house's drama has nothing to do with the player. The authoring prompt therefore carries NO player
# identity at all: secrets/goals/weakness/biography must NEVER be built around, reference, or revolve
# around the player. The NPC's Day-1 read of the player is a SEPARATE concept owned entirely by the
# engine's seeded, net-zero-balanced floor (the LLM does not author it) — so the authored storyline
# cannot tilt the cast toward the player and the calibration (juryReach) balance is preserved.
_SYSTEM = R.render(
    "You are a CASTING PRODUCER for the reality show ORWELL (never call it Big Brother) building the secret bible for ONE houseguest. "
    "Write a rich, believable, reality-TV-plausible person with real depth and a life that exists "
    "ENTIRELY on its own. Output STRICT JSON only (no prose around it), with these keys:\n"
    '  "name": KEEP the houseguest\'s CURRENT name from the skeleton EXACTLY — their identity is already '
    "cast; do NOT rename or re-invent them. ONLY when the skeleton carries no name, supply a realistic, "
    "common, pronounceable FIRST and LAST name (two words), diverse and ordinary, NEVER invented/fantasy/"
    "gibberish.\n"
    '  "identityConcept": [[rule:identity-length]] naming who this exact person is, written about the '
    "name, gender, age and occupation on the card (the skeleton's identityConcept, if any, is a rough draft: rewrite it for THIS card; "
    "do not open it with \"A\" and the age, the age is already printed beside it, and open it the way an OPENING PATTERN line in the prompt says, if there is one; [[rule:identity-no-name]], and make it one complete phrase that reads as a sentence),\n"
    '  "biography": [[rule:bio-length]],\n'
    '  "vocation": echo the skeleton\'s occupation EXACTLY — it is already cast and IMMUTABLE; do NOT '
    "change it, and do NOT adopt a different job from the biography. The biography and the secrets must "
    "name the SAME job as the committed occupation (the engine keys the hidden stakes off vocation),\n"
    '  "physicalCharacteristics": { "heightBuild", "skinTone", "hair", "facialFeatures", '
    '"distinguishingMark", "ageLook", "style", "wardrobe", "lookSignature", "photoHair", "onCamera" } — short phrases '
    "[[rule:look-fields]]; this single facet is what BOTH "
    "the portrait and the narration read, so make it concrete and distinctive. The look must COHERE "
    "with the houseguest's heritage/ethnicity in the skeleton (skin tone, hair, features that fit that "
    "background) — never a generic default; vary it widely across the cast. When the skeleton shows a "
    "seeded physicalCharacteristics block, treat it as the LOOK BRIEF to sharpen — enrich each axis in "
    "your own words but keep it the SAME person. THE INK BUDGET IS FIXED: if the brief's "
    "distinguishingMark carries no tattoo, this houseguest has NO visible tattoos anywhere (not in the "
    "mark, the style, or the biography) — only a small minority of a real cast is visibly inked, and "
    "the casting office already decided who. THE MARK IS DEALT: copy the skeleton's distinguishingMark exactly as it stands "
    "(\"none notable\" stays \"none notable\"); never add a mark of your own or swap it, and never default to a tattoo (a real cast "
    "has about four marks in all, dealt so none repeats; the portrait cannot hold them as scars: no scars, birthmarks or tooth gaps), "
    "THE MARK LIVES IN distinguishingMark ONLY: never repeat it in facialFeatures, the biography or any other field (no gap-toothed grin in "
    "the face line when the mark says so), and keep the face line to bone structure and expression, "
    "STYLE AND CLOTHES START FROM THE PERSON: ask what a person of this age and job, from this hometown, with this money and "
    "personality, would really own and wear to be photographed for TV, and could buy in an ordinary shop in or near their hometown on their income, and write that. The skeleton's presentation is only a "
    "tiebreak between equal choices (a colour, a cut, one accent piece), never a theme to build the outfit from, and never blended "
    "with another family (no rocker edge layered over bohemian). Interests and hobbies in the biography come from this person's own life (job, family, town, background), never from the look: a style does not hand a person a pastime. Write \"style\" as those real clothes in a phrase. "
    + PHOTO_SHEET_RULES + " "
    "[[rule:story-matches]]"
    "[[rule:age-coherence]]"
    "[[rule:build-coherence]],\n"
    '  "voice": the houseguest\'s IDIOLECT — how THIS person talks, all season: { "register", '
    '"rhythm", "energy", "directness", "humor", "stressTell", "signature", "lexicon", "catchphrases" }. '
    'The first six are SHORT dial phrases (e.g. register "folksy", rhythm "rambling", humor "dry", '
    'stressTell "over-explains"); "signature" is ONE prose sentence capturing the texture of their talk; '
    '[[rule:voice]]; "catchphrases" is an array of 2-3 '
    'characteristic PHRASINGS this exact person falls back on — how THEY put things, grounded in their '
    'job/archetype/age (e.g. "at the end of the day", "we move", "I did not come here to make friends") — '
    'authentic verbal habits, NOT comedy bits. Ground the voice in the archetype, '
    "age, and backstory — sixteen mouths, not one; never a generic warm podcast voice. If the "
    "skeleton shows a seeded voice, treat it as the brief to sharpen, not a script to copy,\n"
    '  "secrets": an array of 2-3 real secrets that could play out,\n'
    '  "trueGoals": an array of 2 true strategic goals (distinct from any public game),\n'
    '  "weakness": one named blind spot the game can exploit on a delay.\n'
    "GROUND EVERYTHING IN THIS SPECIFIC PERSON (the core requirement): the secrets, true goals, and "
    "weakness must be authored FROM this houseguest's OWN backstory, OCCUPATION, ARCHETYPE, and AGE in "
    "the public skeleton — a private chef's secret should read like a private chef's, a firefighter's "
    "weakness like a firefighter's, a 23-year-old's stakes unlike a 50-year-old's. Make the hidden life "
    "cohere with the job and the life-stage; never a generic, interchangeable secret that could belong "
    "to anyone. Their threads may involve OTHER houseguests, pre-show ties, or personal stakes.\n"
    "Hard rules: this houseguest's STORYLINE is fully INDEPENDENT — their secrets, goals, weakness, "
    "and backstory exist on their own but must NEVER be built around, reference, or revolve around any "
    "single 'player' or main character; there is no protagonist here, only a cast of equals. Make this "
    "person VISIBLY distinct from a generic warm, witty professional.\n"
    "CARD TEXT CHECKS (HARD): [[rule:bio-no-stop]] [[rule:identity-story]] [[rule:no-copy]]\n"
    "OUTPUT CONTRACT (HARD, #1002): reply with a SINGLE raw JSON object and NOTHING else — no prose, "
    "no markdown, no ```json fences, no preamble, no chain-of-thought in the body. The first character "
    "of your reply MUST be '{' and the last MUST be '}'. JSON only.",
    _RULE_EXAMPLES,
)

# #1002: the OpenAI/OpenRouter structured-output request — threaded onto the authoring call so a model
# that honours it returns strict JSON (no prose/reasoning leaking into the body). A provider that
# ignores it is harmless: the prompt reinforcement above + the one-shot retry below still apply.
_RESPONSE_FORMAT = {"type": "json_object"}


def _response_format_for(messages) -> Optional[dict]:
    """ORW-391: JSON mode only for a prompt that asks for JSON. DeepSeek (the OOB utility model) answers 400 "Prompt must contain the word 'json'" to a json_object request whose prompt does not, and the shared utility fn
    is also used for PROSE calls (the ORW-271 day condense): that call failed after every bedtime and the day was never condensed. Any message mentioning "json" (any case) keeps the format exactly as before."""
    try:
        from src.llm_core import messages_mention_json
        return _RESPONSE_FORMAT if messages_mention_json(messages) else None
    except Exception:
        return _RESPONSE_FORMAT

# #1044: the SHARED background-utility sampling temperature. This module's `_resolve_llm_fn` is the
# common resolver for several background lanes (zeitgeist / off-screen texture / identity / the gateway
# narrator fallback), and THOSE calls keep this moderate value — a high temperature measurably hurt
# strict-JSON adherence on reasoning models (deepseek-v4-pro) for complex structured prompts.
# CAST AUTHORING ITSELF no longer uses this default: it reads the runtime-editable
# `cast_authoring_temperature` knob below (owner directive 2026-07-11 — hot character generation out of
# the box on the narration model), passed per-run through `resolve_authoring_llm_fn`.
_AUTHOR_TEMPERATURE = 0.6

# #1713 — the per-call WALL-CLOCK ceiling for an authoring/genesis STREAM. `stream_llm_with_fallback`
# has no equivalent of `llm_core._bounded_impl_call`'s wall-clock wrap (that fix covers only the
# non-streaming `llm_call_async` chokepoint): its per-chunk httpx read-timeout RESETS on any received
# byte, so a provider that trickles keep-alive padding while contended/stalled never trips it, and the
# call inherits `stream_llm_with_fallback`'s narration-sized default ceiling (`LLMConfig.STREAM_TIMEOUT`
# = 300s) as its only bound. That is the diagnosed root cause of the casting-finalize → premiere hang
# (issue #1713): genesis authors the whole 15-NPC cast ONE houseguest per call (in bounded-concurrency
# waves) awaited INSIDE the player's chat turn — under contention (the documented #1057 concurrent-
# authoring burst sharing the OpenRouter endpoint with premiere narration) a single stalled call could
# ride out most of five minutes before the caller's own best-effort `except Exception` ever saw it.
# A one-NPC JSON object needs nowhere near that; bound it far tighter so a genuinely stuck call fails
# FAST and falls into the existing retry-once / fall-to-the-floor path instead of hanging. Raises
# ``asyncio.TimeoutError`` — the SAME class `_exc_fail_class` already recognizes and every fail-soft
# caller here already treats as an ordinary failure — so nothing downstream needs to change shape.
_AUTHORING_STREAM_WALL_CLOCK_S = 30.0


class AuthoringDeadline(asyncio.TimeoutError):
    """The hard wall-clock ceiling expired (ORW-438). A TimeoutError subclass, so every existing handler still sees it."""


def _quiet_done(task: "asyncio.Task") -> None:
    """Consume a detached task's result so an abandoned stream never logs 'exception was never retrieved'."""
    try:
        if not task.cancelled():
            task.exception()
    except Exception:
        pass


async def _bounded_stream(agen, wall_clock_s: float = _AUTHORING_STREAM_WALL_CLOCK_S):
    """Wrap an async generator with a HARD wall-clock ceiling over the WHOLE iteration, not a per-chunk read timeout
    (see `_AUTHORING_STREAM_WALL_CLOCK_S`).

    ORW-438: the generator is pumped by its own task, and at the ceiling the consumer is released AT ONCE: the task is
    cancelled and detached, never awaited. The old wrapper awaited the cancellation and the generator's `aclose()`, and
    closing a stalled TLS stream can take tens of seconds, so real calls came back after 46.5 s, 57.9 s and 106.8 s
    against a 30 s ceiling while holding their authoring slot. A generator that finishes inside the budget is
    byte-identical; a clean end of stream just ends iteration."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + wall_clock_s
    # A SMALL bounded queue (review of #2752): `put` suspends when the consumer is behind, so a generator that never
    # awaits cannot monopolize the event loop or pile up chunks before the deadline check below gets to run.
    queue: asyncio.Queue = asyncio.Queue(maxsize=4)
    _END = object()

    async def pump():
        try:
            async for chunk in agen:
                await queue.put(("chunk", chunk))
            await queue.put((_END, None))
        except asyncio.CancelledError:
            raise
        except BaseException as e:  # a provider error reaches the consumer exactly as before
            await queue.put(("error", e))

    task = asyncio.ensure_future(pump())
    try:
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise AuthoringDeadline(f"authoring stream exceeded its {wall_clock_s}s wall-clock ceiling")
            try:
                kind, value = await asyncio.wait_for(queue.get(), timeout=remaining)
            except asyncio.TimeoutError:
                raise AuthoringDeadline(f"authoring stream exceeded its {wall_clock_s}s wall-clock ceiling")
            if kind is _END:
                return
            if kind == "error":
                raise value
            yield value
    finally:
        if not task.done():
            task.cancel()
            task.add_done_callback(_quiet_done)  # cleanup runs in the background; the slot is already free


# ── owner directive 2026-07-11: cast-authoring MODEL ROUTING + sampling temperature ──────────────
#
# Cast authoring is EXPRESSIVE end-to-end character work, so by default it now routes to the
# NARRATION model (the better model — the same one that voices the season; settings `default_model`)
# at a HOT sampling temperature, with the UTILITY model chain appended as the EXPLICIT fallback
# (visible in the candidate list + logged — never a silent substitution). Both knobs are
# runtime-editable in settings like the sibling per-class knobs (`reasoning_budget` /
# `max_tokens_budget`, ADR 0010 #1) and read per-run — no restart:
#   * `cast_authoring_model_source` — "narration" (default) | "utility" (the legacy routing).
#   * `cast_authoring_temperature` — default 1.0 (owner ruling 2026-07-20: hot character generation out
#     of the box, dialed back from 1.1), validated/clamped to 0.0-2.0 so >=1.5 stays admin-reachable.
#     Applied to the CAST-AUTHORING call class ONLY — the other `_resolve_llm_fn` consumers keep
#     `_AUTHOR_TEMPERATURE`.
# The #1044/#1002 strict-JSON protections stay in force regardless of routing: reasoning OFF, the
# roomy output floor, `response_format`, and the balanced-brace reparse + retry ladder — a hotter
# temperature varies WHAT is authored; a malformed reply is still caught and retried.
_CAST_MODEL_SOURCES = ("narration", "utility")
_CAST_MODEL_SOURCE_DEFAULT = "narration"
_CAST_TEMPERATURE_DEFAULT = 1.0
_CAST_TEMPERATURE_MIN = 0.0
_CAST_TEMPERATURE_MAX = 2.0


def cast_authoring_model_source() -> str:
    """Which model class serves the cast-authoring call class: "narration" (the default — the better
    model authors characters end-to-end) or "utility" (the legacy routing). Defensive read of the
    runtime-editable `cast_authoring_model_source` setting; garbage/absent ⇒ the default."""
    try:
        from src.settings import get_setting
        v = str(get_setting("cast_authoring_model_source", "") or "").strip().lower()
        if v in _CAST_MODEL_SOURCES:
            return v
    except Exception:
        pass
    return _CAST_MODEL_SOURCE_DEFAULT


def cast_authoring_temperature() -> float:
    """The cast-authoring sampling temperature — default 1.0 (owner: hot out of the box, dialed back
    from 1.1), runtime-editable via the `cast_authoring_temperature` setting, clamped to 0.0-2.0 (an
    admin can push to 1.5+; a fat-fingered 40 can never become the live temperature). Garbage ⇒ the default."""
    try:
        from src.settings import get_setting
        raw = get_setting("cast_authoring_temperature", None)
        if raw is not None and not isinstance(raw, bool):
            v = float(raw)
            if v == v:  # reject NaN
                return min(_CAST_TEMPERATURE_MAX, max(_CAST_TEMPERATURE_MIN, v))
    except Exception:
        pass
    return _CAST_TEMPERATURE_DEFAULT


def _accepts_routing_kwargs(fn) -> bool:
    """True when `fn` (possibly a test's monkeypatched stand-in for `_resolve_llm_fn`) accepts the
    2026-07-11 routing kwargs. MANY existing tests monkeypatch `_resolve_llm_fn` with a bare
    `(owner)` fake — those must keep intercepting the authoring path unchanged, so the router falls
    back to the bare legacy call when the stand-in doesn't take the new keywords."""
    try:
        import inspect
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return False
    return "temperature" in params or any(
        p.kind is inspect.Parameter.VAR_KEYWORD for p in params.values())


async def resolve_authoring_llm_fn(owner: Optional[str], *,
                                   min_output_tokens: Optional[int] = None) -> "Optional[LlmFn]":
    """The CAST-AUTHORING class resolver (owner directive 2026-07-11): route to the NARRATION model
    by default at the runtime-editable authoring temperature, with the utility chain appended as the
    EXPLICIT fallback; `cast_authoring_model_source="utility"` restores the legacy utility-first
    routing (still at the authoring temperature). Every call flows through the module-level
    `_resolve_llm_fn`, so tests that stub it keep intercepting the authoring path.

    This resolver always requests ``response_format=json_object`` (it takes no ``json_mode`` argument). A caller whose
    prompt asks for plain PROSE (a strict provider such as DeepSeek answers HTTP 400 to json_object when the prompt
    never says "json") uses `resolve_prose_llm_fn`, which calls `_resolve_llm_fn(json_mode=False)` (ORW-387).

    ``min_output_tokens`` (2026-07-13 genesis-cap fix): a per-call-family FLOOR on the resolved
    output cap — the full-cast genesis SKETCH passes ``GENESIS_SKETCH_MIN_OUTPUT_TOKENS`` because
    one completion must carry the whole 15-NPC skeleton JSON (the class cap is sized for one NPC).
    ``None`` ⇒ the legacy ``_AUTHOR_MIN_OUTPUT_TOKENS`` floor, byte-identical for every existing
    caller (the per-NPC deep calls keep their cap — also a golden-fixture pin)."""
    if not _accepts_routing_kwargs(_resolve_llm_fn):
        return await _resolve_llm_fn(owner)  # a legacy-signature stub (tests) — bare call
    temperature = cast_authoring_temperature()
    if cast_authoring_model_source() == "utility":
        return await _resolve_llm_fn(owner, temperature=temperature,
                                     min_output_tokens=min_output_tokens)
    return await _resolve_llm_fn(owner, prefix="default", fallbacks_key="default",
                                 include_utility_fallback=True, temperature=temperature,
                                 min_output_tokens=min_output_tokens)

# #1044: the floor visible-output budget for an authoring call. With reasoning forced OFF (below) the
# whole cap is the answer; a full deep-profile JSON object is ~500-800 tokens, so this leaves generous
# headroom for a verbose biography without truncation. Applied even if an admin set the per-class
# `max_tokens_budget` too low (the observed live value was 1200 — fine once reasoning is off, but we
# never want authoring to truncate a profile mid-object).
_AUTHOR_MIN_OUTPUT_TOKENS = 2000

# 2026-07-13 retry-on-length ceiling: when a JSON-authoring completion ends `finish_reason=length`
# (cut off by the output cap ⇒ chopped, unparseable JSON), the call is re-issued EXACTLY ONCE at
# double its cap, never above this bound. The number lives in token_policy (the single source of
# the sizing numbers); the import is defensive so this module stays loadable in isolation.
try:
    from src.token_policy import LENGTH_RETRY_MAX_TOKENS as _LENGTH_RETRY_MAX_TOKENS
except Exception:  # pragma: no cover - token_policy is a sibling pure module
    _LENGTH_RETRY_MAX_TOKENS = 16000

# #1002: the one-shot reparse retry instruction. DeepSeek (and other reasoning models) reliably emit
# reasoning/prose around the JSON instead of a bare object; when the first reply yields no JSON we retry
# ONCE with this maximally-strict instruction appended before falling back to the seeded floor.
_STRICT_RETRY = (
    "Your previous reply did not contain a parseable JSON object. Reply now with ONLY the JSON object "
    "for this houseguest — start with '{', end with '}', no prose, no markdown, no fences, no reasoning."
)

# #1057: the retry instruction for an EMPTY or TRUNCATED visible body. The live-verify proved that under
# the concurrent authoring burst (15 calls sharing the OpenRouter endpoint with premiere narration),
# deepseek-v4-pro emits an EMPTY `text` channel or a JSON object that is CLIPPED mid-stream (finish_reason
# "length" / the budget exhausted before the closing brace). Neither is the #1002 "the model emitted
# prose INSTEAD of JSON" failure — there was no full body to reparse — so that retry never fired and the
# call fell straight to the floor. This re-issues the call (reasoning already OFF, the roomy
# _AUTHOR_MIN_OUTPUT_TOKENS floor) asking for the COMPLETE object, compactly, so it fits the budget.
_TRUNCATION_RETRY = (
    "Your previous reply was empty or cut off before the JSON object was complete. Reply now with the "
    "COMPLETE JSON object for this houseguest in one piece — start with '{', end with '}', keep every "
    "field concise so the whole object fits, no prose, no markdown, no fences, no reasoning."
)

# #1057: how many times to re-issue a call whose VISIBLE body came back EMPTY or TRUNCATED (clipped JSON).
# This is the DOMINANT live failure (provider truncation under the concurrent burst), distinct from the
# #1002 "full body, no JSON" prose case. Bounded + fail-soft: after the budget is spent the call lands on
# the seeded floor exactly as before. A small backoff between attempts gives a transient provider
# overload under the burst time to clear.
_EMPTY_TRUNCATED_RETRIES = 2
_RETRY_BACKOFF_SECONDS = 0.4

# M1-10 (audit A11): the per-houseguest give-up ledger. Authoring is re-kicked from several
# seams (createCharacter, the roster's lazy backfill, the manual + admin levers), and against a
# permanently-failing utility provider each re-kick used to retry every NPC afresh — same-second
# identical call bursts, forever, with no memory. The ledger caps the TOTAL LLM calls spent per
# houseguest per season (across every re-kick in this process); at the cap that NPC's authoring
# GIVES UP loudly — tallied in the run summary and surfaced on /admin/status via
# `authoring_completeness()["givenUp"]` — until `reset_attempts()` (the new-season scrub seam)
# clears it. Retries inside one run ALSO spend from the same budget, and the backoff between
# them is exponential (0.4s → 0.8s → 1.6s …) so a struggling provider gets air, not a hammer.
_ATTEMPT_CAP = 6
_attempt_ledger: dict = {}   # user_key -> {houseguest_id: llm calls spent}
_gaveup_logged: set = set()  # (user_key, houseguest_id) — warn once per give-up, not per re-kick


def _spend_attempt(user_key: str, hid: str) -> None:
    self_map = _attempt_ledger.setdefault(user_key, {})
    self_map[hid] = self_map.get(hid, 0) + 1


def _given_up(user_key: str, hid: str) -> bool:
    return _attempt_ledger.get(user_key, {}).get(hid, 0) >= _ATTEMPT_CAP


def giveups(user) -> list:
    """Houseguest ids whose authoring hit the give-up cap this season (admin visibility)."""
    key = _safe_user(user)
    return sorted(h for h, n in _attempt_ledger.get(key, {}).items() if n >= _ATTEMPT_CAP)


def reset_attempts(user) -> None:
    """New-season scrub: clear the give-up ledger so the fresh cast authors from zero."""
    key = _safe_user(user)
    _attempt_ledger.pop(key, None)
    for k in [t for t in _gaveup_logged if t[0] == key]:
        _gaveup_logged.discard(k)


def attempts_spent(user) -> dict:
    """Per-houseguest authoring LLM calls spent this season (admin/debug-bundle visibility).
    A copy — callers can never mutate the ledger through it. Vault-free: ids + counts only."""
    return dict(_attempt_ledger.get(_safe_user(user), {}))


# The keys the engine's recordCastProfile accepts (everything else is dropped before write-back).
# NOTE: `dayOnePerception` is INTENTIONALLY NOT authored here (anti-sycophancy) — the engine owns the
# seeded, balanced Day-1 read. We never send it, so the authoring path carries zero player coupling.
# `vocation` (#849): the PUBLIC occupation — forwarded so it stays in lockstep with an authored
# biography and the engine re-grounds the hidden stakes off the job the player will infer.
_PUBLIC_KEYS = ("name", "biography", "vocation", "physicalCharacteristics", "voice")
_HIDDEN_KEYS = ("secrets", "trueGoals", "weakness")
_PHYS_KEYS = ("heightBuild", "skinTone", "hair", "facialFeatures", "distinguishingMark", "ageLook", "style")
# The authored VOICE fingerprint (0084 / the 2026-07-11 expressive-e2e widening): six dials + the prose
# signature, plus a small `lexicon` list. Voice is IDENTITY — it is forwarded WHOLE or not at all (the
# engine also enforces whole-or-nothing + bounds in `sanitizeAuthoredVoice`), so a partial/malformed
# voice is omitted and the engine's seeded deterministic voice simply stands.
# #1395: `catchphrases` is an OPTIONAL small set of characteristic phrasings — it rides on a well-formed
# core voice but never gates it (present ⇒ folded, absent/garbage ⇒ simply dropped), mirroring the
# engine's `sanitizeAuthoredVoice` bonus-field rule.
_VOICE_DIAL_KEYS = ("register", "rhythm", "energy", "directness", "humor", "stressTell", "signature")
_VOICE_LEXICON_MAX = 3
_VOICE_CATCHPHRASE_MAX = 3

# Bounded concurrency for `author_cast` (#5): author NPCs in parallel but never flood the utility
# endpoint — at most this many authoring LLM calls are in flight at once.
#
# #1057: lowered 3 → 2. The live-verify proved that at 3 the 15-call authoring burst — running CONCURRENT
# with premiere narration on the SAME OpenRouter endpoint — pushed deepseek-v4-pro into emitting empty /
# truncated `text` (12/15 fell to the floor). Dropping the in-flight authoring load to 2 measurably eases
# the provider pressure while keeping authoring well under a couple of minutes for a 15-NPC cast (15 calls
# / 2 in flight, each a few seconds, plus the empty/truncated retries below). It is fail-soft background
# work, so throughput is secondary to NOT truncating — but 2 (not 1) keeps it from dragging on. The
# empty/truncated retry (below) is the primary defense; this just lowers the rate at which the burst
# trips truncation in the first place.
_AUTHOR_CONCURRENCY = 2

# Quality floor (#3, FE-side guard): a degraded/thin authored field must never overwrite the richer
# deterministic seeded floor in the engine. Since recordCastProfile only overwrites the fields it
# receives, OMITTING a sub-floor field is the whole guard — the engine keeps its prior (seeded) value.
_BIO_MIN_CHARS = R.BIO_FLOOR_CHARS          # a coherent presentable backstory is more than a clause
_BIO_MIN_SENTENCES = R.BIO_FLOOR_SENTENCES       # >= 2 sentence terminators [.!?]
_HIDDEN_ENTRY_MIN_CHARS = 12  # a real secret/weakness is more than a stray word
_SENTENCE_TERMINATORS = re.compile(r"[.!?]")
# `vocation` (#849) is a SHORT occupation noun phrase ("court reporter") — not a sentence. A value that
# is empty or a runaway paragraph is degraded; drop it (the engine keeps the seeded vocation in lockstep).
_VOCATION_MAX_CHARS = 60


# The LLM-authored replacement display name guard — mirrors the engine's `isReasonableName`
# (GameSessionAdapter): exactly two whitespace-separated tokens, each a plausible capitalized name part
# (optional hyphen/apostrophe compound, e.g. "O'Neil"), 2-12 chars, with >= 1 vowel and no run of 4+
# consecutive consonants. A name that fails is DROPPED from the write-back so the engine's seeded corpus
# name (the deterministic floor) simply stands. Rejects "Nerighrengeinen Herneingenenin"; accepts
# "Marcus Webb", "Priya Anand", "Mary-Kate O'Neil".
_NAME_TOKEN = re.compile(r"^[A-Z][a-z]*([-'][A-Z]?[a-z]+)?$")
_NAME_VOWEL = re.compile(r"[aeiouy]", re.I)
_NAME_CONSONANT_RUN = re.compile(r"[bcdfghjklmnpqrstvwxz]{4,}", re.I)


def _is_reasonable_name(s: str) -> bool:
    tokens = (s or "").strip().split()
    if len(tokens) != 2:
        return False
    for token in tokens:
        if not (2 <= len(token) <= 12):
            return False
        if not _NAME_TOKEN.match(token):
            return False
        if not _NAME_VOWEL.search(token):
            return False
        if _NAME_CONSONANT_RUN.search(token):
            return False
    return True


def _biography_meets_floor(bio: str) -> bool:
    """A presentable backstory must clear the coherence floor (>= 2 sentence terminators AND
    >= 80 chars). Below it the seeded floor is richer, so we drop the authored value entirely."""
    if not bio:
        return False
    return len(bio) >= _BIO_MIN_CHARS and len(_SENTENCE_TERMINATORS.findall(bio)) >= _BIO_MIN_SENTENCES


# ── F2 (#1660): the author-time WRITE-BACK coherence lint ──────────────────────────────────────
#
# The engine's RC5 belt (`enforceCastCoherence`/`validateDossierCoherence` in GameSessionAdapter +
# castingIntake.ts) is the airtight net — it validates every committed dossier against its pinned
# `genderPresentation` at SEASON START and strips/floors any contradicting field. This lint is the
# EARLIER, per-NPC complement, at the ONE seam the issue names (the deep-authoring `recordCastProfile`
# write-back): the moment a profile is parsed, BEFORE it commits, drop any self-referential field whose
# prose contradicts the houseguest's PINNED identity (the `genderPresentation` set upstream by identity
# seeding, and the pinned age — both authoritative here) and record a RED-eligible `identity-incoherence`
# health event (#1599 — a real fault is surfaced even when auto-corrected). The dropped field then falls
# to the engine's coherent seeded floor. This catches the bundle's gender-flip six (Lily/Jasmine/Veronica/
# Bradley/Liam) + the age-flip (Donna) at authoring time instead of at game start. It is FE-only — it
# touches no narrator prompt / tool schema / casting-finalize flow, so it does NOT stale the golden
# fixture, and it fires ONLY on a genuine contradiction (a coherent cast ⇒ byte-identical no-op).
#
# Vault-free by construction: the recorded event names only the houseguest id + the dropped FIELD names,
# never the prose or any hidden value.
#
# Pronoun scan (whole-word, case-insensitive). A biography legitimately names OTHER people (a spouse,
# a parent), so the flip signal is deliberately conservative — a field is a "flip" only when the OPPOSITE
# gender's pronouns appear AND the pinned gender's are ABSENT (the houseguest's own pronoun missing
# entirely). A bio that merely mentions an opposite-gender relative still carries the subject's own
# pronoun, so it never trips. `nonbinary` is skipped (they/them yields no clean binary signal).
_MASC_PRONOUN = re.compile(r"\b(he|him|his|himself)\b", re.I)
_FEM_PRONOUN = re.compile(r"\b(she|her|hers|herself)\b", re.I)
# A young pinned age beside an elder self-descriptor in the biography (Donna: age 22 vs "retired
# principal" / "thirty years"). Conservative markers: `retired`/`retiree` (rarely about others in a
# self-bio) and a multi-decade career span (spelled thirty+ or a numeric 30+ years).
_YOUNG_AGE_CEILING = 35
_ELDER_LIFE_STAGE = re.compile(r"\b(retired|retiree)\b", re.I)
_LONG_CAREER = re.compile(
    r"\b(thirty|forty|fifty|sixty|seventy)\b[\s-]+years?\b|\b([3-9]\d)\s*[\s-]*years?\b", re.I)


def _gender_flip(text: str, pin: str) -> bool:
    """True iff `text` self-refers ONLY in the OPPOSITE gender to the pinned `genderPresentation`
    (the opposite pronoun present AND the pinned-gender pronoun absent). Conservative to avoid a
    false positive on a bio that merely mentions an opposite-gender relative."""
    if not text:
        return False
    masc = bool(_MASC_PRONOUN.search(text))
    fem = bool(_FEM_PRONOUN.search(text))
    if pin == "man":
        return fem and not masc
    if pin == "woman":
        return masc and not fem
    return False


# ── E1 (#1733): mixed-script garble + gendered-descriptor + degenerate-dial extensions ──────────────
#
# F7/F8 (BB-Nerd audit, issue #1733): the F2 lint above catches a PRONOUN flip, but the observed bundle
# carried two garble classes it never saw — (1) non-diegetic mixed-script junk dropped straight into an
# English prose field ("缺乏 voice — static and unboiling"), and (2) a GENDERED SELF-DESCRIPTOR term with
# no pronoun at all ("patient and fatherly" on a pinned 32-year-old woman) — `_gender_flip` only scans
# pronouns, so a pronoun-free descriptor sails straight through. A third, related defect: the authored
# `voice` object folds WHOLE onto the houseguest's public voice fingerprint (owner ruling 2026-06-25,
# `sanitizeAuthoredVoice` in `GameSessionAdapter.ts`) and is rendered through a fixed template
# ("{register}, {rhythm}, {directness} voice — {energy}, {humor} humor"); a hot-temperature (1.0, owner
# ruling 2026-07-20) authoring call sometimes hands back a degenerate non-answer for a dial ("none",
# "n/a") that the engine's structural `sanitizeAuthoredVoice` check happily accepts (it only requires a
# non-empty, length-bounded string) — the template then renders the grammatically broken "none humor".
# All three are caught HERE, before write-back, so garbage never reaches `recordCastProfile` — matching
# the existing fail-soft pattern (a rejected field falls to the coherent seeded floor, never a hole).

# Non-Latin scripts (CJK / Kana / Hangul / Cyrillic / Arabic / Hebrew) mixed into what must always be
# plain English prose (a voice cue, a physical descriptor, a biography) is a reliable, cheap structural
# signature of authoring garble — never legitimate content for these fields. A single stray codepoint is
# enough; this is deliberately NOT a semantic/nonsense-word detector (that would false-positive on real
# prose), just a script-mismatch scan.
_NON_LATIN_SCRIPT_RE = re.compile(
    r"[一-鿿぀-ヿㇰ-ㇿ가-힯Ѐ-ӿ؀-ۿ֐-׿]"
)


def _has_script_garble(text: str) -> bool:
    """True iff `text` contains a non-Latin-script codepoint — garble in a field that must read as
    plain English prose. Vault-free, pure regex; no semantic model needed."""
    return bool(text) and bool(_NON_LATIN_SCRIPT_RE.search(text))


def _any_script_garble(*texts: str) -> bool:
    return any(_has_script_garble(t) for t in texts if isinstance(t, str))


# Degenerate / non-answer dial values an LLM sometimes hands back verbatim instead of a real descriptor.
# Grammatically broken once the engine's fixed template renders it ("none humor", "n/a voice") and never
# a genuine authored choice — reject before write-back (owner ruling on issue #1733: "empty dial values").
_DEGENERATE_DIAL_VALUES = frozenset({
    "none", "n/a", "na", "unknown", "unclear", "unspecified", "tbd", "-", "—", "null", "n a",
})


def _is_degenerate_dial(value: str) -> bool:
    return str(value or "").strip().strip(".").lower() in _DEGENERATE_DIAL_VALUES


# Gendered SELF-DESCRIPTOR terms — beyond a bare pronoun, a demeanor/voice/biography can self-describe the
# subject with a gendered noun/adjective ("fatherly", "maternal") that carries no pronoun at all, so the
# pronoun-only `_gender_flip` scan above misses it entirely (the F7 bug: "patient and fatherly" on a
# pinned woman). Deliberately a small, near-unambiguous closed vocabulary — avoids reclaimed/ambiguous
# terms that would false-positive on legitimate prose.
_MASC_DESCRIPTOR_RE = re.compile(r"\b(fatherly|paternal|gentlemanly)\b", re.I)
_FEM_DESCRIPTOR_RE = re.compile(r"\b(motherly|maternal|ladylike|girlish)\b", re.I)


def _gendered_descriptor_flip(text: str, pin: str) -> bool:
    """True iff `text` carries a GENDERED SELF-DESCRIPTOR term opposite the pinned gender (e.g.
    "fatherly" on a pinned "woman") — the non-pronoun complement to `_gender_flip`. Conservative: only
    the OPPOSITE-of-pin term trips it; a term matching the pin (or neither) never does."""
    if not text or pin not in ("man", "woman"):
        return False
    masc = bool(_MASC_DESCRIPTOR_RE.search(text))
    fem = bool(_FEM_DESCRIPTOR_RE.search(text))
    if pin == "man":
        return fem
    if pin == "woman":
        return masc
    return False


# ── ORW-184: reason codes + per-dial repair (behind ORWELL_VOICE_REPAIR, default ON since ORW-242) ─────────────────
#
# On 2026-11-06 the check below dropped three authored voices WHOLE. Two were the model echoing the
# engine's OWN seeded humor dial: `humor: "none"` is a real value of the engine's controlled vocabulary
# (`VOICE_DIALS.humor` in src/engine/voice.ts; the roster clause the model is briefed with renders it
# "none humor"), and `_DEGENERATE_DIAL_VALUES` rejects "none" as an empty answer. The third was one bad
# OPTIONAL catchphrase (a CJK slip), which the engine itself would simply omit. With the flag ON:
#   • `voice_conflict_reasons` names every failing field with a reason code (`script` / `degenerate` /
#     `gender-descriptor`), list entries by index (`catchphrases[2]`);
#   • a value the engine's own dial vocabulary uses is never "degenerate" (the shared fixture
#     `frontend/tests/fixtures/engine_voice_vocabulary.json` + both halves of its drift gate keep this
#     honest: tests/unit/voiceVocabularyFixture.test.ts and frontend/tests/test_orw184_voice_repair.py);
#   • `repair_authored_voice` mends the voice per field (a bad dial → the SEEDED dial read back from the
#     roster card's clause; a bad list entry → removed) instead of dropping the whole object, so the engine
#     still receives a WHOLE voice (its `sanitizeAuthoredVoice` whole-or-nothing contract is unchanged).
#     Only an unrepairable voice (a bad signature, an emptied lexicon, no seeded dial) still drops whole.
# With the flag OFF every verdict, log line and ledger row is byte-identical to the legacy check.
_VOICE_REPAIR_FLAG = "ORWELL_VOICE_REPAIR"

# The engine's own dial values that the degenerate list would otherwise reject (normalized like
# `_is_degenerate_dial`). Today only humor "none" collides; the FE drift test fails if the engine adds another.
_ENGINE_DIAL_VALUES_NOT_DEGENERATE = {"humor": frozenset({"none"})}


def voice_repair_enabled() -> bool:
    """ORW-184 flag, default ON (Ryne's ruling on ORW-242, "fix one detail": repair only the failing dial and keep the authored voice).
    `ORWELL_VOICE_REPAIR=0|false|no|off` turns it off (the legacy whole-voice drop); unset or anything else is on."""
    return str(os.environ.get(_VOICE_REPAIR_FLAG, "")).strip().lower() not in ("0", "false", "no", "off")


def _is_engine_dial_value(key: str, value: str) -> bool:
    norm = str(value or "").strip().strip(".").lower()
    return norm in _ENGINE_DIAL_VALUES_NOT_DEGENERATE.get(key, frozenset())


def _voice_field_reason(key: str, val, pin: str, vocab_aware: bool) -> Optional[str]:
    """The FIRST failing check for one voice field, in the legacy check order, or None when it passes."""
    if not isinstance(val, str):
        return None
    if _has_script_garble(val):
        return "script"
    # The dial fields (everything but the prose `signature`) are single short words/phrases — a degenerate
    # non-answer here is what breaks the rendered template. `signature` is free prose, never checked for
    # degeneracy (a real sentence is never literally "none").
    if key != "signature" and _is_degenerate_dial(val) and not (vocab_aware and _is_engine_dial_value(key, val)):
        return "degenerate"
    # Every rendered dial (AND the signature) is self-referential — a gendered descriptor on ANY of them
    # contradicts the pin exactly like it would in prose.
    if _gendered_descriptor_flip(val, pin):
        return "gender-descriptor"
    return None


def voice_conflict_reasons(profile: dict, npc: dict, *, vocab_aware: Optional[bool] = None) -> list:
    """ORW-184: every reason the authored `voice` fails the E1 (#1733) check, as `(field, code)` pairs —
    `field` is a dial key, `signature`, or a list entry (`lexicon[1]`, `catchphrases[2]`); `code` is
    `script` | `degenerate` | `gender-descriptor`. Empty ⇒ coherent. Vault-free: field names and codes only,
    never the prose. `vocab_aware` (default: the ORWELL_VOICE_REPAIR flag) accepts the engine's own dial
    values (`humor: "none"`); off, the verdict is exactly the legacy `voice_conflicts` one."""
    voice = profile.get("voice") if isinstance(profile, dict) else None
    if not isinstance(voice, dict):
        return []
    if vocab_aware is None:
        vocab_aware = voice_repair_enabled()
    pin = str((npc or {}).get("genderPresentation") or "").strip().lower()
    reasons: list = []
    for key in _VOICE_DIAL_KEYS:  # register, rhythm, energy, directness, humor, stressTell, signature
        code = _voice_field_reason(key, voice.get(key), pin, vocab_aware)
        if code:
            reasons.append((key, code))
    for list_key in ("lexicon", "catchphrases"):
        entries = voice.get(list_key)
        if isinstance(entries, list):
            for i, entry in enumerate(entries):
                if _has_script_garble(str(entry)):
                    reasons.append((f"{list_key}[{i}]", "script"))
    return reasons


def voice_conflicts(profile: dict, npc: dict) -> bool:
    """E1 (#1733): True iff the authored `voice` object (register/rhythm/energy/directness/humor/
    stressTell/signature/lexicon/catchphrases) should be dropped WHOLE before write-back — script
    garble in any dial/signature/lexicon/catchphrase entry, a degenerate non-answer dial value (an
    "empty dial", e.g. `humor: "n/a"`), or a gendered self-descriptor that contradicts the pinned
    gender. Voice folds WHOLE-or-NOTHING (owner ruling 2026-06-25, mirrored by the engine's
    `sanitizeAuthoredVoice`). A well-formed, coherent voice ⇒ False (a byte-identical no-op) — the
    common case.

    P1 (Greptile on #1750): the gendered-descriptor check runs on EVERY dial `voiceFingerprint`
    (`src/engine/voice.ts`) renders into the authoritative roster line — `register`, `rhythm`,
    `directness`, `energy`, `humor`, `stressTell` — not just the free-prose `signature`.

    ORW-184: now the boolean view of `voice_conflict_reasons`. With ORWELL_VOICE_REPAIR off it is the
    legacy verdict exactly (humor "none" still trips it); with it on, the engine's own dial values pass,
    and `_author_one` first mends the voice per field via `repair_authored_voice`, so this only fires on a
    voice that could not be repaired."""
    return bool(voice_conflict_reasons(profile, npc))


def _seeded_voice_floor(npc: dict) -> dict:
    """ORW-184: the SEEDED dials read back from the roster card's `voice` clause (the brief the model was
    given), keeping only dials that themselves pass the check for this houseguest. `{}` when the card has
    no parseable clause (then no dial can be repaired, and a failing dial drops the voice as before)."""
    from src.orwell_voice_repair import parse_voice_clause
    parsed = parse_voice_clause((npc or {}).get("voice")) or {}
    pin = str((npc or {}).get("genderPresentation") or "").strip().lower()
    return {k: v for k, v in parsed.items() if _voice_field_reason(k, v, pin, True) is None}


def repair_authored_voice(profile: dict, npc: dict):
    """ORW-184: mend the authored voice per field (see `src.orwell_voice_repair`). Returns a `VoiceRepair`:
    `.voice` is the mended (or untouched, when nothing failed) voice, or None when it cannot be mended; the
    mended voice is re-checked before it is offered. Pure; the caller decides what to write."""
    from src.orwell_voice_repair import VoiceRepair, repair_voice
    voice = profile.get("voice") if isinstance(profile, dict) else None
    if not isinstance(voice, dict):
        return VoiceRepair(voice=None)
    reasons = voice_conflict_reasons(profile, npc, vocab_aware=True)
    if not reasons:
        return VoiceRepair(voice=voice)
    result = repair_voice(voice, reasons, _seeded_voice_floor(npc))
    if result.voice is not None and voice_conflict_reasons({"voice": result.voice}, npc, vocab_aware=True):
        return VoiceRepair(voice=None, reasons=result.reasons, actions=result.actions,
                           unrepairable=(("voice", "recheck"),))
    return result


def coherence_conflicts(profile: dict, npc: dict) -> list[str]:
    """Return the TOP-LEVEL profile keys whose authored prose contradicts the houseguest's PINNED
    identity in `npc` (`genderPresentation` + `age`, authoritative here), OR whose content is
    non-diegetic garble, before the `recordCastProfile` write-back so they fall to the coherent seeded
    floor. Empty list ⇒ coherent (the common case; a byte-identical no-op). Vault-free: returns field
    NAMES only, never the prose.

    Checks (cheap, in-object):
      • biography — a self-referential gender-PRONOUN flip, a gendered SELF-DESCRIPTOR flip (E1/#1733:
        "fatherly" on a pinned woman — no pronoun involved, so this is a distinct check from the
        pronoun scan), non-Latin script garble, OR a young pinned age beside an elder self-descriptor;
      • physicalCharacteristics — a distinguishingMark gender-pronoun flip, a gendered-descriptor flip
        anywhere in the facet, or script garble anywhere in the facet (the facet folds whole, so the
        WHOLE facet is dropped to keep the engine's whole-or-nothing contract);
      • voice (E1/#1733) — script garble, a degenerate/empty dial value (e.g. `humor: "none"`), or a
        gendered-descriptor flip in the prose signature (see `voice_conflicts`; the whole object drops,
        matching its own whole-or-nothing fold)."""
    drop: set[str] = set()
    pin = str((npc or {}).get("genderPresentation") or "").strip().lower()
    bio = profile.get("biography") if isinstance(profile.get("biography"), str) else ""
    phys = profile.get("physicalCharacteristics")
    mark = str(phys.get("distinguishingMark") or "") if isinstance(phys, dict) else ""
    phys_values = [str(v) for v in phys.values()] if isinstance(phys, dict) else []

    if pin in ("man", "woman"):
        if _gender_flip(bio, pin) or _gendered_descriptor_flip(bio, pin):
            drop.add("biography")
        if _gender_flip(mark, pin) or any(_gendered_descriptor_flip(v, pin) for v in phys_values):
            drop.add("physicalCharacteristics")

    # E1 (#1733): non-diegetic mixed-script garble is rejected regardless of the gender pin — a
    # CJK/Cyrillic/etc. codepoint in an English prose field is never legitimate content.
    if _has_script_garble(bio):
        drop.add("biography")
    if _any_script_garble(*phys_values):
        drop.add("physicalCharacteristics")

    age = (npc or {}).get("age")
    if isinstance(age, (int, float)) and not isinstance(age, bool) and int(age) < _YOUNG_AGE_CEILING:
        # ORW-356: a houseguest whose PINNED vocation is itself "retired ..." (the engine's own fact, e.g. a 24-year-old retired firefighter-paramedic after an injury) must be
        # allowed to say so in the biography; the elder life-stage rule is for a retirement the engine did NOT pin. The multi-decade career span still applies.
        _pinned_retired = bool(_ELDER_LIFE_STAGE.search(str((npc or {}).get("vocation") or "")))
        if bio and (((not _pinned_retired) and _ELDER_LIFE_STAGE.search(bio)) or _LONG_CAREER.search(bio)):
            drop.add("biography")

    # E1 (#1733): the authored voice fingerprint — script garble, a degenerate dial ("none"/"n/a"), or
    # a gendered-descriptor flip in its prose signature. Whole-or-nothing, like the field itself folds.
    if voice_conflicts(profile, npc):
        drop.add("voice")
    return sorted(drop)


# ── F1 / F5 (#1660): roster-constrained authoring — the committed roster is IMMUTABLE ───────────────
#
# The pipeline commits each houseguest's IDENTITY before deep authoring runs (genesis SKELETON → 0063
# identity → deep author → shoot): name + vocation land at genesis, `genderPresentation` + age at the
# 0063 identity seed. Deep authoring must therefore EXTEND that person (depth, look, voice, secrets),
# NEVER re-invent them into a DIFFERENT one — the issue's "occupation-crosswired" (a concierge authored
# as a bartender) and "gender-flipped" houseguests.
#
# F2's `coherence_conflicts` (above) lints the authored PROSE (biography / distinguishingMark) for a
# pronoun/age FLIP. These two guards are the COMPLEMENT at the STRUCTURED-field level: `identity_
# contradictions` compares the authored VALUE of an immutable field (vocation / genderPresentation /
# age) against the committed roster, and `secret_vocation_conflicts` drops the hidden threads that were
# authored around a crosswired job. Both fire ONLY on a genuine contradiction (a coherent dossier ⇒ a
# byte-identical no-op) and are FE-only (no narrator prompt / tool schema / casting-finalize touch).
# Vault-free by construction: they return field NAMES only, never the prose or any hidden value.
_GENDERS_KNOWN = ("man", "woman", "nonbinary")

# Occupation stopwords that carry NO distinctive job signal — so a refinement that shares only these
# ("senior manager" ~ "project manager") never reads as a crosswire, but two genuinely different jobs
# ("concierge" vs "bartender") share no distinctive token and DO.
_VOCATION_STOPWORDS = frozenset({
    "the", "and", "for", "senior", "junior", "assistant", "associate", "lead", "chief", "head",
    "manager", "director", "specialist", "worker", "professional", "freelance", "former", "retired",
    "part", "time", "full", "certified", "licensed",
})
_VOCATION_WORD = re.compile(r"[a-z]{3,}")
# The RAW matcher keeps SHORT tokens too (2+ letters) so a 2-letter vocation ("IT", "DJ") still yields
# a comparable token in the raw fallback below — the distinctive matcher stays at {3,} (2-letter tokens
# fall through to this raw fallback, which now handles them; no 2-letter stopword exists, so no conflict).
_VOCATION_RAW_WORD = re.compile(r"[a-z]{2,}")


def _vocation_tokens(vocation) -> set:
    """The distinctive lower-case word tokens of a vocation noun phrase (>=3 letters, non-stopword) —
    the signal that tells one job from another. "court reporter" -> {"court", "reporter"}; a shared
    token means the same job family (a refinement), a disjoint set means a different job (a crosswire)."""
    if not isinstance(vocation, str):
        return set()
    return {t for t in _VOCATION_WORD.findall(vocation.lower()) if t not in _VOCATION_STOPWORDS}


def _vocation_raw_tokens(vocation) -> set:
    """ALL >=2-letter word tokens of a vocation phrase, stopwords INCLUDED — the fallback signal when a
    committed occupation is a single GENERIC word ("manager", "director") or a SHORT one ("IT", "DJ")
    whose distinctive-token set is empty. "senior manager" -> {"senior", "manager"}; "IT" -> {"it"}.
    Used on BOTH sides together (never mixed with the distinctive set) so containment still judges
    refinements ("manager" ⊆ "senior manager")."""
    if not isinstance(vocation, str):
        return set()
    return set(_VOCATION_RAW_WORD.findall(vocation.lower()))


def identity_contradictions(profile: dict, npc: dict) -> list:
    """F1 (#1660): return the authored STRUCTURED identity fields that CONTRADICT the committed roster's
    IMMUTABLE identity — the set the caller drops before the `recordCastProfile` write-back so the
    committed value STANDS (authored fields EXTEND identity, never OVERWRITE it). Empty ⇒ coherent (the
    common case; a byte-identical no-op). Vault-free: returns field NAMES only.

    Checks:
      • name — `parse_authored_profile` DOES forward an authored `name` (it passes the reasonable-name
        guard), so a model reply that RENAMES a rostered houseguest would overwrite the committed
        identity. A committed name and an authored name that DIFFER (normalized: strip + casefold, so a
        trivial case/whitespace echo of the SAME name is not flagged) drop "name" — the committed name
        stands (the engine also refuses renaming an already-introduced houseguest; this is the earlier
        FE complement).
      • vocation — the committed roster owns the occupation (genesis-authored; the engine keys the hidden
        stakes off it). A three-rung ladder judges coherence, so an empty-token phrase can never skip the
        guard (the "empty-token → guard-skip" class): (1) when BOTH sides carry a distinctive token, judge
        by distinctive-token CONTAINMENT — a refinement ("reporter" ⊆ "court reporter") is kept, a shared
        GENERIC token with neither containing the other ("software engineer" vs "civil engineer") is a
        crosswire dropped; (2) when one side is ALL-GENERIC / SHORT (no distinctive token, e.g. "manager"
        or "IT"), fall back to RAW tokens (>=2 letters, stopwords included) on BOTH sides and apply the
        same containment — "manager" vs "bartender" / "IT" vs "DJ" are crosswires, "manager" vs "senior
        manager" a refinement kept; (3) when NEITHER side yields comparable tokens (1-letter / digits /
        non-latin script), the terminal fallback keeps it coherent ONLY on a WHOLE-TOKEN/phrase substring
        or equality match (space-padded, so a 1-letter "x" can't match INSIDE "taxi driver"), else drops
        "vocation" (a different job).
      • genderPresentation / age — DEFENSIVE: `parse_authored_profile` does not forward these today (the
        pin is engine-owned), so this only fires if a future parse path forwarded a value that differs
        from the committed pin. Kept so the guard is complete + directly unit-testable."""
    drop: list = []
    committed_name = str((npc or {}).get("name") or "").strip()
    authored_name = str((profile or {}).get("name") or "").strip()
    if committed_name and authored_name and committed_name.casefold() != authored_name.casefold():
        drop.append("name")
    cv = (npc or {}).get("vocation")
    av = (profile or {}).get("vocation")
    committed_voc = _vocation_tokens(cv)
    authored_voc = _vocation_tokens(av)
    if committed_voc and authored_voc:
        # Both sides carry a distinctive signal — judge by distinctive-token containment (existing path).
        c, a = committed_voc, authored_voc
    else:
        # One side is ALL-GENERIC / SHORT (no distinctive token, e.g. a committed "manager" or "IT") —
        # distinctive-token containment can't judge it; fall back to RAW tokens (>=2 letters, stopwords
        # included) on BOTH sides. Never mix distinctive-one-side with raw-the-other (that wrongly drops
        # "manager" -> "project manager").
        c, a = _vocation_raw_tokens(cv), _vocation_raw_tokens(av)
    if c and a:
        # Coherent ONLY when one token set CONTAINS the other (a refinement); otherwise a crosswire.
        crosswire = not (c <= a or a <= c)
    else:
        # Terminal fallback: NEITHER side yields comparable tokens (1-letter / digits-only / non-latin
        # script) — an empty-token phrase must NEVER silently skip the guard. Coherent only on a
        # WHOLE-TOKEN/phrase substring or equality match (space-pad both so "x" can't match INSIDE
        # "taxi driver" — the containment must be a whole word/phrase, not an arbitrary substring),
        # else treat it as a different job and drop.
        cv_n = " ".join(str(cv or "").lower().split())
        av_n = " ".join(str(av or "").lower().split())
        cv_phrase = f" {cv_n} "
        av_phrase = f" {av_n} "
        crosswire = bool(cv_n) and bool(av_n) and (cv_phrase not in av_phrase and av_phrase not in cv_phrase)
    if crosswire:
        drop.append("vocation")
    pin = str((npc or {}).get("genderPresentation") or "").strip().lower()
    authored_gp = str((profile or {}).get("genderPresentation") or "").strip().lower()
    if pin in _GENDERS_KNOWN and authored_gp in _GENDERS_KNOWN and authored_gp != pin:
        drop.append("genderPresentation")
    c_age = (npc or {}).get("age")
    a_age = (profile or {}).get("age")
    if isinstance(c_age, (int, float)) and not isinstance(c_age, bool) \
            and isinstance(a_age, (int, float)) and not isinstance(a_age, bool) \
            and int(c_age) != int(a_age):
        drop.append("age")
    return drop


def secret_vocation_conflicts(profile: dict, npc: dict) -> list:
    """F5 (#1660): the hidden-thread field names (`secrets` / `trueGoals` / `weakness`) to drop because
    the profile's authored VOCATION crosswires the committed roster. The hidden bible is authored in the
    SAME call as the vocation, so a crosswired job means the secrets were grounded in the WRONG identity
    — they must not commit against the (correct) committed vocation. Returns the PRESENT hidden-thread
    fields when the authored vocation is a different job from the committed one, else []. Dropping them
    lets the engine re-derive the hidden stakes off the committed vocation (non-degradation: the engine
    holds a seeded hidden floor keyed to the committed job). Reuses the F1 crosswire signal so the two
    guards can never disagree. Vault-free: returns field NAMES only."""
    if "vocation" not in identity_contradictions(profile, npc):
        return []
    return [k for k in _HIDDEN_KEYS if k in (profile or {})]


# ── T0-6: the FE half of the closed-facet ADOPT-OR-REGENERATE merge ────────────────────────────
#
# The skeleton's closed facets are DEALT (the seeded FacetLedger + the engine's cast-wide spread) —
# an authored deep profile must ADOPT them or be REGENERATED, never grafted: a biography written for
# a tattooed sleeve must not commit beside a de-inked facet (and vice versa). This is the authoring-
# time half; the engine's generic closed-facet-diff validator at the recordCastProfile boundary
# (src/engine/facetDiff.ts) is the airtight backstop, with the old per-facet INK_RE patch demoted to
# an alarmed monitor behind it (T9: demote → observe → delete-never).
#
# The ink lexicon mirrors the engine's INK_RE (facetDiff.ts) — one lexicon, pinned sites.
_INK_RE = re.compile(
    r"\btattoo|\bink(?:ed)?\b|\bblackwork\b|\bbody art\b"
    r"|\b(?:full|half)[- ]sleeves?(?!\s+(?:tee|t-?shirt|shirt|top|blouse|sweater|kurta)s?\b)",
    re.I)
#: The CLOSED facet dimensions the transactional merge validates (ADR 0005: closed facets only —
#: open prose is never normalized). Table-driven so a future closed facet is one row, not a new guard.
_CLOSED_FACET_DIMENSIONS = (("visible-ink", _INK_RE),)

_FACET_RETRY = (
    "Your profile contradicts this houseguest's FIXED casting facets ({dims}): the committed skeleton "
    "facets are a dealt, immutable budget — e.g. a houseguest whose skeleton carries no visible "
    "tattoos has none, anywhere (not in the look, the style, or the biography). Rewrite the COMPLETE "
    "JSON object now with the physicalCharacteristics and biography consistent with the skeleton's "
    "facets exactly as given. JSON only."
)


def facet_hand_conflicts(profile: dict, npc: dict) -> list:
    """The closed-facet dimensions the authored profile INTRODUCES against the committed skeleton
    facet (the dealt hand): for each closed dimension absent from the skeleton's
    ``physicalCharacteristics``, flag it when the authored facet block OR biography introduces it.
    Returns dimension names ([] when coherent / no skeleton facet to validate against). Vault-free."""
    skel = (npc or {}).get("physicalCharacteristics")
    if not isinstance(skel, dict) or not skel:
        return []
    out = []
    authored_pc = (profile or {}).get("physicalCharacteristics")
    bio = str((profile or {}).get("biography") or "")
    for dim, rx in _CLOSED_FACET_DIMENSIONS:
        if any(rx.search(str(v or "")) for v in skel.values()):
            continue  # the skeleton GRANTED this dimension — the author may sharpen it freely
        authored_has = isinstance(authored_pc, dict) \
            and any(rx.search(str(v or "")) for v in authored_pc.values())
        if authored_has or rx.search(bio):
            out.append(dim)
    return out


# ---------------------------------------------------------------------------------------------------
# ORW-360: the look accept path. The checks run on the authored physicalCharacteristics after the identity
# lint; one strict retry names the problem(s); after the retry still fails each axis falls back (hair and
# build to the seeded brief, style to the family sample and wardrobe omitted, onCamera omitted). Nothing here
# ever logs the authored text: only the houseguest id and the reason code.
# ---------------------------------------------------------------------------------------------------
_GRAY_HAIR_RE = re.compile(r"\b(?:gr[ae]y(?:ing)?|silver|salt[- ]and[- ]pepper|white[- ]haired)\b", re.I)
_DYED_RE = re.compile(r"\b(?:dyed|bleached|platinum)\b", re.I)
_GRAY_HAIR_MIN_AGE = 35
_BROAD_WORDS = ("broad-shouldered", "stocky", "heavyset", "burly", "thick")
_SLIGHT_WORDS = ("willowy", "slight", "petite", "lanky", "reedy", "slender")
_BROAD_RE = re.compile(r"(?<![\w-])(?:%s)(?![\w-])" % "|".join(re.escape(w) for w in _BROAD_WORDS), re.I)
_SLIGHT_RE = re.compile(r"(?<![\w-])(?:%s)(?![\w-])" % "|".join(re.escape(w) for w in _SLIGHT_WORDS), re.I)
_TALL_RE = re.compile(r"\btall\b", re.I)
_PETITE_RE = re.compile(r"\bpetite\b", re.I)
_WARDROBE_TEXT_RE = re.compile(
    r"\blogos?\b|\blettering\b|\blettered\b|\bslogans?\b|\bprinted (?:words?|text|lettering)\b"
    r"|\bwords?\b|\btext\b|[\"\u201c\u201d]", re.I)
# A short list of common band and brand names (not exhaustive: the prompt carries the rule, this is the net).
_BAND_BRAND_NAMES = (
    "def leppard", "metallica", "nirvana", "ramones", "ac/dc", "ac-dc", "led zeppelin", "pink floyd",
    "the clash", "misfits", "slayer", "megadeth", "guns n' roses", "iron maiden", "black sabbath",
    "nike", "adidas", "puma", "reebok", "gucci", "supreme", "carhartt", "levi's", "levis", "vans",
    "converse", "patagonia", "harley", "rolex", "birkenstock", "ray-ban", "dr. martens", "doc martens",
    "louis vuitton", "chanel", "prada", "champion", "yeezy", "jordans", "under armour", "north face",
    "lululemon", "hollister", "abercrombie", "burberry", "versace", "off-white", "stussy", "timberland",
    "wrangler", "ariat", "stetson", "new balance", "columbia", "hanes", "fila", "asics", "hurley", "quiksilver",
    "oakley", "nautica", "ralph lauren", "tommy hilfiger", "calvin klein", "uniqlo", "dickies",
    "russell athletic", "fruit of the loom", "zara", "h&m", "fendi", "dior", "hermes", "tiffany",
    "canada goose", "arc'teryx", "arcteryx", "salomon", "crocs", "skechers", "hoka", "saucony",
)
_BAND_BRAND_RE = re.compile(
    r"(?<![\w])(?:%s)(?![\w])" % "|".join(re.escape(n) for n in _BAND_BRAND_NAMES), re.I)
_ONCAMERA_MAX = R.ONCAMERA_MAX_CHARS
_SPOT_MAX = R.SPOT_MAX  # at most this many houseguests share one house spot in their on-camera moment
_PHOTOHAIR_MAX = R.PHOTOHAIR_MAX_CHARS
_SPOT_PATTERNS = (
    ("kitchen", re.compile(r"\bkitchen\b", re.I)), ("living room", re.compile(r"\bliving room\b", re.I)),
    ("dining room", re.compile(r"\bdining room\b", re.I)), ("backyard", re.compile(r"\bback ?yard\b", re.I)),
    ("lounge", re.compile(r"\blounge\b", re.I)), ("bedroom", re.compile(r"\bbedrooms?\b", re.I)),
)
_ONCAMERA_BANNED_RE = re.compile(
    r"(?<![\w-])(?:%s)(?![\w-])" % "|".join(re.escape(w) for w in _ONCAMERA_BANNED_WORDS), re.I)
# The closing read may say "someone who ...": that one clause is exempt from the ban on "someone".
_ONCAMERA_READ_RE = re.compile(r"(?:^|[,;.\u2014\u2013-])\s*(?:someone|the one) (?:who|you|that)\b[^,;.\u2014\u2013-]*[.!]?\s*$", re.I)
_PHOTOHAIR_BANNED_RE = re.compile(
    r"(?<![\w-])(?:%s)(?![\w-])" % "|".join(re.escape(w) for w in _PHOTOHAIR_BANNED_WORDS), re.I)
_PRONOUN_CONTRADICTIONS = {
    # ORW-437: man/woman also reject they/them (a sheet line is about ONE person and the prompt pins he/him or she/her).
    "man": re.compile(r"\b(?:she|her|hers|herself|they|them|their|theirs|themselves)\b", re.I),
    "woman": re.compile(r"\b(?:he|him|his|himself|they|them|their|theirs|themselves)\b", re.I),
    "nonbinary": re.compile(r"\b(?:he|him|his|himself|she|her|hers|herself)\b", re.I),
}
_PIECE_CUT_RE = re.compile(r"\s+(?:with|over|in|and|on|under|featuring|paired)\b|[,;(]", re.I)


def oncamera_spots(text: str) -> set:
    """The house spots a moment names (a set of canonical names)."""
    return {name for name, rx in _SPOT_PATTERNS if rx.search(text or "")}


def repair_oncamera(text: str) -> str:
    """The on-camera line with whatever made it a scene taken out: clauses with a banned word or a second house spot are dropped
    (the closing "the one who ..." read is kept), then the rest is cut at a clause end inside the length cap. "" when nothing clean
    is left."""
    t = " ".join(str(text or "").split())
    if not t:
        return ""
    read = ""
    m = _ONCAMERA_READ_RE.search(t)
    if m:
        read, t = t[m.start():].lstrip(",;.\u2014\u2013- "), t[:m.start()]
    kept, spots = [], set()
    for clause in re.split(r"(?<=[,;.\u2014\u2013])\s+|\s+[\u2014\u2013-]\s+", t):
        if _ONCAMERA_BANNED_RE.search(clause):
            continue
        cs = oncamera_spots(clause)
        if cs and spots and not (cs & spots):
            continue  # a second house spot
        spots |= cs
        kept.append(clause.strip(" ,;.\u2014\u2013-"))
    body = ", ".join(x for x in kept if x)
    if read and not _ONCAMERA_BANNED_RE.search(_ONCAMERA_READ_RE.sub("", ", " + read)):
        body = f"{body}, {read}" if body else read
    while len(body) > _ONCAMERA_MAX and "," in body:
        body = body.rsplit(",", 1)[0]
    body = body.strip(" ,;")
    if body and not body.endswith((".", "!", "?")):
        body += "."
    return body if len(body) <= _ONCAMERA_MAX else ""


def oncamera_is_scene(text: str) -> bool:
    """A moment that reads as a scene: a banned word, more than one spot, or over 240 characters. The
    closing "someone who ..." read is exempt from the word ban."""
    t = str(text or "")
    if len(t) > _ONCAMERA_MAX or len(oncamera_spots(t)) > 1:
        return True
    return bool(_ONCAMERA_BANNED_RE.search(_ONCAMERA_READ_RE.sub("", t)))


def photohair_is_messy(text: str) -> bool:
    t = str(text or "")
    return len(t) > _PHOTOHAIR_MAX or bool(_PHOTOHAIR_BANNED_RE.search(t))


def pronoun_mismatch(text: str, gender) -> bool:
    rx = _PRONOUN_CONTRADICTIONS.get(str(gender or ""))
    return bool(rx and rx.search(str(text or "")))


def main_piece_key(piece) -> str:
    """The head noun phrase of a main piece, compared on its last two words ("a worn leather jacket with
    brass buttons" -> "leather jacket")."""
    t = _PIECE_CUT_RE.split(str(piece or "").lower().strip())[0]
    words = re.findall(r"[a-z][a-z'-]*", t)
    return " ".join(words[-2:])


def photo_sheet_taken(cards: list) -> dict:
    """The `taken` lists the photo-sheet writer is given: the main pieces and the spot counts of the
    houseguests in `cards` (public stored fields only)."""
    pieces: list = []
    spots: dict = {}
    for c in cards or []:
        phys = (c or {}).get("physicalCharacteristics") if isinstance(c, dict) else None
        if not isinstance(phys, dict):
            continue
        wd = phys.get("wardrobe")
        if isinstance(wd, list) and wd and str(wd[0]).strip():
            pieces.append(str(wd[0]).strip())
        found = oncamera_spots(str(phys.get("onCamera") or ""))
        if len(found) == 1:
            spot = next(iter(found))
            spots[spot] = spots.get(spot, 0) + 1
    return {"mainPieces": pieces, "spots": spots}


_LOOK_PROBLEM_TEXT = {
    "gray-hair-young": "hair reads gray/silver/salt-and-pepper for someone under 35 (write it as dyed, or pick a natural colour that fits their age)",
    "build-contradiction": "heightBuild combines opposites (broad/stocky/heavyset/burly/thick with willowy/slight/petite/lanky/reedy/slender, or tall with petite)",
    "style-wrong-family": "style/wardrobe reads as a different style family than the skeleton's presentation (stay inside the presentation family, never blend)",
    "wardrobe-shape": f"wardrobe must be {R.WARDROBE_MIN_PIECES}-{R.WARDROBE_MAX_PIECES} specific pieces, each with no logo, lettering, slogan, printed words, or band or brand name",
    "oncamera-shape": "onCamera is a still moment of posture, hands, gaze and expression, with no room named",
    "oncamera-scene": f"onCamera must be ONE still moment, at most {R.ONCAMERA_MAX_CHARS} characters, with exactly one spot, and none of these words: " + ", ".join(_ONCAMERA_BANNED_WORDS) + " (no sequence, speech, chores or other people)",
    "pronoun-mismatch": "a pronoun in onCamera, photoHair or wardrobe contradicts genderPresentation (man: he/him; woman: she/her; nonbinary: they/them)",
    "photohair-messy": f"photoHair must be at most {R.PHOTOHAIR_MAX_CHARS} characters and positive: neat, styled, the same cut as the written hair, and none of: " + ", ".join(R.PHOTOHAIR_BANNED_WORDS),
    "oncamera-taken": "the house spot in onCamera already holds three houseguests (see taken.spots); choose a spot with fewer than three",
    "wardrobe-unreal": "a wardrobe piece or the style line is not a real garment (a work badge, lanyard or name tag, a costume, a uniform worn as a style, bare skin under a blazer, hand-sewn decoration); use ordinary pieces a shop sells",
    "wardrobe-multi": "a wardrobe piece is two things in one (a vest over a polo, sneakers with a gold chain): write each garment as its own piece",
    "wardrobe-not-garment": "a wardrobe piece names no garment or accessory a shop sells (it is hair, a person or a vibe); every piece must be a real garment",
    "wardrobe-taken": "the MAIN (first) wardrobe piece repeats one already taken in this cast; choose a different garment",
}

_LOOK_RETRY_TAIL = (
    " Rewrite the COMPLETE JSON object now with those look fields fixed and everything else as before. "
    "Only the JSON object — start with '{', end with '}', no prose, no markdown, no fences."
)


def look_retry_message(problems: list, taken: Optional[dict] = None) -> str:
    """The strict retry text naming each look problem (reuses the strict JSON-only instruction). With
    `taken`, the taken lists ride along so a wardrobe-taken or spot retry can see them."""
    named = "; ".join(f"{p}: {_LOOK_PROBLEM_TEXT[p]}" for p in problems if p in _LOOK_PROBLEM_TEXT)
    extra = ""
    if isinstance(taken, dict) and taken:
        extra = " taken = " + json.dumps(taken, ensure_ascii=False) + "."
    return (f"{_STRICT_RETRY} Your profile's look failed these checks: {named}.{extra}{_LOOK_RETRY_TAIL}")


def _age_of(npc: dict):
    try:
        a = (npc or {}).get("age")
        return int(a) if a is not None and not isinstance(a, bool) else None
    except (TypeError, ValueError):
        return None


def look_problems(profile: dict, npc: dict, taken: Optional[dict] = None) -> list:
    """The look-check reason codes the authored ``physicalCharacteristics`` trips ([] when clean or when
    there is no facet). The optional wardrobe/photoHair/onCamera are checked only when present (absent =
    omitted, the prompt then uses its fallback lines). `taken` ({"mainPieces": [...], "spots": {...}}) turns on
    the wardrobe-taken check. Vault-free: codes only, never the authored text."""
    from src.orwell_style_families import families_mentioned, family_for_label
    pc = (profile or {}).get("physicalCharacteristics")
    if not isinstance(pc, dict):
        return []
    out = []
    age = _age_of(npc)
    hair = str(pc.get("hair") or "")
    if age is not None and age < _GRAY_HAIR_MIN_AGE and _GRAY_HAIR_RE.search(hair) and not _DYED_RE.search(hair):
        out.append("gray-hair-young")
    hb = str(pc.get("heightBuild") or "")
    if (_BROAD_RE.search(hb) and _SLIGHT_RE.search(hb)) or (_TALL_RE.search(hb) and _PETITE_RE.search(hb)):
        out.append("build-contradiction")
    wardrobe = pc.get("wardrobe")
    items = [str(x) for x in wardrobe] if isinstance(wardrobe, list) else []
    fam = family_for_label(str((npc or {}).get("presentation") or ""))
    if fam is not None:
        mentioned = families_mentioned(str(pc.get("style") or "") + " " + " ".join(items))
        if fam["id"] not in mentioned and any(m != fam["id"] for m in mentioned):
            out.append("style-wrong-family")
    if "wardrobe" in pc and (
            not isinstance(wardrobe, list) or not R.WARDROBE_MIN_PIECES <= len(items) <= R.WARDROBE_MAX_PIECES
            or any(len(i) > R.WARDROBE_PIECE_MAX_CHARS or _WARDROBE_TEXT_RE.search(i) or _BAND_BRAND_RE.search(i) for i in items)):
        out.append("wardrobe-shape")
    if items or pc.get("style"):
        from src import orwell_cast_realism as _R
        if any(_R.unreal_clothes(x) for x in items) or _R.unreal_clothes(str(pc.get("style") or "")):
            out.append("wardrobe-unreal")
        elif any(not _R.is_garment(x) for x in items):
            out.append("wardrobe-not-garment")
        elif any(_R.is_multi_garment(x) for x in items):
            out.append("wardrobe-multi")
    from src import orwell_cast_realism as _RL
    if any(_RL.label_leaks(" ".join(str(x) for x in (v if isinstance(v, list) else [v]))) for v in (pc.get("wardrobe"), pc.get("style"), pc.get("lookSignature"), pc.get("onCamera"), pc.get("photoHair"))):
        out.append("label-leak")  # an internal category name ("red-pink") in a card text: the gate scrubs it, a first pass is asked again
    if "lookSignature" in pc:
        sg = pc.get("lookSignature")
        if (not isinstance(sg, str) or not sg.strip() or len(sg) > R.SIGNATURE_MAX_CHARS or _WARDROBE_TEXT_RE.search(sg) or _BAND_BRAND_RE.search(sg)
                or _INK_RE.search(sg)):
            out.append("signature-shape")
        else:
            from src import orwell_cast_realism as _RH
            seeded_hair = ((npc or {}).get("physicalCharacteristics") or {}).get("hair") if isinstance((npc or {}).get("physicalCharacteristics"), dict) else ""
            hair_text = f"{pc.get('hair') or seeded_hair or ''} {pc.get('photoHair') or ''}"
            if _RH.tag_card({"physicalCharacteristics": {"lookSignature": sg}}).get("signature") == ["hair"] and _RH.hair_signature_conflict(sg, hair_text):
                out.append("signature-hair")  # a hair signature that names a cut or texture the card's own hair does not carry
            elif _RH.is_multi_garment(sg):
                out.append("signature-shape")  # ONE thing, not a whole outfit ("a polo tucked into jeans with clogs")
    if "onCamera" in pc:
        oc = str(pc.get("onCamera") or "")
        if oncamera_is_scene(oc):
            out.append("oncamera-scene")
        elif oncamera_spots(oc) and isinstance(taken, dict) and (taken.get("spots") or {}).get(next(iter(oncamera_spots(oc))), 0) >= _SPOT_MAX:
            out.append("oncamera-taken")  # ORW-437: that house spot already holds three houseguests
    gender = (npc or {}).get("genderPresentation")
    if gender and (pronoun_mismatch(str(pc.get("onCamera") or ""), gender)
                   or pronoun_mismatch(str(pc.get("photoHair") or ""), gender)
                   or pronoun_mismatch(" ".join(items), gender)):
        out.append("pronoun-mismatch")
    if "photoHair" in pc and photohair_is_messy(str(pc.get("photoHair") or "")):
        out.append("photohair-messy")
    if items and isinstance(taken, dict):
        key = main_piece_key(items[0])
        if key and key in {main_piece_key(x) for x in (taken.get("mainPieces") or [])}:
            out.append("wardrobe-taken")
    return out


def apply_look_fallbacks(profile: dict, npc: dict, problems: list) -> list:
    """After the strict retry still fails: hair and build fall back to the seeded brief's value for that
    axis (never to a seeded hair that itself reads gray); style falls back to the family sample and wardrobe is omitted; onCamera / photoHair are omitted; a pronoun mismatch omits the offending field; wardrobe-taken keeps the clothes. Mutates
    ``profile`` in place; returns the reason codes applied."""
    from src.orwell_style_families import family_for_label
    pc = profile.get("physicalCharacteristics")
    if not isinstance(pc, dict):
        return []
    seeded = (npc or {}).get("physicalCharacteristics")
    seeded = seeded if isinstance(seeded, dict) else {}
    for code in problems:
        if code == "gray-hair-young" and seeded.get("hair"):
            seeded_hair = str(seeded["hair"])
            if _GRAY_HAIR_RE.search(seeded_hair) and not _DYED_RE.search(seeded_hair):
                # The seeded hair itself reads gray: drop the gray words (never fall back to a gray head on someone young).
                pc["hair"] = _GRAY_HAIR_RE.sub("dark", seeded_hair)
            else:
                pc["hair"] = seeded_hair
        elif code == "gray-hair-young":
            pc["hair"] = _GRAY_HAIR_RE.sub("dark", str(pc.get("hair") or "")) or "dark hair"
        elif code == "build-contradiction" and seeded.get("heightBuild"):
            pc["heightBuild"] = str(seeded["heightBuild"])
        elif code == "style-wrong-family":
            fam = family_for_label(str((npc or {}).get("presentation") or ""))
            if fam is not None:
                pc["style"] = fam["sample"]
            # ORW-480: the clothes stay: the style family is only a lean now, so a retry that still blends another family keeps the
            # writer's pieces (real garments are checked on their own) instead of blanking the wardrobe
        elif code == "wardrobe-shape":
            pc.pop("wardrobe", None)
        elif code in ("signature-shape", "signature-hair"):
            pc.pop("lookSignature", None)  # the casting-director pass asks for another (it is shown the card's hair lines)
        elif code == "label-leak":
            from src import orwell_cast_realism as _RS
            for _f in ("wardrobe", "style", "lookSignature", "onCamera", "photoHair"):
                _v = pc.get(_f)
                if isinstance(_v, list):
                    pc[_f] = [_RS.scrub_labels(str(x)) for x in _v]
                elif isinstance(_v, str):
                    pc[_f] = _RS.scrub_labels(_v)
        elif code == "wardrobe-multi":
            # ORW-480: split each two-things piece at its joiner ("a vest over a polo" -> "a vest", "a polo") rather than lose the clothes
            from src import orwell_cast_realism as _R
            split: list = []
            for x in [str(i) for i in (pc.get("wardrobe") or [])]:
                if _R.is_multi_garment(x):
                    parts = re.split(r"\s+(?:over|with|and|under|plus|paired with|layered over|tucked into|beneath|atop)\s+|,\s*", x, maxsplit=1, flags=re.I)
                    split += [p_.strip() for p_ in parts if p_.strip()]
                else:
                    split.append(x)
            seen: list = []
            for x in split:
                if x.lower() not in {y.lower() for y in seen}:
                    seen.append(x)
            garments = [x for x in seen if _R.is_garment(x) and not _R.unreal_clothes(x)]
            if len(garments) >= 2:
                pc["wardrobe"] = garments[:3]  # a split that gives four pieces keeps the first three (the main piece leads)
            else:
                pc.pop("wardrobe", None)
        elif code in ("wardrobe-unreal", "wardrobe-not-garment"):
            # ORW-480: clothes a shop does not sell never reach the photo. The pieces that ARE real garments stay when two or more are left; only
            # otherwise is the wardrobe omitted (the casting director then asks for one). An unreal style line falls back to the family sample.
            from src import orwell_cast_realism as _R0
            kept = [str(x) for x in (pc.get("wardrobe") or []) if _R0.is_garment(str(x)) and not _R0.unreal_clothes(str(x))]
            if len(kept) >= 2:
                pc["wardrobe"] = kept[:3]
            else:
                pc.pop("wardrobe", None)
            from src import orwell_cast_realism as _R
            if _R.unreal_clothes(str(pc.get("style") or "")):
                fam = family_for_label(str((npc or {}).get("presentation") or ""))
                pc["style"] = fam["sample"] if fam is not None else "plain everyday clothes"
        elif code == "oncamera-taken":
            pc.pop("onCamera", None)  # a named spot that already holds three houseguests: the line goes (the room is not asked of the writer now)
        elif code in ("oncamera-shape", "oncamera-scene"):
            # ORW-480: mend the line (a clause out of a second spot or a banned word, cut to length) before dropping it, so a card
            # keeps its on-camera line whenever a clean part of it survives
            fixed = repair_oncamera(str(pc.get("onCamera") or ""))
            if fixed and not oncamera_is_scene(fixed):
                pc["onCamera"] = fixed
            else:
                pc.pop("onCamera", None)
        elif code == "pronoun-mismatch":
            gender = (npc or {}).get("genderPresentation")
            if pronoun_mismatch(str(pc.get("onCamera") or ""), gender):
                pc.pop("onCamera", None)
            if pronoun_mismatch(str(pc.get("photoHair") or ""), gender):
                pc.pop("photoHair", None)
            if pronoun_mismatch(" ".join(str(x) for x in (pc.get("wardrobe") or []) if isinstance(pc.get("wardrobe"), list)), gender):
                pc.pop("wardrobe", None)
        elif code == "photohair-messy":
            pc.pop("photoHair", None)
        # wardrobe-taken: never drop clothes for this alone: the piece stays (the code is returned, so it is logged)
    return list(problems)




# ── ORW-956: a failing field is re-asked once with the failing rule's own sentence, before a fallback may delete it ──────────────────
# `apply_look_fallbacks` (and the parse floors) used to DELETE a field a check refused: an onCamera line with one banned word cost the
# card its whole on-camera line, a wardrobe a second chance. `repair_failing_fields` finds which fields a fallback would delete or replace,
# asks the writer for exactly those fields in ONE call (so at most one targeted repair per field, one extra call per card and place),
# and keeps a new value only when it clears the rules it was asked for and brings no new look problem. Whatever is still failing then
# goes to the fallback exactly as before, so the repair can only add a field, never remove one.
_REPAIR_PHYS_FIELDS = ("wardrobe", "photoHair", "onCamera", "lookSignature", "style", "hair", "heightBuild")
_REPAIR_TOP_FIELDS = ("biography", "identityConcept")
_REPAIR_DROP_ONLY = ("wardrobe", "photoHair", "onCamera", "lookSignature")  # these vanish; style, hair and heightBuild are replaced by the brief


def parse_dropped(text, npc: dict) -> dict:
    """{field: code} for the biography / identityConcept the writer sent that `parse_authored_profile` then dropped on a floor
    (`bio-floor`: under 80 characters or fewer than 2 sentences; `identity-length`: outside 12 to 250 characters)."""
    try:
        obj = _extract_json(text or "") if isinstance(text, str) else None
    except Exception:  # failsoft-ok: no object, nothing was dropped by a floor
        return {}
    if not isinstance(obj, dict):
        return {}
    out = {}
    bio = obj.get("biography")
    if isinstance(bio, str) and bio.strip() and not _biography_meets_floor(bio.strip()):
        out["biography"] = "bio-floor"
    ic = obj.get("identityConcept")
    if isinstance(ic, str) and ic.strip() and not R.IDENTITY_PARSE_MIN_CHARS <= len(" ".join(ic.split())) <= R.IDENTITY_MAX_CHARS:
        out["identityConcept"] = "identity-length"
    return out


def _copy_profile(profile: dict) -> dict:
    out = dict(profile)
    if isinstance(out.get("physicalCharacteristics"), dict):
        out["physicalCharacteristics"] = {k: (list(v) if isinstance(v, list) else v) for k, v in out["physicalCharacteristics"].items()}
    return out


def fields_a_fallback_changes(profile: dict, npc: dict, problems: list) -> list:
    """The look fields `apply_look_fallbacks` would delete (wardrobe, photoHair, onCamera, lookSignature) or replace with the brief (style,
    hair, heightBuild) for these problems. A deterministic mend that keeps the field (a split wardrobe, a scrubbed label, a cut
    on-camera line) is not a deletion, so it does not count."""
    pc = (profile or {}).get("physicalCharacteristics")
    if not isinstance(pc, dict):
        return []
    probe = _copy_profile(profile)
    apply_look_fallbacks(probe, npc, list(problems))
    after = probe.get("physicalCharacteristics") or {}
    out = []
    for f in _REPAIR_PHYS_FIELDS:
        if pc.get(f) in (None, "", [], {}):
            continue
        gone = after.get(f) in (None, "", [], {})
        if gone or (f not in _REPAIR_DROP_ONLY and after.get(f) != pc.get(f)):
            out.append(f)
    return out


def _repair_card(profile: dict, npc: dict) -> dict:
    card = {k: v for k, v in (npc or {}).items()}
    for k, v in (profile or {}).items():
        if k == "physicalCharacteristics" and isinstance(v, dict):
            card[k] = {**(card.get(k) if isinstance(card.get(k), dict) else {}), **v}
        elif v not in (None, "", [], {}):
            card[k] = v
    return card


def repair_ask(field_codes: dict, npc: dict, taken: Optional[dict] = None) -> str:
    """The one-call ask: for each failing field, the sentence of every rule it failed, worded as the prompt words it."""
    first = str((npc or {}).get("name") or "").split(" ")[0] or "the houseguest"
    extras = {**_RULE_EXAMPLES, "name": first}
    parts = []
    for field, codes in field_codes.items():
        sents = []
        for c in codes:
            sent = R.sentence(c, extras)
            if sent not in sents:
                sents.append(sent)
        parts.append(f"{field} (it failed {', '.join(codes)}): " + " ".join(sents))
    tail = ""
    if isinstance(taken, dict) and taken:
        tail = " taken = " + json.dumps(taken, ensure_ascii=False) + "."
    return ("Only this needs fixing: " + " | ".join(parts) + "." + tail + " Reply with ONLY a JSON object holding just the field or fields "
            "named above (the look fields inside physicalCharacteristics); change nothing else.")


def _reply_field(obj: dict, field: str):
    phys = obj.get("physicalCharacteristics")
    if isinstance(phys, dict) and field in phys:
        return phys[field]
    return obj.get(field)


def _clean_repair_value(field: str, v):
    if field == "wardrobe":
        return _clean_sheet({"wardrobe": v}).get("wardrobe")
    if isinstance(v, str) and v.strip():
        out = " ".join(v.split())
        return out[:R.SIGNATURE_MAX_CHARS] if field == "lookSignature" else out
    return None


async def repair_failing_fields(profile: dict, npc: dict, problems: list, llm_fn, taken: Optional[dict] = None,
                                dropped: Optional[dict] = None) -> dict:
    """Re-ask, ONCE and in ONE model call, every field a fallback would delete or replace (and the biography / identityConcept a parse
    floor dropped: `dropped` = `parse_dropped(...)`), with the sentence of the rule it failed. Mutates `profile` with each new value
    that clears the rules it was asked for and brings no new look problem; returns {"asked": [...], "fixed": [...]} (no call, and empty
    lists, when nothing is at risk). Call failures and unusable replies leave `profile` as it was. Codes and field names only in logs."""
    asked: dict = {}
    for f in fields_a_fallback_changes(profile, npc, problems):
        codes = [r.code for r in R.rules_for_field(f, problems) if r.repair]
        if codes:
            asked[f] = codes
    for f, code in (dropped or {}).items():
        if (profile or {}).get(f) in (None, ""):  # a field the first draft lost on a floor and nothing has put back since
            asked.setdefault(f, [code])
    if not asked:
        return {"asked": [], "fixed": []}
    card = _repair_card(profile, npc)
    messages = compact_rewrite_messages(card, repair_ask(asked, npc, taken))
    try:
        text = await llm_fn(messages)
    except Exception as e:  # failsoft-ok: a failed repair leaves the fallback to run as it always did
        logger.info(f"[cast-repair] call failed ({type(e).__name__})")
        return {"asked": list(asked), "fixed": []}
    obj = _extract_json(text or "") if isinstance(text, str) else None
    if not isinstance(obj, dict):
        return {"asked": list(asked), "fixed": []}
    fixed = []
    base_problems = set(problems)
    for f, codes in asked.items():
        val = _clean_repair_value(f, _reply_field(obj, f))
        if val is None:
            continue
        trial = _copy_profile(profile)
        if f in _REPAIR_TOP_FIELDS:
            trial[f] = val
            if f == "biography":
                ok = (_biography_meets_floor(val) and not story_problems(trial, npc)
                      and not [c for c in card_consistency(trial, npc) if c.startswith("story-")])
            else:
                ok = (R.IDENTITY_PARSE_MIN_CHARS <= len(val) <= R.IDENTITY_MAX_CHARS
                      and not [c for c in card_consistency(trial, npc) if c.startswith("identity-")])
        else:
            pc = trial.get("physicalCharacteristics")
            trial["physicalCharacteristics"] = pc = dict(pc) if isinstance(pc, dict) else {}
            pc[f] = val
            after = set(look_problems(trial, npc, taken))
            ok = not (after & set(codes)) and not (after - base_problems)
        if ok:
            if f in _REPAIR_TOP_FIELDS:
                profile[f] = val
            else:
                pcw = profile.get("physicalCharacteristics")
                if not isinstance(pcw, dict):
                    pcw = profile["physicalCharacteristics"] = {}
                pcw[f] = val
            fixed.append(f)
    logger.info(f"[cast-repair] asked {','.join(asked)} fixed {','.join(fixed) or '-'}")
    return {"asked": list(asked), "fixed": fixed}


# ── ORW-388: the story must match the card ─────────────────────────────────────────────────────────────
# A houseguest's own story (identityConcept from genesis, biography from this writer) must not contradict the
# card the player reads: the pinned gender's pronouns, the stated age, the look, and the show's name (Orwell).
# `story_problems` names what is wrong in the biography the writer just produced (the strict retry);
# `repair_story_text` mends any story text deterministically (identityConcept is written once by genesis, so it
# is repaired here, never retried). Vault-free: codes only, never the text.
_STORY_PROBLEM_TEXT = {
    "story-pronoun": "the biography uses pronouns that contradict genderPresentation for the houseguest (man: he/him/his; woman: she/her; nonbinary: they/them); refer to other people by role, never by the houseguest's own pronoun",
    "story-age": "the biography states an age that is not the skeleton age; say exactly the skeleton age or no number at all",
    "story-feature": "the biography names a physical feature (tooth gap, tattoo, glasses, scar, birthmark, freckles...) that the look block does not have; remove it or add it to the look",
    "story-show-name": "the show is called Orwell; never write Big Brother",
    "story-name": "the biography is about someone other than the houseguest: write it about the houseguest by the exact name in the skeleton (first name or full name), never another first name as its subject",
    "story-no-biography": "the biography is missing or too short: write a presentable biography of at least two sentences about this houseguest",
    "story-cast-name": "the biography is about another houseguest on the cast: write it about this houseguest by the exact name in the skeleton",
}
_LOOK_PROBLEM_TEXT.update(_STORY_PROBLEM_TEXT)

_BB_RE = re.compile(r"\bBig[ -]Brother\b", re.I)
_AGE_FORMS = (
    re.compile(r"\b(\d{2})(?:[- ]years?[- ]old)\b", re.I),
    re.compile(r"\b(?:aged?|age:)\s+(\d{2})\b", re.I),
)
_AT_AGE_RE = re.compile(r"\b(at\s+)(\d{2})\b(?=\s*[,.;)]|\s+(?:she|he|they|her|his|their|and|when|after)\b)", re.I)
_AT_AGE_WINDOW = 3  # "at N" is also how a past life event is told ("at 19 he joined"): only a number this close to the card age is read as the age

# Third parties: a sentence that names one of these is about someone else too, so a wrong-gender pronoun in
# it is NOT plainly the houseguest (a man's "her mother"). Such a sentence is never flagged or rewritten.
_OTHER_PERSON_RE = re.compile(
    r"\b(?:mother|mom|mum|mama|father|dad|papa|sister|brother|sibling|wife|husband|spouse|partner|fianc[eé]e?|"
    r"boyfriend|girlfriend|ex|daughter|son|kids?|child|children|aunt|uncle|cousin|niece|nephew|grandmother|"
    r"grandfather|grandma|grandpa|grandparents?|parents?|twin|friend|best friend|roommate|neighbou?r|boss|"
    r"manager|coach|mentor|teacher|professor|student|clients?|customers?|patients?|crew|team|colleagues?|"
    r"coworkers?|rivals?|family|someone|girls|boys|men|women|guys)\b", re.I)
_NAMED_PERSON_RE = re.compile(r"(?<!\bthe )(?<!\bThe )\b[A-Z][a-z]{2,}\b")
_SENT_SPLIT_RE = re.compile(r"(?<=[.!?])(\s+)")
_PRON_RE = re.compile(r"\b(she|he|they|her|hers|herself|him|his|himself|them|their|theirs|themself|themselves)\b", re.I)

_FEATURES = {
    "tooth-gap": (re.compile(r"\b(?:gap-?toothed|gappy|gap[- ]tooth(?:ed)?|(?:a |the )?gap (?:in|between) (?:her|his|their|the) (?:front )?teeth|tooth gap)\b", re.I),
                  re.compile(r"\bgap|diastema", re.I)),
    "tattoo": (re.compile(r"\b(?:tattoo(?:s|ed)?|inked|ink(?:ed)? (?:sleeve|forearm|arm)s?)\b", re.I),
               re.compile(r"\btattoo|\bink(?:ed)?\b|\b(?:full|half)[- ]sleeves?(?!\s+(?:tee|t-?shirt|shirt|top|blouse|sweater|kurta)s?\b)", re.I)),  # ORW-437: a "short-sleeve shirt" is not a tattoo
    "glasses": (re.compile(r"\b(?:(?:wire|horn|round|thick|black|tortoiseshell)[- ]?(?:rimmed|framed)? ?glasses|glasses|spectacles|eyeglasses|bespectacled)\b", re.I),
                re.compile(r"glasses|spectacles|eyeglasses|bespectacled|frames\b", re.I)),
    "scar": (re.compile(r"\bscars?\s+(?:above|across|on|over|under|along|through|beside|near)\b|\ban?\s+(?:[\w-]+\s+)?scar\b", re.I), re.compile(r"\bscar", re.I)),
    "birthmark": (re.compile(r"\bbirth ?marks?\b", re.I), re.compile(r"birth ?mark", re.I)),
    "freckles": (re.compile(r"\b(?:freckles|freckled)\b", re.I), re.compile(r"freckle", re.I)),
}
_GLASSES_NOT = re.compile(r"\b(?:wine|shot|beer|pint|champagne|water|cocktail|drinking|raised?|raising|clink\w*|pour\w*)\s+(?:\w+\s+)?glasses\b", re.I)
_FEATURE_MODIFIER_RE = re.compile(
    r"\b(?:gap-?toothed|gappy|tattooed|inked|bespectacled|freckled|scarred)\s+", re.I)
_FEATURE_NOUN_CLAUSE = {
    "tooth-gap": r"(?:an?\s+|the\s+|her\s+|his\s+|their\s+)?(?:(?!(?:wears?|wearing|has|have|had|with|and|of|in|on|sports?|sporting|the|an?|her|his|their)\b)[\w-]+\s+){0,1}(?:gap (?:in|between) (?:her|his|their|the) (?:front )?teeth|tooth gap)",
    "tattoo": r"(?:an?\s+|the\s+|her\s+|his\s+|their\s+)?(?:(?!(?:wears?|wearing|has|have|had|with|and|of|in|on|sports?|sporting|the|an?|her|his|their)\b)[\w-]+\s+){0,1}tattoos?(?:\s+(?:on|across|along|over|under|around)\s+(?:her|his|their|the)\s+\w+)?",
    "glasses": r"(?:an?\s+|the\s+|her\s+|his\s+|their\s+)?(?:(?!(?:wears?|wearing|has|have|had|with|and|of|in|on|sports?|sporting|the|an?|her|his|their)\b)[\w-]+\s+){0,1}(?:glasses|spectacles|eyeglasses)",
    "scar": r"(?:an?\s+|the\s+|her\s+|his\s+|their\s+)?(?:(?!(?:wears?|wearing|has|have|had|with|and|of|in|on|sports?|sporting|the|an?|her|his|their)\b)[\w-]+\s+){0,1}scars?(?:\s+(?:on|across|above|over|under|along)\s+(?:her|his|their|the)\s+\w+)?",
    "birthmark": r"(?:an?\s+|the\s+|her\s+|his\s+|their\s+)?(?:(?!(?:wears?|wearing|has|have|had|with|and|of|in|on|sports?|sporting|the|an?|her|his|their)\b)[\w-]+\s+){0,1}birth ?marks?",
    "freckles": r"(?:an?\s+|the\s+|her\s+|his\s+|their\s+)?(?:(?!(?:wears?|wearing|has|have|had|with|and|of|in|on|sports?|sporting|the|an?|her|his|their)\b)[\w-]+\s+){0,1}freckles",
}


def _look_text(profile: dict, npc: dict) -> str:
    """Every public look string the card will carry: the authored facet over the seeded one, plus the narrator's appearance line."""
    parts = []
    # ORW-437: the authored facet REPLACES the seeded one on the card, so it alone is read when present (a feature the
    # author removed must not be kept "consistent" by the seeded block); the seeded facet stands in when none was authored.
    authored = (profile or {}).get("physicalCharacteristics")
    seeded = (npc or {}).get("physicalCharacteristics")
    src = authored if isinstance(authored, dict) and authored else seeded
    if isinstance(src, dict):
        for v in src.values():
            parts.extend(str(x) for x in v) if isinstance(v, list) else parts.append(str(v))
    parts.append(str((npc or {}).get("appearance") or ""))
    return " ".join(parts)


def _wrong_pronoun_re(pin: str):
    if pin == "man":
        return re.compile(r"\b(she|her|hers|herself)\b", re.I)
    if pin == "woman":
        return re.compile(r"\b(he|him|his|himself)\b", re.I)
    if pin == "nonbinary":
        return re.compile(r"\b(he|him|his|himself|she|her|hers|herself)\b", re.I)
    return None


def _sentences(text: str) -> list:
    """Alternating [sentence, separator, sentence, ...] so a rewrite keeps the original spacing."""
    return _SENT_SPLIT_RE.split(text or "")


def _plainly_the_houseguest(sentence: str, npc: dict, *, names: bool = True) -> bool:
    """A wrong-gender pronoun is the houseguest's own only when the sentence is about no one else: it names no
    relative, colleague or other person by role, and (when `names`) no other capitalised name. The houseguest's own
    name, hometown and job words do not count as other people."""
    sentence = _BB_RE.sub("Orwell", sentence)  # the show's old name is not a brother
    voc = {w.lower() for w in re.findall(r"[A-Za-z']+", str((npc or {}).get("vocation") or ""))}
    for m in _OTHER_PERSON_RE.finditer(sentence):
        word = m.group(0).lower()
        if word in voc:
            continue  # ORW-431: a role noun that is the houseguest's OWN job is not another person
        if re.search(r"\ban?\s+(?:[\w'-]+\s+){0,4}" + re.escape(m.group(0)) + r"\s+(?:who|that)\b", sentence, re.I):
            continue  # "A small-town strength coach who ...": the role describes the houseguest, it is not a second person
        return False
    if not names:
        return True
    own = {w.lower() for k in ("name", "hometown", "vocation") for w in re.findall(r"[A-Za-z']+", str((npc or {}).get(k) or ""))}
    # ORW-437: a sentence OPENED by another person's name ("Dana trusted her gut.") is about them, not the houseguest.
    lead = re.match(r"^[\"'\u201c\u2018(\s]*([A-Z][a-z]{2,})(?:\s+[A-Z][a-z]+)?\s+([a-z]+)", sentence)
    if lead:
        low = lead.group(1).lower()
        if (low not in own and low not in _NOT_A_NAME and lead.group(2) not in _NOT_A_VERB
                and not low.endswith(("ing", "ly"))):
            return False
    for m in _NAMED_PERSON_RE.finditer(sentence):
        if m.start() > 0 and m.group(0).lower() not in own and m.group(0) != "Orwell":
            return False
    return True


def _swap_pronouns(sentence: str, pin: str) -> str:
    def to_binary(m):
        w = m.group(0)
        lw = w.lower()
        rest = sentence[m.end():]
        poss = re.match(r"\s+[A-Za-z]", rest) is not None  # a noun follows: possessive
        if pin == "man":
            out = {"she": "he", "herself": "himself", "hers": "his"}.get(lw)
            if out is None:
                out = "his" if poss else "him"
        elif pin == "woman":
            out = {"he": "she", "himself": "herself"}.get(lw)
            if out is None:
                out = "her" if lw == "him" else ("her" if poss else "hers")
        else:
            out = {"he": "they", "she": "they", "himself": "themself", "herself": "themself", "him": "them",
                   "his": "their" if poss else "theirs", "her": "their" if poss else "them", "hers": "theirs"}[lw]
        return out.capitalize() if w[0].isupper() else out
    rx = _wrong_pronoun_re(pin)
    out = rx.sub(to_binary, sentence)
    if pin == "nonbinary":
        out = _they_verbs(out)
    return out


_BE_HAVE = {"is": "are", "was": "were", "has": "have", "does": "do", "doesn't": "don't", "isn't": "aren't",
            "wasn't": "weren't", "hasn't": "haven't"}
_S_NOT_VERB = {"always", "perhaps", "sometimes", "this", "thus", "yes", "its", "us", "plus", "less", "unless", "is"}


def _they_verbs(text: str) -> str:
    """Third-person agreement for the word right after "they" ("they floats" -> "they float", "they's" -> "they're")."""
    text = re.sub(r"\b(They|they)['\u2019]s\b", lambda m: m.group(1) + "'re", text)

    def fix(m):
        verb = m.group(2)
        lv = verb.lower()
        if lv in _BE_HAVE:
            new = _BE_HAVE[lv]
        elif lv in _S_NOT_VERB or not lv.endswith("s") or lv.endswith("ss") or len(lv) <= 3:
            new = verb
        elif lv.endswith("ies") and len(lv) > 4:
            new = verb[:-3] + "y"
        elif lv.endswith("oes"):
            new = verb[:-2]  # ORW-437: "goes" -> "go", "echoes" -> "echo" (never "goe")
        elif re.search(r"(?:ch|sh|ss|x|z)es$", lv):
            new = verb[:-2]
        else:
            new = verb[:-1]
        return m.group(1) + new
    return re.sub(r"\b((?:They|they)\s+)([A-Za-z']+)", fix, text)


def pronoun_conflict_sentences(text: str, npc: dict) -> list:
    """Indexes (into `_sentences`) of sentences whose pronouns contradict the pinned gender AND plainly refer to the houseguest."""
    pin = str((npc or {}).get("genderPresentation") or "").strip().lower()
    rx = _wrong_pronoun_re(pin)
    if rx is None:
        return []
    parts = _sentences(text)
    return [i for i in range(0, len(parts), 2) if rx.search(parts[i]) and _plainly_the_houseguest(parts[i], npc)]


_NAME_BEFORE_AGE_RE = re.compile(r"(?<![\w])([A-Z][a-z]{2,})(?:\s+[A-Z][a-z]+)?,?\s*(?:\(|aged?\s+|an?\s+)?$")
_AGE_OPENERS = {"aged", "age", "now", "still", "just", "nearly", "almost", "only", "already", "barely", "turning", "over", "under", "about"}
_PLACE_PREP_RE = re.compile(r"\b(?:in|from|of|to|near|at|around|outside|across|born)\s+$", re.I)


def _age_after_other_name(sentence: str, start: int, npc: dict) -> bool:
    """True when the age number at `start` directly follows a capitalised name that is not the houseguest's own and is
    not a place ("Marcus, 45" or "Dana (45"): that is another person's age, never rewritten to the card's."""
    before = sentence[max(0, start - 48):start]
    m = _NAME_BEFORE_AGE_RE.search(before)
    if not m:
        return False
    # A sentence-opening word that is no name ("Aged 45 she moved", "Now 45") is the houseguest's own age; a sentence
    # opened by a name ("Marcus aged 45") is that person's, unless it is the card's own (review of #2748).
    if m.group(1).lower() in _AGE_OPENERS and sentence[:m.start(1)].strip() == "":
        return False
    if m.group(1).lower() in _own_words(npc):
        return False
    return not _PLACE_PREP_RE.search(before[:m.start(1)])


def _wrong_age_spans(text: str, npc: dict) -> list:
    """(start, end) of each stated-age number that is not the card age. Only sentences about no one else are read: a
    "12-year-old niece" or "her 52-year-old mother" is another person's age. A stated age under 18 is never a houseguest's."""
    age = _age_of(npc)
    if age is None:
        return []
    out = []
    parts = _sentences(text or "")
    pos = 0
    for i, part in enumerate(parts):
        if i % 2 == 0 and _plainly_the_houseguest(part, npc, names=False):
            for rx in _AGE_FORMS:
                out += [(pos + m.start(1), pos + m.end(1)) for m in rx.finditer(part)
                        if int(m.group(1)) != age and int(m.group(1)) >= 18
                        # ORW-437: "At age 19, she left home" is a past life event, read only inside the "at N" window;
                        # and an age right after another person's capitalised name ("Marcus, 45") is theirs.
                        and not (re.search(r"\bat$", part[:m.start()].rstrip(), re.I) and abs(int(m.group(1)) - age) > _AT_AGE_WINDOW)
                        and not _age_after_other_name(part, m.start(), npc)]
            out += [(pos + m.start(2), pos + m.end(2)) for m in _AT_AGE_RE.finditer(part)
                    if int(m.group(2)) != age and abs(int(m.group(2)) - age) <= _AT_AGE_WINDOW]
        pos += len(part)
    return out


def story_age_conflict(text: str, npc: dict) -> bool:
    return bool(_wrong_age_spans(text, npc))


def story_missing_features(text: str, profile: dict, npc: dict) -> list:
    """The look features the story names that the look does not have (codes from `_FEATURES`)."""
    look = _look_text(profile, npc)
    out = []
    for code, (said, has) in _FEATURES.items():
        scan = _GLASSES_NOT.sub("", text or "") if code == "glasses" else (text or "")
        if said.search(scan) and not has.search(look):
            out.append(code)
    return out



# ── ORW-430: the story must be about the card's own name ───────────────────────────────────────────────
# Genesis writes the name, identity and first biography together; the gender fold later re-picks the GIVEN name
# (diversity.ts step 7.5) and nothing rewrote the prose, so a biography can be about "Nia" on Samir's card.
# The net reads PUBLIC text only and logs codes, never the text. A first name is the SUBJECT when it opens a
# sentence and a verb follows. The check fires only when the houseguest's own first name never appears in the text
# and the same other name opens the first sentence or two or more sentences. A relative or boss named in passing
# is never a subject-opener, so it is left alone.
_SUBJECT_RE = re.compile(r"^[\"'\u201c\u2018(\s]*([A-Z][a-z]{2,})(['\u2019]s)?(?:\s+[A-Z][a-z]+)?\s+([a-z]+)")  # ORW-437: group 2 = possessive, optional surname
_NOT_A_VERB = frozenset({"and", "or", "but", "of", "in", "on", "at", "to", "from", "for", "with", "the", "a", "an",
                         "who", "whose", "which", "that", "as", "by", "than", "nor", "so", "if", "into", "over"})
_NOT_A_NAME = frozenset(w.lower() for w in (
    "The This That These Those There Their They Then When While Where After Before During Since Until Though Although "
    "She He We You Who Whom Because Between Raised Born Off Outside Inside Every Each Most Some Many Much Few Once Always Never Even Just Only "
    "Also Her His Its Our Your Whenever Behind Beyond Across Along Among Around Beneath Despite Instead Meanwhile "
    "Nobody Everyone Someone Anyone Nothing Something Everything Today Tonight Yesterday Often Sometimes Lately "
    "Recently Eventually Still Later Soon Now Here Over Under With Without From Into Upon Within Beside Besides "
    "May Orwell Sunday Monday Tuesday Wednesday Thursday Friday Saturday January February March April June July August "
    "September October November December Off-camera Fresh Quiet Soft Gentle Sharp Warm Cool Quick Steady Young Older "
    "Small Large Little Early Late Good Great Real Free Open Private Public Single Double Second Third First Last "
    "Next Both Neither Either Another Other Such What Which Whoever Whatever Whichever However Still Yet Perhaps "
    "Maybe Likely Mostly Mainly Nearly Almost Already Currently Formerly Honestly Quietly Slowly Gently").split())


def _own_words(npc: dict) -> set:
    return {w.lower() for k in ("name", "hometown", "vocation") for w in re.findall(r"[A-Za-z']+", str((npc or {}).get(k) or ""))}


def _first_name(npc: dict) -> str:
    toks = str((npc or {}).get("name") or "").split()
    return toks[0] if toks else ""


def _cast_first_names(cast, npc: dict) -> frozenset:
    out = set()
    for c in cast or []:
        if isinstance(c, dict) and c.get("id") != (npc or {}).get("id"):
            f = _first_name(c).lower()
            if f:
                out.add(f)
    return frozenset(out)


def _subject_names(text: str, npc: dict, cast=None) -> dict:
    """First names that open sentences as the grammatical subject, in order: {name: sentence count}. Empty when the
    houseguest's own first name is in the text (the biography is then about them), or when there is no card name."""
    own_first = _first_name(npc).lower()
    if not own_first or not isinstance(text, str) or not text.strip():
        return {}
    if re.search(r"\b%s\b" % re.escape(own_first), text, re.I):
        return {}
    own = _own_words(npc)
    cast_first = _cast_first_names(cast, npc)
    counts: dict = {}
    for part in _sentences(text)[::2]:
        m = _SUBJECT_RE.match(part)
        if not m:
            continue
        tok, nxt = m.group(1), m.group(3)
        low = tok.lower()
        if m.group(2):
            continue  # ORW-437: "Nia's bakery" is a possessive, never the sentence's subject
        if nxt in _NOT_A_VERB or low in _NOT_A_NAME or low in own:
            continue
        if low.endswith("ing") and len(low) > 5:
            continue
        if own_first.startswith(low) and low not in cast_first:
            # ORW-437: a nickname is a SHORTENING the card's own first name starts with (Sam for Samuel) and is not
            # another cast member's first name. A LONGER name (Samira for Samir) is a different person, never a nickname.
            continue
        if re.search(r"\b(?:in|from|of|to|near|at|around|outside|across)\s+%s\b" % re.escape(tok), text):
            continue  # a place, used as a place elsewhere in the text
        counts[tok] = counts.get(tok, 0) + 1
    first = next((t for t in [_SUBJECT_RE.match(_sentences(text)[0] or "")] if t), None)
    opener = first.group(1) if first else None
    return {t: n for t, n in counts.items() if n >= 2 or t == opener}


def story_name_codes(text: str, npc: dict, cast=None) -> list:
    """`story-name` (a first name nobody on the cast owns is the subject) and/or `story-cast-name` (another cast
    member's first name is the subject). [] when the text is about the houseguest or names no subject."""
    subj = _subject_names(text, npc, cast)
    if not subj:
        return []
    cast_first = _cast_first_names(cast, npc)
    out = []
    if any(t.lower() not in cast_first for t in subj):
        out.append("story-name")
    if any(t.lower() in cast_first for t in subj):
        out.append("story-cast-name")
    return out


def repair_story_name(text: str, npc: dict, cast=None) -> str:
    """Swap each wrong subject first name (every occurrence, with its possessive) for the card's first name."""
    out = text
    own_first = _first_name(npc)
    for tok in _subject_names(text, npc, cast):
        # ORW-437: a wrong FULL name ("Nia Smith grew up") is swapped whole, so the card's first name never trails a stray surname
        out = re.sub(r"\b%s(?:\s+[A-Z][a-z]+)?\b(?=['\u2019]s\b|\s+[a-z])" % re.escape(tok), own_first, out)
        out = re.sub(r"\b%s\b" % re.escape(tok), own_first, out)
    return out


def story_problems(profile: dict, npc: dict, cast=None) -> list:
    """Reason codes for the biography the writer just produced ([] when clean or when there is none)."""
    bio = (profile or {}).get("biography")
    if not isinstance(bio, str) or not bio.strip():
        return []
    out = []
    if pronoun_conflict_sentences(bio, npc):
        out.append("story-pronoun")
    if story_age_conflict(bio, npc):
        out.append("story-age")
    if story_missing_features(bio, profile, npc):
        out.append("story-feature")
    if _BB_RE.search(bio):
        out.append("story-show-name")
    out += story_name_codes(bio, npc, cast)
    return out



# ── ORW-430: the one final check, run after ALL repairs ────────────────────────────────────────────────
# `card_consistency` is the single place the accept path asks "is this card consistent". Codes only, never text.
# Repaired before this runs (so a code here that is not a hole means the repair could not settle it):
#   story-name, story-cast-name (name swapped for the card's), story-pronoun, story-age, story-feature, story-show-name
#   (all mended by repair_story_text, for the biography and the identityConcept).
# Only reported: story-no-biography (retried once; if still missing the card is NOT written, so it stays unauthored and
# the existing backfill picks it up; RED soft failure), look-missing-<field> (wardrobe/onCamera/photoHair come from the
# photo-sheet pass, which may still fill them; reported, RED at the end of the run if still missing, and the card is
# listed by `unauthored_ids` so the backfill takes it again), identity-missing (genesis owns the identity; the writer cannot
# make one and no filler is invented), identity-* (an identity problem the repair could not settle).
_IDENTITY_MIN_CHARS = R.IDENTITY_MIN_CHARS
_REQUIRED_LOOK_FIELDS = ("wardrobe", "onCamera", "photoHair")


def look_fields_missing(pc_a, pc_b=None) -> list:
    """The required photo-sheet fields (wardrobe, onCamera, photoHair) that neither look block carries."""
    pcs = [x for x in (pc_a, pc_b) if isinstance(x, dict)]
    return [f for f in _REQUIRED_LOOK_FIELDS if not any(x.get(f) not in (None, "", [], {}) for x in pcs)]
_BIO_FINAL_MIN_CHARS = 40


def _has_floor_biography(npc: dict) -> bool:
    """The seeded floor biography the engine already holds for this card (the skeleton carries it): when the writer
    omits its own, that one stands, so the card is not empty. Briana had none left."""
    if (npc or {}).get("biographyDraft") is True:
        return False  # ORW-438: genesis's nameless first draft is not a floor; the writer must supply the real one
    b = (npc or {}).get("biography")
    return isinstance(b, str) and len(b.strip()) >= _BIO_FINAL_MIN_CHARS


def card_consistency(profile: dict, npc: dict, cast=None) -> list:
    out = []
    bio = (profile or {}).get("biography")
    if not isinstance(bio, str) or len(bio.strip()) < _BIO_FINAL_MIN_CHARS:  # a repair may trim a floor-clearing text
        if not _has_floor_biography(npc):
            out.append("story-no-biography")
    out += story_problems(profile, npc, cast)
    ident = (profile or {}).get("identityConcept") or (npc or {}).get("identityConcept")
    if not isinstance(ident, str) or len(ident.strip()) < _IDENTITY_MIN_CHARS:
        out.append("identity-missing")
    else:
        if pronoun_conflict_sentences(ident, npc):
            out.append("identity-pronoun")
        if story_age_conflict(ident, npc):
            out.append("identity-age")
        out += ["identity-" + c.replace("story-", "") for c in story_name_codes(ident, npc, cast)]
    out += ["look-missing-" + f for f in look_fields_missing((profile or {}).get("physicalCharacteristics"),
                                                              (npc or {}).get("physicalCharacteristics"))]
    return out


_MODIFIER_FOR = {"tooth-gap": r"gap-?toothed", "tattoo": r"tattooed|inked", "glasses": r"bespectacled", "freckles": r"freckled"}


def _drop_feature(text: str, code: str) -> str:
    """Drop the feature's words (the modifier form, then the noun phrase with its connector), then tidy spacing."""
    out = text
    if code in _MODIFIER_FOR:
        out = re.sub(r"\b(?:%s)\s+" % _MODIFIER_FOR[code], "", out, flags=re.I)
    if _FEATURES[code][0].search(_GLASSES_NOT.sub("", out) if code == "glasses" else out):
        out = re.sub(r"(?:,\s*|\s+and\s+|\s+with\s+)?" + _FEATURE_NOUN_CLAUSE[code], "", out, flags=re.I)
    out = re.sub(r"\s+([,.;!?])", r"\1", out)
    out = re.sub(r"(?:\s+and)?\s+\b(?:wears?|wearing|has|have|had|sports?|sporting|with)\s*([,.;!?]|$)", r"\1", out, flags=re.I)
    out = re.sub(r"[ \t]{2,}", " ", out).strip()
    parts = _sentences(out)
    kept = "".join(p for i, p in enumerate(parts)
                   if i % 2 == 0 and len(p.split()) >= 3 or i % 2 == 1)  # a stub left by the drop ("Laura.") goes
    return re.sub(r"^\s+", "", kept) if kept.strip() else out


def repair_story_text(text: str, profile: dict, npc: dict, cast=None) -> str:
    """Mend one story text deterministically: the houseguest's own wrong pronouns, a wrong age, a look feature the look
    lacks, and "Big Brother". Returns the text unchanged when nothing is wrong (and never an empty string)."""
    if not isinstance(text, str) or not text.strip():
        return text
    out = repair_story_name(text, npc, cast)  # first: the repaired name makes the pronoun and age checks below see the houseguest
    pin = str((npc or {}).get("genderPresentation") or "").strip().lower()
    bad = pronoun_conflict_sentences(out, npc)
    if bad:
        parts = _sentences(out)
        for i in bad:
            parts[i] = _swap_pronouns(parts[i], pin)
        out = "".join(parts)
    age = _age_of(npc)
    if age is not None:
        for a, b in sorted(_wrong_age_spans(out, npc), reverse=True):
            out = out[:a] + str(age) + out[b:]
    for code in story_missing_features(out, profile, npc):
        dropped = _drop_feature(out, code)
        if dropped:
            out = dropped
    out = _BB_RE.sub("Orwell", out)
    return out if out.strip() else text


def repair_story(profile: dict, npc: dict, cast=None) -> list:
    """Repair the biography in `profile` and the card's identityConcept in place; returns the story codes repaired
    (`biography`, `identityConcept`). The repaired identityConcept rides along in `profile` for the write-back."""
    done = []
    bio = profile.get("biography")
    if isinstance(bio, str):
        fixed = repair_story_text(bio, profile, npc, cast)
        if fixed != bio:
            profile["biography"] = fixed
            done.append("biography")
    ident = profile.get("identityConcept") or (npc or {}).get("identityConcept")  # ORW-431: the writer's own, else genesis's
    if isinstance(ident, str) and ident.strip():
        fixed = repair_story_text(ident, profile, npc, cast)
        if fixed != ident:
            profile["identityConcept"] = fixed
            done.append("identityConcept")
    return done


# ── ORW-380: the shared photo-sheet writer (running-season upgrader, new-cast de-duplication pass) ──────

# The ONLY card fields the photo-sheet writer ever sees: public profile fields. Never a Vault-adjacent field.
SHEET_WRITER_FIELDS = ("name", "genderPresentation", "age", "ethnicity", "vocation", "hometown", "demeanor",
                       "archetype", "identityConcept", "presentation")
_SHEET_PHYS_FIELDS = ("heightBuild", "hair", "style")
SHEET_FIELDS = ("wardrobe", "photoHair", "onCamera")


def photo_sheet_writer_input(card: dict, taken: Optional[dict] = None) -> dict:
    """Allowlisted PUBLIC inputs for the photo-sheet writer: name, genderPresentation, age, ethnicity, vocation,
    hometown, demeanor, archetype, identityConcept, voice (energy and register only), presentation,
    physicalCharacteristics.{heightBuild, hair, style}, castingType ({label, read}, when the card has it), and the `taken` lists."""
    card = card if isinstance(card, dict) else {}
    out = {k: card[k] for k in SHEET_WRITER_FIELDS if card.get(k) not in (None, "", [], {})}
    ct = card.get("castingType")
    if isinstance(ct, dict):
        sub = {k: str(ct[k]) for k in ("label", "read") if ct.get(k) not in (None, "")}
        if sub:
            out["castingType"] = sub
    voice = card.get("voice")
    if isinstance(voice, dict):
        sub = {k: voice[k] for k in ("energy", "register") if voice.get(k) not in (None, "")}
        if sub:
            out["voice"] = sub
    phys = card.get("physicalCharacteristics")
    if isinstance(phys, dict):
        sub = {k: phys[k] for k in _SHEET_PHYS_FIELDS if phys.get(k) not in (None, "")}
        if sub:
            out["physicalCharacteristics"] = sub
    out["taken"] = {"mainPieces": list((taken or {}).get("mainPieces") or []),
                    "spots": dict((taken or {}).get("spots") or {})}
    return out


def sheet_problems(fields: dict, card: dict, taken: Optional[dict] = None) -> list:
    """The look-check codes over a proposed photo sheet (`fields` holds wardrobe / photoHair / onCamera)."""
    pc = {k: fields[k] for k in SHEET_FIELDS if isinstance(fields, dict) and k in fields}
    if not pc:
        return []
    phys = card.get("physicalCharacteristics") if isinstance(card, dict) else None
    if isinstance(phys, dict) and phys.get("style"):
        pc["style"] = phys["style"]
    return look_problems({"physicalCharacteristics": pc}, card, taken)


def sheet_fallbacks(fields: dict, card: dict, problems: list) -> dict:
    """Apply the fallbacks to a copy of `fields` (a failing field is omitted, wardrobe-taken keeps the clothes)."""
    profile = {"physicalCharacteristics": {k: fields[k] for k in SHEET_FIELDS if k in fields}}
    apply_look_fallbacks(profile, card, list(problems))
    return {k: v for k, v in profile["physicalCharacteristics"].items() if k in SHEET_FIELDS and v}


def _clean_sheet(raw) -> dict:
    out: dict = {}
    if not isinstance(raw, dict):
        return out
    wd = raw.get("wardrobe")
    if isinstance(wd, list):
        items = [" ".join(str(x).split()) for x in wd if isinstance(x, (str, int)) and str(x).strip()]
        if items:
            out["wardrobe"] = items
    for k in ("photoHair", "onCamera"):
        v = raw.get(k)
        if isinstance(v, str) and v.strip():
            out[k] = " ".join(v.split())
    return out


async def write_photo_sheet(card: dict, taken: Optional[dict], llm_fn: LlmFn) -> tuple:
    """The ONE photo-sheet writer. One model call over `photo_sheet_writer_input(card, taken)` with the shared
    instruction; the shared checker; on any problem ONE strict retry naming it (with the taken lists); then the
    fallbacks (a failing field is omitted; wardrobe-taken keeps the clothes). Returns ``(fields, codes)``: the
    accepted fields and the reason codes still standing after the retry. Logs codes and the houseguest id only."""
    hid = str((card or {}).get("id") or "?")
    messages = [{"role": "system", "content": PHOTO_SHEET_SYSTEM},
                {"role": "user", "content": json.dumps(photo_sheet_writer_input(card, taken), ensure_ascii=False)}]
    fields: dict = {}
    problems: list = []
    for attempt in (0, 1):
        # ORW-437: the strict retry names real problems; after a RAISED first call there are none, so resend the original.
        msgs = messages if attempt == 0 or not problems else messages + [
            {"role": "user", "content": look_retry_message(problems, taken)}]
        try:
            text = await llm_fn(msgs)
        except Exception as e:  # failsoft-ok: best-effort-enrichment (the photo sheet is optional)
            logger.info(f"[photo-sheet] writer call failed for {hid}: {type(e).__name__}")
            continue
        got = _clean_sheet(_extract_json(text or "") or {})
        if not got:
            problems = problems or ["wardrobe-shape", "oncamera-shape"]
            continue
        fields = got
        problems = sheet_problems(fields, card, taken)
        if not problems:
            return fields, []
        logger.info(f"[photo-sheet] check failed for {hid} ({', '.join(problems)})"
                    + (" - retrying once" if attempt == 0 else ""))
    if not fields:
        return {}, problems
    # ORW-956: a field the fallback would delete is re-asked ONCE first (one extra call, with the failing rules' sentences)
    holder = {"physicalCharacteristics": dict(fields)}
    rep_result = await repair_failing_fields(holder, card, problems, llm_fn, taken)
    if rep_result["fixed"]:
        fields = {k: v for k, v in holder["physicalCharacteristics"].items() if k in SHEET_FIELDS}
        problems = sheet_problems(fields, card, taken)
        if not problems:
            return fields, []
    out = sheet_fallbacks(fields, card, problems)
    logger.warning(f"[photo-sheet] fell back for {hid} after the retry ({', '.join(problems)})")
    return out, problems


async def dedupe_photo_sheets(cards: list, llm_fn: LlmFn, write_look_fn) -> int:
    """The new-cast de-duplication post-pass. Walk `cards` (houseguests with their authored sheets) in id order
    building the taken lists (main pieces, spot counts). A houseguest whose main piece repeats an earlier one, or
    whose spot already has 3 houseguests, gets ONLY their photo sheet rewritten by `write_photo_sheet` given the
    taken lists; the accepted fields are stored with `write_look_fn(houseguest_id, fields)`. One writer call per
    offender, one pass; a failure leaves the original sheet. Returns how many sheets were rewritten."""
    ordered = sorted((c for c in (cards or []) if isinstance(c, dict) and c.get("id")), key=lambda c: str(c["id"]))
    taken: dict = {"mainPieces": [], "spots": {}}
    rewritten = 0
    for card in ordered:
        phys = card.get("physicalCharacteristics") if isinstance(card.get("physicalCharacteristics"), dict) else {}
        current = {"physicalCharacteristics": phys}
        mine = photo_sheet_taken([current])
        piece = (mine["mainPieces"] or [None])[0]
        spot = next(iter(mine["spots"]), None)
        piece_dup = piece is not None and main_piece_key(piece) in {main_piece_key(x) for x in taken["mainPieces"]}
        spot_full = spot is not None and taken["spots"].get(spot, 0) >= _SPOT_MAX
        offender = bool(piece_dup or spot_full)
        if offender:
            try:
                fields, codes = await write_photo_sheet(card, {"mainPieces": list(taken["mainPieces"]),
                                                               "spots": dict(taken["spots"])}, llm_fn)
                fields = {k: v for k, v in fields.items() if k in SHEET_FIELDS}
                # ORW-437 (review of #2665): a failing field is OMITTED by the writer, so the old value would stand. When
                # the omitted field is the offending one (the repeated main piece, the full spot) it is cleared, never
                # left stored and counted for later guests; the backfill refills a cleared field.
                clear = [k for k, bad in (("wardrobe", piece_dup), ("onCamera", spot_full)) if bad and fields and k not in fields and k in phys]  # (no fields at all = the writer failed: the original stands)
                if fields or clear:
                    res = await write_look_fn(str(card["id"]), {**fields, **({"clear": clear} if clear else {})})
                    if isinstance(res, dict) and res.get("accepted"):
                        merged = {k: v for k, v in phys.items() if k not in clear}
                        merged.update(fields)
                        card["physicalCharacteristics"] = merged  # ORW-437: in place, so the caller's post-pass check sees the stored sheet
                        card = {**card}
                        phys = merged
                        rewritten += 1
                        logger.info(f"[cast-authoring] photo sheet rewritten for {card['id']} (de-duplication)")
            except Exception as e:  # failsoft-ok: best-effort-enrichment (the original sheet stands)
                logger.info(f"[cast-authoring] photo-sheet de-duplication skipped for {card.get('id')}: {type(e).__name__}")
        now = photo_sheet_taken([{"physicalCharacteristics": phys}])
        taken["mainPieces"].extend(now["mainPieces"])
        for k, v in now["spots"].items():
            taken["spots"][k] = taken["spots"].get(k, 0) + v
    return rewritten


FIT_AUDIT_RULE = (
    "One rule, applied to each person on their own terms: would THIS person, with this job, this age, this income and the weather of this "
    "hometown, plausibly wear each piece and carry the signature on an ordinary day, at work or off it? Flag a piece only when it clearly "
    "does not make sense for who they are: gear or clothes that belong to a different trade or life, clothes for the wrong season or climate "
    "for the job they do, something far above what they could pay, or a get-up that reads as a costume. Taste is not a fault. Every person "
    "gets the same question; there is no list of jobs or garments."
)


def fit_audit_messages(cards: list) -> list[dict]:
    """The one batched casting-director question for the whole cast: which cards carry a piece that does not fit the life."""
    people = []
    for c in cards:
        pc = c.get("physicalCharacteristics") if isinstance(c.get("physicalCharacteristics"), dict) else {}
        people.append({"id": c.get("id"), "age": c.get("age"), "job": c.get("vocation"), "hometown": c.get("hometown"),
                       "wardrobe": pc.get("wardrobe"), "lookSignature": pc.get("lookSignature")})
    system = ("You are the casting director of a reality show checking that every person looks like a real person with a real life. "
              + FIT_AUDIT_RULE + ' Reply with STRICT JSON only: {"misfits": [{"id": "...", "piece": "the exact piece", "why": "one short reason"}]}, '
              "at most 4, the clearest first, or an empty list.")
    return [{"role": "system", "content": system}, {"role": "user", "content": json.dumps(people, ensure_ascii=False)}]


async def fit_audit_pass(cards: list, llm_fn: LlmFn, write_look_fn, limit: int = 6) -> int:
    """The cast-level look pass (ORW-480). ONE model call over the finished cast applies the fit rule to every person and names the cards with a
    piece that does not fit the life. Those cards, plus cards left with NO wardrobe, NO signature, or a signature whose category is full, get ONE
    field-only rewrite each (at most `limit`, in that order of importance) that must pass the look checks and the table's look-fit check. A
    rewritten wardrobe also rewrites the style line (so no style names a garment that is gone), and the rewrites are re-audited ONCE together (one
    more call): a rewrite the audit flags again gets one more attempt with that reason, then whatever passes the checks is stored with
    `write_look_fn`. A failure at any step leaves the original look. The audit is advisory: it can miss a misfit. Returns how many cards changed.
    Logs counts only."""
    by_id = {str(c["id"]): c for c in (cards or []) if isinstance(c, dict) and c.get("id")}
    if len(by_id) < 2:
        return 0
    from src import orwell_cast_realism as _R
    flagged: list = []
    try:
        got = _extract_json(await llm_fn(fit_audit_messages(list(by_id.values())))) or {}
        flagged = got.get("misfits") if isinstance(got.get("misfits"), list) else []
    except Exception as e:  # failsoft-ok: best-effort-enrichment (the looks stand; the missing-field rewrites below still run)
        logger.info(f"[fit-audit] audit call failed: {type(e).__name__}")
    jobs: list = []  # (hid, reason)
    seen: set = set()

    def add(hid, reason):
        if hid in by_id and hid not in seen and len(jobs) < limit:
            seen.add(hid)
            jobs.append((hid, reason))

    def _pc(c):
        return c.get("physicalCharacteristics") if isinstance(c.get("physicalCharacteristics"), dict) else {}

    def _wd(c):
        return _pc(c).get("wardrobe")

    def _sig(c):
        return str(_pc(c).get("lookSignature") or "").strip()
    for hid, c in by_id.items():
        if not _wd(c):
            add(hid, "it has no wardrobe at all")
    for item in flagged:
        if isinstance(item, dict):
            add(str(item.get("id")), f'"{str(item.get("piece") or "")[:80]}" does not fit this life ({str(item.get("why") or "")[:120]})')
    for hid, c in by_id.items():  # a card with NO signature outranks a card whose signature merely repeats a kind
        if not _sig(c):
            add(hid, "it has no lookSignature")
    held: dict = {}  # category -> the cards holding it
    cap = _R.cap_for("signature", "hair", len(by_id))
    for hid, c in by_id.items():
        if _sig(c):
            for cat in _R.tag_card({"physicalCharacteristics": {"lookSignature": _sig(c)}}).get("signature", []):
                if cat != "other":
                    if len(held.get(cat, [])) >= cap:
                        add(hid, f"its signature is about {_R.plain_label('signature', cat)}, which {cap} other cards already have")
                    held.setdefault(cat, []).append(hid)
    logger.info(f"[fit-audit] audit flagged={len(flagged)} rewrites-planned={len(jobs)}")

    async def propose(hid, reason):
        """One field-only rewrite for a card: {wardrobe, style, lookSignature} that passes the look checks, or None."""
        card = by_id[hid]
        phys = _pc(card)
        free = [_R.plain_label("signature", c) for c in _R.signature_categories() if len([h for h in held.get(c, []) if h != hid]) < cap]
        ask = (f"A casting director found a problem with this look: {reason}. " + FIT_AUDIT_RULE
               + " Rewrite the wardrobe (2-3 pieces, one garment each; keep the current one when it is fine) and the lookSignature (ONE memorable thing about "
               f"how they look or dress, from their own life, never a whole outfit; its kind must be one of: {', '.join(free)}; when it is about hair it names "
               "only the cut, length and texture that the card's own hair lines already carry). "
               'Reply with ONLY {"wardrobe": [...], "lookSignature": "..."}.')
        fresh = _extract_json(await llm_fn(compact_rewrite_messages(card, ask))) or {}
        wd = fresh.get("wardrobe")
        wd = [" ".join(str(x).split()) for x in wd if isinstance(x, (str, int)) and str(x).strip()] if isinstance(wd, list) else []
        new: dict = {}
        if 2 <= len(wd) <= 3 and (not _wd(card) or "wardrobe" in reason.lower() or "fit" in reason.lower()):
            new["wardrobe"] = wd
            new["style"] = ", ".join(x.lower() for x in wd)  # the style line is the new pieces in plain words: it can never name a garment that is gone
        sig = fresh.get("lookSignature")
        if isinstance(sig, str) and sig.strip() and ("signature" in reason.lower() or "wardrobe" in new):
            cats = [c for c in _R.tag_card({"physicalCharacteristics": {"lookSignature": sig}}).get("signature", []) if c != "other"]
            if not any(len([h for h in held.get(c, []) if h != hid]) >= cap for c in cats):
                new["lookSignature"] = " ".join(sig.split())[:R.SIGNATURE_MAX_CHARS]
        new = {k: ([_R.scrub_labels(x) for x in v] if isinstance(v, list) else _R.scrub_labels(v)) for k, v in new.items()}
        if not new:
            logger.info(f"[fit-audit] rewrite for {hid} carried nothing usable (reply keys={sorted(str(k) for k in fresh)[:6]}, wardrobe pieces={len(wd)}, "
                        f"signature kinds={[c for c in _R.tag_card({'physicalCharacteristics': {'lookSignature': str(fresh.get('lookSignature') or '')}}).get('signature', []) if c != 'other']}, "
                        f"reason={reason.split(',')[0][:40]})")
            return None
        cand = {**card, "physicalCharacteristics": {**phys, **new}}
        bad = [c for c in look_problems(cand, card) if c != "style-wrong-family"]
        fit = [x for x in _R.look_fits_life(cand) if x in ("upscale", "climate", "missing")]  # "family" and "family-worn" are about the dealt label, which this write-back cannot change
        if bad or fit:
            logger.info(f"[fit-audit] rewrite for {hid} rejected: {','.join(bad + fit)}")
            if "signature-hair" in bad or "signature-shape" in bad:
                new.pop("lookSignature", None)  # keep the clothes the checks passed; the signature is re-asked later, never stored contradicting the hair
                cand = {**card, "physicalCharacteristics": {**phys, **new}}
                if new and not [c for c in look_problems(cand, card) if c != "style-wrong-family"] and not [x for x in _R.look_fits_life(cand) if x in ("upscale", "climate", "missing")]:
                    return new
            return None
        return new

    cands: dict = {}
    for hid, reason in jobs:
        try:
            new = await propose(hid, reason)
        except Exception as e:  # failsoft-ok: best-effort-enrichment (the original look stands)
            logger.info(f"[fit-audit] rewrite skipped for {hid}: {type(e).__name__}")
            continue
        if new:
            cands[hid] = (reason, new)
            for cat in _R.tag_card({"physicalCharacteristics": {"lookSignature": new.get("lookSignature", "")}}).get("signature", []):
                held.setdefault(cat, []).append(hid)
    # the audit's own rewrites are audited once (a rewrite can introduce a new misfit): the cards whose wardrobe was rewritten, in one call
    changed = [{**by_id[h], "physicalCharacteristics": {**_pc(by_id[h]), **n}} for h, (_, n) in cands.items() if "wardrobe" in n]
    if len(changed) >= 1:
        try:
            again = _extract_json(await llm_fn(fit_audit_messages(changed))) or {}
            for item in (again.get("misfits") if isinstance(again.get("misfits"), list) else []):
                hid = str(item.get("id")) if isinstance(item, dict) else ""
                if hid in cands:
                    logger.info(f"[fit-audit] re-audit flagged the rewrite for {hid}: one more attempt")
                    retry = await propose(hid, f'"{str(item.get("piece") or "")[:80]}" does not fit this life ({str(item.get("why") or "")[:120]})')
                    if retry and "wardrobe" in retry:
                        cands[hid] = (cands[hid][0], retry)
                    else:
                        del cands[hid]  # the original look stands rather than a second misfit
        except Exception as e:  # failsoft-ok: best-effort-enrichment (the first rewrites stand)
            logger.info(f"[fit-audit] re-audit skipped: {type(e).__name__}")
    done = 0
    for hid, (_, new) in cands.items():
        try:
            res = await write_look_fn(hid, new)
        except Exception as e:  # failsoft-ok: best-effort-enrichment (the original look stands)
            logger.info(f"[fit-audit] write skipped for {hid}: {type(e).__name__}")
            continue
        if isinstance(res, dict) and res.get("accepted"):
            by_id[hid]["physicalCharacteristics"] = {**_pc(by_id[hid]), **new}
            done += 1
            logger.info(f"[fit-audit] look rewritten for {hid} ({','.join(new)})")
        else:
            logger.info(f"[fit-audit] write for {hid} not accepted: {(res or {}).get('reason') if isinstance(res, dict) else type(res).__name__}")
    logger.info(f"[fit-audit] rewritten={done} of {len(jobs)}")
    return done


# Opening patterns, dealt by the card's slot in the cast (modulo the list), so cards written in parallel do not converge on
# "A <age>-year-old ..." or "He stands ...". Steering text only; the checks and the gate are unchanged.
IDENTITY_OPENINGS = ("the occupation", "what they care about most", "where they come from", "a trait people notice first",
                     "what they are known for in the house", "how a stranger would meet them")
ONCAMERA_OPENINGS = ("the house spot", "the hands", "the gaze", "the lean or posture of the shoulders", "the expression",
                     "the prop in reach")


def _signature_lean(slot: int) -> str:
    try:
        from src import orwell_cast_realism as _R
        cats = [c for c in _R.signature_categories() if c != "hair"]
        return _R.plain_label("signature", cats[(slot * 5) % len(cats)])  # plain words: the internal category names never reach the writer
    except Exception:  # failsoft-ok: the table never blocks a card
        return "jewellery"


def opening_pattern(slot: int) -> dict:
    return {"identityConcept opens with": IDENTITY_OPENINGS[slot % len(IDENTITY_OPENINGS)],
            "onCamera opens with": ONCAMERA_OPENINGS[(slot + 2) % len(ONCAMERA_OPENINGS)],
            # ORW-480: about one card in three ends with a "the one who" read, so it is not on every line
            "closing read": "yes" if slot % 3 == 0 else "no"}


def compact_rewrite_messages(npc: dict, ask: str) -> list[dict]:
    """The short prompt for a field-only rewrite (a repeated opening, a name in the identity line, a casting-director offender): the
    card's own facts, the on-camera and wardrobe rules, and the ask. About a third of the input and a tenth of the output of a full
    regeneration, so it adds seconds, not tens of seconds."""
    pc = npc.get("physicalCharacteristics") if isinstance(npc.get("physicalCharacteristics"), dict) else {}
    facts = {k: npc.get(k) for k in ("genderPresentation", "age", "vocation", "hometown", "demeanor", "identityConcept", "presentation") if npc.get(k)}
    facts["look"] = {k: pc.get(k) for k in ("hair", "heightBuild", "facialFeatures", "distinguishingMark", "style", "wardrobe", "lookSignature", "photoHair", "onCamera") if pc.get(k)}
    if npc.get("biography"):
        facts["biography"] = " ".join(str(npc["biography"]).split())[:420]  # the signature is drawn from their life
    system = ("You fix one or two PUBLIC text fields of a reality-show houseguest card. Output STRICT JSON only. "
              + PHOTO_SHEET_RULES)
    user = f"The card (public facts): {json.dumps(facts, ensure_ascii=False)}\n{ask}"
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def build_authoring_messages(npc: dict, taken: Optional[dict] = None,
                             hand: Optional[dict] = None) -> list[dict]:
    """The producer prompt for ONE houseguest. Seeds the LLM with the houseguest's PUBLIC skeleton
    (name + whatever public facets the engine already exposes) and NOTHING about the player — the
    NPC's storyline is authored as if the player does not exist (anti-sycophancy, mandate #3).
    Returns chat messages for the utility model.

    T0-6 (the ONE Casting Bible): ``hand`` is this NPC's dealt FacetLedger hand (voice tic / build /
    hair / complexion steering) and ``taken`` is the cast-wide taken-list (``{"vocations": [...],
    "hometowns": [...]}`` — the SIBLINGS' committed facets), both injected so a deep-authoring call
    can neither drift this houseguest off their dealt ground nor converge onto a sibling's. Both
    optional (absent ⇒ byte-identical legacy prompt)."""
    name = str(npc.get("name") or "this houseguest")
    # Include `ethnicity` (the engine-guaranteed heritage, 0063) so the authored look COHERES with it —
    # without it the model invents complexion/features unmoored from the seeded identity and reliably
    # defaults skin tone to a generic "olive". (The engine RE-GROUNDS skinTone to the heritage on
    # write-back regardless, so this is for the surrounding facets — hair, features, style.)
    # `voice` (the 2026-07-11 expressive-e2e widening): the engine's seeded voice-fingerprint clause —
    # included as the BRIEF the model sharpens into a full authored idiolect (never a script to copy).
    # S4c (RC5, #1599): thread the committed IDENTITY HEADER — `genderPresentation` (the PINNED pronoun
    # spine the portrait + narration both read) and `vocation`/`name` — into the skeleton as IMMUTABLE
    # context, so the authored secret bible cannot invent a DIFFERENT person: a "man" houseguest's secrets
    # must not read "her past", and a concierge's secret must not become a bartender's (the bundle's
    # concierge/bar, mortgage/teacher mismatches). Without the pin the model reliably drifts pronouns in the
    # hidden prose; with it the whole dossier coheres at the SOURCE (the engine's game-start coherence gate
    # is still the airtight belt). `genderPresentation` is a PUBLIC, Vault-free HouseguestCard facet.
    # 2026-07-21 prompt audit: thread the SEEDED `physicalCharacteristics` in as the LOOK BRIEF — the
    # engine deals the cast-wide capped look spread (incl. the visible-ink budget), and without it the
    # model invents the whole look from its prior (the "full sleeve of tattoos x4" index case). The
    # model sharpens the brief; the ink budget is fixed (and the engine's write-back backstop holds it).
    skeleton = {
        k: npc.get(k)
        for k in ("name", "age", "vocation", "hometown", "archetype", "demeanor", "presentation", "appearance", "ethnicity", "genderPresentation", "voice", "physicalCharacteristics", "background", "identityConcept")  # ORW-431: the earlier writer's text is shown as fact to keep
        if npc.get(k) is not None
    }
    gp = npc.get("genderPresentation")
    pronoun_rule = (
        f" This houseguest's PINNED gender presentation is '{gp}' — every self-reference in the biography, "
        f"secrets, true goals, and weakness MUST use the matching pronouns and never the opposite; the "
        f"pinned identity is immutable, do not re-gender {name}. Other people in the story (a mother, a sister, a rival) keep their own "
        f"pronouns and are named by role; only {name} takes the pinned ones."
        if gp in ("man", "woman", "nonbinary") else ""
    )
    # F1/F5 (#1660): the committed roster's IMMUTABLE identity — name, gender presentation, vocation, age
    # are already CAST (genesis + the 0063 identity seed). The authored bible EXTENDS this exact person
    # (adds depth, look, voice, secrets) but must NEVER contradict or replace these fixed facts: the SAME
    # occupation, gender, age, and name throughout the biography, secrets, goals, and weakness. This pins
    # the hidden threads to the committed vocation (F5) at the SOURCE — the engine keys the hidden stakes
    # off it, and a crosswired job / re-gendered secret is dropped at write-back and re-grounded.
    immutable = {k: npc.get(k) for k in ("name", "genderPresentation", "vocation", "age")
                 if npc.get(k) is not None}
    immutable_rule = (
        f" FIXED IDENTITY (IMMUTABLE — do NOT contradict or replace any of these): "
        f"{json.dumps(immutable, ensure_ascii=False)}. Keep {name}'s name, gender, occupation, and age "
        f"EXACTLY as given; your authored fields EXTEND this exact person. Every secret, true goal, and "
        f"weakness must belong to THIS occupation and this person — never imply a different job, a "
        f"different gender, or a different life-stage/age."
        if immutable else ""
    )
    # T0-6: the dealt hand (fixed steering) + the cast-wide taken-list (the siblings' committed
    # facets) — a per-NPC call cannot see the rest of the cast, so the ledger IS its shared bible.
    hand_rule = ""
    if isinstance(hand, dict):
        try:
            from src.orwell_facet_ledger import render_hand
            rendered = render_hand(hand, hometown=not str(npc.get("hometown") or "").strip())  # the card's own hometown wins over the dealt one
            if rendered:
                hand_rule = (f"\nDEALT FACETS (the casting office's bible for {name} — honor them; "
                             f"the committed skeleton above already reflects this deal): {rendered}.")
        except Exception:  # pragma: no cover - defensive: the ledger never breaks the prompt
            hand_rule = ""
    taken_rule = ""
    if isinstance(taken, dict):
        jobs = [str(v).strip() for v in (taken.get("vocations") or []) if str(v).strip()]
        towns = [str(t).strip() for t in (taken.get("hometowns") or []) if str(t).strip()]
        parts = []
        if jobs:
            parts.append(f"occupations already cast: {', '.join(jobs)}")
        if towns:
            parts.append(f"hometowns already cast: {', '.join(towns)}")
        ph = taken.get("phrases") if isinstance(taken.get("phrases"), dict) else {}
        if ph.get("oncamera_endings"):
            parts.append("onCamera lines already end: " + " | ".join(ph["oncamera_endings"]))
        if ph.get("photohair_openings"):
            parts.append("photoHair lines already open: " + " | ".join(ph["photohair_openings"]) + " (open this one differently)")
        if ph.get("identity_openers"):
            parts.append("identity lines already open: " + " | ".join(ph["identity_openers"]))
        if ph.get("oncamera_openings"):
            parts.append("onCamera lines already open: " + " | ".join(ph["oncamera_openings"]))
        if ph.get("marks"):
            parts.append("distinguishing marks already used (every mark is unique in the cast): " + " | ".join(ph["marks"]))
        if ph.get("signatures"):
            parts.append("lookSignature categories already taken (do NOT use these): " + ", ".join(ph["signatures"])
                         + ("; still free (pick one that fits their life): " + ", ".join(ph["signatures_free"]) if ph.get("signatures_free") else ""))
        if ph.get("colours"):
            parts.append("colours already worn by enough people (no more " + ", ".join(ph["colours"]) + "; use other colours)")
        if taken.get("signature_lean"):
            parts.append(f"lookSignature leans toward {taken['signature_lean']} only if their own life supports it, otherwise a kind other than hair")
        op = taken.get("openings") if isinstance(taken.get("openings"), dict) else {}
        if op:
            # a small rotated list keyed by this card's slot, so cards written in parallel still open differently
            parts.append("OPENING PATTERN for this card: " + "; ".join(f"{k} {v}" for k, v in op.items()))
        if parts:
            taken_rule = ("\n" + R.render("[[rule:taken]]", _RULE_EXAMPLES) + ": " + "; ".join(parts) + ".")
    user = (
        f"Houseguest to flesh out: {name}.\n"
        f"Public skeleton (build FROM this, never contradict it): {json.dumps(skeleton, ensure_ascii=False)}\n"
        f"Ground {name}'s secrets, true goals, and weakness in THIS skeleton — their specific occupation, "
        f"archetype, age, and backstory — so the hidden life reads like THIS exact person and no one else."
        f"{immutable_rule}"
        f"{pronoun_rule}"
        f"{hand_rule}"
        f"{taken_rule}\n"
        + R.render("[[rule:background-years]]\n[[rule:bio-subject]]\n", {**_RULE_EXAMPLES, "name": name}) +
        f"Write {name}'s secret bible as JSON now — their own independent life, no protagonist."
    )
    return [{"role": "system", "content": _SYSTEM}, {"role": "user", "content": user}]


def _balanced_json_objects(text: str):
    """Yield each top-level balanced ``{...}`` candidate substring in `text`, in order, string-aware
    (braces inside JSON string literals are ignored). This survives a prose preamble/epilogue AND a
    trailing second object/garbage that a naive first-`{`/last-`}` slice would swallow (e.g.
    ``Here is the profile: {…} Hope that helps!``). Each candidate is a complete brace-balanced span."""
    depth = 0
    start = -1
    in_str = False
    esc = False
    for i, ch in enumerate(text):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start != -1:
                    yield text[start:i + 1]
                    start = -1


def _extract_json(text: str) -> Optional[dict]:
    """Pull the first usable JSON OBJECT out of the model's reply — robust to prose-wrapped output.

    Strategy (in order):
      1. a ```json … ``` fenced block, if present;
      2. otherwise scan for the first *balanced* ``{…}`` span and parse it (string-aware so braces
         inside string values don't throw off the balance) — surviving a prose preamble/epilogue and
         a stray trailing object. If the first balanced span fails to parse, try the next one.
    A reasoning model that emits "Here's the profile: {…}" or wraps the object in commentary therefore
    still yields the profile instead of nuking the whole houseguest to the seeded floor (#1044)."""
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fenced:
        try:
            obj = json.loads(fenced.group(1))
            if isinstance(obj, dict):
                return obj
        except (ValueError, TypeError):
            pass  # fall through to the balanced-brace scan
    # Balanced-brace scan: tolerant of prose around the object and a stray trailing object/garbage
    # (the naive first-`{`/last-`}` slice would over-grab and fail to parse in both cases).
    for candidate in _balanced_json_objects(text):
        try:
            obj = json.loads(candidate)
        except (ValueError, TypeError):
            continue
        if isinstance(obj, dict):
            return obj
    return None


def parse_authored_profile(text: str, houseguest_id: str) -> Optional[dict]:
    """Parse the LLM's reply into a recordCastProfile request, keeping ONLY the schema keys and
    coercing types. Returns None when nothing usable was authored (the seeded floor then stays)."""
    obj = _extract_json(text)
    if obj is None:
        return None
    out: dict = {"houseguestId": houseguest_id}

    if isinstance(obj.get("name"), str) and obj["name"].strip():
        name = obj["name"].strip()
        # Guard (mirrors the engine): only forward a reasonable two-token human name. A gibberish/
        # fantasy/malformed name is DROPPED so the engine's seeded corpus name (the floor) stands.
        if _is_reasonable_name(name):
            out["name"] = name
        else:
            logger.warning(
                f"[cast-authoring] unreasonable name for {houseguest_id} ({name!r}) — "
                "dropping so the corpus name stands")

    if isinstance(obj.get("biography"), str) and obj["biography"].strip():
        bio = obj["biography"].strip()
        # Quality floor (#3): only overwrite the seeded floor with a coherent biography. A thin /
        # degraded one is dropped (omitted), so the engine keeps its richer deterministic value.
        if _biography_meets_floor(bio):
            out["biography"] = bio
        else:
            logger.warning(
                f"[cast-authoring] biography below floor for {houseguest_id} "
                f"({len(bio)} chars, {len(_SENTENCE_TERMINATORS.findall(bio))} sentence(s)) — "
                "omitting so the seeded floor stands")
    # ORW-431 A: the writer, which runs after every pin and sees the final card, owns the one-line identityConcept too
    # (genesis's was written before the name, gender and age were settled and is never shown once this lands).
    if isinstance(obj.get("identityConcept"), str):
        ic = " ".join(obj["identityConcept"].split())
        if R.IDENTITY_PARSE_MIN_CHARS <= len(ic) <= R.IDENTITY_MAX_CHARS:  # ORW-437: the prompt promises "under 250 characters"
            out["identityConcept"] = ic
    # The PUBLIC occupation (#849) — forwarded so the engine keeps it in lockstep with the biography and
    # re-grounds the hidden stakes off the job the player will infer. A blank / runaway value is dropped
    # (the engine then leaves the seeded vocation — and its keyed stakes — untouched). Single line only.
    if isinstance(obj.get("vocation"), str) and obj["vocation"].strip():
        voc = " ".join(obj["vocation"].split())  # collapse whitespace/newlines to a clean noun phrase
        if len(voc) <= _VOCATION_MAX_CHARS:
            out["vocation"] = voc
        else:
            logger.warning(
                f"[cast-authoring] vocation too long for {houseguest_id} ({len(voc)} chars) — "
                "omitting so the seeded vocation stands")
    phys = obj.get("physicalCharacteristics")
    if isinstance(phys, dict):
        facet = {k: str(phys[k]).strip() for k in _PHYS_KEYS if isinstance(phys.get(k), (str, int)) and str(phys.get(k)).strip()}
        if len(facet) == len(_PHYS_KEYS):  # the facet is the text↔image source of truth — only write it whole
            # ORW-360: the two OPTIONAL look fields ride along when present (never required, never a gate).
            # Forwarded raw-ish (cleaned strings, no clamping) so the accept path can check them; the engine
            # clamps again at the recordCastProfile boundary.
            wd = phys.get("wardrobe")
            if isinstance(wd, list):
                wd_clean = [" ".join(str(x).split()) for x in wd if isinstance(x, (str, int)) and str(x).strip()]
                if wd_clean:
                    facet["wardrobe"] = wd_clean
            oc = phys.get("onCamera")
            if isinstance(oc, str) and oc.strip():
                facet["onCamera"] = " ".join(oc.split())
            ph = phys.get("photoHair")
            if isinstance(ph, str) and ph.strip():
                facet["photoHair"] = " ".join(ph.split())
            ls = phys.get("lookSignature")
            if isinstance(ls, str) and ls.strip():
                facet["lookSignature"] = " ".join(ls.split())[:R.SIGNATURE_MAX_CHARS]
            out["physicalCharacteristics"] = facet

    # The authored VOICE fingerprint (0084 / the 2026-07-11 expressive-e2e widening): forwarded WHOLE
    # or not at all — voice is identity (never spliced over the seeded floor field-by-field). All six
    # dials + the signature must be non-empty strings and the lexicon must clean to >=1 short entry;
    # anything less is omitted so the engine's seeded deterministic voice stands (the engine enforces
    # the same whole-or-nothing rule + bounds again in `sanitizeAuthoredVoice`).
    voice = obj.get("voice")
    if isinstance(voice, dict):
        dials = {k: str(voice[k]).strip() for k in _VOICE_DIAL_KEYS
                 if isinstance(voice.get(k), str) and str(voice.get(k)).strip()}
        lex = voice.get("lexicon")
        lex_clean = ([str(x).strip() for x in lex if str(x).strip()][:_VOICE_LEXICON_MAX]
                     if isinstance(lex, list) else [])
        # #1395: OPTIONAL catchphrases — a bonus on a well-formed core voice, never a gate. A clean small
        # set is forwarded; anything missing/garbage is simply omitted (the engine drops it too).
        cats = voice.get("catchphrases")
        cats_clean = ([str(x).strip() for x in cats if str(x).strip()][:_VOICE_CATCHPHRASE_MAX]
                      if isinstance(cats, list) else [])
        if len(dials) == len(_VOICE_DIAL_KEYS) and lex_clean:
            out["voice"] = {**dials, "lexicon": lex_clean,
                            **({"catchphrases": cats_clean} if cats_clean else {})}
        else:
            logger.warning(
                f"[cast-authoring] incomplete authored voice for {houseguest_id} — "
                "omitting whole (the seeded voice stands)")

    secrets = obj.get("secrets")
    if isinstance(secrets, list):
        # Light floor (#3): drop trivially-short/empty secrets so a degraded list never replaces
        # the seeded hidden material wholesale. If everything is too thin, omit the field entirely.
        clean = [str(s).strip() for s in secrets if len(str(s).strip()) >= _HIDDEN_ENTRY_MIN_CHARS]
        if clean:
            out["secrets"] = clean[:3]
        elif any(str(s).strip() for s in secrets):
            logger.warning(f"[cast-authoring] all secrets below floor for {houseguest_id} — omitting")
    goals = obj.get("trueGoals")
    if isinstance(goals, list):
        clean = [str(g).strip() for g in goals if str(g).strip()]
        if clean:
            out["trueGoals"] = clean[:2]
    if isinstance(obj.get("weakness"), str) and obj["weakness"].strip():
        weak = obj["weakness"].strip()
        # Light floor (#3): a one-word weakness is degraded — drop it so the seeded value stands.
        if len(weak) >= _HIDDEN_ENTRY_MIN_CHARS:
            out["weakness"] = weak
        else:
            logger.warning(f"[cast-authoring] weakness below floor for {houseguest_id} — omitting")
    # `dayOnePerception` is deliberately NOT forwarded (anti-sycophancy): even if a model echoes it
    # back, the NPC's Day-1 read of the player is the engine's seeded, balanced floor — never authored.

    # Nothing beyond the id ⇒ nothing to write.
    if len(out) <= 1:
        return None
    return out


def _no_json_in(text: str) -> bool:
    """#1002 observability: True iff the reply contained NO parseable JSON object at all (the strongest
    suspect — a reasoning model emitting prose/reasoning instead of a bare object). Distinct from "JSON
    parsed but every field landed below the quality floor"; the two no-op causes are logged separately so
    the silent fallback is diagnosable."""
    return _extract_json(text or "") is None


def _has_unbalanced_open_brace(text: str) -> bool:
    """True iff `text` contains an UNCLOSED top-level ``{`` — i.e. a JSON object the provider started
    streaming but never finished (the live truncation shape: the body opens the object, streams several
    fields, then the stream is cut by finish_reason "length" / a mid-stream provider error before the
    closing brace). String-aware so a brace inside a string literal is ignored. Distinct from "no JSON at
    all" (pure prose, no opening brace) — that is the #1002 case, not truncation."""
    depth = 0
    in_str = False
    esc = False
    saw_open = False
    for ch in text or "":
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
            saw_open = True
        elif ch == "}":
            if depth > 0:
                depth -= 1
    return saw_open and depth > 0


def _classify_visible_body(text: str) -> str:
    """#1057: classify a model reply's VISIBLE body so the authoring loop can pick the right recovery.
    Returns one of:
      • "ok"        — a usable JSON object is present (parse it; no retry needed);
      • "empty"     — the visible body is empty/whitespace-only (the provider returned nothing — RETRY);
      • "truncated" — an UNCLOSED ``{`` (the object was clipped mid-stream by length/error — RETRY);
      • "no_json"   — a NON-empty, brace-balanced body with no parseable object (genuine prose — the
                      #1002 reparse case, a different retry).
    The two RETRY shapes (empty / truncated) are the live-verify's dominant failure (provider
    truncation under the concurrent burst); the existing #1002 reparse only covered "no_json"."""
    if _extract_json(text or "") is not None:
        return "ok"
    if not (text or "").strip():
        return "empty"
    if _has_unbalanced_open_brace(text or ""):
        return "truncated"
    return "no_json"


# ── the orchestrator (injectable — fully unit-testable) ───────────────────────

# The resolved completion fn accepts EITHER a chat `list[dict]` (the cast-authoring path) OR a
# single prompt string (the faithfulness judge / overseer hooks) — normalized inside `_resolve_llm_fn._fn`.
LlmFn = Callable[[Union[str, list[dict]]], Awaitable[str]]
WriteFn = Callable[[dict], Awaitable[dict]]


def _identity_dropped(profile: dict, res) -> bool:
    """ORW-431b: True when the writer sent an identityConcept and the engine's reply says the card does not hold it. A reply that
    carries no `publicFields` list (a stub, an older engine) says nothing, so it is not read as a drop."""
    ident = (profile or {}).get("identityConcept")
    fields = res.get("publicFields") if isinstance(res, dict) else None
    return bool(isinstance(ident, str) and ident.strip() and isinstance(fields, list) and "identityConcept" not in fields)


async def author_cast(cast: list[dict], llm_fn: LlmFn, write_fn: WriteFn,
                      on_authored: Optional[Callable[[str], None]] = None,
                      *, concurrency: int = _AUTHOR_CONCURRENCY,
                      user: Optional[str] = None,
                      seed: Optional[int] = None,
                      hands: Optional[dict] = None,
                      look_write_fn: Optional[Callable[[str, dict], Awaitable[dict]]] = None,
                      live_look_sink: bool = True) -> int:
    """For each NPC in `cast`: build the producer prompt → `llm_fn` → parse → `write_fn`
    (recordCastProfile). Best-effort PER houseguest: one failure never aborts the rest (the seeded
    floor stays authoritative for any NPC that couldn't be authored). Returns how many were written.

    The PLAYER is skipped (only the player's profile is human-authored, at OOBE). Anything without an
    id is skipped. The engine owns the wall (validation / split / seal); this never seals anything.
    The player's identity is NOT threaded in at all — NPC storylines are authored player-independent
    (anti-sycophancy, mandate #3).

    Authoring runs with BOUNDED concurrency (#5): NPCs are authored in parallel (the engine write-back
    is idempotent per houseguest, so there is no cross-NPC ordering dependency), but at most
    `concurrency` LLM calls are in flight at once so the utility endpoint is never flooded.

    `on_authored(houseguest_id)` — when supplied — is fired AFTER each successful, engine-accepted
    write-back (per-NPC portrait gating, #7). It is best-effort: a callback raising never aborts
    authoring. It is never fired for an NPC that wasn't authored / was refused.

    ORW-380: the callbacks fire once ALL profiles are authored, after the photo-sheet de-duplication
    post-pass (`dedupe_photo_sheets`): authoring runs houseguests concurrently, so no writer could see the
    others' clothes and spots; the pass walks the cast in id order and rewrites ONLY the photo sheet of a
    houseguest whose main piece repeats an earlier one or whose spot already has 3 (one extra writer call
    per offender, one pass, `look_write_fn` or the engine's recordLookExtras stores it). A clean cast
    makes zero extra calls; a failure leaves the original sheet. Portraits are requested after the pass.

    T0-6 — the ONE Casting Bible: `seed` (the season seed, when known — always known on the live
    kickoff paths) mints this cast's FacetLedger via the SAME slot alignment `orwell_cast_genesis`
    used (`assign_genesis_slots` is pure, so re-deriving it here — rather than threading genesis's own
    minted hands forward — keeps this call independent of whether genesis actually ran first), keyed
    by houseguest id. `hands` (a `{houseguestId: hand}` mapping) lets a caller inject a pre-minted
    ledger directly (tests; a lane that already minted one) — when both are given, `hands` wins. Every
    per-NPC prompt then carries ITS dealt hand + the cast-wide TAKEN-LIST (the siblings' actually
    COMMITTED vocations/hometowns, read straight off `cast` — no ledger needed for that half). A ledger
    mint failure is fail-soft: the legacy plain prompt stands (steering only; the engine's structural
    envelope is what actually binds).

    #1057 — ROBUSTNESS to the live concurrent-burst failure (the live-verify authored only 3/15):
      • the LLM call retries on an EMPTY or TRUNCATED visible body (provider truncation under the burst),
        not just on the #1002 "full body, no JSON" prose case;
      • lower concurrency (2) eases the provider pressure that triggers the truncation;
      • the engine write-back is SERIALIZED through a single-flight lock and retried on a transient
        `degradation` / refused result, so concurrent `recordCastProfile` calls no longer collide on the
        orchestrator integrity checkpoint (the live-verify's 3 `degradation` refusals).
    All three stay fail-soft: after the bounded retries the call simply lands on the seeded floor.
    """
    sem = asyncio.Semaphore(max(1, int(concurrency)))
    # T0-6 — mint (or accept a pre-minted) cast-wide FacetLedger BEFORE any LLM call, keyed by
    # houseguest id. `npc_ids` mirrors genesis's own `roster_ids` filter (a truthy id, player excluded)
    # so `len(npc_ids)` matches the count genesis minted against, which is what makes the independent
    # re-derivation byte-identical to genesis's original deal.
    npc_ids = [str(n.get("id")) for n in (cast or [])
              if isinstance(n, dict) and n.get("id") and n.get("id") != "player"]
    hand_by_id: dict = dict(hands) if isinstance(hands, dict) else {}
    if not hand_by_id and seed is not None and npc_ids:
        try:
            from src.orwell_cast_genesis import assign_genesis_slots
            from src.orwell_facet_ledger import mint_facet_ledger
            slots = assign_genesis_slots(seed, len(npc_ids))
            physical = [bool(s.get("physical")) for s in slots]
            ledger = mint_facet_ledger(seed, len(npc_ids), physical)
            if len(ledger) == len(npc_ids):
                hand_by_id = {hid: ledger[i] for i, hid in enumerate(npc_ids)}
        except Exception as e:  # pragma: no cover - defensive: a ledger hiccup never breaks authoring
            logger.warning(f"[cast-authoring] facet-ledger mint failed (plain prompts stand): {e}")

    slot_of = {str(n.get("id")): i for i, n in enumerate(n for n in (cast or []) if isinstance(n, dict))}

    def _taken_for(hid: str) -> dict:
        """The cast-wide taken-list for one houseguest: the OTHER houseguests' actually-COMMITTED
        vocation/hometown (read straight off the roster — genesis already settled these; a per-NPC
        deep-authoring call can't see its siblings otherwise)."""
        return {
            "vocations": [n.get("vocation") for n in (cast or [])
                         if isinstance(n, dict) and str(n.get("id")) != hid and n.get("vocation")],
            "hometowns": [n.get("hometown") for n in (cast or [])
                         if isinstance(n, dict) and str(n.get("id")) != hid and n.get("hometown")],
            **({"phrases": season_gate.taken_phrases(hid)} if season_gate.registry else {}),
            "openings": opening_pattern(slot_of.get(hid, 0)),
            # ORW-480: cards are written at the same time, so none can see the others' signatures; each slot leans toward a different kind
            # of signature (a lean, not a deal; kept out of `opening_pattern`, whose period of 6 is its contract)
            "signature_lean": _signature_lean(slot_of.get(hid, 0)),
        }
    # #1057: SERIALIZE the engine write-back. The per-NPC recordCastProfile write-backs collide on the
    # orchestrator integrity checkpoint when they run concurrently (the live-verify's 3 `degradation`
    # refusals dropped good profiles). A single-flight lock funnels every write-back through one at a time
    # — authoring still parallelizes the (slow) LLM calls, only the (fast) commit is serialized.
    write_lock = asyncio.Lock()
    authored_cards: dict = {}  # ORW-380: houseguest id -> the card with its authored sheet (for the post-pass)
    authored_ids: list = []
    # #1002 / #1057: per-season tallies for the end-of-run diagnostic counter — how many NPCs fell back to
    # the deterministic floor, and WHY. The breakdown distinguishes every no-op cause so a live-verify can
    # read exactly where the loss is (no-JSON prose vs. empty/truncated provider output vs. a write-back
    # degradation vs. JSON parsed but below the quality floor).
    floor_no_json = 0     # a reasoning model emitted prose, no parseable object (the #1002 case)
    floor_empty = 0       # #1057: the provider returned an EMPTY visible body (after retries)
    floor_truncated = 0   # #1057: the provider returned a CLIPPED/unbalanced object (after retries)
    floor_degradation = 0  # #1057: the write-back was refused as a transient degradation (after retries)
    floor_below = 0       # JSON parsed but nothing cleared the quality floor (seeded floor is richer)
    floor_gaveup = 0      # M1-10: the per-season attempt cap is spent — give up loudly, stop calling
    floor_call_failed = 0  # RC6 S6c: the provider call RAISED (timeout/HTTP/network) — no completion body
    coherence_stripped = 0  # F2 (#1660): NPCs whose authored dossier PROSE contradicted the pinned identity
    identity_pinned = 0     # F1 (#1660): NPCs whose authored STRUCTURED field crosswired the committed roster
    secret_pinned = 0       # F5 (#1660): NPCs whose hidden threads were dropped (authored around a crosswired job)
    facet_stripped = 0      # T0-6: NPCs whose biography was dropped after a failed dealt-facet regenerate
    voice_repaired = 0      # ORW-184: NPCs whose authored voice was mended per field (flag on)
    ukey = _safe_user(user)  # M1-10: the give-up ledger scope
    from src import orwell_cast_gate as _gate  # ORW-431: the one gate at the end
    _gate_on = _gate.gate_enabled()
    season_gate = _gate.SeasonGate(user)
    season_gate.want_signature = True
    gate_lock = asyncio.Lock()  # the cross-cast registry is checked and filled one card at a time

    async def _call_with_retries(npc: dict, hid: str):
        """Issue the authoring call(s) for one NPC and return its parsed profile (or None).

        Layered, bounded, fail-soft recovery for the live failure modes:
          1. first call;
          2. #1057 — EMPTY or TRUNCATED visible body ⇒ re-issue (up to `_EMPTY_TRUNCATED_RETRIES`,
             small backoff) asking for the COMPLETE object (the dominant burst-truncation failure);
          3. #1002 — a NON-empty body with NO parseable JSON (genuine prose) ⇒ ONE strict-JSON reparse.

        Returns ``(profile_or_None, last_text, call_error)`` where ``call_error`` is the message of a
        provider EXCEPTION on ANY attempt that left no usable profile (RC6 S6c: `_call_with_retries`
        used to return an empty-string sentinel on BOTH a genuine empty-visible completion AND a
        raised timeout/HTTP/network error, so the exception path was mislabeled a reasoning-channel
        misroute). ``call_error`` is set whenever the FIRST call OR a retry raised (a raised retry is
        preserved even after a prior completion — an empty completion FOLLOWED BY a timeout is a
        call failure, not a misroute) and None only when every attempt returned. So the caller records
        `reasoning-misroute` only for a genuine successful-but-empty completion, and a provider-call
        failure class for the exception path."""
        # T0-6: every lane's prompt gets its NPC's dealt hand + the cast-wide taken-list.
        messages = build_authoring_messages(npc, taken=_taken_for(hid), hand=hand_by_id.get(hid))
        _spend_attempt(ukey, hid)  # M1-10: every real provider call spends from the season budget
        call_error = None  # RC6 S6c: the message of the last provider EXCEPTION (None ⇒ every call returned)
        try:
            text = await llm_fn(messages)
        except AuthoringDeadline as e:
            # ORW-438: the ceiling cancelled a stalled call. ONE immediate retry on a fresh request (a new connection),
            # spending from the same per-houseguest attempt budget; a second stall falls to the floor as before.
            logger.warning(f"[cast-authoring] llm stalled for {hid}: {e} - retrying once on a fresh connection")
            if _given_up(ukey, hid):
                return None, "", str(e)
            _spend_attempt(ukey, hid)
            try:
                text = await llm_fn(messages)
            except Exception as e2:
                logger.warning(f"[cast-authoring] llm failed for {hid} after the stall retry: {e2}")
                return None, "", str(e2)
        except Exception as e:  # the model can fail for one houseguest; carry on
            logger.warning(f"[cast-authoring] llm failed for {hid}: {e}")
            return None, "", str(e)  # a raised call with NO completion body — never a misroute
        profile = parse_authored_profile(text or "", hid)
        # #1057: retry on EMPTY / TRUNCATED visible body — the provider returned nothing usable because the
        # body was empty or the object was clipped mid-stream (burst truncation), NOT because it emitted
        # prose instead of JSON. Re-issue asking for the complete object; reasoning is already OFF and the
        # roomy _AUTHOR_MIN_OUTPUT_TOKENS floor is applied in `_resolve_llm_fn`.
        attempt = 0
        while profile is None and _classify_visible_body(text or "") in ("empty", "truncated") \
                and attempt < _EMPTY_TRUNCATED_RETRIES and not _given_up(ukey, hid):
            attempt += 1
            shape = _classify_visible_body(text or "")
            logger.info(
                f"[cast-authoring] {shape} visible body for {hid} (attempt {attempt}/"
                f"{_EMPTY_TRUNCATED_RETRIES}) — re-issuing for the complete object")
            if _RETRY_BACKOFF_SECONDS:
                # M1-10: EXPONENTIAL backoff (0.4 → 0.8 → 1.6 …) — a struggling provider gets
                # air between attempts instead of a same-second hammer (audit A11).
                await asyncio.sleep(_RETRY_BACKOFF_SECONDS * (2 ** (attempt - 1)))
            _spend_attempt(ukey, hid)
            try:
                text = await llm_fn(messages + [{"role": "user", "content": _TRUNCATION_RETRY}])
            except Exception as e:
                logger.warning(f"[cast-authoring] llm empty/truncated retry failed for {hid}: {e}")
                call_error = str(e)  # RC6 S6c: a raised retry is a call failure, not the prior empty body
                break
            profile = parse_authored_profile(text or "", hid)
        # #1002: one-shot reparse retry — a NON-empty body with NO JSON object at all (genuine prose).
        # Distinct from the empty/truncated case above; only fires when there WAS a full body to reparse.
        if profile is None and _classify_visible_body(text or "") == "no_json" \
                and not _given_up(ukey, hid):
            logger.info(
                f"[cast-authoring] no JSON in reply for {hid} — retrying once with a "
                "strict JSON-only instruction")
            _spend_attempt(ukey, hid)
            try:
                text = await llm_fn(messages + [{"role": "user", "content": _STRICT_RETRY}])
            except Exception as e:
                logger.warning(f"[cast-authoring] llm retry failed for {hid}: {e}")
                call_error = str(e)  # RC6 S6c: a raised retry is a call failure, not the prior body
            else:
                profile = parse_authored_profile(text or "", hid)
        # RC6 S6c: report the exception whenever ANY attempt raised without yielding a usable profile —
        # a raised retry is preserved even after a prior completion (a completion then a timeout is a
        # call failure, never the prior empty body's misroute). None ⇒ every attempt returned.
        return profile, (text or ""), call_error

    async def _write_with_retries(profile: dict, hid: str):
        """#1057: commit one profile through the SERIALIZED single-flight write-back, retrying a transient
        `degradation` / refused result (a concurrency collision on the orchestrator integrity checkpoint,
        not a permanent reject). Returns the accepted result dict, or None on a terminal failure. The
        write-back is idempotent per houseguest, so a retry is safe."""
        last = None
        for attempt in range(1 + _EMPTY_TRUNCATED_RETRIES):
            if attempt and _RETRY_BACKOFF_SECONDS:
                # M1-10: exponential, matching the call-side retries.
                await asyncio.sleep(_RETRY_BACKOFF_SECONDS * (2 ** (attempt - 1)))
            try:
                async with write_lock:  # serialize: never two recordCastProfile commits at once
                    res = await write_fn(profile)
            except Exception as e:
                # #1067: a `turn refused — integrity checkpoint failed (degradation)` 409 surfaces here as a
                # RAISED exception (the engine boundary maps the refusal to HTTP 409), NOT a dict result — so
                # it must be classified + retried + tallied exactly like the dict-degradation branch below.
                # Previously this swallowed it as a bare `None`, so the end-of-run breakdown reported
                # "0 degradation" even though every lost NPC was a degradation refusal (the live-verify
                # miscount). Treat an integrity/degradation/turn-refused message as a (now usually transient)
                # degradation: retry, then fall back to the floor with the correct sentinel.
                _es = str(e).lower()
                if "degrad" in _es or "integrity" in _es or "checkpoint" in _es or "turn refused" in _es:
                    if attempt < _EMPTY_TRUNCATED_RETRIES:
                        logger.info(
                            f"[cast-authoring] write-back degradation (raised) for {hid} (attempt "
                            f"{attempt + 1}/{1 + _EMPTY_TRUNCATED_RETRIES}) — retrying serialized")
                        continue
                    logger.warning(
                        f"[cast-authoring] write-back still degraded (raised) for {hid} after retries — "
                        "keeping the seeded floor")
                    return "degradation"  # sentinel for the diagnostic tally (counted as floor_degradation)
                logger.warning(f"[cast-authoring] write-back failed for {hid}: {e}")
                return None
            if isinstance(res, dict) and res.get("accepted"):
                return res
            last = res
            _reason = res.get("reason") if isinstance(res, dict) else f"non-dict result ({type(res).__name__})"
            # A transient degradation/refused commit is a concurrency collision — retry. Anything else is
            # a permanent reject (validation etc.) — don't hammer it; fall through to the floor.
            _rs = str(_reason or "").lower()
            if "degrad" in _rs or "integrity" in _rs or "checkpoint" in _rs:
                if attempt < _EMPTY_TRUNCATED_RETRIES:
                    logger.info(
                        f"[cast-authoring] write-back degradation for {hid} (attempt "
                        f"{attempt + 1}/{1 + _EMPTY_TRUNCATED_RETRIES}) — retrying serialized")
                    continue
                logger.warning(
                    f"[cast-authoring] write-back still degraded for {hid} after retries — "
                    "keeping the seeded floor")
                return "degradation"  # sentinel for the diagnostic tally
            # permanent / unexpected non-accept
            logger.warning(f"[cast-authoring] write-back not accepted for {hid}: {_reason or 'accepted=false'}")
            return None
        return last

    async def _author_one(npc: dict) -> int:
        nonlocal floor_no_json, floor_empty, floor_truncated, floor_degradation, floor_below, \
            floor_gaveup, floor_call_failed, coherence_stripped, identity_pinned, secret_pinned, \
            facet_stripped, voice_repaired
        hid = npc.get("id")
        if not hid or hid == "player":
            return 0
        # M1-10: the season budget for this NPC is spent — give up LOUDLY (once), never silently
        # re-burst on every re-kick. /admin/status surfaces the list via giveups(); the ledger
        # resets on the new-season scrub.
        if _given_up(ukey, hid):
            floor_gaveup += 1
            if (ukey, hid) not in _gaveup_logged:
                _gaveup_logged.add((ukey, hid))
                logger.warning(
                    f"[cast-authoring] give-up cap reached for {hid} "
                    f"({_ATTEMPT_CAP} provider calls this season) — keeping the seeded floor; "
                    "re-authoring resumes next season or after a provider fix + manual lever")
                # STRICT enrichment policy: a per-NPC give-up is a loud, ledgered failure (once per
                # season per houseguest — the same cadence as the warning above). Soft: unchanged.
                try:
                    from src import enrichment_policy
                    if enrichment_policy.is_strict():
                        enrichment_policy.record_failure(
                            user, "cast-authoring",
                            f"authoring gave up for houseguest {hid} after {_ATTEMPT_CAP} provider calls")
                except Exception:
                    pass
            return 0
        async with sem:
            profile, text, call_error = await _call_with_retries(npc, hid)
            if not profile:
                # RC6 S6c: a provider EXCEPTION with no completion body is NOT an empty-visible
                # reasoning misroute — it's a timeout/HTTP/network fault. Count it apart so it is
                # never mislabeled `reasoning-misroute` (the empty-body class below).
                if call_error:
                    floor_call_failed += 1
                    logger.warning(
                        f"[cast-authoring] authoring provider call raised for {hid} (no completion "
                        f"reached — timeout / HTTP / network) — keeping the seeded floor: {call_error}")
                    return 0
                # #1002 / #1057: close the silent-None gap — distinguish the no-op causes so a whole-cast
                # floor-fallback is diagnosable, not silent. Classify the FINAL reply body.
                shape = _classify_visible_body(text or "")
                if shape == "empty":
                    floor_empty += 1
                    logger.warning(
                        f"[cast-authoring] empty model reply for {hid} (after retries) — "
                        "keeping the seeded floor")
                elif shape == "truncated":
                    floor_truncated += 1
                    logger.warning(
                        f"[cast-authoring] truncated model reply for {hid} (after retries) — "
                        "keeping the seeded floor")
                elif shape == "no_json":
                    floor_no_json += 1
                    logger.warning(
                        f"[cast-authoring] no JSON found in model reply for {hid} (after retry) — "
                        "keeping the seeded floor")
                else:  # parsed JSON, but every field landed below the quality floor
                    floor_below += 1
                    logger.warning(
                        f"[cast-authoring] JSON parsed but all fields below the quality floor for {hid} "
                        "— keeping the seeded floor")
                return 0
            # F2 (#1660): author-time COHERENCE LINT — drop any field whose self-referential prose
            # contradicts the pinned identity BEFORE the write-back, so the contradiction never
            # commits (it falls to the engine's coherent seeded floor, which the RC5 belt then
            # guarantees at game start). Record a RED-eligible `identity-incoherence` health event —
            # a genuine fault surfaced even though auto-corrected (#1599). Vault-free: the id + the
            # dropped FIELD names only, never the prose. A coherent dossier ⇒ no-op (byte-identical).
            # The author-time identity lint (the ORW-184 voice repair, F2 coherence, F1/F5 roster) as ONE function, so a
            # dealt-facet REGENERATE (below) is checked exactly like the first draft before it can be adopted. Before
            # this, an adopted regenerate skipped all of it and a flipped identity could commit. Mutates `p` in place;
            # False ⇒ nothing writable is left (the caller decides: the first draft falls to the floor, a regenerate
            # is simply not adopted).
            def _lint_identity(p: dict) -> bool:
                nonlocal voice_repaired, coherence_stripped, identity_pinned, secret_pinned
                # ORW-184 (ORWELL_VOICE_REPAIR, default ON; =0 ⇒ this block is skipped and everything below is
                # byte-identical): mend the authored voice PER FIELD before the lint, so one bad dial or one bad
                # optional entry no longer costs the whole voice. A mended voice is still a recorded fault
                # (#1599: a correction is not a cloak), as auto-corrected. An unmendable one falls through to the
                # lint below, which drops it whole as before, now with its reason codes.
                voice_note = ""
                if voice_repair_enabled() and isinstance(p.get("voice"), dict):
                    from src.orwell_voice_repair import format_actions, format_reasons
                    repair = repair_authored_voice(p, npc)
                    if repair.repaired:
                        p["voice"] = repair.voice
                        voice_repaired += 1
                        logger.warning(
                            f"[cast-authoring] repaired the authored voice for {hid} per field "
                            f"({format_actions(repair.actions)}) — the rest of the authored voice stands")
                        try:
                            from src import log_rings
                            log_rings.record_soft_failure(
                                "cast-authoring:voice-repaired",
                                f"authored voice for {hid} failed the voice check on "
                                f"{format_reasons(repair.reasons)} — repaired per field "
                                f"({format_actions(repair.actions)}) instead of dropping the whole voice",
                                corrected="seeded-voice-dial", user=user, houseguest=hid)
                        except Exception:  # pragma: no cover - the health record must never break authoring
                            pass
                    elif repair.voice is None and repair.reasons:
                        voice_note = f" [voice: {format_reasons(repair.reasons)}]"
                dropped = coherence_conflicts(p, npc)
                if dropped:
                    for k in dropped:
                        p.pop(k, None)
                    coherence_stripped += 1
                    note = voice_note if "voice" in dropped else ""
                    logger.warning(
                        f"[cast-authoring] authored dossier for {hid} contradicts the pinned identity "
                        f"(dropped {', '.join(dropped)} to the coherent floor){note} — identity-incoherence")
                    try:
                        from src import enrichment_policy
                        enrichment_policy.record_runtime_failure(
                            user, "identity-incoherence",
                            f"authored dossier for {hid} contradicts the pinned identity — dropped "
                            f"{', '.join(dropped)} to the coherent seeded floor before write-back{note}")
                    except Exception:  # pragma: no cover - the health record must never break authoring
                        pass
                    # Only the houseguestId survived the strip — nothing coherent left to write; the whole
                    # NPC falls to the seeded floor (already RED-recorded above).
                    if len(p) <= 1:
                        return False
                # F1 (#1660): roster-constrained authoring — drop any authored STRUCTURED identity field
                # (vocation / genderPresentation / age) that CONTRADICTS the committed roster's immutable
                # value, so the committed identity STANDS (authored fields EXTEND, never OVERWRITE). This is
                # the "occupation-crosswired" complement to F2's prose lint. RED-recorded via log_rings
                # (#1599 — a real fault surfaced even when auto-corrected), Vault-free (field names only).
                id_drop = identity_contradictions(p, npc)
                if id_drop:
                    # F5 (#1660): a crosswired vocation means the hidden threads (secrets/goals/weakness),
                    # authored in the SAME call, were grounded in the WRONG job — compute them BEFORE the
                    # vocation is popped so they are re-derived by the engine off the committed vocation.
                    secret_drop = secret_vocation_conflicts(p, npc)
                    for k in id_drop:
                        p.pop(k, None)
                    identity_pinned += 1
                    logger.warning(
                        f"[cast-authoring] authored dossier for {hid} contradicts the committed roster "
                        f"(dropped {', '.join(id_drop)} — the committed identity stands) — identity-contradiction")
                    try:
                        from src import log_rings
                        log_rings.record_soft_failure(
                            "cast-authoring:identity-contradiction",
                            f"authored dossier for {hid} contradicts the committed roster — dropped "
                            f"{', '.join(id_drop)} so the committed identity stands (authored fields extend, "
                            f"never overwrite)",
                            corrected="committed-roster-identity", user=user, houseguest=hid)
                    except Exception:  # pragma: no cover - the health record must never break authoring
                        pass
                    if secret_drop:
                        for k in secret_drop:
                            p.pop(k, None)
                        secret_pinned += 1
                        logger.warning(
                            f"[cast-authoring] hidden threads for {hid} were authored around a crosswired "
                            f"vocation (dropped {', '.join(secret_drop)}) — the engine re-grounds the hidden "
                            f"stakes off the committed job — secret-identity-contradiction")
                        try:
                            from src import log_rings
                            log_rings.record_soft_failure(
                                "cast-authoring:secret-identity-contradiction",
                                f"hidden threads for {hid} were authored around a crosswired vocation — "
                                f"dropped {', '.join(secret_drop)} so the engine re-grounds the hidden stakes "
                                f"off the committed vocation",
                                corrected="committed-roster-vocation", user=user, houseguest=hid)
                        except Exception:  # pragma: no cover - the health record must never break authoring
                            pass
                    # Nothing coherent left after the identity strip — the whole NPC falls to the seeded floor.
                    if len(p) <= 1:
                        return False
                return True

            if not _lint_identity(profile):
                floor_below += 1
                return 0
            # T0-6 — the TRANSACTIONAL adopt-or-regenerate guard for the dealt CLOSED facets (visible-ink
            # today; table-driven for whatever else joins `_CLOSED_FACET_DIMENSIONS`). The engine's
            # generic closed-facet-diff validator (`src/engine/facetDiff.ts`) is the airtight backstop at
            # the `recordCastProfile` boundary — it reverts a conflicting `physicalCharacteristics` field
            # per-field regardless of what happens here — but a contradicting BIOGRAPHY is a whole
            # paragraph the engine can only drop wholesale, which risks a GRAFT (the corrected facet block
            # standing beside prose that still describes the un-granted mark). So the FE gets ONE
            # regenerate attempt with corrective feedback first: adopt the dealt hand cleanly if the model
            # can, or drop the biography here (never commit the graft) if it can't.
            facet_conflicts = facet_hand_conflicts(profile, npc)
            if facet_conflicts:
                logger.info(
                    f"[cast-authoring] authored dossier for {hid} contradicts a dealt closed facet "
                    f"({', '.join(facet_conflicts)}) — regenerating once (adopt-or-regenerate, never graft)")
                _spend_attempt(ukey, hid)
                retried_profile = None
                try:
                    retry_messages = build_authoring_messages(npc, taken=_taken_for(hid), hand=hand_by_id.get(hid))
                    retry_text = await llm_fn(retry_messages + [
                        {"role": "user", "content": _FACET_RETRY.format(dims=", ".join(facet_conflicts))}])
                    retried_profile = parse_authored_profile(retry_text or "", hid)
                except Exception as e:
                    logger.warning(f"[cast-authoring] facet-conflict regenerate call failed for {hid}: {e}")
                if (retried_profile is not None and not facet_hand_conflicts(retried_profile, npc)
                        and _lint_identity(retried_profile)):
                    # The regenerate ADOPTED the dealt hand cleanly AND passed the same identity lint as the first
                    # draft. One that cannot pass it is not adopted: the first draft's handling below stands.
                    profile = retried_profile
                elif "biography" in profile:
                    # Regeneration didn't land cleanly (or the call itself failed) — ADOPT the skeleton
                    # rather than commit a graft: drop the biography (the one field the engine's per-facet
                    # floor guard can't repair piecemeal). `physicalCharacteristics` stays IN the profile —
                    # the engine's generic closed-facet-diff validator reverts it per-field at the
                    # recordCastProfile boundary, so a clean facet field never gets lost alongside it.
                    profile.pop("biography", None)
                    facet_stripped += 1
                    logger.warning(
                        f"[cast-authoring] dropped {hid}'s biography after a failed dealt-facet regenerate "
                        f"({', '.join(facet_conflicts)}) — closed-facet-conflict")
                    try:
                        from src import log_rings
                        log_rings.record_soft_failure(
                            "cast-authoring:closed-facet-conflict",
                            f"authored biography for {hid} contradicted a dealt closed facet "
                            f"({', '.join(facet_conflicts)}) and a regenerate could not clear it — dropped "
                            "the biography so the dealt skeleton stands",
                            corrected="dealt-closed-facet", user=user, houseguest=hid)
                    except Exception:  # pragma: no cover - the health record must never break authoring
                        pass
                if len(profile) <= 1:
                    floor_below += 1
                    return 0
            # ORW-360: the look accept path. One strict retry naming the problem(s); then per-axis fallbacks.
            # ORW-388: the biography's own story checks (pronoun, age, look feature, show name) ride the same single strict retry.
            _no_bio = lambda p: [] if (_biography_meets_floor(str((p or {}).get("biography") or "").strip())
                                       or _has_floor_biography(npc)) else ["story-no-biography"]
            problems = look_problems(profile, npc) + story_problems(profile, npc, cast) + _no_bio(profile)
            _dropped = parse_dropped(text, npc)  # ORW-956: the biography / identityConcept the parse floors deleted from the first draft
            if problems:
                logger.info(f"[cast-authoring] look check failed for {hid} ({', '.join(problems)}) — retrying once")
                try:  # ORW-1025: counted per look-check failure
                    from src import log_rings
                    log_rings.record_soft_failure(
                        "cast-authoring:look-check-failed",
                        f"look check failed for {hid} ({', '.join(problems)})",
                        corrected="strict-retry", user=user, houseguest=hid)
                except Exception:  # pragma: no cover - the health record must never break authoring
                    pass
                _spend_attempt(ukey, hid)
                try:
                    look_messages = build_authoring_messages(npc, taken=_taken_for(hid), hand=hand_by_id.get(hid))
                    # ORW-437: the first draft rides along as the assistant turn, so the retry FIXES it (the accepted voice and
                    # hidden storyline stay) instead of replacing it with a fresh draft.
                    look_text = await llm_fn(look_messages + [
                        {"role": "assistant", "content": json.dumps(profile, ensure_ascii=False)},
                        {"role": "user", "content": look_retry_message(problems)}])
                    look_profile = parse_authored_profile(look_text or "", hid)
                except Exception as e:
                    logger.warning(f"[cast-authoring] look-check retry call failed for {hid}: look-retry-call-failed ({type(e).__name__})")
                    look_profile = None
                if (look_profile is not None and not look_problems(look_profile, npc)
                        and not story_problems(look_profile, npc, cast) and not _no_bio(look_profile)
                        and not facet_hand_conflicts(look_profile, npc) and _lint_identity(look_profile)):
                    profile = look_profile
                    _dropped = {}
                else:
                    # ORW-956: ONE targeted repair call for the fields a fallback would delete, before it does
                    if not _given_up(ukey, hid):
                        _spend_attempt(ukey, hid)
                        _fixed = await repair_failing_fields(profile, npc, problems, llm_fn, dropped=_dropped)
                        if _fixed["fixed"]:
                            problems = look_problems(profile, npc) + story_problems(profile, npc, cast) + _no_bio(profile)
                        _dropped = {}
                    applied = apply_look_fallbacks(profile, npc, problems)
                    logger.warning(
                        f"[cast-authoring] look fell back to the seeded brief for {hid} after the retry "
                        f"({', '.join(applied)}) — look-fallback")
                    try:  # ORW-1025: a counted, visible degrade (the photo may not match the written face)
                        from src import log_rings
                        log_rings.record_soft_failure(
                            "cast-authoring:look-fallback",
                            f"look for {hid} fell back to the seeded brief after the retry ({', '.join(applied)})",
                            corrected="seeded-brief", user=user, houseguest=hid)
                    except Exception:  # pragma: no cover - the health record must never break authoring
                        pass
            elif _dropped and not _given_up(ukey, hid):
                # ORW-956: nothing failed a look check, but a parse floor deleted the biography or identity line: ask for it once
                _spend_attempt(ukey, hid)
                await repair_failing_fields(profile, npc, [], llm_fn, dropped=_dropped)
            # ORW-388: whatever the retry did not clear is mended deterministically (the biography here, and the card's
            # identityConcept, which genesis wrote and no retry can rewrite). Codes and the id only in the log.
            repaired = [] if _gate_on else repair_story(profile, npc, cast)  # ORW-431: the gate below mends (and counts) it
            if repaired:
                logger.warning(f"[cast-authoring] repaired the story text of {hid} ({', '.join(repaired)}) — story-repair")
            # ORW-431: THE ONE GATE at the end. The final card (roster card + this profile) must be complete and
            # consistent in every public text; mended, re-written (bounded) or left NOT authored. Codes only in logs.
            if _gate_on:
                async def _gate_rewrite(_npc, _codes, message=None):
                    if _given_up(ukey, hid):
                        return None
                    _spend_attempt(ukey, hid)
                    if message:
                        # ORW-480: a repetition or casting-director ask regenerates ONLY the named field(s), from a short prompt
                        _t = await llm_fn(compact_rewrite_messages(_npc, message))
                        _obj = _extract_json(_t or "")
                        return _obj if isinstance(_obj, dict) else None
                    _msgs = build_authoring_messages(_npc, taken=_taken_for(hid), hand=hand_by_id.get(hid))
                    _t = await llm_fn(_msgs + [{"role": "user", "content": message or _gate.rewrite_message(_codes)}])
                    return parse_authored_profile(_t or "", hid)
                async with gate_lock:
                    _gated, _left = await _gate.run_gate(season_gate, profile, npc, cast, _gate_rewrite)
                if _gated is None:
                    floor_below += 1
                    return 0
            if not _gate_on:  # the gate below includes this check (ORW-431); kept for the flag-off path
                # ORW-430: the final check, after every repair. A card with no usable biography is NEVER written as authored:
                # it stays on the floor (unauthored_ids picks it up again, bounded by the attempt ledger) and the fault is RED.
                final = card_consistency(profile, npc, cast)
                if final:
                    logger.warning(f"[cast-authoring] final consistency check for {hid}: {', '.join(final)}")
                if "story-no-biography" in final:
                    floor_below += 1
                    try:
                        from src import log_rings
                        log_rings.record_soft_failure(
                            "cast-authoring:biography-missing",
                            f"authoring for {hid} produced no usable biography after the strict retry — the card is left "
                            "unauthored so the background retry takes it again",
                            corrected="left-unauthored", user=user, houseguest=hid)
                    except Exception:  # pragma: no cover - the health record must never break authoring
                        pass
                    return 0
            # #1057: the write-back is SERIALIZED + degradation-retried (it must not run concurrently
            # against the orchestrator integrity checkpoint).
            res = await _write_with_retries(profile, hid)
        if res == "degradation":
            floor_degradation += 1
            return 0
        if not (isinstance(res, dict) and res.get("accepted")):
            # FEPY-5 (#621): a rejected/odd write-back was silently dropped here — already logged inside
            # `_write_with_retries`; the seeded floor still stands (best-effort, never aborts).
            return 0
        # ORW-431b: verify what the engine STORED. A card is never accepted as authored with an empty identity line: the engine
        # reports "identityConcept" in `publicFields` when the card now holds the writer's text. If the writer sent one and the
        # engine did not keep it, that is the gate's blocking `identity-missing`: re-write within the gate's bound, else the card is
        # left not authored (an empty identity makes `card_missing_story` true, so the background backfill takes it again).
        if _gate_on and _identity_dropped(profile, res):
            for _try in range(_gate.GATE_REWRITE_BOUND):
                _fresh = None
                try:
                    _fresh = await _gate_rewrite(npc, ["identity-missing"])
                except Exception as e:  # failsoft-ok: a failed re-write is a failed attempt, never an abort
                    logger.warning(f"[cast-gate] identity re-write call failed for {hid}: {type(e).__name__}")
                if isinstance(_fresh, dict):
                    _merged_p = {**profile, **{k: v for k, v in _fresh.items() if v not in (None, "", [], {})}}
                    _gate.mend(_merged_p, npc)
                    profile.clear()
                    profile.update(_merged_p)
                if any(_gate.is_blocking(c) for c in _gate.card_codes(profile, npc, cast, season_gate.registry)):
                    continue  # the re-write must pass the same gate before it is written
                res = await _write_with_retries(profile, hid)
                if not (isinstance(res, dict) and res.get("accepted")):
                    return 0
                if not _identity_dropped(profile, res):
                    break
            else:
                floor_below += 1
                season_gate.failing += 1
                logger.warning(f"[cast-gate] {hid} left not authored: identity-missing (the engine did not store it)")
                try:
                    from src import log_rings
                    log_rings.record_soft_failure(
                        "cast-gate:failed", f"card {hid} failed the final gate: identity-missing - left not authored",
                        corrected="left-unauthored", user=user, houseguest=hid)
                except Exception:  # pragma: no cover - the health record must never break authoring
                    pass
                return 0
        # The write-back landed. Keep the authored card so the post-pass can see the sheet; the per-NPC
        # completion signal (the portrait gate, #7) fires after the photo-sheet de-duplication pass below.
        _phys = profile.get("physicalCharacteristics")
        authored_cards[hid] = {**npc, "id": hid,
                               "physicalCharacteristics": {**(npc.get("physicalCharacteristics") or {}),
                                                           **(_phys if isinstance(_phys, dict) else {})},
                               **({"voice": profile["voice"]} if isinstance(profile.get("voice"), dict) else {}),
                               **({"biography": profile["biography"]} if isinstance(profile.get("biography"), str) and profile["biography"].strip() else {})}
        authored_ids.append(hid)
        return 1

    results = await asyncio.gather(*[_author_one(npc) for npc in (cast or [])])
    written = sum(results)
    season_gate.log_summary()  # ORW-431 C: one line per season, counts and codes only
    # ORW-380: the photo-sheet de-duplication post-pass, then the per-NPC completion signals.
    if len(authored_cards) > 1:
        try:
            # ORW-437 (review of #2677): the engine's look-only write-back lands on the LIVE cast. A run whose own sink
            # is the next-season holding store (`live_look_sink=False`, no `look_write_fn`) skips the pass: there is no
            # holding-store look write, and a live write would put next-season sheets on the running season's cards.
            if look_write_fn is None and live_look_sink:
                async def look_write_fn(h: str, fields: dict) -> dict:  # noqa: F811 - the engine's look-only write-back
                    from src import orwell_engine
                    return await orwell_engine.record_look_extras(h, fields, user=user)
            if look_write_fn is not None:
                await dedupe_photo_sheets(list(authored_cards.values()), llm_fn, look_write_fn)
                await fit_audit_pass(list(authored_cards.values()), llm_fn, look_write_fn)  # ORW-480: the cast-level look-fits-life audit
                try:  # ORW-563: ONE batched believability judgement per cast (a far outlier is re-picked and its clothes rewritten)
                    from src import orwell_cast_believability as _B
                    _taken = {str(c.get("presentation") or "") for c in (cast or []) if isinstance(c, dict)} - {""}
                    _taken |= {str(c.get("presentation") or "") for c in authored_cards.values()} - {""}
                    await _B.believability_pass(list(authored_cards.values()), _taken, llm_fn, write_fn, look_write_fn, user=user, stats=season_gate.believe)
                    logger.info(season_gate.believability_line())
                except Exception as e:  # failsoft-ok: best-effort-enrichment (the dealt looks stand)
                    logger.warning(f"[cast-authoring] believability pass failed: {type(e).__name__}")
        except Exception as e:  # failsoft-ok: best-effort-enrichment (the original sheets stand)
            logger.warning(f"[cast-authoring] photo-sheet de-duplication failed: {type(e).__name__}")
    for _hid, _card in authored_cards.items():
        _miss = look_fields_missing(_card.get("physicalCharacteristics"))
        if _miss:
            logger.warning(f"[cast-authoring] {_hid} finished authoring without {', '.join(_miss)} — look-fields-missing")
            try:
                from src import log_rings
                log_rings.record_soft_failure(
                    "cast-authoring:look-fields-missing",
                    f"{_hid} finished authoring without {', '.join(_miss)}; the roster backfill takes the card again",
                    corrected="left-for-backfill", user=user, houseguest=_hid)
            except Exception:  # pragma: no cover - the health record must never break authoring
                pass
    if on_authored is not None:
        for _hid in authored_ids:
            try:
                on_authored(_hid)
            except Exception as e:  # pragma: no cover - defensive: a gate callback must never abort
                logger.warning(f"[cast-authoring] on_authored({_hid}) failed: {e}")
    # #1002 / #1057: the per-season diagnostic counter — the headline "did the LLM actually enrich the
    # cast, or did it all fall back to the thin deterministic floor?" line. `total` counts the authorable
    # NPCs (the player is human-authored and skipped); the floor tallies break down EVERY no-op cause so a
    # mass fallback is immediately diagnosable in the logs — empty / truncated / degradation are each
    # visible now (the live-verify's dominant failures), beside the original no-JSON / below-floor.
    total = sum(1 for npc in (cast or []) if npc.get("id") and npc.get("id") != "player")
    floor = total - written
    logger.info(
        f"[cast-authoring] cast authoring: authored {written}/{total} houseguests "
        f"(floor fallback for {floor}: {floor_no_json} no-JSON, {floor_empty} empty, "
        f"{floor_truncated} truncated, {floor_degradation} degradation, {floor_below} below-floor, "
        f"{floor_gaveup} given-up, {floor_call_failed} call-failed; "
        f"{coherence_stripped} identity-incoherent prose-strip(s), "
        f"{identity_pinned} roster-contradiction field-strip(s), "
        f"{secret_pinned} crosswired-vocation secret-strip(s), "
        f"{facet_stripped} closed-facet-conflict biography-strip(s)"
        + (f", {voice_repaired} voice repair(s)" if voice_repair_enabled() else "") + ")")
    # STRICT enrichment policy (owner directive 2026-07-11): any houseguest left on the deterministic
    # floor after the bounded retry ladder is a LOUD failure — an ERROR + an admin-visible ledger
    # entry (the #1313 house-entry gate is what blocks the flow itself). Under `soft` the tally above
    # stays the only trace, byte-identical to the legacy behavior.
    if floor > 0:
        try:
            from src import enrichment_policy
            if enrichment_policy.is_strict():
                mark_strict_failed(user)  # ORW-260: the backstories are required - latch the loud pre-finalize gate
                enrichment_policy.record_failure(
                    user, "cast-authoring",
                    f"{floor}/{total} houseguest(s) fell back to the deterministic floor after retries",
                    detail=(f"{floor_no_json} no-JSON, {floor_empty} empty, {floor_truncated} truncated, "
                            f"{floor_degradation} degradation, {floor_below} below-floor, "
                            f"{floor_gaveup} given-up, {floor_call_failed} call-failed"))
        except Exception:
            pass
    # RC6 S6c (#1599): an EMPTY visible body after the retry ladder is the reasoning-channel misroute —
    # the model routed its whole turn to the reasoning channel (or otherwise vanished), leaving the
    # visible reply empty, so nothing could be authored. It was previously folded only into the aggregate
    # `cast-authoring` floor row above (strict-gated). Land it as its OWN alarm-eligible runtime class
    # (`enrichment:reasoning-misroute`) via the unconditional runtime recorder — a vanished completion is
    # a genuine provider fault (a wired model returned nothing), never the deliberate no-model floor, so
    # it is loud regardless of the enrichment soft/strict policy. Fail-soft; telemetry never blocks start.
    if floor_empty > 0:
        try:
            from src import enrichment_policy
            enrichment_policy.record_runtime_failure(
                user, "reasoning-misroute",
                f"model routed the whole turn to the reasoning channel (empty visible body) for "
                f"{floor_empty} houseguest(s) — nothing authored, seeded floor stands")
        except Exception:
            pass
    # RC6 S6c: a provider CALL that RAISED (timeout / HTTP / network) is a genuine provider/transport
    # fault, NOT a reasoning-channel misroute — record it under its own truthful runtime class so the
    # exception path is never mislabeled the misroute above. Unconditional (a raised provider call is
    # always a real fault, never the deliberate no-model floor); fail-soft, never blocks start.
    if floor_call_failed > 0:
        try:
            from src import enrichment_policy
            enrichment_policy.record_runtime_failure(
                user, "cast-authoring-call",
                f"the authoring provider call raised (timeout / HTTP / network) for "
                f"{floor_call_failed} houseguest(s) — no completion reached, seeded floor stands")
        except Exception:
            pass
    return written


# ── the live wiring (best-effort, background; graceful no-op when no model) ────

async def resolve_prose_llm_fn(resolver, owner):
    """ORW-387: resolve the shared utility completion for a PLAIN-PROSE prompt (no ``response_format``). ``resolver`` is
    the caller's own ``_resolve_llm_fn`` reference; a legacy-signature stub (tests) gets the bare call."""
    try:
        return await resolver(owner, json_mode=False)
    except TypeError:
        return await resolver(owner)


async def _resolve_llm_fn(owner: Optional[str], *, prefix: str = "utility",
                          fallbacks_key: str = "utility",
                          include_utility_fallback: bool = False,
                          temperature: Optional[float] = None,
                          min_output_tokens: Optional[int] = None,
                          json_mode: bool = True) -> Optional[LlmFn]:
    """Build a one-shot completion fn over the user's UTILITY model (background-safe, like the email
    triage path). Returns None when no usable endpoint resolves — authoring then silently no-ops.

    Feature 0081: pass ``prefix='faithfulness', fallbacks_key='faithfulness'`` to resolve the DEDICATED
    faithfulness-judge model (settings ``faithfulness_*``) instead — ``resolve_endpoint`` itself chains
    faithfulness → utility → default. The default call ``_resolve_llm_fn(owner)`` is byte-identical to
    before (same utility resolution, same utility fallback chain, same image-filter + streaming tail).

    Owner directive 2026-07-11 (the cast-authoring narration routing — see
    ``resolve_authoring_llm_fn``): ``include_utility_fallback=True`` appends the UTILITY endpoint +
    its configured fallback chain to the candidates as the EXPLICIT fallback (de-duped, logged —
    never a silent substitution), and ``temperature`` overrides the shared ``_AUTHOR_TEMPERATURE``
    for THIS resolved fn only (``None`` ⇒ unchanged). Both default OFF, so every existing caller is
    byte-identical.

    ``min_output_tokens`` (2026-07-13 genesis-cap fix): a per-call-family FLOOR on the resolved
    output cap — the full-cast genesis sketch needs a ~15-NPC-sized budget the one-NPC class cap
    can't carry (``token_policy.GENESIS_SKETCH_MIN_OUTPUT_TOKENS``). ``None`` ⇒ the legacy
    ``_AUTHOR_MIN_OUTPUT_TOKENS`` floor (byte-identical for every existing caller). An admin
    ``max_tokens_budget`` override LARGER than the floor still wins (max, not replace)."""
    try:
        from src.endpoint_resolver import (resolve_endpoint, resolve_utility_fallback_candidates,
                                           _resolve_fallback_candidates)
        from src.llm_core import stream_llm_with_fallback
    except Exception:
        return None
    url, model, headers = resolve_endpoint(prefix, owner=owner)
    if not url or not model:
        url, model, headers = resolve_endpoint("default", owner=owner)
    if not url or not model:
        return None
    if fallbacks_key == "utility":
        _extra = resolve_utility_fallback_candidates(owner=owner) or []
    else:
        _extra = _resolve_fallback_candidates(f"{fallbacks_key}_model_fallbacks", owner=owner) or []
    candidates = [(url, model, headers)] + _extra

    if include_utility_fallback:
        # The EXPLICIT utility fallback (owner directive 2026-07-11): when cast authoring routes to
        # the narration model, the utility endpoint + its configured fallback chain are APPENDED as
        # visible fallback candidates — configured, de-duped, and logged, never a silent
        # substitution. A narration outage therefore degrades to the utility tier deliberately.
        _u_url, _u_model, _u_headers = resolve_endpoint("utility", owner=owner)
        _tail = ([(_u_url, _u_model, _u_headers)] if _u_url and _u_model else []) \
            + (resolve_utility_fallback_candidates(owner=owner) or [])
        _seen = {(u, m) for (u, m, _h) in candidates}
        _added = []
        for (_tu, _tm, _th) in _tail:
            if _tu and _tm and (_tu, _tm) not in _seen:
                _seen.add((_tu, _tm))
                _added.append((_tu, _tm, _th))
        if _added:
            logger.info(
                "[cast-authoring] narration-first routing: primary %s; explicit utility fallback %s",
                model, [m for (_u2, m, _h2) in _added])
            candidates = candidates + _added
    _temperature = _AUTHOR_TEMPERATURE if temperature is None else float(temperature)

    # #546: an image-only model (dall-e / flux / gpt-image / …) resolves fine as an endpoint but can
    # NOT do JSON/chat authoring — POSTing prose messages to it degrades silently (empty/garbage text
    # ⇒ the parse fails and the write-back no-ops). Drop any image-only candidate so we only keep a
    # real text/chat model. Fail-soft: if that empties the list, return None and the engine's
    # deterministic floor simply stands (same as "no model configured").
    try:
        from src.orwell_portraits import _is_image_model
    except Exception:
        _is_image_model = None  # type: ignore
    if _is_image_model is not None:
        kept = [(u, m, h) for (u, m, h) in candidates if not _is_image_model(m)]
        if len(kept) != len(candidates):
            dropped = [m for (_u, m, _h) in candidates if _is_image_model(m)]
            logger.warning(
                "[utility-llm] skipping image-only model(s) %s for JSON authoring — "
                "they cannot do text/chat completion", dropped,
            )
        candidates = kept
        if not candidates:
            logger.warning(
                "[utility-llm] no text/chat utility model resolved (only image model(s)) — "
                "keeping the engine deterministic floor"
            )
            return None

    # ADR 0010: the background-authoring reasoning + output budget (admin-overridable). Fail-open.
    _policy = None
    _max_tokens = 0
    try:
        from src.token_policy import resolve_token_policy
        from src.settings import get_setting as _gs
        _policy = resolve_token_policy("background-authoring", {
            "reasoning_budget": _gs("reasoning_budget", {}),
            "max_tokens_budget": _gs("max_tokens_budget", {}),
        })
        # #1002: APPLY the per-class output cap (raised to a comfortable floor in token_policy) as the
        # call's max_tokens — a full authored JSON profile must fit even on a reasoning model that counts
        # reasoning+visible against the same budget. Without this the call ran with no positive cap.
        _mt = _policy.get("max_tokens") if isinstance(_policy, dict) else None
        if isinstance(_mt, int) and not isinstance(_mt, bool) and _mt > 0:
            _max_tokens = _mt
    except Exception:
        _policy = None
        _max_tokens = 0

    # #1044 — the SECOND root cause (the live 0/15 that survived the #1007 budget raise): the resolved
    # `background-authoring` policy turns reasoning ON (effort "low") on a reasoning model. On
    # deepseek-v4-pro the rich deep-profile prompt makes the model spend the ENTIRE output budget on
    # reasoning tokens (`thinking: true` deltas) and a mid-stream provider error / budget exhaustion
    # then lands BEFORE any visible JSON — so the body is empty/truncated prose and `_extract_json`
    # finds nothing. Authoring is pure STRUCTURED EXTRACTION (emit one JSON object) — reasoning adds no
    # value here, only burns the budget. Force reasoning OFF for the authoring call (independent of the
    # admin effort knob, which governs the player-facing narrator, not this background utility task):
    # `_apply_reasoning_budget` translates `reasoning=None` into an explicit `{"enabled": false}` on
    # OpenRouter, so visible JSON streams from the first token. Verified live: reasoning-off + a roomy
    # cap returns a clean, parseable object every call.
    if isinstance(_policy, dict):
        _policy = dict(_policy)
        _policy["reasoning"] = None  # explicit OFF (omit-vs-disable handled by _apply_reasoning_budget)
    # Guarantee a comfortable visible-output budget regardless of any admin `max_tokens_budget` override
    # that set the authoring cap too low (a full JSON profile is ~500-800 tokens; with reasoning OFF the
    # whole cap is the answer, but keep generous headroom so a verbose biography never truncates).
    # 2026-07-13: a caller-supplied `min_output_tokens` RAISES the floor for its call family (the
    # full-cast genesis sketch) — max, not replace, so a LARGER admin override still wins.
    _floor = _AUTHOR_MIN_OUTPUT_TOKENS
    if isinstance(min_output_tokens, int) and not isinstance(min_output_tokens, bool) \
            and min_output_tokens > 0:
        _floor = max(_floor, min_output_tokens)
    if _max_tokens < _floor:
        _max_tokens = _floor

    async def _once(messages: list[dict], cap: int) -> tuple[str, Optional[str], str]:
        """One completion at output cap ``cap``. Returns ``(visible_text, finish_reason, reasoning_text)``
        and records one Vault-free token-ledger entry (ADR 0010) for the attempt.

        S3b (RC4): the reasoning/thinking channel is captured SEPARATELY (it never pollutes the visible
        body — `_delta_text` still drops it) so a reasoning-channel MISROUTE (glm-4.7 emitting the whole
        JSON answer as `thinking` deltas with an empty visible body) can be recovered instead of silently
        discarded as paid-for content."""
        parts: list[str] = []
        rparts: list[str] = []
        _usage: dict = {}
        _finish: Optional[str] = None
        _error_frame: Optional[str] = None  # ORW-437: the provider's `event: error` frame, when one arrives
        # #1002: request strict JSON (response_format) so a model that honours it can't leak prose/
        # reasoning into the body. Threads through stream_llm_with_fallback → stream_llm onto the
        # OpenAI-style payload; a provider that ignores it is harmless (the strict prompt + the one-shot
        # retry in author_cast still apply). The policy already supplies the (raised, #1002) token budget.
        # #1713: bounded to a hard wall-clock ceiling (see `_bounded_stream`) — a JSON-authoring call
        # must fail fast under contention, never ride the narration-sized 300s default. The ceiling is
        # passed explicitly (read from the module global at CALL time, not `_bounded_stream`'s default
        # parameter — a default is bound once at function-definition time) so a runtime override of
        # `_AUTHORING_STREAM_WALL_CLOCK_S` (e.g. a test, or a future admin knob) actually takes effect.
        # ORW-983: close the wrapper whenever this loop ends, however it ends (a body error between two chunks would otherwise leave its pump blocked on its full queue until the garbage collector
        # closes the generator, possibly in another loop).
        _stream = _bounded_stream(stream_llm_with_fallback(
            candidates, messages, temperature=_temperature, policy=_policy,
            max_tokens=cap, response_format=(_response_format_for(messages) if json_mode else None)), wall_clock_s=_AUTHORING_STREAM_WALL_CLOCK_S)
        async with contextlib.aclosing(_stream):
            async for chunk in _stream:
                # stream_llm yields SSE-ish data lines; keep only the assistant text deltas.
                piece = _delta_text(chunk)
                if piece:
                    parts.append(piece)
                    continue
                if isinstance(chunk, str) and chunk.lstrip().startswith("event: error"):
                    _error_frame = _error_frame or chunk  # ORW-437: the stream failed; the text so far is a PARTIAL
                    continue
                # S3b: keep reasoning/thinking deltas in a SEPARATE buffer (never the visible body) so a
                # misrouted JSON answer is recoverable — see the empty-visible fallback in `_fn`.
                rpiece = _reasoning_delta_text(chunk)
                if rpiece:
                    rparts.append(rpiece)
                    continue
                # ADR 0010: capture the usage envelope (the trailing 'usage' SSE event) for the meter,
                # and the terminal finish event ("length" ⇒ the model was CUT OFF by the output cap).
                s = str(chunk or "")
                if s.startswith("data:"):
                    _body = s[5:].strip()
                    if _body and _body != "[DONE]":
                        try:
                            _d = json.loads(_body)
                        except (ValueError, TypeError):
                            _d = None
                        if isinstance(_d, dict) and _d.get("type") == "usage":
                            _ud = _d.get("data") or {}
                            if _ud:
                                _usage = {
                                    "input_tokens": _ud.get("input_tokens", 0),
                                    "output_tokens": _ud.get("output_tokens", 0),
                                    "cached_tokens": _ud.get("cached_tokens", 0) or 0,
                                    "cache_miss_tokens": _ud.get("cache_miss_tokens"),
                                    "reasoning_tokens": _ud.get("reasoning_tokens", 0) or 0,
                                    "cost": _ud.get("cost"),
                                    "cost_estimated": bool(_ud.get("cost_estimated")),
                                    "model": _ud.get("model"),
                                    "provider": _ud.get("provider"),
                                }
                        elif isinstance(_d, dict) and _d.get("type") == "finish":
                            _finish = _d.get("reason") or _finish
        # ADR 0010: one Vault-free token/cost entry per authoring call, keyed by the canonical game
        # session so it aggregates with the game's narration spend. Fail-open; never seen by the player.
        if owner and _usage:
            try:
                from src import orwell_token_ledger as _tl
                _sess = None
                try:
                    from src import orwell_game_session as _gs2
                    _sess = _gs2.get_game_session(owner)
                except Exception:
                    _sess = None
                _tl.record_turn(
                    owner, session=_sess or owner, turn_id=None, call_class="background-authoring",
                    input_tokens=_usage.get("input_tokens", 0), cached_tokens=_usage.get("cached_tokens", 0),
                    reasoning_tokens=_usage.get("reasoning_tokens", 0), output_tokens=_usage.get("output_tokens", 0),
                    # DB3 (#1026): the cap WAS applied on the wire (max_tokens=cap above); log it so
                    # the ledger shows appliedMaxTokens=cap, not cap=0. Omitting it mis-logged cap=0.
                    applied_max_tokens=cap, finish_reason=_finish,
                    cost=float(_usage.get("cost") or 0), provider=_usage.get("provider"),
                    cost_estimated=_usage.get("cost_estimated"), model=_usage.get("model"),
                    cache_miss_tokens=_usage.get("cache_miss_tokens"),
                )
            except Exception:
                pass
        if _error_frame is not None:
            # ORW-437 (review of #2668): an error frame mid-stream means everything before it is a partial response (a
            # cut-off summary would be stored as the day's memory); `_fn` turns it into a raised failure.
            return _error_frame, "error", ""
        return "".join(parts), _finish, "".join(rparts)

    async def _fn(messages) -> str:
        # Shape-normalize the input. The cast-authoring path passes a proper `list[dict]` of chat
        # messages, but the faithfulness judge (0081) and the runtime overseer (0079/0080) call this
        # resolved fn with a single prompt STRING (`_llm(judge.build_prompt(...))`). A raw string was
        # passed straight through to `stream_llm_with_fallback` → `_sanitize_llm_messages`, which
        # iterates it CHAR-BY-CHAR (each char is not a dict) and yields an EMPTY messages array — so
        # the provider rejected it with HTTP 400 "Input required: specify prompt or messages" and the
        # judge NEVER ran (13/13 calls 400'd in a prod debug bundle). Wrap a bare string (or any
        # non-list) as a single user message so the prompt actually reaches the wire. A list[dict]
        # caller is byte-identical (no wrapping).
        if isinstance(messages, str):
            messages = [{"role": "user", "content": messages}]
        elif not isinstance(messages, list):
            messages = [{"role": "user", "content": str(messages)}]
        try:  # ORW-1024: name the caller class so a provider 400 says who sent it (labels only)
            import sys as _sys
            from src.llm_core import LLM_CALLER
            _f = _sys._getframe(1)
            LLM_CALLER.set(f"{_f.f_globals.get('__name__', '?')}.{_f.f_code.co_name}")
        except Exception:  # pragma: no cover - a log label only
            pass
        text, finish, reasoning = await _once(messages, _max_tokens)
        if finish == "error":
            # ORW-437: a failed stream RAISES (never returns the frame as text): every consumer already wraps the call in a
            # try/except and takes its own failure path (nothing stored, a retry or the floor), and nothing is retried-over or recovered.
            raise RuntimeError("provider-error-frame")
        # 2026-07-13 retry-on-length: `finish_reason == "length"` means the completion was CUT OFF
        # by the output cap — for a JSON-authoring call the body is chopped mid-object and
        # unparseable, so a same-cap retry (#1057) can never fix it. Re-issue EXACTLY ONCE at
        # double the cap, bounded by LENGTH_RETRY_MAX_TOKENS; never loop (a second "length" at the
        # doubled cap falls through to the caller's normal parse-failure handling / the floor).
        if finish == "length" and _max_tokens < _LENGTH_RETRY_MAX_TOKENS:
            retry_cap = min(_max_tokens * 2, _LENGTH_RETRY_MAX_TOKENS)
            logger.warning(
                f"[cast-authoring] completion hit the output cap (finish_reason=length at "
                f"max_tokens={_max_tokens}) — retrying ONCE at a doubled cap {retry_cap}")
            try:  # ORW-1025: a counted, visible degrade (every cast paying two calls shows on /admin/status)
                from src import log_rings
                log_rings.record_soft_failure(
                    "cast-authoring:output-cap-hit",
                    f"completion hit the output cap at max_tokens={_max_tokens}",
                    corrected="doubled-cap-retry", user=owner)
            except Exception:  # pragma: no cover - the health record must never break authoring
                pass
            retry_text, _retry_finish, retry_reasoning = await _once(messages, retry_cap)
            if _retry_finish == "error":
                # ORW-437: the doubled-cap retry ended in an error frame: raise, never hand the frame back as a completion.
                raise RuntimeError("provider-error-frame")
            if retry_text:
                return retry_text
            # The retry's visible body was also empty — carry its reasoning as an extra recovery source.
            if retry_reasoning and not (reasoning or "").strip():
                reasoning = retry_reasoning
        # S3b (RC4): the visible body came back EMPTY but the model MISROUTED the JSON answer into the
        # reasoning channel (glm-4.7 does this even with reasoning:{enabled:false} sent). Recover the
        # paid-for content instead of discarding it — and record a RED-eligible health event (#1599:
        # a real fault is logged even when auto-corrected, never an `except: pass` of a live error).
        if not (text or "").strip() and (reasoning or "").strip():
            recovered = _recover_from_reasoning_channel(reasoning, owner)
            if recovered:
                return recovered
        return text

    return _fn


def _delta_text(chunk) -> str:
    """Extract the assistant's VISIBLE-content text from one `stream_llm` SSE chunk.

    #1044 — the real, load-bearing shape: `stream_llm` emits visible content as
    ``data: {"delta": "<text>"}`` and reasoning/thinking as ``data: {"delta": "<text>", "thinking": true}``
    (see `_stream_delta_event` in `llm_core`). The old reader only looked at ``content``/``text`` keys, so
    it dropped EVERY content chunk — the authoring `_fn` returned an empty string, `_extract_json` found
    nothing, and the whole cast fell back to the seeded floor (`authored 0/15`) even when the model
    streamed perfect JSON.

    We now:
      • read the `delta` key (the real streaming key) first, then fall back to `content`/`text` for any
        dict-shaped chunk (back-compat);
      • SKIP thinking/reasoning deltas (``thinking: true``) — reasoning must never pollute the JSON body;
      • SKIP non-text event chunks (``type`` set: usage / finish / tool_calls / model_actual / …).
    """
    if isinstance(chunk, dict):
        if chunk.get("thinking") or chunk.get("type"):
            return ""
        return str(chunk.get("delta") or chunk.get("content") or chunk.get("text") or "")
    s = str(chunk or "")
    if s.startswith("data:"):
        body = s[5:].strip()
        if body and body != "[DONE]":
            try:
                d = json.loads(body)
            except (ValueError, TypeError):
                return ""
            if isinstance(d, dict):
                # Drop reasoning deltas and typed meta events (usage/finish/tool_calls/model_actual);
                # keep ONLY the visible-content `delta` (then content/text for any older shape).
                if d.get("thinking") or d.get("type"):
                    return ""
                return str(d.get("delta") or d.get("content") or d.get("text") or "")
        return ""
    if s.lstrip().startswith("event:"):
        return ""  # ORW-387: an SSE control frame (`event: error` + its data line) is never the model's text
    return s


def _reasoning_delta_text(chunk) -> str:
    """The MIRROR of `_delta_text` for the REASONING/thinking channel (S3b). `_stream_delta_event`
    (llm_core) emits reasoning content as ``data: {"delta": "<text>", "thinking": true}``; the visible
    reader drops it. This reader keeps ONLY those thinking deltas (their `delta` text), so a reasoning-
    channel misroute (an empty visible body while the JSON answer streamed as reasoning) is recoverable.
    Non-thinking / typed-meta chunks yield ""."""
    if isinstance(chunk, dict):
        if chunk.get("type"):
            return ""
        if chunk.get("thinking"):
            return str(chunk.get("delta") or chunk.get("content") or chunk.get("text") or "")
        return ""
    s = str(chunk or "")
    if s.startswith("data:"):
        body = s[5:].strip()
        if body and body != "[DONE]":
            try:
                d = json.loads(body)
            except (ValueError, TypeError):
                return ""
            if isinstance(d, dict) and d.get("thinking") and not d.get("type"):
                return str(d.get("delta") or d.get("content") or d.get("text") or "")
        return ""
    return ""


def _recover_from_reasoning_channel(reasoning: str, owner: Optional[str]) -> Optional[str]:
    """S3b (RC4): when the visible body is empty but a parseable JSON answer sat in the reasoning
    channel, recover it (via the genesis detector) and return the JSON STRING so the normal parser
    consumes it — counting the recovery a SUCCESS, never a silent discard of paid-for content. A
    RED-eligible ``reasoning-channel-misroute`` health event is recorded regardless of the enrichment
    policy (#1599: a real fault is surfaced even when auto-corrected). Returns ``None`` when the
    reasoning holds no usable JSON (the caller then keeps the empty body ⇒ the deterministic floor)."""
    try:
        from src.orwell_cast_genesis import recover_reasoning_channel_json
    except Exception:
        return None
    recovered = recover_reasoning_channel_json(reasoning)
    if not recovered:
        return None
    logger.warning(
        "[cast-authoring] the model MISROUTED its JSON answer into the reasoning channel "
        "(empty visible body) — recovered it (reasoning-channel-misroute)")
    try:
        from src import enrichment_policy
        enrichment_policy.record_failure(
            owner, "cast-genesis", "reasoning-channel-misroute",
            detail="model emitted JSON into the reasoning channel with an empty visible body; "
                   "recovered the paid-for content (auto-corrected, but RED-eligible per #1599)")
    except Exception:  # pragma: no cover - the health record must never break the recovery
        pass
    return recovered


async def run_authoring(cast: list[dict], owner: Optional[str],
                        on_authored: Optional[Callable[[str], None]] = None,
                        write: Optional[WriteFn] = None,
                        seed: Optional[int] = None) -> int:
    """Resolve the live deps and author the cast. Silent no-op (returns 0) if no model resolves.
    No player identity is threaded in — NPC storylines are authored player-independent.
    `on_authored(houseguest_id)` fires per successful write-back (per-NPC portrait gating, #7).

    `write` overrides the write-back sink (default: `record_cast_profile` onto the active/pre-game cast).
    The 0065 advance-warm passes a sink that routes through `pre_seed_next_season(profile=…)` so the
    authored profile lands on the NEXT-season HOLDING store — NEVER the live cast (mid-season,
    `record_cast_profile` would author the running house, the wrong cast).

    `seed` (T0-6) — the season seed, when known — mints the cast-wide FacetLedger `author_cast` threads
    into every per-NPC prompt (dealt hand + taken-list). Absent ⇒ authoring still runs, just without the
    ledger steering (the legacy plain prompt; the engine's structural envelope still binds regardless).

    Routing (owner directive 2026-07-11): the calls resolve through `resolve_authoring_llm_fn` —
    narration-model-first at the runtime `cast_authoring_temperature`, explicit utility fallback.
    Under the STRICT enrichment policy a missing model is LOUD (an ERROR + a failure-ledger entry,
    never a silent floor); under `soft` the legacy silent no-op stands byte-identical."""
    begin_authoring_run(owner)  # ORW-260: a fresh run re-evaluates from clean (and supersedes any older run still in flight)
    llm_fn = await resolve_authoring_llm_fn(owner)
    if llm_fn is None:
        try:
            from src import enrichment_policy
            strict = enrichment_policy.is_strict()
        except Exception:
            strict = False
        if strict:
            mark_strict_failed(owner)  # ORW-260: no model => no backstories => the game must not start on the floor
            enrichment_policy.record_failure(
                owner, "cast-authoring",
                "no model resolved for the cast-authoring call class — authoring cannot run",
                detail="the deterministic floor must not stand silently under the strict policy")
        else:
            logger.debug("[cast-authoring] no authoring model — keeping the seeded floor")
        return 0
    from src import orwell_engine

    async def _write(profile: dict) -> dict:
        return await orwell_engine.record_cast_profile(profile, user=owner)

    # Only the DEFAULT sink mutates the LIVE cast; a `write` override targets the next-season
    # holding store (which deliberately does not touch the live board), so don't push for it.
    is_live_write = write is None
    written = await author_cast(cast, llm_fn, write or _write, on_authored, user=owner, seed=seed, **({} if is_live_write else {"live_look_sink": False}))
    # #617: enrichment landed on the live game — push a server-side "game-updated" so open pages
    # reconcile now instead of waiting for the next poll. Best-effort/fail-soft.
    if written and is_live_write:
        try:
            from src import orwell_game_session
            orwell_game_session.publish_game_updated(owner)
        except Exception:
            pass
    return written


def kickoff_authoring(cast: list[dict], owner: Optional[str],
                      then: Optional[Callable[[], None]] = None,
                      on_authored: Optional[Callable[[str], None]] = None,
                      write: Optional[WriteFn] = None,
                      seed: Optional[int] = None) -> None:
    """Fire-and-forget: author the cast in the background BEFORE portraits (the authored physical
    facet feeds the portrait prompt — pipeline order), then call `then` (e.g. the portrait kickoff)
    REGARDLESS of authoring success, so the picture still generates from the seeded facets if the
    model was unavailable. Never blocks game start; never raises into the caller.
    The player's identity is NOT passed in — NPC storylines are authored player-independent.

    `on_authored(houseguest_id)` — when supplied — fires after EACH NPC's successful write-back so a
    consumer can gate that one houseguest's portrait the moment it is authored (#7). `then` still
    fires once at the very end (whole-cast done), success or failure, so a whole-cast fallback /
    gate-release can never hang.

    `seed` (T0-6) — thread the season seed through when known, so `author_cast` can mint the
    cast-wide FacetLedger. Absent ⇒ authoring runs without ledger steering (byte-identical to before)."""
    async def _runner():
        try:
            await run_authoring(cast, owner, on_authored, write, seed=seed)
        except Exception as e:  # pragma: no cover - defensive
            logger.warning(f"[cast-authoring] background run failed: {e}")
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


# ── deep-authoring backfill: re-author NPCs still on the deterministic floor ───────────────
# Authoring originally kicked off ONLY from the createCharacter / pre-warm path, fire-and-forget
# with no retry, no backfill, and no observability — so when the utility model was absent/flaky at
# game start, every houseguest stayed a thin deterministic-floor template FOREVER (the anti-"sameness"
# mandate #1 fails silently). This is the SAME reliability spine the 0051 portrait backfill has
# (`orwell_portraits.{missing_portrait_ids,completeness,portrait_completeness,kickoff_backfill}`):
# when the roster is served (or the manual lever / admin lever is pulled) and active NPCs are still
# on the floor, re-author just those NPCs through the existing authoring path and write them back via
# recordCastProfile. No engine change — it reads the engine's own Vault-free `authored` flag.

# A "still on the floor" NPC is one whose Vault-free roster card carries `authored` not-true. The
# flag is the engine's (a parallel engine change adds it to every roster card); the FE only reads it.

AUTHORING_BACKFILL_DEBOUNCE_S = 10 * 60  # one auto-attempt per user per process per window
_LAST_AUTHORING_BACKFILL_AT: dict = {}


def _safe_user(user: Optional[str]) -> str:
    """The per-user debounce key (mirrors orwell_portraits._safe_user) — None ⇒ "default"."""
    return str(user) if user else "default"


def card_missing_story(card: dict, look: bool = False) -> bool:
    """ORW-430: a card marked authored whose public biography or identity is empty, or that lacks a required photo-sheet field (the game-start coherence repair
    clears a contradicting biography and nothing refilled it) is still unfinished: the background retry takes it again."""
    if card.get("biographyDraft") is True or card.get("storyMissing") is True:
        return True  # ORW-438: only genesis's draft stands, or the roster already worked this out from the full card
    if look and card.get("lookMissing") is True:
        return True  # the roster worked out a missing look field from the full card (non-blocking: only the look backfill asks)
    pc = card.get("physicalCharacteristics")
    if "physicalCharacteristics" not in card and not isinstance(pc, dict):
        return False  # a thin stub (no story keys at all) says nothing; a roster card from `_roster_cards` carries the keys (None when absent)
    if not isinstance(pc, dict):
        pc = {}  # a house entry with no look block: the look is missing, the story checks below still run
    if look and look_fields_missing(pc):  # ORW-431: a missing look sub-field is NON-BLOCKING: it asks for a backfill, it never holds the season start
        return True
    bio = card.get("biography")
    ident = card.get("identityConcept")
    return not (isinstance(bio, str) and bio.strip()) or not (isinstance(ident, str) and ident.strip())


def is_genesis_draft_biography(card: dict) -> bool:
    """ORW-438: True only when the engine records that this card's biography is still genesis's nameless first draft
    (`biographyDraft`, set at the genesis commit and cleared when the writer's biography lands). Provenance, never a
    guess from the text, so a real biography is never hidden; a save from before the flag simply lacks it."""
    return isinstance(card, dict) and card.get("biographyDraft") is True and isinstance(card.get("biography"), str)


def unauthored_ids(user: Optional[str], roster_cards: list, *, include_look: bool = False) -> list:
    """ACTIVE NPC ids on the roster still on the DETERMINISTIC FLOOR (deep profile not authored).

    THE one definition of "still floor" — the roster's lazy backfill, the manual lever, the admin
    lever, and the completeness counters all derive from this helper (mirrors
    `orwell_portraits.missing_portrait_ids`). Cast-authoring is NPC-only: the PLAYER is human-authored
    at OOBE, so the player's card is EXCLUDED (it has no deep-profile authoring path). Departed
    houseguests keep whatever they had — no late authoring."""
    out = []
    for card in roster_cards or []:
        if not isinstance(card, dict):
            continue
        if (card.get("status") or "active") != "active":
            continue  # departed houseguests are not re-authored
        if card.get("isPlayer") or card.get("id") == "player":
            continue  # the player's profile is human-authored — NEVER deep-authored here
        hid = card.get("id")
        if hid and (card.get("authored") is not True or card_missing_story(card, look=include_look)):
            out.append(str(hid))
    return out


def authoring_completeness(user: Optional[str], roster_cards: list) -> dict:
    """{total, authored, missing} over the ACTIVE NPC cast (the player is excluded) — operator visibility.

    `missing` comes straight from `unauthored_ids` (the one definition), so the admin Health card,
    the /admin/status page, and any counter can never disagree with what the backfill would act on
    (mirrors `orwell_portraits.completeness`)."""
    active_npcs = [
        c for c in roster_cards or []
        if isinstance(c, dict)
        and (c.get("status") or "active") == "active"
        and c.get("id")
        and not (c.get("isPlayer") or c.get("id") == "player")
    ]
    missing = unauthored_ids(user, roster_cards)
    return {"total": len(active_npcs), "authored": len(active_npcs) - len(missing),
            "missing": len(missing),
            # M1-10: NPCs whose authoring hit the per-season give-up cap — a give-up is visible
            # on /admin/status (the castAuthoring block), never silence.
            "givenUp": giveups(user)}


async def pipeline_cast_for(owner: Optional[str]) -> Optional[dict]:
    """ORW-969: the FULL cast for a server-side casting job, or None when the engine cannot give it.

    ``get_game_state`` lists only the houseguests who have walked in during the premiere (ORW-710); a job that must see every card reads this instead (the engine's unadvertised
    ``pipelineCast``, never sent to the browser or the narrator). Returns the engine's dict (``started``, ``total``, ``unarrivedCount``, ``house``), ``{"started": False}`` for a
    no-game user, and None for ANY failure or an unexpected shape (an engine without the tool, an outage), so every caller can fall back to the met-only read exactly as before."""
    from src import orwell_engine

    try:
        pc = await orwell_engine.pipeline_cast(user=owner)
    except Exception as e:
        logger.info("[cast-authoring] pipeline cast read unavailable for %s: %s", _safe_user(owner), e)
        return None
    if not isinstance(pc, dict):
        return None
    if pc.get("started") is False:
        return {"started": False}
    unarrived = pc.get("unarrivedCount")
    if not isinstance(pc.get("house"), list) or not isinstance(unarrived, int) or isinstance(unarrived, bool):
        return None
    return pc


async def authoring_completeness_for(user: Optional[str]) -> Optional[dict]:
    """{total, authored, missing} for this user's active NPC cast, or None pre-game / engine-down.

    Fetches the SAME Vault-free public projection `orwell_portraits.portrait_completeness` uses and
    derives the cards with the SAME helper (`routes.orwell_routes._roster_cards`, imported lazily —
    routes import this module at load, so the cycle only resolves at call time). Used by the admin
    health surface; best-effort — any failure reads as None, never a 500."""
    from src import orwell_engine

    # ORW-969: read the FULL cast, so every houseguest (arrived or not) is counted and the gate compares the whole cast with the threshold. Unavailable => the met-only read below.
    state = await pipeline_cast_for(user)
    full_cast = state is not None
    if state is None:
        try:
            state = await orwell_engine.get_game_state(user=user)
        except Exception:
            return None
    if not isinstance(state, dict) or state.get("started") is False:
        return None
    try:
        from routes.orwell_routes import roster_cards  # the one roster-card derivation (G9), public
        comp = authoring_completeness(user, roster_cards(state, user))
    except Exception:
        return None
    if full_cast:
        return comp  # the pipeline read: nothing is withheld, so no `unarrived` allowance rides with the counts
    # ORW-948: during the premiere the engine's public read lists only the houseguests who have walked in (ORW-710)
    # and counts the rest in `unarrivedCount`. `total` / `authored` above therefore cover the arrived cast only; the
    # count of the withheld ones rides beside them (a number, never a card) so the house-entry gate does not wait
    # for cards this read cannot show. Absent or zero (the flag off, or everyone is in) leaves the dict as it was.
    unarrived = state.get("unarrivedCount")
    if isinstance(unarrived, int) and not isinstance(unarrived, bool) and unarrived > 0:
        comp["unarrived"] = unarrived
    return comp


def authoring_backfill_allowed(user: Optional[str]) -> bool:
    """True when this user's process-local authoring-backfill debounce window has elapsed."""
    last = _LAST_AUTHORING_BACKFILL_AT.get(_safe_user(user))
    return last is None or (time.time() - last) >= AUTHORING_BACKFILL_DEBOUNCE_S


async def backfill_unauthored(missing_ids: list, user: Optional[str]) -> int:
    """Re-author ONLY the floor NPCs in `missing_ids` and write them back. Returns how many were authored.

    Resolves the LIVE cast (the engine's Vault-free `house` projection — the rich skeleton the
    authoring prompt reads: vocation / archetype / age / heritage), filters to `missing_ids`, and runs
    the existing authoring path (`run_authoring` → `author_cast` → `record_cast_profile`) over that
    subset. Best-effort throughout (never raises): no model / engine-down ⇒ the engine's deterministic
    floor simply stands, exactly like authoring degrades at game start."""
    wanted = {str(h) for h in (missing_ids or [])}
    if not wanted:
        return 0
    from src import orwell_engine

    # ORW-969: the straggler list now includes houseguests who have not walked in yet, so the cast is read in full; unavailable => the met-only read.
    state = await pipeline_cast_for(user)
    if state is None:
        try:
            state = await orwell_engine.get_game_state(user=user)
        except Exception as e:
            logger.info("[cast-authoring] backfill state read failed for %s: %s", _safe_user(user), e)
            return 0
    if not isinstance(state, dict) or state.get("started") is False:
        return 0
    house = state.get("house") if isinstance(state.get("house"), list) else []
    # Re-author ONLY the requested floor NPCs (never the player, never an already-authored NPC).
    subset = [
        hg for hg in house
        if isinstance(hg, dict)
        and (hg.get("id") or hg.get("name"))
        and str(hg.get("id") or hg.get("name")) in wanted
        and (hg.get("id") or hg.get("name")) != "player"
    ]
    if not subset:
        return 0

    def _reshoot(hid):
        # ADR 0013 (2026-07-13): this NPC's authoring JUST landed — (re)shoot its face from the now-
        # authored prompt. This is the LATE-authoring seam (the game-start seams wire their own
        # per-NPC shoots): without it, an NPC authored hours late kept whatever face was shot from
        # the pre-authoring floor — permanently mismatched. The helper discards a stale-fingerprint
        # face first (never carried as an img2img reference) and is fail-soft throughout.
        try:
            from src import orwell_portraits
            orwell_portraits.kickoff_authored_reshoot(hid, user)
        except Exception as e:
            logger.info("[cast-authoring] authored re-shoot kick for %s failed: %s", hid, e)

    written = await run_authoring(subset, user, on_authored=_reshoot)
    logger.info("[cast-authoring] backfill for %s: authored %d/%d requested",
                _safe_user(user), written, len(subset))
    return written


def kickoff_authoring_backfill(missing_ids: list, user: Optional[str], force: bool = False) -> bool:
    """Fire-and-forget deep-authoring backfill; returns True when a run was actually kicked.

    The AUTOMATIC roster-poll path is debounced (at most one attempt per user per process per
    AUTHORING_BACKFILL_DEBOUNCE_S — a failing/absent provider is never hammered). `force=True` is the
    EXPLICIT manual/admin lever: a deliberate click means "run now", so it bypasses the debounce window
    — but still STAMPS it, so an auto-poll seconds later can't pile on (mirrors
    `orwell_portraits.kickoff_backfill`). Never blocks the caller, never raises into it."""
    if not missing_ids:
        return False
    if not force and not authoring_backfill_allowed(user):
        return False
    _LAST_AUTHORING_BACKFILL_AT[_safe_user(user)] = time.time()

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop is not None:
        task = loop.create_task(backfill_unauthored(list(missing_ids), user))

        def _done(t):
            try:
                t.result()
            except Exception as e:  # pragma: no cover - defensive
                logger.warning("[cast-authoring] background backfill error: %s", e)

        task.add_done_callback(_done)
    else:  # non-async callers (tests drive backfill_unauthored directly)
        try:
            __import__("src.llm_core", fromlist=["run_isolated"]).run_isolated(backfill_unauthored(list(missing_ids), user))
        except Exception as e:
            logger.warning("[cast-authoring] sync backfill error: %s", e)
    return True


# ── #1313: the HOUSE-ENTRY authoring gate ────────────────────────────────────────────
#
# THE P0 fix: the game must never START on the deterministic FLOOR cast (0/15 authored). A real
# playtest opened a season at 0/15 because authoring is fail-soft with NO runtime start gate — a
# missing utility model, or a transient authoring failure, silently no-op'd and the floor stood.
#
# The gate HOLDS house entry (in `do_create_character`) until the cast is authored to a threshold,
# but it engages ONLY when authoring can actually run — i.e. a REAL utility model resolves — and the
# operator has not opted out. The reasoning:
#   • No utility model ⇒ authoring can NEVER produce authored identities, so the deterministic floor
#     is the ONLY possible cast; gating there would DEADLOCK game start forever. So the gate is OFF —
#     byte-identical to today (every LLM-stubbed test + a genuinely model-less deploy start instantly).
#   • A real utility model ⇒ authoring CAN and SHOULD run; the gate holds until it lands, retrying via
#     the existing backfill spine, and NEVER silently floor-starts.
# `ORWELL_ALLOW_FLOOR_START=1` is the operator/dev/CI escape hatch: it forces the gate OFF even with a
# model configured (fast starts for record runs / manual dev). This design keeps PROD safe (a model is
# always configured ⇒ gated) and CI deterministic (the suite stubs the LLM ⇒ no model ⇒ ungated, and
# the golden driver sets the hatch explicitly).

HOUSE_READY_MIN_AUTHORED = 15          # of the 15-NPC cast (PO ruling, 2026-07-10: the deterministic
# seeded floor is NEVER a viable cast identity in prod — no NPC may enter the house un-authored, so the
# gate is the FULL cast size, not a tolerance band. Tightened from the earlier >= 13/15 task-spec floor;
# `tests/test_1313_house_entry_gate.py` pins this to the cast's NPC count so a future cast-size change
# can't silently reopen the gap.
_HOUSE_READY_TOTAL_DEFAULT = 15


def _env_float(name: str, default: float) -> float:
    """Parse a float env var, falling back LOUDLY (never raising) on a malformed value — this module
    reads its tunables at import time, so a bad value must never break app startup."""
    raw = str(os.environ.get(name, "") or "").strip()
    if not raw:
        return float(default)
    try:
        return float(raw)
    except (TypeError, ValueError):
        logger.warning("[house-entry-gate] malformed %s=%r — using the default %s",
                       name, raw, default)
        return float(default)


# How long house entry may wait for authoring to land before we give up LOUDLY (env-tunable). The
# happy path returns the instant completeness clears the threshold — only a genuine failure waits it
# out. Kept generous because the no-prewarm path starts all 15 authoring calls at house entry.
_HOUSE_READY_TIMEOUT_S = _env_float("ORWELL_HOUSE_READY_TIMEOUT_S", 180.0)
_HOUSE_READY_POLL_S = _env_float("ORWELL_HOUSE_READY_POLL_S", 2.0)
# 2026-07-13 (fast holding card — no dead air): how long the createCharacter TURN may wait INLINE for
# authoring before returning the "Production is finalizing your casting…" HOLDING card and letting the
# background gate-clear watch own the rest. The old inline wait was the FULL readiness window
# (`_HOUSE_READY_TIMEOUT_S`, ~180s) — the player watched a silent spinning tool for minutes. The PO
# design is card-promptly + background watch: a short grace keeps the common "authoring just finishing"
# case starting on the same turn; anything longer converges through the watch (which clears the marker,
# runs the deferred post-start kicks exactly once, and pushes a game-updated so open pages reconcile).
_HOUSE_READY_INLINE_S = _env_float("ORWELL_HOUSE_READY_INLINE_S", 10.0)
# After a REFUSED entry the background gate-clear watch keeps polling this much longer, so the season
# still opens (and the skipped post-start kicks still run) the moment authoring finally lands.
_HOUSE_READY_WATCH_TIMEOUT_S = _env_float("ORWELL_HOUSE_READY_WATCH_TIMEOUT_S", 1800.0)
# ORW-949: after the long window expires the watch keeps re-checking at this slow interval, so a cast that
# lands late still releases the player without a process restart.
_HOUSE_READY_RECHECK_S = _env_float("ORWELL_HOUSE_READY_RECHECK_S", 60.0)

# The HOLDING/refused marker: which users currently have house entry held (or refused) because the
# cast isn't authored yet. While a user's marker is set, the FE status/state projections OVERLAY
# `started: false` + a `castingHouse` phase (`routes/orwell_routes.py` — the engine season is already
# live internally the moment createCharacter commits, so without the overlay a concurrent status poll
# would report a started game mid-hold). Doubles as the loud, in-process health signal (operator-
# visible; read by tests). Never a silent floor start.
_HOUSE_ENTRY_GATE_BLOCKS: dict = {}


def _checklist_hold(user: Optional[str], held: bool) -> None:
    """ORW-970: mirror the in-process hold marker into the persisted season-start checklist (a no-op without a record; never raises)."""
    try:
        from src import orwell_season_checklist
        orwell_season_checklist.mark_hold(user, held)
    except Exception:
        pass
# One background gate-clear watch per user (exactly-once post-start kicks on clear).
_HOUSE_READY_WATCHES: dict = {}


def house_ready_inline_budget() -> float:
    """The INLINE (in-turn) slice of the readiness wait — how long `do_create_character` may block the
    player's turn before returning the holding card and handing off to the background watch. Bounded to
    the full readiness window so a mis-tuned env value can never make the inline wait LONGER than the
    old inline-everything behavior."""
    return min(_HOUSE_READY_INLINE_S, _HOUSE_READY_TIMEOUT_S)


# ── ORW-260 (Ryne, BDD card 30, option B): the deeper backstories (0058) are REQUIRED, like the cast skeleton ──────────
# "I think if it fails, it fails. I don't want a fallback." Under the DEFAULT strict policy a cast-authoring run that leaves ANY houseguest on the
# deterministic floor (or cannot run at all: no model) latches this, exactly like the genesis strict-failed latch, and the loud pre-finalize gate in
# `do_create_character` refuses to start the game on it. The world snapshot / off-screen detail stay fail-soft (admin alert only). Cleared on a new season
# and at the start of every authoring run.
_STRICT_FAILED: set = set()


def _skey(user: Optional[str]) -> str:
    return str(user) if user else "default"


# Review of #2375: an OLD, slow authoring run that fails after a newer run (a new season, or a retry) finished must not latch the flag against the new cast. Every clear
# bumps the user's run sequence; a run remembers the sequence it started under (a ContextVar, copied into its task) and its failure is ignored once it is superseded.
_RUN_SEQ: dict = {}
_RUN_ID: "contextvars.ContextVar[Optional[int]]" = contextvars.ContextVar("cast_authoring_run", default=None)


def mark_strict_failed(user: Optional[str]) -> None:
    rid = _RUN_ID.get()
    if rid is not None and _RUN_SEQ.get(_skey(user), 0) != rid:
        return  # a superseded run (the season was reset or a newer run started): its failure is not this cast's
    _STRICT_FAILED.add(_skey(user))


def clear_strict_failed(user: Optional[str]) -> None:
    _STRICT_FAILED.discard(_skey(user))
    _RUN_SEQ[_skey(user)] = _RUN_SEQ.get(_skey(user), 0) + 1  # any run still in flight is now superseded


def begin_authoring_run(user: Optional[str]) -> None:
    """A fresh run re-evaluates from clean and owns the current sequence."""
    clear_strict_failed(user)
    _RUN_ID.set(_RUN_SEQ[_skey(user)])


def strict_failed(user: Optional[str]) -> bool:
    """True iff the last cast-authoring run for this user FAILED under the strict policy (a houseguest ended on the floor, or authoring could not run)."""
    return _skey(user) in _STRICT_FAILED


def refusal_message() -> str:
    """The clear, player-visible casting-finalize refusal (strict policy, the deeper backstories failed)."""
    return (
        "Casting can't finalize yet: the houseguests' deeper backstories could not be written, and this game does not start on a generic fallback. "
        "Check the chat model endpoint (Settings → Models) and try again.")


def floor_start_allowed() -> bool:
    """The operator/dev/CI escape hatch: ORWELL_ALLOW_FLOOR_START=1 forces the house-entry gate OFF
    (immediate floor start) even when a utility model is configured. Default absent ⇒ gate governed by
    whether authoring can actually run."""
    return str(os.environ.get("ORWELL_ALLOW_FLOOR_START", "")).strip().lower() in (
        "1", "true", "yes", "on")


async def _utility_model_available(owner: Optional[str]) -> bool:
    """True when a real text/chat AUTHORING model resolves for this user — i.e. cast authoring CAN
    run. Mirrors exactly what `run_authoring` uses (`resolve_authoring_llm_fn` — narration-first with
    the explicit utility fallback, 2026-07-11), so the gate engages iff authoring could actually
    produce authored identities. Fail-soft: any hiccup ⇒ False (ungated)."""
    try:
        fn = await resolve_authoring_llm_fn(owner)
    except Exception:
        return False
    return fn is not None


async def house_entry_gate_active(owner: Optional[str]) -> bool:
    """Whether house entry must be HELD until the cast is authored. ON iff a real utility model
    resolves (authoring can run) AND the operator has not set ORWELL_ALLOW_FLOOR_START=1."""
    if floor_start_allowed():
        return False
    return await _utility_model_available(owner)


def _hold_since(user: Optional[str]) -> float:
    """ORW-971: when this hold began. A re-stamp of a live marker (the readiness result, the expired watch) keeps the first time, so the hold's age never resets."""
    prev = _HOUSE_ENTRY_GATE_BLOCKS.get(_safe_user(user)) or {}
    since = prev.get("since")
    return float(since) if isinstance(since, (int, float)) and not isinstance(since, bool) else time.time()


def house_entry_holds() -> list:
    """ORW-971: every active house-entry hold, for the health snapshot and the doctor. One row per owner: ``{owner, ageS, authored, total, missing, windowS, overdue}``.
    ``overdue`` = held longer than the watch window (`ORWELL_HOUSE_READY_WATCH_TIMEOUT_S`, 1800 s): the cast should have landed by then. Counts and ids only; never cast text."""
    now = time.time()
    rows = []
    for owner, hold in list(_HOUSE_ENTRY_GATE_BLOCKS.items()):
        if not isinstance(hold, dict):
            continue
        began = hold.get("since") if isinstance(hold.get("since"), (int, float)) else hold.get("at")
        age = max(0, int(now - began)) if isinstance(began, (int, float)) else 0
        rows.append({"owner": str(owner), "ageS": age, "authored": hold.get("authored"), "total": hold.get("total"),
                     "missing": hold.get("missing"), "windowS": int(_HOUSE_READY_WATCH_TIMEOUT_S),
                     "overdue": age > _HOUSE_READY_WATCH_TIMEOUT_S})
    return sorted(rows, key=lambda r: -r["ageS"])


def begin_house_entry_hold(user: Optional[str], info: Optional[dict] = None) -> None:
    """Mark that house entry is being HELD for `user` (the gate is awaiting authoring). Set BEFORE
    the readiness wait begins so a concurrent /status or /state poll during the hold reports the
    authoring/holding state instead of a started game (the engine season is already live internally
    the instant createCharacter commits)."""
    try:
        _HOUSE_ENTRY_GATE_BLOCKS[_safe_user(user)] = {
            "state": "authoring", **(info or {}), "at": time.time(), "since": _hold_since(user)}
        _checklist_hold(user, True)
    except Exception:
        pass


def record_house_entry_gate_block(user: Optional[str], info: dict) -> None:
    """Record a LOUD health marker that house entry was refused for `user` (authoring below the
    threshold after the readiness window). Operator-visible; never a silent floor start. The marker
    keeps the status/state overlay reporting the holding state until the gate-clear watch releases."""
    try:
        _HOUSE_ENTRY_GATE_BLOCKS[_safe_user(user)] = {
            "state": "authoring", **(info or {}), "at": time.time(), "since": _hold_since(user)}
        _checklist_hold(user, True)
    except Exception:
        pass


def clear_house_entry_gate_block(user: Optional[str]) -> None:
    """Clear the holding/refused marker once the cast is ready / the game genuinely starts."""
    _HOUSE_ENTRY_GATE_BLOCKS.pop(_safe_user(user), None)
    _checklist_hold(user, False)


def house_entry_gate_status(user: Optional[str]) -> Optional[dict]:
    """The current house-entry HOLD/refusal marker for this user (the status/state overlay + the
    health surface + tests), or None when entry is not being held."""
    return _HOUSE_ENTRY_GATE_BLOCKS.get(_safe_user(user))


def house_ready_watch_active(user: Optional[str]) -> bool:
    """Whether a background house-ready gate-clear WATCH is currently armed for this user
    (admin/debug-bundle visibility). Vault-free: a single boolean."""
    try:
        t = _HOUSE_READY_WATCHES.get(_safe_user(user))
        return t is not None and not t.done()
    except Exception:
        return False


def kickoff_house_ready_watch(owner: Optional[str],
                              on_ready: Optional[Callable[[], None]] = None,
                              *, timeout: Optional[float] = None,
                              poll_interval: Optional[float] = None,
                              recheck_interval: Optional[float] = None) -> bool:
    """After a REFUSED house entry: keep watching authoring in the background and, the moment the
    cast reaches the threshold, CLEAR the holding marker, run the post-start kicks the early holding
    return skipped (`on_ready` — e.g. the 0062 zeitgeist capture) EXACTLY ONCE, and push a server-side
    game-updated so open pages reconcile to the now-open season. One watch per user (a second kick
    while one is armed is a no-op ⇒ the exactly-once guarantee); fire-and-forget, never raises.
    Returns True when a watch was actually armed."""
    k = _safe_user(owner)
    existing = _HOUSE_READY_WATCHES.get(k)
    if existing is not None and not existing.done():
        return False

    def _release(ready: dict) -> None:
        clear_house_entry_gate_block(owner)
        logger.info(
            "[house-entry-gate] gate CLEARED for %s — cast authored %s/%s; opening the "
            "season and running the deferred post-start kicks", k,
            ready.get("authored"), ready.get("total"))
        if on_ready is not None:
            try:
                on_ready()
            except Exception as e:
                logger.warning(
                    "[house-entry-gate] deferred post-start kick failed for %s: %s", k, e)
        try:
            from src import orwell_game_session
            orwell_game_session.publish_game_updated(owner)
        except Exception:
            pass

    async def _watch():
        try:
            ready = await await_house_ready(
                owner,
                timeout=(_HOUSE_READY_WATCH_TIMEOUT_S if timeout is None else timeout),
                poll_interval=poll_interval)
            if ready.get("ready"):
                _release(ready)
            else:
                # Still below the threshold after the long watch window — stay LOUD (the marker
                # stays, the overlay keeps reporting the holding state, the operator sees it).
                logger.error(
                    "[house-entry-gate] watch expired for %s — cast still %s/%s authored; house "
                    "entry remains held (set ORWELL_ALLOW_FLOOR_START=1 to override).", k,
                    ready.get("authored"), ready.get("total"))
                record_house_entry_gate_block(owner, ready)
                try:  # ORW-971: the expired watch is the stuck-hold alert (RED on /admin/status, a FAIL in the doctor)
                    from src import log_rings
                    log_rings.record_soft_failure(
                        "season-start:hold-expired",
                        "house entry still held after the watch window: cast %s/%s authored" % (ready.get("authored"), ready.get("total")),
                        user=owner)
                except Exception:  # failsoft-ok: the alert is bookkeeping, the marker and the error log above stand
                    pass
                # STRICT enrichment policy: the exhausted watch is the REAL "house entry refused"
                # failure (2026-07-13 — it moved here from the createCharacter turn, whose short
                # inline wait now returns the holding card as the NORMAL path, not a failure).
                # Ledger it loudly on the admin surface beside the gate marker. Soft: the error
                # log + marker alone (legacy).
                try:
                    from src import enrichment_policy
                    if enrichment_policy.is_strict():
                        enrichment_policy.record_failure(
                            owner, "cast-authoring",
                            f"house entry refused — cast only {ready.get('authored')}/"
                            f"{ready.get('total')} authored after the readiness window")
                except Exception:
                    pass
                # ORW-949: an expired watch used to keep the hold until a restart. Keep re-checking slowly
                # (one poll per round) until the cast is ready or someone else clears the marker.
                gap = _HOUSE_READY_RECHECK_S if recheck_interval is None else recheck_interval
                while house_entry_gate_status(owner) is not None:
                    await asyncio.sleep(max(0.0, float(gap)))
                    if house_entry_gate_status(owner) is None:
                        break
                    ready = await await_house_ready(owner, timeout=0, poll_interval=poll_interval)
                    if ready.get("ready"):
                        _release(ready)
                        break
        except Exception as e:  # noqa: BLE001 - background helper never raises
            logger.warning("[house-entry-gate] watch failed for %s: %s", k, e)
        finally:
            if _HOUSE_READY_WATCHES.get(k) is task_ref[0]:
                _HOUSE_READY_WATCHES.pop(k, None)

    task_ref: list = [None]
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return False  # no running loop (sync caller / test) — the manual/admin levers still apply
    task = loop.create_task(_watch())
    task_ref[0] = task
    _HOUSE_READY_WATCHES[k] = task
    return True


async def await_house_ready(owner: Optional[str], *, min_authored: int = HOUSE_READY_MIN_AUTHORED,
                            timeout: Optional[float] = None,
                            poll_interval: Optional[float] = None) -> dict:
    """Poll authoring completeness until >= `min_authored` of the active NPC cast is deep-authored,
    kicking the existing backfill spine for any stragglers, up to `timeout` seconds. Returns
    ``{ready, authored, total, missing}``. NON-BLOCKING (``asyncio.sleep`` between polls) and never
    raises — a read failure simply keeps polling until the deadline."""
    timeout = _HOUSE_READY_TIMEOUT_S if timeout is None else timeout
    poll_interval = _HOUSE_READY_POLL_S if poll_interval is None else poll_interval
    deadline = time.monotonic() + max(0.0, float(timeout))
    last = {"ready": False, "authored": 0, "total": _HOUSE_READY_TOTAL_DEFAULT,
            "missing": _HOUSE_READY_TOTAL_DEFAULT}
    while True:
        comp = None
        try:
            comp = await authoring_completeness_for(owner)
        except Exception:
            comp = None
        if isinstance(comp, dict):
            authored = int(comp.get("authored") or 0)
            total = int(comp.get("total") or _HOUSE_READY_TOTAL_DEFAULT)
            missing_n = int(comp.get("missing") if comp.get("missing") is not None
                            else max(0, total - authored))
            # ORW-948: the threshold is the FULL cast, but while the premiere's entrances run the read above shows only
            # the houseguests who have arrived (`unarrived` = how many it withholds). Comparing the arrived count to
            # the full-cast threshold could never pass (prod, 2026-11-26: 7 of 7 arrived cards authored, 8 still to
            # walk in, held against 15 until the watch expired and kept the hold). The withheld cards cannot be read
            # here, so they come off the threshold: every houseguest this read CAN show must be authored. A later
            # arrival that is still on the floor is picked up by the roster backfill the moment its card appears.
            unarrived = comp.get("unarrived")
            unarrived = unarrived if isinstance(unarrived, int) and not isinstance(unarrived, bool) and unarrived > 0 else 0
            need = max(0, int(min_authored) - unarrived)
            last = {"ready": authored >= need, "authored": authored,
                    "total": total, "missing": missing_n}
            if unarrived:
                last["unarrived"] = unarrived
            if authored >= need:
                return last
            # Nudge the stragglers through the existing (debounced, fail-soft) backfill spine so a
            # transient per-NPC authoring miss is re-attempted while we wait.
            try:
                await _kick_backfill_for_stragglers(owner)
            except Exception:
                pass
        if time.monotonic() >= deadline:
            return last
        await asyncio.sleep(max(0.05, float(poll_interval)))


async def _kick_backfill_for_stragglers(owner: Optional[str]) -> None:
    """Best-effort: re-author the NPCs still on the floor via the existing backfill spine."""
    from src import orwell_engine
    state = await pipeline_cast_for(owner)  # ORW-969: the full cast; unavailable => the met-only read
    if state is None:
        try:
            state = await orwell_engine.get_game_state(user=owner)
        except Exception:
            return
    if not isinstance(state, dict) or state.get("started") is False:
        return
    try:
        from routes.orwell_routes import roster_cards
        missing_ids = unauthored_ids(owner, roster_cards(state, owner))
    except Exception:
        missing_ids = []
    if missing_ids:
        kickoff_authoring_backfill(missing_ids, owner)
