"""Feature #1400 (FE lane) — GENERATIVE COMPETITION DESIGN: the model DRESSES the engine's fixed roll.

The engine resolves each staged competition as ONE calibrated roll UP FRONT — the crown and the full
drop order are fixed before any staging renders. This module is the FE-owned author that, AFTER the roll
commits, invents the week's competition (theme + staging premise + per-round elimination fiction) MATCHED
to that already-decided outcome, and writes it BACK so the engine stays the source of truth
(``recordCompetitionFiction``). The FE owns the concrete utility LLM exactly as it owns the 0062 zeitgeist
/ 0058 cast-authoring write-backs; the engine treats the write-back as presentation-only season flavor.

THE SAFETY PROPERTY (why this is approvable): the model can never touch the result. It is handed the
FIXED drop order and authors prose for each drop IN THAT ORDER; the engine then RE-VALIDATES that every
elimination maps to its fixed drop order EXACTLY and REJECTS any mismatch — on a reject the deterministic
0042 competition-library floor simply stands. Best-effort + background + fail-soft: no model, no usable
output, or a rejected write-back ⇒ the 0042 floor stands (byte-identical to the pre-feature model).

COST CAP (#1400): exactly ONE utility completion per competition (~2/week — one HOH + one veto), fired
fire-and-forget with a per-(user, comp) in-flight guard. Tests inject deps; nothing depends on a live model.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

# The bounds the engine also enforces (defense-in-depth; keeps the ask tight — flavor, not an almanac).
_MAX_THEME = 120
_MAX_PREMISE = 600
_MAX_LINE = 300

# Per-(user, comp-key) in-flight guard so two rapid advances never double-author the same competition.
_IN_FLIGHT: set[str] = set()

StagingFn = Callable[[], Awaitable[Optional[dict]]]   # () -> the competitionStagingView (or None)
LlmFn = Callable[[list], Awaitable[str]]              # messages -> completion text
WriteFn = Callable[[dict], Awaitable[dict]]           # fiction -> { accepted, reason? }


def _key(user: Optional[str], staging: dict) -> str:
    return f"{user or 'default'}:{staging.get('week')}:{staging.get('comp')}"


def _clamp(v: str, n: int) -> str:
    v = " ".join(str(v).split())
    return v[:n].rstrip() if len(v) > n else v


def _synthesis_messages(staging: dict) -> list[dict]:
    """Build the prompt: hand the model the comp type + participants + the FIXED winner + the FIXED drop
    order + the 0042 library scaffold, and ask for a theme/premise plus one fiction line PER DROP, IN THE
    GIVEN ORDER. The model dresses a decided result — the order is fixed and must be honored."""
    winner = (staging.get("winner") or {}).get("name", "the winner")
    drop = [d.get("name", "") for d in staging.get("dropOrder", []) if d.get("name")]
    field = [p.get("name", "") for p in staging.get("participants", []) if p.get("name")]
    lib = staging.get("library") or {}
    ordered = "\n".join(f"{i + 1}. {name}" for i, name in enumerate(drop))
    system = (
        "You are a reality-TV competition producer writing the STAGING of a Big Brother competition. The "
        "OUTCOME IS ALREADY DECIDED and is NOT yours to change — you are dressing a fixed result. Invent a "
        "vivid competition: a THEME (a short title), a PREMISE (how it is set up and played), and one short "
        "FICTION line for EACH elimination, IN THE EXACT ORDER GIVEN. Do NOT reorder, rename, add, or drop "
        "anyone. The winner OUTLASTS the field. Output ONLY a JSON object (no prose, no markdown fence), "
        'exactly these keys: {"theme":"..","premise":"..","winReads":"..","drops":{"<name>":"<one line>"}}. '
        "`drops` maps EACH eliminated houseguest's name (exactly as given) to one short line describing how "
        "they go out, consistent with the theme. Keep each line to one sentence."
    )
    user = (
        f"Competition type: {staging.get('type', 'endurance')} ({staging.get('format', 'endurance')}).\n"
        f"Field (all who competed): {', '.join(field)}.\n"
        f"Winner (outlasts everyone): {winner}.\n"
        f"Eliminated, in the EXACT order they go out (earliest first) — write one line for each, in this order:\n"
        f"{ordered}\n\n"
        f"Library inspiration to riff on (optional): {lib.get('name', '')} — {lib.get('premise', '')}\n\n"
        "JSON only:"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def build_fiction(staging: dict, text: str) -> Optional[dict]:
    """Parse the model JSON and build the ``recordCompetitionFiction`` payload, keying every elimination
    to the ENGINE'S FIXED drop order (id + name from the staging view) and pulling the model's line for
    that name. Returns ``None`` when nothing usable parsed OR the model did not cover every drop — so the
    engine's floor stands rather than a doomed write-back. The engine RE-VALIDATES regardless."""
    if not isinstance(text, str) or not text.strip():
        return None
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        obj = json.loads(text[start:end + 1])
    except (ValueError, TypeError):
        return None
    if not isinstance(obj, dict):
        return None
    theme = _clamp(obj.get("theme", ""), _MAX_THEME)
    premise = _clamp(obj.get("premise", ""), _MAX_PREMISE)
    if not theme or not premise:
        return None
    win_reads = _clamp(obj.get("winReads", ""), _MAX_LINE)
    drops = obj.get("drops")
    if not isinstance(drops, dict):
        return None
    # Case-insensitive name -> line map from the model's output.
    by_name = {str(k).strip().lower(): str(v).strip() for k, v in drops.items() if str(v).strip()}
    eliminations = []
    for d in staging.get("dropOrder", []):
        name = d.get("name", "")
        did = d.get("id")
        line = by_name.get(str(name).strip().lower())
        if not did or not line:
            return None  # incomplete coverage ⇒ do not attempt a partial write-back (floor stands)
        eliminations.append({"id": did, "fiction": _clamp(line, _MAX_LINE)})
    if not eliminations:
        return None
    payload = {
        "comp": staging.get("comp"),
        "week": staging.get("week"),
        "theme": theme,
        "premise": premise,
        "eliminations": eliminations,
    }
    if win_reads:
        payload["winReads"] = win_reads
    return payload


async def author_competition(staging_fn: StagingFn, llm_fn: LlmFn, write_fn: WriteFn) -> dict:
    """Orchestrate: read the staging view → synthesize fiction → write it back. Injected deps make the
    whole lane testable without a live model/engine. Returns the write-back result (``{accepted, reason?}``)
    or ``{"accepted": False, "reason": ...}`` — the deterministic 0042 floor then stands. Never raises."""
    try:
        staging = await staging_fn()
    except Exception as e:
        # #1599 (CodeRabbit): a staging read that RAISES is a genuine engine/transport fault — RED,
        # NOT the expected-empty "no dropOrder" case below (generation off / no comp resolved yet).
        logger.warning("[gen-comp] staging read failed: %s", e)
        try:
            from src import log_rings
            log_rings.record_soft_failure("gen-comp:staging-read-failed", e,
                                          corrected="competition-library-floor")
        except Exception:  # pragma: no cover — failsoft-ok: recorder-self
            pass
        return {"accepted": False, "reason": "no-staging"}
    if not isinstance(staging, dict) or not staging.get("dropOrder"):
        return {"accepted": False, "reason": "no-staging"}  # generation off, or no comp resolved yet
    # EXACTLY-ONCE guard: the staged comp stays surfaced across every reveal round until it crowns, and the
    # kickoff fires after every advance/decision — so once the engine already holds VALIDATED fiction for
    # this (week, comp), authoring again is a wasted utility call that would OVERWRITE the stored fiction
    # (later rounds would then render different staging than earlier ones). No-op BEFORE any model call.
    if staging.get("alreadyAuthored"):
        return {"accepted": False, "reason": "already-authored"}
    try:
        text = await llm_fn(_synthesis_messages(staging))
    except Exception as e:  # failsoft-ok: handled-by-terminal (run_author records llm-failed RED via log_rings.record_soft_failure)
        logger.warning("[gen-comp] synthesis failed: %s", e)
        return {"accepted": False, "reason": "llm-failed"}
    fiction = build_fiction(staging, text or "")
    if not fiction:
        return {"accepted": False, "reason": "no-fiction"}
    try:
        return await write_fn(fiction)
    except Exception as e:  # failsoft-ok: handled-by-terminal (run_author records write-failed RED via log_rings.record_soft_failure)
        logger.warning("[gen-comp] write-back failed: %s", e)
        return {"accepted": False, "reason": "write-failed"}


# ── live wiring (best-effort, background; graceful no-op when no model / generation off) ─────────────

async def run_author(owner: Optional[str], staging: Optional[dict] = None) -> dict:
    """Resolve the live deps and author the current competition's fiction over the ALREADY-FETCHED staging
    view (or fetch it when not supplied). Silent no-op (not accepted) when no utility model resolves OR
    there is no staging view (generation disabled, or no comp has resolved its roll) — the engine's
    deterministic 0042 floor then stands."""
    from src import orwell_engine
    if staging is None:
        try:
            staging = await orwell_engine.competition_staging_view(user=owner)
        except Exception as e:
            # #1599 (CodeRabbit): PRE-GAME (EngineToolError.no_game) is expected-empty; anything else is
            # a genuine engine/transport fault while a game exists — surface it RED. `no_game` is set only
            # on the engine's pre-game refusal, so getattr suffices (no orwell_engine ref needed here).
            if not getattr(e, "no_game", False):
                try:
                    from src import log_rings
                    log_rings.record_soft_failure("gen-comp:staging-read-failed", e,
                                                  corrected="competition-library-floor", user=owner)
                except Exception:  # pragma: no cover — failsoft-ok: recorder-self
                    pass
            return {"accepted": False, "reason": "no-staging"}
    if not isinstance(staging, dict) or not staging.get("dropOrder"):
        return {"accepted": False, "reason": "no-staging"}

    try:
        from src.orwell_cast_authoring import _resolve_llm_fn  # the shared background-utility completion
    except Exception:
        return {"accepted": False, "reason": "no-model"}
    llm_fn = await _resolve_llm_fn(owner)
    if llm_fn is None:
        logger.debug("[gen-comp] no utility model — the 0042 competition floor stands")
        return {"accepted": False, "reason": "no-model"}

    ready = staging  # already validated non-None with a drop order above

    async def _write(fiction: dict) -> dict:
        return await orwell_engine.record_competition_fiction(fiction, user=owner)

    result = await author_competition(lambda: _ready(ready), llm_fn, _write)
    # #1599 (CodeRabbit): a GENUINE competition-fiction failure shows RED on /admin/status — the model
    # call RAISED (llm-failed), OR the engine REFUSED the write-back (write-failed on a transport error,
    # OR a NON-exceptional reject reason returned by recordCompetitionFiction — e.g. a drop-order
    # mismatch). Record on ANY non-accept EXCEPT the expected-empty reasons (no comp/model/already-done/
    # quality-miss), which are normal flow. The deterministic 0042 floor stands (auto-corrected).
    _EXPECTED_EMPTY = ("no-staging", "no-model", "already-authored", "no-fiction")
    if isinstance(result, dict) and not result.get("accepted") \
            and result.get("reason") not in _EXPECTED_EMPTY:
        try:
            from src import log_rings
            log_rings.record_soft_failure(
                "gen-comp:fiction-failed", str(result.get("reason") or "refused"),
                corrected="competition-library-floor", user=owner)
        except Exception:  # pragma: no cover — failsoft-ok: recorder-self
            pass
    # If the fiction landed on the live game, push a server-side "game-updated" so open pages reconcile.
    if isinstance(result, dict) and result.get("accepted"):
        try:
            from src import orwell_game_session
            orwell_game_session.publish_game_updated(owner)
        except Exception:
            pass
    return result


async def _ready(staging: dict) -> dict:
    """Return the already-fetched staging view (avoids a second engine round-trip inside author_competition)."""
    return staging


def kickoff_fiction(owner: Optional[str]) -> None:
    """Fire-and-forget the competition-fiction author in the background, ONCE per staged competition.
    Never blocks the turn; never raises into the caller. A per-(user, week, comp) in-flight guard stops a
    rapid re-advance from double-authoring the same competition.
    One cheap staging read gates everything — no staged comp ⇒ no model is ever spun up."""

    async def _runner():
        try:
            from src import orwell_engine
            staging = await orwell_engine.competition_staging_view(user=owner)
        except Exception as e:
            # #1599 (CodeRabbit): PRE-GAME refusal (EngineToolError.no_game) is expected-empty; any other
            # engine/transport fault while a game exists is RED — never a silent skip. The 0042 floor stands.
            if not getattr(e, "no_game", False):
                try:
                    from src import log_rings
                    log_rings.record_soft_failure("gen-comp:staging-read-failed", e,
                                                  corrected="competition-library-floor", user=owner)
                except Exception:  # pragma: no cover — failsoft-ok: recorder-self
                    pass
            return
        if not isinstance(staging, dict) or not staging.get("dropOrder"):
            return  # generation off, or no comp has resolved its roll — nothing to dress
        # EXACTLY-ONCE (the persistent, engine-owned guard): once VALIDATED fiction is already stored for
        # this (week, comp), no-op — never resolve a model or re-author. This is what makes the kickoff
        # idempotent across the comp's many reveal rounds; `_IN_FLIGHT` only guards CONCURRENT runs.
        if staging.get("alreadyAuthored"):
            return
        k = _key(owner, staging)
        if k in _IN_FLIGHT:
            return
        _IN_FLIGHT.add(k)
        try:
            await run_author(owner, staging)
        except Exception as e:  # pragma: no cover - defensive
            # #1599: run_author records its own llm/write failures but its resolver call is un-wrapped;
            # a raise here means competition fiction silently degraded with no record — surface it RED.
            logger.warning("[gen-comp] background author failed: %s", e)
            try:
                from src import log_rings
                log_rings.record_soft_failure("gen-comp:background-run-failed", e,
                                              corrected="competition-library-floor", user=owner)
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
            pass
