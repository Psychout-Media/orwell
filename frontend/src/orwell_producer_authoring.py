"""Issue #1626 (increment 3, FE lane) — DEEPEN the off-camera casting PRODUCER persona.

The engine seeds a deterministic producer at season creation — a stable NAME (the byline) plus a thin
``archetype`` / ``demeanor`` / ``disposition`` / ``wit`` / ``quirk`` / ``backstory`` floor. This module
is the FE-owned utility-LLM driver that DEEPENS that persona ONCE with a richer authored overlay written
BACK via ``recordProducerProfile`` — the mirror of the 0058 cast-authoring handshake
(``orwell_cast_authoring``), scaled to the single producer:

    engine seeds the deterministic producer floor
      → the FE utility-LLM authors a richer backstory / temperament / demeanor / disposition / wit / quirk
      → the FE writes it back via recordProducerProfile (the engine validates OPEN-SET voice PROSE only,
        strips any Vault/stat vocabulary, ACCUMULATES onto the seeded floor, and NEVER changes the
        seeded NAME)
      → the engine is now the source of truth.

Hard rules (mirror ``orwell_cast_authoring`` / #1626):
  * the seeded NAME is NEVER changed — the byline stays byte-stable (we never even send one; the engine
    ignores a ``name`` field anyway);
  * Vault-free BY CONSTRUCTION — no stat / number / hidden field is authored (the engine strips any that
    slips through regardless);
  * best-effort + background — no model/provider ⇒ the engine's seeded floor simply STANDS (an
    expected-empty, not a failure); a REAL error is logged, never swallowed silently (#1599), but never
    raised into the caller (game start must never block on it).

The orchestrator (``author_producer``) takes INJECTED deps (``llm_fn`` / ``write_fn``) so the whole lane
is unit-testable without a live model or engine, exactly like ``orwell_zeitgeist.capture_zeitgeist``.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Awaitable, Callable, Optional, Union

logger = logging.getLogger(__name__)

# The OPEN-SET public-voice fields the engine's recordProducerProfile accepts (everything else — a
# name, any stat/number/hidden field — is dropped before write-back; the engine also strips forbidden
# Vault vocabulary again in `validateProducerProfile`). Kept in lockstep with the engine's
# `PRODUCER_OVERLAY_FIELDS` (src/engine/producerPersona.ts). `name` is DELIBERATELY absent — the byline
# is seeded and immovable, so we never author or send one.
_OVERLAY_KEYS = ("archetype", "demeanor", "disposition", "wit", "quirk", "backstory")

# Length floors: a real authored field is more than a stray word (thin values are dropped so the richer
# seeded floor stands — the engine keeps any field the overlay omits). The engine length-caps on its side.
_FIELD_MIN_CHARS = 8
_BACKSTORY_MIN_CHARS = 40

# Per-user in-flight guard so two rapid createCharacter calls never double-author the same producer.
_IN_FLIGHT: set[str] = set()

# The resolved completion fn accepts EITHER a chat `list[dict]` or a single prompt string (normalized
# inside orwell_cast_authoring._resolve_llm_fn) — mirror that type so the shared resolver drops straight in.
LlmFn = Callable[[Union[str, list]], Awaitable[str]]
WriteFn = Callable[[dict], Awaitable[dict]]


def _key(user: Optional[str]) -> str:
    return user or "default"


# ── the producer-framed authoring prompt ──────────────────────────────────────
#
# The producer is OFF-CAMERA and player-facing only through the casting room / the diary-room framing —
# a distinct, believable reality-TV casting producer with real depth, authored as PUBLIC voice PROSE
# (facts to VOICE, ADR 0003), never a stat or hidden game weight. We NEVER author a name (the byline is
# seeded + immovable) and NEVER a number (Vault-free by construction; the engine strips any anyway).
_SYSTEM = (
    "You are writing the persona bible for the OFF-CAMERA casting PRODUCER of a Big Brother-style "
    "reality show — the shrewd, seen-it-all voice behind the casting desk who probes and frames the "
    "player, but is never a houseguest and never on camera. Author a rich, believable, distinctive "
    "person with real depth. Output STRICT JSON only (no prose around it), with any of these keys "
    "(every one OPTIONAL — omit a key rather than pad it):\n"
    '  "archetype": their CORE temperament / register in a short phrase (who they are underneath),\n'
    '  "demeanor": their observable demeanor / voice register,\n'
    '  "disposition": their strategic read on running a casting room — the lens they probe a player through,\n'
    '  "wit": their calculated, deliberate WIT style,\n'
    '  "quirk": one small, distinct verbal quirk that colors their voice consistently,\n'
    '  "backstory": 2-3 sentences on who this producer is and how they came to the casting desk.\n'
    "Hard rules: this is PUBLIC voice only — NO name (the byline is fixed), NO stats, NO numbers, NO "
    "hidden game state; ground everything in a specific, real, reality-TV-plausible person, not a "
    "generic warm host. "
    "OUTPUT CONTRACT (HARD): reply with a SINGLE raw JSON object and NOTHING else — no prose, no "
    "markdown, no ```json fences, no preamble. The first character MUST be '{' and the last '}'."
)

# #1002-style structured-output request — threaded onto the call so a compliant model returns strict JSON.
_RESPONSE_FORMAT = {"type": "json_object"}

# The one-shot reparse retry instruction — a reasoning model can wrap the object in commentary; when the
# first reply yields no JSON we retry ONCE, maximally strict, before falling back to the seeded floor.
_STRICT_RETRY = (
    "Your previous reply did not contain a parseable JSON object. Reply now with ONLY the JSON object "
    "for the producer persona — start with '{', end with '}', no prose, no markdown, no fences."
)


def build_authoring_messages(producer: Optional[dict] = None) -> list[dict]:
    """The producer-deepening prompt. `producer` (optional) is the engine's Vault-free seeded skeleton —
    when present we hand the model the seeded NAME + any seeded facets as the BRIEF to sharpen (never a
    script to copy, and never a name to change). Returns chat messages for the utility model."""
    brief = ""
    if isinstance(producer, dict) and producer:
        # Only the public voice facets — no hidden/stat field can be present (the engine's projection is
        # Vault-free), but be defensive and forward only the known open-set keys + the seeded name.
        skeleton = {k: producer.get(k) for k in ("name",) + _OVERLAY_KEYS if producer.get(k)}
        if skeleton:
            brief = (
                "Deepen this seeded producer (build FROM it, never contradict it, NEVER change the name): "
                f"{json.dumps(skeleton, ensure_ascii=False)}\n"
            )
    user = brief + "Write the producer's persona bible as JSON now — richer backstory, temperament, and voice."
    return [{"role": "system", "content": _SYSTEM}, {"role": "user", "content": user}]


def _balanced_json_object(text: str) -> Optional[str]:
    """Return the first top-level balanced ``{...}`` substring in `text` (string-aware so braces inside
    JSON string literals are ignored), surviving a prose preamble/epilogue. None when there is none."""
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
                    return text[start:i + 1]
    return None


def _extract_json(text: str) -> Optional[dict]:
    """Pull the first usable JSON OBJECT out of the model's reply — robust to prose-wrapped output.
    Tries a ```json … ``` fence first, then the first balanced ``{…}`` span. None when nothing parses."""
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fenced:
        try:
            obj = json.loads(fenced.group(1))
            if isinstance(obj, dict):
                return obj
        except (ValueError, TypeError):
            pass
    candidate = _balanced_json_object(text)
    if candidate is not None:
        try:
            obj = json.loads(candidate)
            if isinstance(obj, dict):
                return obj
        except (ValueError, TypeError):
            return None
    return None


def parse_authored_producer(text: str) -> dict:
    """Parse the LLM's reply into a ``recordProducerProfile`` overlay, keeping ONLY the open-set voice
    keys, coercing each to a trimmed string, and dropping trivially-short / blank / unknown fields (so a
    degraded value never overwrites the richer seeded floor — the engine keeps any omitted field). Never
    forwards a ``name`` (the byline is seeded + immovable). Returns ``{}`` when nothing usable parsed
    (⇒ no write-back; the seeded floor stands)."""
    obj = _extract_json(text)
    if obj is None:
        return {}
    out: dict = {}
    for k in _OVERLAY_KEYS:
        v = obj.get(k)
        if not isinstance(v, str):
            continue
        val = " ".join(v.split())  # collapse whitespace/newlines to clean prose
        floor = _BACKSTORY_MIN_CHARS if k == "backstory" else _FIELD_MIN_CHARS
        if len(val) >= floor:
            out[k] = val
    # `name` and any unknown key are intentionally NEVER forwarded — the byline is seeded + immovable.
    return out


async def author_producer(llm_fn: LlmFn, write_fn: WriteFn, *,
                          producer: Optional[dict] = None) -> dict:
    """Orchestrate: build the producer prompt → `llm_fn` → parse → `write_fn` (recordProducerProfile).
    Injected deps make the whole lane testable without a live model or engine. Best-effort + fail-soft:
    a one-shot strict-JSON reparse on a prose reply, then — if nothing usable authored — NO write-back
    (the seeded floor stands). Returns the write-back result (``{accepted, fields, ...}``) or
    ``{"accepted": False, "reason": ...}``. NEVER raises."""
    messages = build_authoring_messages(producer)
    try:
        text = await llm_fn(messages)
    except Exception as e:  # failsoft-ok: handled-by-terminal (run_authoring records llm-failed RED via log_rings.record_soft_failure)
        logger.warning("[producer-authoring] synthesis failed: %s", e)
        return {"accepted": False, "reason": "llm-failed"}
    overlay = parse_authored_producer(text or "")
    if not overlay:
        # A NON-empty body with no JSON object (genuine prose) ⇒ one strict-JSON reparse before the floor.
        if _extract_json(text or "") is None and (text or "").strip():
            logger.info("[producer-authoring] no JSON in reply — retrying once with a strict JSON-only instruction")
            try:
                text = await llm_fn(messages + [{"role": "user", "content": _STRICT_RETRY}])
            except Exception as e:  # failsoft-ok: handled-by-terminal (run_authoring records llm-failed RED via log_rings.record_soft_failure)
                logger.warning("[producer-authoring] strict-JSON retry failed: %s", e)
                return {"accepted": False, "reason": "llm-failed"}
            overlay = parse_authored_producer(text or "")
    if not overlay:
        return {"accepted": False, "reason": "no-fields"}
    try:
        return await write_fn(overlay)
    except Exception as e:  # failsoft-ok: handled-by-terminal (run_authoring records write-failed RED via log_rings.record_soft_failure)
        logger.warning("[producer-authoring] write-back failed: %s", e)
        return {"accepted": False, "reason": "write-failed"}


# ── the live wiring (best-effort, background; graceful no-op when no model) ────

async def run_authoring(owner: Optional[str]) -> dict:
    """Resolve the live deps and deepen the producer. Silent no-op (not accepted) when no model resolves
    — the engine's seeded producer floor then stands byte-identically, exactly like when no provider is
    configured. The producer is player-INDEPENDENT (the same off-camera voice for everyone); the player's
    identity is never threaded in. Never raises."""
    try:
        # Reuse the SHARED background-utility completion resolver (the same one zeitgeist / off-screen
        # texture use) — an image-only / absent endpoint resolves to None ⇒ a clean no-op. BOTH the
        # import AND the resolve share ONE logged boundary: a resolver/config error must NOT escape
        # (run_authoring promises never to raise) and must NOT be mislabeled "no-model" (#1599 — a real
        # failure is logged + given a distinct reason; only a resolved None is the expected no-model).
        from src.orwell_cast_authoring import _resolve_llm_fn
        llm_fn = await _resolve_llm_fn(owner)
    except Exception as e:  # noqa: BLE001 — fail-soft background driver: never raise
        logger.warning("[producer-authoring] utility-model resolution failed: %s", e)
        # #1599: a RAISED resolver is a genuine fault (distinct from a resolved None = expected
        # no-model) — surface it RED; the seeded producer floor stands (auto-corrected).
        try:
            from src import log_rings
            log_rings.record_soft_failure("producer:resolver-failed", e,
                                          corrected="seeded-producer-floor", user=owner)
        except Exception:  # pragma: no cover — failsoft-ok: recorder-self
            pass
        return {"accepted": False, "reason": "resolver-failed"}
    if llm_fn is None:
        logger.debug("[producer-authoring] no utility model — keeping the seeded producer floor")
        return {"accepted": False, "reason": "no-model"}
    from src import orwell_engine

    async def _write(overlay: dict) -> dict:
        return await orwell_engine.record_producer_profile(overlay, user=owner)

    result = await author_producer(llm_fn, _write)
    # #1599: a GENUINE producer-authoring failure (the model call RAISED, or the engine REFUSED the
    # write-back) shows RED on /admin/status — the seeded producer floor stands (auto-corrected),
    # never a silent skip. Expected-empty reasons (no-model / no-fields) are normal flow, no alarm.
    if isinstance(result, dict) and not result.get("accepted") \
            and result.get("reason") in ("llm-failed", "write-failed"):
        try:
            from src import log_rings
            log_rings.record_soft_failure(
                "producer:authoring-failed", str(result.get("reason")),
                corrected="seeded-producer-floor", user=owner)
        except Exception:  # pragma: no cover — failsoft-ok: recorder-self
            pass
    return result


def kickoff_producer_authoring(owner: Optional[str]) -> None:
    """Fire-and-forget the producer-persona deepening in the background, ONCE per season start. Never
    blocks game start; never raises into the caller. A per-user in-flight guard stops a rapid second
    createCharacter from double-authoring the same producer."""
    k = _key(owner)
    if k in _IN_FLIGHT:
        return
    _IN_FLIGHT.add(k)

    async def _runner():
        try:
            await run_authoring(owner)
        except Exception as e:  # pragma: no cover - defensive
            # #1599: run_authoring records its own failures and is not expected to raise; a raise here
            # means the producer deepening silently degraded with no record — surface it RED. Seeded floor stands.
            logger.warning("[producer-authoring] background run failed: %s", e)
            try:
                from src import log_rings
                log_rings.record_soft_failure("producer:background-run-failed", e,
                                              corrected="seeded-producer-floor", user=owner)
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
            __import__("src.llm_core", fromlist=["run_isolated"]).run_isolated(_runner())
        except Exception:
            _IN_FLIGHT.discard(k)
