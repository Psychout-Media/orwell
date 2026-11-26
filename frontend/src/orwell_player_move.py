"""ORW-419 - intent-first moves (FE side): resolve the player's OWN move in the engine BEFORE the narrator runs.

One small, fail-soft helper. The player's message text goes to the engine's ``resolvePlayerMove`` lever (an INFRA lever, never a
model lever): the engine parses present-tense self-moves ("I go to the kitchen", "leave the backyard", "go inside"), performs
the move itself and records ``playerMove`` on the turn state the narrator's briefing reads. The narrator voices the exit and the
arrival; it never decides, blocks or asks permission for the player's own move. Unsure parses move nothing (the existing
post-reply move belt, ``agent_loop._auto_move_player``, stays the fallback; the player's stated move always wins).

Called from ``routes.chat_helpers`` right after the per-message ``noteMessage`` and BEFORE ``apply_game_framing`` builds the
narrator's moment prompt, so the prompt already shows the new room. Telemetry is success-gated: a belt fire is counted only when
the engine actually applied a move.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)

BELT_NAME = "player-move-intent"

#: ORW-1038: the users whose LAST message the engine's parser already decided (moved them, or refused the move): the post-reply move belt must not write a second, different move over it.
_DECIDED: set = set()


def engine_decided_this_message(user) -> bool:
    return (user or "") in _DECIDED


async def resolve_player_move_before_narrator(text: Any, user: Optional[str], client_msg_id: Optional[str] = None,
                                              *, engine: Any = None, previous_reply: Optional[str] = None) -> Optional[dict]:
    """Resolve the player's own move from ``text`` in the engine. Returns the engine's ``playerMove`` dict ({from,to} or
    {refused,reason}) when the words held a clear move, else None. Never raises."""
    try:
        _DECIDED.discard(user or "")  # ORW-1038: a new message: last turn's verdict is over
        if not isinstance(text, str) or not text.strip():
            return None
        if engine is None:
            from src import orwell_engine as engine  # type: ignore[no-redef]
        key = f"move:{client_msg_id}" if client_msg_id else None
        extra = {"previous_reply": previous_reply} if previous_reply else {}
        res = await engine.resolve_player_move(text, key, user=user, **extra)
        if not isinstance(res, dict):
            return None
        try:
            from routes.chat_helpers import _refresh_beat_seq
            _refresh_beat_seq(user, res)
        except Exception:
            pass
        move = res.get("playerMove")
        if not isinstance(move, dict):
            return None
        _DECIDED.add(user or "")
        try:
            from src import orwell_sync_ledger as _led
            if not move.get("refused"):
                _led.note_belt_fire(user, BELT_NAME)  # success-gated: an APPLIED move, never an attempt
        except Exception:
            pass
        logger.info("[orwell] intent-first move user=%s refused=%s", user, bool(move.get("refused")))  # no content
        return move
    except Exception as exc:
        try:
            from src import log_rings
            log_rings.record_soft_failure("player-move:resolve-failed", exc,
                                          corrected="the post-reply move belt stays the fallback", user=user)
        except Exception:  # failsoft-ok: the recorder itself is down; the failure was already WARN-logged below
            logger.warning("[orwell] intent-first move failed (fail-soft): %s", exc)
        return None
