"""ORW-1165 - the day's recap is its own chat message ("Day N in review"), not a paragraph at the top of a turn reply.

The engine's `turnIn` result carries `dailyRecap` for the day that just closed (a digest of lines by kind, the gossip that reached the player, an optional hook). This module turns it into ONE assistant row of
`metadata.kind == "day-recap"` that sits between the night and the morning, and tells the other windows over the session bus. Idempotent per (season, day): a replayed turnIn, a replayed turn start or a second re-issue
never saves a second card for the same day. Fail-soft: never raises, never blocks the turn. No model call: the card is built from the engine's own lines (public names and the record's text, witnessed and surfaced only).

`reissue()` is the ops path (dry run by default): it asks the engine for the closed day's recap rebuilt with the current digest builder and saves it as a card once.
"""
from __future__ import annotations

import json
import logging
from typing import Optional

logger = logging.getLogger(__name__)

KIND = "day-recap"
_MAX_LINES = 18
_ORDER = ("arrival", "toast", "bed", "deal", "alliance", "strategy", "bond", "talk", "gossip", "clash", "betrayal", "ceremony", "overheard", "house", "moment", "scene")
_LEAD = "The day plays back as you drift off."


def recap_from_turn_in(result) -> Optional[dict]:
    """The `dailyRecap` of a successful turnIn tool result, or None."""
    try:
        view = json.loads(result["output"]) if isinstance(result, dict) and isinstance(result.get("output"), str) else None
        rec = (view or {}).get("dailyRecap")
        return rec if isinstance(rec, dict) else None
    except Exception:
        return None


def _day_of(rec) -> Optional[int]:
    d = rec.get("day") if isinstance(rec, dict) else None
    return d if isinstance(d, int) and not isinstance(d, bool) and d >= 1 else None


def card_from_recap(rec) -> Optional[dict]:
    """The validated card payload {day, digest:[{kind,text}], surfaced:[str], hook:str|None} for an engine recap, or None when it has nothing in it."""
    day = _day_of(rec)
    if day is None:
        return None
    digest = []
    for d in rec.get("digest") or []:
        if isinstance(d, dict) and isinstance(d.get("text"), str) and d["text"].strip():
            digest.append({"kind": str(d.get("kind") or "moment")[:24], "text": d["text"].strip()[:220]})
    if not digest:  # an older engine (no digest): the highlights and the scenes of the day, as plain moments
        digest = [{"kind": "moment", "text": str(t).strip()[:220]} for t in (rec.get("highlights") or []) if isinstance(t, str) and t.strip()]
        digest += [{"kind": "scene", "text": str(t).strip()[:220]} for t in (rec.get("yourDay") or []) if isinstance(t, str) and t.strip()]
    rank = {k: i for i, k in enumerate(_ORDER)}
    digest = sorted(digest, key=lambda d: rank.get(d["kind"], len(_ORDER)))[:_MAX_LINES]  # stable: the order they happened within a kind
    surfaced = [str(t).strip()[:220] for t in (rec.get("surfaced") or []) if isinstance(t, str) and t.strip()][:6]
    hk = rec.get("hook")
    hook = hk.get("framing").strip()[:220] if isinstance(hk, dict) and isinstance(hk.get("framing"), str) and hk["framing"].strip() else None
    if not digest and not surfaced:
        return None
    return {"day": day, "digest": digest, "surfaced": surfaced, "hook": hook}


def fallback_text(card: dict) -> str:
    """Plain-text rendering (what a client with no card shows, and what the narrator's history window reads)."""
    parts = [f"Day {card['day']} in review.", _LEAD]
    parts += [f"- {d['text']}" for d in card["digest"]]
    if card["surfaced"]:
        parts.append("Word that reached you:")
        parts += [f"- {t}" for t in card["surfaced"]]
    if card["hook"]:
        parts.append(f"Tomorrow: {card['hook']}")
    return "\n".join(parts)


def has_card(history, day: int) -> bool:
    for m in history:
        md = (m.get("metadata") if isinstance(m, dict) else getattr(m, "metadata", None)) or {}
        if md.get("kind") == KIND and md.get("day") == day:
            return True
    return False


def save_day_recap(owner, rec) -> bool:
    """Save + announce the card row for an engine recap. True only when a NEW row was saved."""
    try:
        card = card_from_recap(rec)
        if not card:
            return False
        from core.models import ChatMessage, current_season_rows
        from src import orwell_game_session, session_events
        from src.ai_interaction import get_session_manager
        sid = orwell_game_session.get_game_session(owner)
        mgr = get_session_manager()
        if not sid or not mgr:
            return False
        sess = mgr.get_session(sid)
        if has_card(current_season_rows(sess.history), card["day"]):
            return False
        md = {"kind": KIND, "day": card["day"], "recap": {"digest": card["digest"], "surfaced": card["surfaced"], "hook": card["hook"]}, "phase": "game"}
        try:
            from routes.chat_helpers import current_game_moment
            moment = current_game_moment(owner)
            if moment:
                md["game_moment"] = moment
        except Exception:
            pass  # failsoft-ok: the card is saved without the moment stamp
        sess.add_message(ChatMessage("assistant", fallback_text(card), metadata=md))
        mgr.save_sessions()
        session_events.publish(sid, "message-added", {"type": "day_recap", "day": card["day"]})
        return True
    except Exception as e:
        logger.debug("[day-recap] save skipped", exc_info=True)
        try:
            from src import log_rings
            log_rings.record_soft_failure("day-recap:save-failed", e, corrected="the recap card is simply absent; the game continues", user=owner)
        except Exception:  # failsoft-ok: recorder-self
            pass
        return False


def save_from_turn_in(owner, result) -> bool:
    """The turnIn hook: save the card for the recap the result carries."""
    rec = recap_from_turn_in(result)
    return save_day_recap(owner, rec) if rec else False


async def reissue(owner: str, day: int, apply: bool = False) -> dict:
    """Ops: re-issue a closed day's recap once as a card, rebuilt by the engine with the current digest builder. Dry run unless `apply`. Returns a report (never raises)."""
    from src import orwell_engine
    report = {"user": owner, "day": day, "apply": bool(apply), "status": "", "lines": 0}
    try:
        rec = await orwell_engine._call("dailyRecap", {"rebuildDay": day}, user=owner)
        card = card_from_recap(rec) if isinstance(rec, dict) else None
        if not card or card["day"] != day:
            report["status"] = "no-recap-for-that-day-or-its-record-slice-is-unknown"
        else:
            from core.models import current_season_rows
            from src import orwell_game_session
            from src.ai_interaction import get_session_manager
            sid = orwell_game_session.get_game_session(owner)
            mgr = get_session_manager()
            if not sid or not mgr:
                report["status"] = "no-game-session"
            elif has_card(current_season_rows(mgr.get_session(sid).history), day):
                report["status"] = "already-issued"
            else:
                report["lines"] = len(card["digest"]) + len(card["surfaced"])
                report["kinds"] = sorted({d["kind"] for d in card["digest"]})
                if not apply:
                    report["status"] = "dry-run: would issue the card"
                else:
                    report["status"] = "issued" if save_day_recap(owner, rec) else "not-saved"
    except Exception as e:
        report["status"] = f"error: {type(e).__name__}"
        try:
            from src import log_rings
            log_rings.record_soft_failure("day-recap:reissue-failed", e, corrected="nothing issued; the report says so", user=owner)
        except Exception:  # failsoft-ok: recorder-self
            pass
    logger.info("[day-recap] reissue %s", report)
    return report
