"""Open ledger (ORW-407, first slice) - the FRONT-END half of the commitment/claim write-back.

After a narrated turn, one small constrained extraction asks a utility model which commitments or claims the narration
newly put between the PLAYER and a houseguest who is in the room (a promise made to or by the player, a reveal, an
assertion), as free text: ``{text, speaker, addressedTo, kind}`` where ``kind`` is any short phrase, never a fixed list.
Each is written BACK with ``recordOpenLedger``; the engine re-validates, derives the witnesses from its own presence,
de-duplicates, stores it, and shows it back in the narrator's brief while that houseguest is present.

Hard rules: best-effort and fail-soft (no model, a bad reply, a refused write => nothing happens); it only relays what the
narration already said, built from the player-visible narration and the public presence list (names and ids), never any
hidden state; sends exactly the four fields. Tests never need a live model: the extraction fn is injectable.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

TEXT_MAX_CHARS = 240      # the engine's cap; longer ones are DROPPED, never truncated
KIND_MAX_CHARS = 40
MAX_ENTRIES_PER_TURN = 2
_MIN_NARRATION_CHARS = 80

LlmFn = Callable[[list], Awaitable[str]]
WriteFn = Callable[[dict], Awaitable[dict]]

_SYSTEM = (
    "You extract COMMITMENTS and CLAIMS from a Big Brother narration: something a houseguest says to the player, or the "
    "player says to a houseguest, that matters later (a promise, a threat, an offer, a reveal, an assertion about "
    "themselves or others). Reply IMMEDIATELY with ONLY a JSON object, no prose, no code fence: "
    '{"entries":[{"text":"<their words, verbatim or nearly, one sentence>","speaker":"<id from the list, or player>",'
    '"addressedTo":["<id or player>"],"kind":"<a short free phrase, e.g. promise to protect>"}]} . '
    "Only people from the PRESENT list may speak or be addressed, and the player must be the speaker or the addressee. "
    "Copy what was said; invent nothing. Skip small talk and anything already finished in the scene. "
    'Most turns have none: reply {"entries":[]} when unsure.'
)


def clean_entries(raw: object, allowed_ids: set[str]) -> list[dict]:
    """Entries from an extraction reply, bounded: well-formed, known ids only, the player involved, text <= 240 chars
    (longer ones dropped, not truncated), one line, no duplicates, at most ``MAX_ENTRIES_PER_TURN``."""
    items = raw.get("entries") if isinstance(raw, dict) else None
    ok_ids = set(allowed_ids) | {"player"}
    out: list[dict] = []
    seen: set[str] = set()
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        text, speaker, to, kind = it.get("text"), it.get("speaker"), it.get("addressedTo"), it.get("kind")
        if not (isinstance(text, str) and isinstance(speaker, str) and isinstance(to, list) and isinstance(kind, str)):
            continue
        t = re.sub(r"\s+", " ", text).strip().strip('"').strip()
        if not t or len(t) > TEXT_MAX_CHARS or t.lower() in seen:
            continue
        if speaker not in ok_ids or any(not isinstance(a, str) or a not in ok_ids or a == speaker for a in to):
            continue
        if speaker != "player" and "player" not in to:
            continue
        k = re.sub(r"\s+", " ", kind).strip()[:KIND_MAX_CHARS].strip() or "claim"
        seen.add(t.lower())
        out.append({"text": t, "speaker": speaker, "addressedTo": list(dict.fromkeys(to)), "kind": k})
        if len(out) >= MAX_ENTRIES_PER_TURN:
            break
    return out


def _parse(reply: str) -> object:
    """The LAST brace-balanced JSON object in a (possibly reasoning-prefixed) reply with an ``entries`` key, or None."""
    for m in reversed([m.start() for m in re.finditer(r"\{", reply or "")]):
        depth = 0
        for j in range(m, len(reply)):
            depth += (reply[j] == "{") - (reply[j] == "}")
            if depth == 0:
                try:
                    obj = json.loads(reply[m:j + 1])
                except ValueError:
                    break
                if isinstance(obj, dict) and "entries" in obj:
                    return obj
                break
    return None


async def capture_open_ledger(narration: str, present: list[dict], llm: LlmFn, write: WriteFn) -> int:
    """Extract the narration's newly stated commitments/claims and write them back. ``present`` is the public presence
    list ``[{id, name}]`` (houseguests in the player's room). Returns how many writes the engine ACCEPTED. Never raises."""
    try:
        people = [p for p in present if isinstance(p, dict) and isinstance(p.get("id"), str) and p["id"]]
        if not people or len(narration or "") < _MIN_NARRATION_CHARS:
            return 0
        roster = "\n".join(f"- {p['id']}: {str(p.get('name') or 'someone')[:60]}" for p in people)
        reply = await llm([
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": f"PRESENT:\n{roster}\n(the player is: player)\n\nTHE NARRATION:\n{narration[:1800]}\n\nJSON:"},
        ])
        accepted = 0
        for entry in clean_entries(_parse(reply or ""), {p["id"] for p in people}):
            res = await write(entry)
            if isinstance(res, dict) and res.get("accepted") is True:
                accepted += 1
        return accepted
    except Exception as e:  # fail-soft: the ledger is enrichment, never the turn
        logger.debug(f"[open-ledger] skipped: {e}")
        try:
            from src import log_rings
            log_rings.record_soft_failure("open-ledger:capture-failed", e, corrected="the show goes on without it")
        except Exception:  # failsoft-ok: recorder-self
            pass
        return 0


async def after_turn(narration: str, owner, endpoint_url, model, headers) -> int:
    """The live hook (called from the agent loop's end-of-turn banking). Off when the Show Brief is off."""
    try:
        from src.orwell_show_brief import show_brief_enabled
        if not show_brief_enabled():
            return 0
        from src.llm_core import llm_call_async
        from src import orwell_engine as _oe

        wa = await _oe.whereabouts(user=owner)
        present = (wa.get("present") if isinstance(wa, dict) else None) or []

        async def _llm(messages: list) -> str:
            return await llm_call_async(url=endpoint_url, model=model, messages=messages, headers=headers,
                                        temperature=0.2, max_tokens=700, timeout=30,
                                        call_class="utility-extraction", user=(owner or "default"))

        async def _write(payload: dict) -> dict:
            return await _oe.record_open_ledger(payload, user=owner)

        return await capture_open_ledger(narration, present, _llm, _write)
    except Exception as e:
        logger.debug(f"[open-ledger] hook skipped: {e}")
        try:
            from src import log_rings
            log_rings.record_soft_failure("open-ledger:hook-failed", e, corrected="the show goes on without it", user=owner)
        except Exception:  # failsoft-ok: recorder-self
            pass
        return 0
