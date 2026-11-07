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


# ── the producer-framed authoring prompt ──────────────────────────────────────
#
# ANTI-SYCOPHANCY (mandate #3): an NPC's STORYLINE is authored as if the player does not exist.
# Each houseguest is one of sixteen with their OWN life, rivalries, secrets, and arcs — most of the
# house's drama has nothing to do with the player. The authoring prompt therefore carries NO player
# identity at all: secrets/goals/weakness/biography must NEVER be built around, reference, or revolve
# around the player. The NPC's Day-1 read of the player is a SEPARATE concept owned entirely by the
# engine's seeded, net-zero-balanced floor (the LLM does not author it) — so the authored storyline
# cannot tilt the cast toward the player and the calibration (juryReach) balance is preserved.
_SYSTEM = (
    "You are a Big Brother CASTING PRODUCER building the secret bible for ONE houseguest. "
    "Write a rich, believable, reality-TV-plausible person with real depth and a life that exists "
    "ENTIRELY on its own. Output STRICT JSON only (no prose around it), with these keys:\n"
    '  "name": KEEP the houseguest\'s CURRENT name from the skeleton EXACTLY — their identity is already '
    "cast; do NOT rename or re-invent them. ONLY when the skeleton carries no name, supply a realistic, "
    "common, pronounceable FIRST and LAST name (two words), diverse and ordinary, NEVER invented/fantasy/"
    "gibberish.\n"
    '  "biography": a 2-3 sentence presentable backstory (life outside the house),\n'
    '  "vocation": echo the skeleton\'s occupation EXACTLY — it is already cast and IMMUTABLE; do NOT '
    "change it, and do NOT adopt a different job from the biography. The biography and the secrets must "
    "name the SAME job as the committed occupation (the engine keys the hidden stakes off vocation),\n"
    '  "physicalCharacteristics": { "heightBuild", "skinTone", "hair", "facialFeatures", '
    '"distinguishingMark", "ageLook", "style" } — short phrases; this single facet is what BOTH '
    "the portrait and the narration read, so make it concrete and distinctive. The look must COHERE "
    "with the houseguest's heritage/ethnicity in the skeleton (skin tone, hair, features that fit that "
    "background) — never a generic default; vary it widely across the cast. When the skeleton shows a "
    "seeded physicalCharacteristics block, treat it as the LOOK BRIEF to sharpen — enrich each axis in "
    "your own words but keep it the SAME person. THE INK BUDGET IS FIXED: if the brief's "
    "distinguishingMark carries no tattoo, this houseguest has NO visible tattoos anywhere (not in the "
    "mark, the style, or the biography) — only a small minority of a real cast is visibly inked, and "
    "the casting office already decided who. A distinguishingMark is usually minor or absent: a scar, "
    "a birthmark, freckles, glasses, jewelry, a gap-toothed grin — or plain \"none notable\"; never "
    "default to a tattoo,\n"
    '  "voice": the houseguest\'s IDIOLECT — how THIS person talks, all season: { "register", '
    '"rhythm", "energy", "directness", "humor", "stressTell", "signature", "lexicon", "catchphrases" }. '
    'The first six are SHORT dial phrases (e.g. register "folksy", rhythm "rambling", humor "dry", '
    'stressTell "over-explains"); "signature" is ONE prose sentence capturing the texture of their talk; '
    '"lexicon" is an array of 2-3 habitual filler words/phrases; "catchphrases" is an array of 2-3 '
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
    "OUTPUT CONTRACT (HARD, #1002): reply with a SINGLE raw JSON object and NOTHING else — no prose, "
    "no markdown, no ```json fences, no preamble, no chain-of-thought in the body. The first character "
    "of your reply MUST be '{' and the last MUST be '}'. JSON only."
)

# #1002: the OpenAI/OpenRouter structured-output request — threaded onto the authoring call so a model
# that honours it returns strict JSON (no prose/reasoning leaking into the body). A provider that
# ignores it is harmless: the prompt reinforcement above + the one-shot retry below still apply.
_RESPONSE_FORMAT = {"type": "json_object"}

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


async def _bounded_stream(agen, wall_clock_s: float = _AUTHORING_STREAM_WALL_CLOCK_S):
    """Wrap an async generator with a hard WALL-CLOCK ceiling over the WHOLE iteration — every chunk,
    every internal retry/fallback candidate the generator itself tries — not a per-chunk read timeout
    (see `_AUTHORING_STREAM_WALL_CLOCK_S`). On expiry the source generator is closed (best-effort) and
    ``asyncio.TimeoutError`` is raised; a clean end-of-stream (``StopAsyncIteration``) simply ends
    iteration as normal. A generator that finishes well inside the budget is byte-identical."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + wall_clock_s
    it = agen.__aiter__()
    try:
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                raise asyncio.TimeoutError(
                    f"authoring stream exceeded its {wall_clock_s}s wall-clock ceiling")
            try:
                chunk = await asyncio.wait_for(it.__anext__(), timeout=remaining)
            except StopAsyncIteration:
                return
            yield chunk
    finally:
        aclose = getattr(agen, "aclose", None)
        if aclose is not None:
            try:
                await aclose()
            except Exception:
                pass


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
_BIO_MIN_CHARS = 80          # a coherent presentable backstory is more than a clause
_BIO_MIN_SENTENCES = 2       # >= 2 sentence terminators [.!?]
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


# ── ORW-184: reason codes + per-dial repair (behind ORWELL_VOICE_REPAIR, default OFF) ─────────────────
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
    """ORW-184 flag: `ORWELL_VOICE_REPAIR=1|true|yes|on` turns on reason codes + per-dial repair."""
    return str(os.environ.get(_VOICE_REPAIR_FLAG, "")).strip().lower() in ("1", "true", "yes", "on")


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
        if bio and (_ELDER_LIFE_STAGE.search(bio) or _LONG_CAREER.search(bio)):
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
        for k in ("name", "age", "vocation", "hometown", "archetype", "demeanor", "presentation", "appearance", "ethnicity", "genderPresentation", "voice", "physicalCharacteristics")
        if npc.get(k) is not None
    }
    gp = npc.get("genderPresentation")
    pronoun_rule = (
        f" This houseguest's PINNED gender presentation is '{gp}' — every self-reference in the biography, "
        f"secrets, true goals, and weakness MUST use the matching pronouns and never the opposite; the "
        f"pinned identity is immutable, do not re-gender {name}."
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
            rendered = render_hand(hand)
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
        if parts:
            taken_rule = ("\nCAST-WIDE TAKEN LIST (the other houseguests occupy this ground — do NOT "
                          "duplicate it or drift this houseguest toward it): " + "; ".join(parts) + ".")
    user = (
        f"Houseguest to flesh out: {name}.\n"
        f"Public skeleton (build FROM this, never contradict it): {json.dumps(skeleton, ensure_ascii=False)}\n"
        f"Ground {name}'s secrets, true goals, and weakness in THIS skeleton — their specific occupation, "
        f"archetype, age, and backstory — so the hidden life reads like THIS exact person and no one else."
        f"{immutable_rule}"
        f"{pronoun_rule}"
        f"{hand_rule}"
        f"{taken_rule}\n"
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


async def author_cast(cast: list[dict], llm_fn: LlmFn, write_fn: WriteFn,
                      on_authored: Optional[Callable[[str], None]] = None,
                      *, concurrency: int = _AUTHOR_CONCURRENCY,
                      user: Optional[str] = None,
                      seed: Optional[int] = None,
                      hands: Optional[dict] = None) -> int:
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

    def _taken_for(hid: str) -> dict:
        """The cast-wide taken-list for one houseguest: the OTHER houseguests' actually-COMMITTED
        vocation/hometown (read straight off the roster — genesis already settled these; a per-NPC
        deep-authoring call can't see its siblings otherwise)."""
        return {
            "vocations": [n.get("vocation") for n in (cast or [])
                         if isinstance(n, dict) and str(n.get("id")) != hid and n.get("vocation")],
            "hometowns": [n.get("hometown") for n in (cast or [])
                         if isinstance(n, dict) and str(n.get("id")) != hid and n.get("hometown")],
        }
    # #1057: SERIALIZE the engine write-back. The per-NPC recordCastProfile write-backs collide on the
    # orchestrator integrity checkpoint when they run concurrently (the live-verify's 3 `degradation`
    # refusals dropped good profiles). A single-flight lock funnels every write-back through one at a time
    # — authoring still parallelizes the (slow) LLM calls, only the (fast) commit is serialized.
    write_lock = asyncio.Lock()
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
            # ORW-184 (ORWELL_VOICE_REPAIR, default off ⇒ this block is skipped and everything below is
            # byte-identical): mend the authored voice PER FIELD before the lint, so one bad dial or one bad
            # optional entry no longer costs the whole voice. A mended voice is still a recorded fault
            # (#1599: a correction is not a cloak), as auto-corrected. An unmendable one falls through to the
            # lint below, which drops it whole as before, now with its reason codes.
            voice_note = ""
            if voice_repair_enabled() and isinstance(profile.get("voice"), dict):
                from src.orwell_voice_repair import format_actions, format_reasons
                repair = repair_authored_voice(profile, npc)
                if repair.repaired:
                    profile["voice"] = repair.voice
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
            dropped = coherence_conflicts(profile, npc)
            if dropped:
                for k in dropped:
                    profile.pop(k, None)
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
                if len(profile) <= 1:
                    floor_below += 1
                    return 0
            # F1 (#1660): roster-constrained authoring — drop any authored STRUCTURED identity field
            # (vocation / genderPresentation / age) that CONTRADICTS the committed roster's immutable
            # value, so the committed identity STANDS (authored fields EXTEND, never OVERWRITE). This is
            # the "occupation-crosswired" complement to F2's prose lint. RED-recorded via log_rings
            # (#1599 — a real fault surfaced even when auto-corrected), Vault-free (field names only).
            id_drop = identity_contradictions(profile, npc)
            if id_drop:
                # F5 (#1660): a crosswired vocation means the hidden threads (secrets/goals/weakness),
                # authored in the SAME call, were grounded in the WRONG job — compute them BEFORE the
                # vocation is popped so they are re-derived by the engine off the committed vocation.
                secret_drop = secret_vocation_conflicts(profile, npc)
                for k in id_drop:
                    profile.pop(k, None)
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
                        profile.pop(k, None)
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
                if len(profile) <= 1:
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
                if retried_profile is not None and not facet_hand_conflicts(retried_profile, npc):
                    profile = retried_profile  # the regenerate ADOPTED the dealt hand cleanly
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
        # The write-back landed — signal this one NPC's completion so its portrait can shoot now (#7).
        if on_authored is not None:
            try:
                on_authored(hid)
            except Exception as e:  # pragma: no cover - defensive: a gate callback must never abort
                logger.warning(f"[cast-authoring] on_authored({hid}) failed: {e}")
        return 1

    results = await asyncio.gather(*[_author_one(npc) for npc in (cast or [])])
    written = sum(results)
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

async def _resolve_llm_fn(owner: Optional[str], *, prefix: str = "utility",
                          fallbacks_key: str = "utility",
                          include_utility_fallback: bool = False,
                          temperature: Optional[float] = None,
                          min_output_tokens: Optional[int] = None) -> Optional[LlmFn]:
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
        # #1002: request strict JSON (response_format) so a model that honours it can't leak prose/
        # reasoning into the body. Threads through stream_llm_with_fallback → stream_llm onto the
        # OpenAI-style payload; a provider that ignores it is harmless (the strict prompt + the one-shot
        # retry in author_cast still apply). The policy already supplies the (raised, #1002) token budget.
        # #1713: bounded to a hard wall-clock ceiling (see `_bounded_stream`) — a JSON-authoring call
        # must fail fast under contention, never ride the narration-sized 300s default. The ceiling is
        # passed explicitly (read from the module global at CALL time, not `_bounded_stream`'s default
        # parameter — a default is bound once at function-definition time) so a runtime override of
        # `_AUTHORING_STREAM_WALL_CLOCK_S` (e.g. a test, or a future admin knob) actually takes effect.
        async for chunk in _bounded_stream(stream_llm_with_fallback(
            candidates, messages, temperature=_temperature, policy=_policy,
            max_tokens=cap, response_format=_RESPONSE_FORMAT), wall_clock_s=_AUTHORING_STREAM_WALL_CLOCK_S):
            # stream_llm yields SSE-ish data lines; keep only the assistant text deltas.
            piece = _delta_text(chunk)
            if piece:
                parts.append(piece)
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
                                "reasoning_tokens": _ud.get("reasoning_tokens", 0) or 0,
                                "cost": _ud.get("cost"),
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
                )
            except Exception:
                pass
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
        text, finish, reasoning = await _once(messages, _max_tokens)
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
            retry_text, _retry_finish, retry_reasoning = await _once(messages, retry_cap)
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
    llm_fn = await resolve_authoring_llm_fn(owner)
    if llm_fn is None:
        try:
            from src import enrichment_policy
            strict = enrichment_policy.is_strict()
        except Exception:
            strict = False
        if strict:
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
    written = await author_cast(cast, llm_fn, write or _write, on_authored, user=owner, seed=seed)
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


def unauthored_ids(user: Optional[str], roster_cards: list) -> list:
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
        if hid and card.get("authored") is not True:
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


async def authoring_completeness_for(user: Optional[str]) -> Optional[dict]:
    """{total, authored, missing} for this user's active NPC cast, or None pre-game / engine-down.

    Fetches the SAME Vault-free public projection `orwell_portraits.portrait_completeness` uses and
    derives the cards with the SAME helper (`routes.orwell_routes._roster_cards`, imported lazily —
    routes import this module at load, so the cycle only resolves at call time). Used by the admin
    health surface; best-effort — any failure reads as None, never a 500."""
    from src import orwell_engine

    try:
        state = await orwell_engine.get_game_state(user=user)
    except Exception:
        return None
    if not isinstance(state, dict) or state.get("started") is False:
        return None
    try:
        from routes.orwell_routes import roster_cards  # the one roster-card derivation (G9), public
        return authoring_completeness(user, roster_cards(state, user))
    except Exception:
        return None


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

# The HOLDING/refused marker: which users currently have house entry held (or refused) because the
# cast isn't authored yet. While a user's marker is set, the FE status/state projections OVERLAY
# `started: false` + a `castingHouse` phase (`routes/orwell_routes.py` — the engine season is already
# live internally the moment createCharacter commits, so without the overlay a concurrent status poll
# would report a started game mid-hold). Doubles as the loud, in-process health signal (operator-
# visible; read by tests). Never a silent floor start.
_HOUSE_ENTRY_GATE_BLOCKS: dict = {}
# One background gate-clear watch per user (exactly-once post-start kicks on clear).
_HOUSE_READY_WATCHES: dict = {}


def house_ready_inline_budget() -> float:
    """The INLINE (in-turn) slice of the readiness wait — how long `do_create_character` may block the
    player's turn before returning the holding card and handing off to the background watch. Bounded to
    the full readiness window so a mis-tuned env value can never make the inline wait LONGER than the
    old inline-everything behavior."""
    return min(_HOUSE_READY_INLINE_S, _HOUSE_READY_TIMEOUT_S)


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


def begin_house_entry_hold(user: Optional[str], info: Optional[dict] = None) -> None:
    """Mark that house entry is being HELD for `user` (the gate is awaiting authoring). Set BEFORE
    the readiness wait begins so a concurrent /status or /state poll during the hold reports the
    authoring/holding state instead of a started game (the engine season is already live internally
    the instant createCharacter commits)."""
    try:
        _HOUSE_ENTRY_GATE_BLOCKS[_safe_user(user)] = {
            "state": "authoring", **(info or {}), "at": time.time()}
    except Exception:
        pass


def record_house_entry_gate_block(user: Optional[str], info: dict) -> None:
    """Record a LOUD health marker that house entry was refused for `user` (authoring below the
    threshold after the readiness window). Operator-visible; never a silent floor start. The marker
    keeps the status/state overlay reporting the holding state until the gate-clear watch releases."""
    try:
        _HOUSE_ENTRY_GATE_BLOCKS[_safe_user(user)] = {
            "state": "authoring", **(info or {}), "at": time.time()}
    except Exception:
        pass


def clear_house_entry_gate_block(user: Optional[str]) -> None:
    """Clear the holding/refused marker once the cast is ready / the game genuinely starts."""
    _HOUSE_ENTRY_GATE_BLOCKS.pop(_safe_user(user), None)


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
                              poll_interval: Optional[float] = None) -> bool:
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

    async def _watch():
        try:
            ready = await await_house_ready(
                owner,
                timeout=(_HOUSE_READY_WATCH_TIMEOUT_S if timeout is None else timeout),
                poll_interval=poll_interval)
            if ready.get("ready"):
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
            else:
                # Still below the threshold after the long watch window — stay LOUD (the marker
                # stays, the overlay keeps reporting the holding state, the operator sees it).
                logger.error(
                    "[house-entry-gate] watch expired for %s — cast still %s/%s authored; house "
                    "entry remains held (set ORWELL_ALLOW_FLOOR_START=1 to override).", k,
                    ready.get("authored"), ready.get("total"))
                record_house_entry_gate_block(owner, ready)
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
            last = {"ready": authored >= min_authored, "authored": authored,
                    "total": total, "missing": missing_n}
            if authored >= min_authored:
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
