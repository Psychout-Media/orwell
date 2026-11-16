"""ORW-510 - the front-end half of the live narration-use record (the live counterpart of season memory).

After a narrated turn the VISIBLE narration is handed back to the engine with ``recordNarrationUse({text})``. The engine reads it with plain
string work (no model call), checks it against a short bounded rolling record of what the narration already used (sentence openings, scene
closers, each houseguest's gestures and lines), counts the repeats and folds it in; the next Show Brief lists the record as "ALREADY USED".
This module only relays the text and logs the engine's counts-only season line, so repetition is visible in the logs every turn.

Hard rules: best-effort and fail-soft (a refused or failed write changes nothing for the player); sends exactly ``{text}``; never touches
hidden state; adds no model call and waits on nothing (it runs alongside the other after-turn records). Gated by the Show Brief flag (the
brief is where the record shows); the engine's ``ORWELL_NARRATION_USAGE=0`` makes the write a no-op.
"""
from __future__ import annotations

import logging
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

MAX_TEXT_CHARS = 6000  # the engine's own cut; we never send more
_MIN_CHARS = 40  # a one-liner has no frame worth recording

WriteFn = Callable[[str], Awaitable[dict]]


async def capture(narration: str, write: WriteFn) -> Optional[str]:
    """Relay one turn's visible narration; return the engine's season line when it recorded the turn, else None."""
    text = (narration or "").strip()
    if len(text) < _MIN_CHARS:
        return None
    res = await write(text[:MAX_TEXT_CHARS])
    if not isinstance(res, dict) or not res.get("recorded"):
        return None
    line = res.get("seasonLine")
    if isinstance(line, str) and line:
        logger.info(line)
        return line
    return None


async def after_turn(narration: str, owner) -> Optional[str]:
    """The live hook (called from the agent loop's end-of-turn banking). Off when the Show Brief is off."""
    try:
        from src.orwell_show_brief import show_brief_enabled
        if not show_brief_enabled():
            return None
        from src import orwell_engine as _oe

        async def _write(text: str) -> dict:
            return await _oe.record_narration_use(text, user=owner)

        return await capture(narration, _write)
    except Exception as e:
        logger.debug(f"[narration-repetition] hook skipped: {e}")
        try:
            from src import log_rings
            log_rings.record_soft_failure("narration-use:hook-failed", e, corrected="the show goes on without it", user=owner)
        except Exception:  # failsoft-ok: recorder-self
            pass
        return None
