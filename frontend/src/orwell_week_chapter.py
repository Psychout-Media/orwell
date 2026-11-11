"""ORW-275 (week chapters, slice 1) - save the "new chapter" row when a turnIn crosses a week boundary.

The engine's `turnIn` carries a Vault-free ``weekChapter`` ({week, recap:{evicted, hoh, standing}}) on the bed that closes a
week (eviction night). This module turns it into ONE assistant row (the first row of the new week) and tells the other
windows over the existing session bus. Idempotent per (session, week): a replayed turnIn never saves a second row. Fail-soft:
never raises, never blocks the turn. Builds no UI (the chapter card is Overseer B's) and touches no prompt.
"""
from __future__ import annotations

import json
import logging
from typing import Optional

logger = logging.getLogger(__name__)

KIND = "week-chapter"


def chapter_from_turn_in(result) -> Optional[dict]:
    """The validated ``weekChapter`` of a successful turnIn tool result, or None."""
    try:
        view = json.loads(result["output"]) if isinstance(result, dict) and isinstance(result.get("output"), str) else None
        wc = (view or {}).get("weekChapter")
        if not isinstance(wc, dict):
            return None
        week, recap = wc.get("week"), wc.get("recap")
        if not isinstance(week, int) or isinstance(week, bool) or week < 1 or not isinstance(recap, dict):
            return None
        evicted = [str(x) for x in (recap.get("evicted") or []) if isinstance(x, str)]
        hoh = recap.get("hoh") if isinstance(recap.get("hoh"), str) else None
        standing = recap.get("standing") if isinstance(recap.get("standing"), str) else ""
        return {"week": week, "recap": {"evicted": evicted, "hoh": hoh, "standing": standing}}
    except Exception:
        return None


def fallback_text(wc: dict) -> str:
    """Plain-text rendering of the recap (what a client with no chapter card shows)."""
    r = wc["recap"]
    parts = [f"Week {wc['week']}."]
    if r["evicted"]:
        parts.append("Out: " + ", ".join(r["evicted"]) + ".")
    if r["hoh"]:
        parts.append(f"Head of Household: {r['hoh']}.")
    if r["standing"]:
        parts.append(r["standing"])
    return " ".join(parts)


def _has_chapter(history, week: int) -> bool:
    for m in history:
        md = (m.get("metadata") if isinstance(m, dict) else getattr(m, "metadata", None)) or {}
        if md.get("kind") == KIND and md.get("week") == week:
            return True
    return False


def save_week_chapter(owner, result) -> bool:
    """Save + announce the chapter row for a turnIn result. True only when a NEW row was saved."""
    try:
        wc = chapter_from_turn_in(result)
        if not wc:
            return False
        from core.models import ChatMessage
        from src import orwell_game_session, session_events
        from src.ai_interaction import get_session_manager
        sid = orwell_game_session.get_game_session(owner)
        mgr = get_session_manager()
        if not sid or not mgr:
            return False
        sess = mgr.get_session(sid)
        if _has_chapter(list(sess.history), wc["week"]):
            return False
        moment = None
        try:
            from routes.chat_helpers import current_game_moment
            moment = current_game_moment(owner)
        except Exception:
            moment = None
        md = {"kind": KIND, "week": wc["week"], "recap": wc["recap"], "phase": "game"}
        if moment:
            md["game_moment"] = moment
        sess.add_message(ChatMessage("assistant", fallback_text(wc), metadata=md))
        mgr.save_sessions()
        # Rides the existing per-session bus: other windows reload history on `message-added`; the extra keys let a
        # client place the chapter without a round trip. Ids/short public strings only - no Vault data.
        session_events.publish(sid, "message-added", {"type": "week_chapter", "week": wc["week"], "recap": wc["recap"]})
        return True
    except Exception:
        logger.debug("[week-chapter] save skipped", exc_info=True)
        return False
