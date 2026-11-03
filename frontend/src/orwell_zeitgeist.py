"""Feature 0062 (FE lane) — capture the real-world MOVE-IN ZEITGEIST via web search.

The engine seeds a deterministic ``model-framed`` ``WorldSnapshot`` at season creation (the fail-soft
floor — generic, date-unaware pools). This module is the FE-owned ``web_search`` provider that REPLACES
it ONCE per season with a REAL capture of the move-in-era zeitgeist — the shared movies/music/sports/
news/internet/mood the whole cast walked in with, frozen with a deliberate ~7-day lag (settled, not
bleeding-edge). The FE owns the concrete search provider exactly as it owns the 0051 image provider; the
engine treats the write-back as outward-safe season flavor (``recordWorldSnapshot``).

Hard rules (0062 §6/§8): FLAVOR ONLY — it never informs a game outcome; best-effort + background —
no model OR no usable output ⇒ the deterministic fallback simply stands; captured ONCE then frozen +
recalled all season (the engine persists it). Tests never depend on a live search (the orchestrator
takes injected deps; §9/§10).
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

# ~7-day one-time lag (§11 #1): the cast moves in slightly behind, so the snapshot is settled and fully
# consistent with the no-internet fiction (the house never updates). A single tunable.
LAG_DAYS = 7

# Small + bounded (§11 #3): the engine caps each slice at 2 items, so a few searches + a tight synthesis
# is plenty — texture, not an almanac. The research queries are broad and cover the five slices.
_RESEARCH_QUERIES = [
    "biggest movies, TV shows, and streaming series everyone is watching right now",
    "most popular music, songs, and artists trending right now; major sports headlines this week",
    "notable mainstream news headlines this week; viral internet trends, memes, and phrases right now",
]

# The slice keys the engine accepts (everything else is dropped before write-back). `mood` is a string.
_SLICE_KEYS = ("screen", "music", "sports", "news", "internet")
_MAX_ITEMS = 3  # ask for a touch more than the engine's cap of 2; the engine trims the rest.

# Per-user in-flight guard so two rapid createCharacter calls never double-search the same season.
_IN_FLIGHT: set[str] = set()

ResearchFn = Callable[[], Awaitable[str]]    # () -> combined research text ("" when search unavailable)
LlmFn = Callable[[list], Awaitable[str]]     # messages -> completion text
WriteFn = Callable[[dict], Awaitable[dict]]  # snapshot -> { accepted, source }


def _key(user: Optional[str]) -> str:
    return user or "default"


def captured_dates(now: Optional[datetime] = None) -> tuple[str, str]:
    """The in-fiction move-in date label (today − LAG_DAYS, what the house is frozen at) and the real
    capture timestamp (provenance, never voiced). Public, non-secret."""
    now = now or datetime.now(timezone.utc)
    moved_in = now - timedelta(days=LAG_DAYS)
    return moved_in.strftime("%B %d, %Y"), now.isoformat()


def _synthesis_messages(captured_for: str, research: str) -> list[dict]:
    grounded = (
        f"Use this fresh web-search research to ground the picture in the REAL current world:\n\n{research}\n\n"
        if research.strip()
        else "No live search was available — draw on your own knowledge of the era around that date.\n\n"
    )
    system = (
        "You are a reality-TV producer capturing the shared real-world ZEITGEIST the cast moved in with — "
        f"the pop-culture moment FROZEN as of {captured_for}. Capture what was big RIGHT THEN: the movies/"
        "shows everyone had seen, the songs everyone heard, the sport in season, the headline-level news, "
        "the meme everyone was quoting, and the overall vibe. Real, recognizable, mainstream, non-sensitive. "
        "Output ONLY a JSON object (no prose, no markdown fence), exactly these keys: "
        '{"screen":[..],"music":[..],"sports":[..],"news":[..],"internet":[..],"mood":".."}. '
        "Each list: 2-3 SHORT items (a title/name/phrase, not a sentence). `mood`: one short line reading "
        "the cultural moment. Nothing that postdates the move-in date."
    )
    user = grounded + f'Capture the zeitgeist frozen as of {captured_for}. JSON only:'
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def parse_zeitgeist(text: str) -> dict:
    """Tolerantly extract the synthesized JSON into a ``recordWorldSnapshot`` ``slices`` dict — keeping
    ONLY the known slice keys, coercing each to a short list of trimmed strings (+ a string ``mood``),
    and dropping everything empty/unknown. Returns ``{}`` when nothing usable parsed (⇒ no write-back)."""
    if not isinstance(text, str) or not text.strip():
        return {}
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return {}
    try:
        obj = json.loads(text[start:end + 1])
    except (ValueError, TypeError):
        return {}
    if not isinstance(obj, dict):
        return {}
    out: dict = {}
    for k in _SLICE_KEYS:
        v = obj.get(k)
        if isinstance(v, str):
            v = [v]
        if not isinstance(v, list):
            continue
        items = [str(s).strip() for s in v if str(s).strip()][:_MAX_ITEMS]
        if items:
            out[k] = items
    mood = obj.get("mood")
    if isinstance(mood, str) and mood.strip():
        out["mood"] = mood.strip()
    # Require at least one real slice (mood alone is too thin to replace the fallback).
    if not any(k in out for k in _SLICE_KEYS):
        return {}
    return out


async def capture_zeitgeist(research_fn: ResearchFn, llm_fn: LlmFn, write_fn: WriteFn, *,
                            captured_for: str, captured_at: str) -> dict:
    """Orchestrate: research (best-effort) → synthesize JSON slices → write the snapshot back. Injected
    deps make the whole lane testable without a live search/model/engine. Returns the write-back result
    (``{accepted, source}``) or ``{"accepted": False, "reason": ...}`` — the deterministic fallback then
    stands. Never raises."""
    research = ""
    try:
        research = await research_fn() or ""
    except Exception as e:  # search is best-effort — fall through to model-framed synthesis
        logger.warning("[zeitgeist] research failed: %s", e)
    try:
        text = await llm_fn(_synthesis_messages(captured_for, research))
    except Exception as e:
        logger.warning("[zeitgeist] synthesis failed: %s", e)
        return {"accepted": False, "reason": "llm-failed"}
    slices = parse_zeitgeist(text or "")
    if not slices:
        return {"accepted": False, "reason": "no-slices"}
    try:
        return await write_fn({"slices": slices, "capturedFor": captured_for, "capturedAt": captured_at})
    except Exception as e:
        logger.warning("[zeitgeist] write-back failed: %s", e)
        return {"accepted": False, "reason": "write-failed"}


# ── live wiring (best-effort, background; graceful no-op when no model) ─────────────

# RC6 S6c: transport/provider signatures in a raw exception message — a CONFIRMED provider outage,
# not a local bug. Kept narrow so a parsing/programming error never trips a false provider alarm.
_SEARCH_TRANSPORT_MARKERS = (
    "connection refused", "econnrefused", "connection reset", "connection aborted",
    "timed out", "timeout", "read timed out", "network is unreachable", "no route to host",
    "temporary failure in name resolution", "name or service not known", "max retries exceeded",
    "failed to establish a new connection", "ssl", "certificate", "proxy",
)


def _classify_search_error(exc: BaseException) -> str:
    """RC6 S6c: only a CONFIRMED transport/provider fault is a ``search-provider`` outage (the
    threshold-1 provider RED alarm). A local parsing/programming bug is a ``search-runtime`` fault —
    it must NOT raise a false provider-outage alarm. Keys on builtin + the search layer's typed
    transport errors first (``NetworkError`` / ``RateLimitError``, but never ``ParseError``), then
    falls back to a transport signature in the message. Anything else is ``search-runtime``."""
    if isinstance(exc, (ConnectionError, TimeoutError)):
        return "search-provider"
    try:  # the search layer's typed transport/provider errors — ParseError is deliberately excluded
        from src.search import NetworkError, RateLimitError
        if isinstance(exc, (NetworkError, RateLimitError)):
            return "search-provider"
    except ImportError:  # pragma: no cover - defensive: the typed errors may be unimportable in isolation
        pass
    low = str(exc).lower()
    if any(m in low for m in _SEARCH_TRANSPORT_MARKERS):
        return "search-provider"
    return "search-runtime"


async def _live_research_fn(owner: Optional[str]) -> ResearchFn:
    """A research fn over the FE's real ``web_search`` (C32's provider). Returns an async fn that runs the
    bounded query set in an executor (the search is sync + network-bound) and concatenates the results.
    When search is disabled, returns a fn yielding "" so synthesis falls back to the model's framed
    knowledge (the §8 model-framed tier)."""
    try:
        from src.settings import get_setting
        if str(get_setting("search_provider", "searxng")).lower() == "disabled":
            async def _none() -> str:
                return ""
            return _none
        from src.search import comprehensive_web_search
    except Exception:
        async def _none2() -> str:
            return ""
        return _none2

    async def _run() -> str:
        loop = asyncio.get_event_loop()
        chunks: list[str] = []
        _provider_down_recorded = False  # RC6 S6c: record the outage ONCE per run, not per-query
        for q in _RESEARCH_QUERIES:
            try:
                txt = await loop.run_in_executor(
                    None, lambda q=q: comprehensive_web_search(q, max_pages=2))
                if isinstance(txt, str) and txt.strip() and "disabled by the administrator" not in txt:
                    chunks.append(f"## {q}\n{txt}")
            except Exception as e:
                logger.warning("[zeitgeist] search failed for %r: %s", q, e)
                # RC6 S6c (#1599): a web-search provider outage feeding the zeitgeist enrichment lane
                # ("SearXNG search failed: [Errno 111] Connection refused") was recorded NOWHERE — it
                # fell through this best-effort WARN with no failure row, and synthesis quietly stood on
                # the model's framed knowledge. Land it in the admin-visible LOUD failure ledger + a
                # RED-eligible health event. Classify TRUTHFULLY: only a confirmed transport/provider
                # fault is `search-provider` (the threshold-1 provider alarm); a local parsing/programming
                # bug is `search-runtime` so it can't raise a false provider-outage alarm. Once per run
                # (a down provider fails every query). Fail-soft.
                if not _provider_down_recorded:
                    _provider_down_recorded = True
                    try:
                        from src import enrichment_policy as _ep
                        _cls = _classify_search_error(e)
                        _kind = ("provider unavailable" if _cls == "search-provider"
                                 else "runtime error (not a provider outage)")
                        _ep.record_runtime_failure(
                            owner, _cls,
                            f"web-search {_kind} for the move-in zeitgeist: {e}")
                    except Exception:  # pragma: no cover - defensive: telemetry never breaks the lane
                        pass
        return "\n\n".join(chunks)

    return _run


async def run_capture(owner: Optional[str]) -> dict:
    """Resolve the live deps and capture the zeitgeist. Under the `soft` enrichment policy a missing
    model / failed capture is the legacy silent no-op (not accepted) — the engine's deterministic
    fallback stands byte-identically. Under the DEFAULT `strict` policy (owner directive 2026-07-11)
    the failure is LOUD: a missing model records an ERROR + a failure-ledger entry, and a failed /
    unusable capture is RETRIED once before being ledgered. The capture is player-INDEPENDENT
    (the real world is the same for everyone); the player's identity is never threaded in."""
    strict = False
    try:
        from src import enrichment_policy
        strict = enrichment_policy.is_strict()
    except Exception:
        strict = False
    try:
        from src.orwell_cast_authoring import _resolve_llm_fn  # the shared background-utility completion
    except Exception:
        return {"accepted": False, "reason": "no-model"}
    llm_fn = await _resolve_llm_fn(owner)
    if llm_fn is None:
        if strict:
            enrichment_policy.record_failure(
                owner, "zeitgeist", "no model resolved for the zeitgeist call class",
                detail="the deterministic snapshot must not stand silently under the strict policy")
        else:
            logger.debug("[zeitgeist] no utility model — keeping the deterministic snapshot")
        return {"accepted": False, "reason": "no-model"}
    research_fn = await _live_research_fn(owner)
    captured_for, captured_at = captured_dates()
    from src import orwell_engine

    async def _write(snapshot: dict) -> dict:
        return await orwell_engine.record_world_snapshot(snapshot, user=owner)

    result = await capture_zeitgeist(research_fn, llm_fn, _write,
                                     captured_for=captured_for, captured_at=captured_at)
    # STRICT: one bounded retry on a failed/unusable capture (llm failure, no parseable slices, or a
    # refused write-back), then a LOUD ledger entry. Soft keeps the legacy single attempt untouched.
    if strict and not (isinstance(result, dict) and result.get("accepted")):
        logger.warning("[zeitgeist] capture failed (%s) — retrying once (strict policy)",
                       (result or {}).get("reason"))
        result = await capture_zeitgeist(research_fn, llm_fn, _write,
                                         captured_for=captured_for, captured_at=captured_at)
        if not (isinstance(result, dict) and result.get("accepted")):
            enrichment_policy.record_failure(
                owner, "zeitgeist",
                f"zeitgeist capture failed after retry ({(result or {}).get('reason', 'unknown')})",
                detail="the deterministic snapshot stands, but the failure is loud + ledgered")
    # #617: the zeitgeist landed on the live game — push a server-side "game-updated" so open
    # pages reconcile now instead of waiting for the next poll. Best-effort/fail-soft.
    if isinstance(result, dict) and result.get("accepted"):
        try:
            from src import orwell_game_session
            orwell_game_session.publish_game_updated(owner)
        except Exception:
            pass
    return result


def kickoff_capture(owner: Optional[str]) -> None:
    """Fire-and-forget the move-in zeitgeist capture in the background, ONCE per season start. Never
    blocks game start; never raises into the caller. A per-user in-flight guard stops a rapid second
    createCharacter from double-capturing the same season."""
    k = _key(owner)
    if k in _IN_FLIGHT:
        return
    _IN_FLIGHT.add(k)

    async def _runner():
        try:
            await run_capture(owner)
        except Exception as e:  # pragma: no cover - defensive
            logger.warning("[zeitgeist] background capture failed: %s", e)
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
