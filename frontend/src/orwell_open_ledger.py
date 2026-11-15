"""Open ledger (ORW-407, slices 1 and 2) - the FRONT-END half of the commitment/claim write-back.

After a narrated turn, one small constrained extraction asks a utility model which commitments or claims the narration
newly put between the PLAYER and a houseguest who is in the room (a promise made to or by the player, a reveal, an
assertion), as free text: ``{text, speaker, addressedTo, kind}`` where ``kind`` is any short phrase, never a fixed list.
Each is written BACK with ``recordOpenLedger``; the engine re-validates, derives the witnesses from its own presence,
de-duplicates, stores it, and shows it back in the narrator's brief while that houseguest is present.

Hard rules: best-effort and fail-soft (no model, a bad reply, a refused write => nothing happens); it only relays what the
narration already said, built from the player-visible narration and the public presence list (names and ids), never any
hidden state; sends the four fields plus, when the narration has them, ``parties`` (a group pact) and ``about`` (who or what
a claim concerns, free text). Slice 2 also marks an entry kept / broken / withdrawn (``resolutions``) when the narration clearly
shows it. Per turn it writes at most ``MAX_ENTRIES_PER_TURN`` entries and ``MAX_RESOLUTIONS_PER_TURN`` resolutions. Tests never need a live model: the extraction fn is injectable.
"""
from __future__ import annotations

import json
import logging
import re
from typing import Awaitable, Callable, Optional

logger = logging.getLogger(__name__)

TEXT_MAX_CHARS = 240      # the engine's cap; longer ones are DROPPED, never truncated
KIND_MAX_CHARS = 40
ABOUT_MAX_CHARS = 80
NOTE_MAX_CHARS = 160
PARTIES_MAX = 8
MAX_ENTRIES_PER_TURN = 3
MAX_RESOLUTIONS_PER_TURN = 2
_RESOLUTIONS = ("kept", "broken", "withdrawn")
_MIN_NARRATION_CHARS = 80

LlmFn = Callable[[list], Awaitable[str]]
WriteFn = Callable[[dict], Awaitable[dict]]

_SYSTEM = (
    "You extract what a Big Brother narration puts on the record in the player's hearing, as free text: a promise, threat, "
    "offer or reveal between two people; a PACT or proposal among a GROUP (e.g. if one of us wins the rest are safe); a "
    "CLAIM one houseguest makes ABOUT another; a stated PLAN or intention voiced in front of the player. Reply "
    "IMMEDIATELY with ONLY a JSON object, no prose, no code fence: "
    '{"entries":[{"text":"<their words, verbatim or nearly, one sentence>","speaker":"<id from the list, or player>",'
    '"addressedTo":["<id or player>"],"kind":"<a short free phrase, any words>",'
    '"parties":["<every id party to a group pact>"],"about":"<who or what a claim concerns: an id from the list, else a few words>"}],'
    '"resolutions":[{"entryId":"<id from the OPEN list>","status":"kept|broken|withdrawn","note":"<why, one short sentence>"}]} . '
    "parties and about are optional: leave them out when they do not apply. Only people from the PRESENT list may speak, be "
    "addressed or be a party; about may also be someone from the ELSEWHERE list. addressedTo may be empty and holds at most four ids "
    "(use parties for a larger group pact). "
    "Copy what was said; invent nothing. Skip small talk and anything already finished in the scene. "
    "resolutions: ONLY for entries in the OPEN list, ONLY when this narration clearly shows that promise or claim kept, "
    "broken or taken back. "
    'Most turns have none: reply {"entries":[],"resolutions":[]} when unsure.'
)


def _norm(v: str, limit: int) -> str:
    return re.sub(r"\s+", " ", v).strip()[:limit].strip()


def clean_entries(raw: object, allowed_ids: set[str], known: Optional[dict] = None) -> list[dict]:
    """Entries from an extraction reply, bounded: well-formed, known ids only, text <= 240 chars (longer ones dropped, not
    truncated), one line, no duplicates, at most ``MAX_ENTRIES_PER_TURN``. ``known`` maps every houseguest the player can
    name (id -> name, present or elsewhere): a claim's ``about`` that is an id or a name from it becomes that id."""
    items = raw.get("entries") if isinstance(raw, dict) else None
    ok_ids = set(allowed_ids) | {"player"}
    by_name = {str(n).strip().lower(): i for i, n in (known or {}).items() if str(n).strip()}
    out: list[dict] = []
    seen: set = set()  # (speaker, normalized text): the engine keeps identical words from different speakers as distinct entries
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        text, speaker, to, kind = it.get("text"), it.get("speaker"), it.get("addressedTo"), it.get("kind")
        if not (isinstance(text, str) and isinstance(speaker, str) and isinstance(to, list) and isinstance(kind, str)):
            continue
        t = re.sub(r"\s+", " ", text).strip().strip('"').strip()
        if not t or len(t) > TEXT_MAX_CHARS or (speaker if isinstance(speaker, str) else "", t.lower()) in seen:
            continue
        if speaker not in ok_ids or any(not isinstance(a, str) or a not in ok_ids or a == speaker for a in to):
            continue
        parties = it.get("parties")
        if parties is not None and not (isinstance(parties, list) and len(parties) <= PARTIES_MAX
                                        and all(isinstance(a, str) and a in ok_ids for a in parties)):
            continue
        about = it.get("about")
        if about is not None and not isinstance(about, str):
            continue
        k = _norm(kind, KIND_MAX_CHARS) or "claim"
        entry: dict = {"text": t, "speaker": speaker, "addressedTo": list(dict.fromkeys(to)), "kind": k}
        group = list(dict.fromkeys(parties or []))
        if len(group) > 1:
            entry["parties"] = group
        ab = _norm(about, ABOUT_MAX_CHARS) if isinstance(about, str) else ""
        if ab:
            entry["about"] = ab if ab in (known or {}) else by_name.get(ab.lower(), ab)
        seen.add((speaker, t.lower()))
        out.append(entry)
        if len(out) >= MAX_ENTRIES_PER_TURN:
            break
    return out


def clean_resolutions(raw: object, open_ids: set[str]) -> list[dict]:
    """Resolutions from an extraction reply: only for entries that were offered as open, a status in kept/broken/withdrawn,
    a short one-line note, no repeats, at most ``MAX_RESOLUTIONS_PER_TURN``."""
    items = raw.get("resolutions") if isinstance(raw, dict) else None
    out: list[dict] = []
    done: set[str] = set()
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        eid, status, note = it.get("entryId"), it.get("status"), it.get("note")
        if not (isinstance(eid, str) and eid in open_ids and eid not in done and status in _RESOLUTIONS and isinstance(note, str)):
            continue
        done.add(eid)
        out.append({"entryId": eid, "status": status, "note": _norm(note, NOTE_MAX_CHARS)})
        if len(out) >= MAX_RESOLUTIONS_PER_TURN:
            break
    return out


def _parse(reply: str) -> object:
    """The LAST brace-balanced JSON object in a (possibly reasoning-prefixed) reply with an ``entries`` or ``resolutions`` key, or None."""
    for m in reversed([m.start() for m in re.finditer(r"\{", reply or "")]):
        depth = 0
        for j in range(m, len(reply)):
            depth += (reply[j] == "{") - (reply[j] == "}")
            if depth == 0:
                try:
                    obj = json.loads(reply[m:j + 1])
                except ValueError:
                    break
                if isinstance(obj, dict) and ("entries" in obj or "resolutions" in obj):
                    return obj
                break
    return None


async def capture_open_ledger(narration: str, present: list[dict], llm: LlmFn, write: WriteFn,
                              elsewhere: Optional[list[dict]] = None, open_items: Optional[list[dict]] = None,
                              resolve: Optional[WriteFn] = None) -> int:
    """Extract the narration's newly stated commitments, pacts, claims and plans, and any open entry it shows kept, broken
    or withdrawn, and write them back. ``present`` is the public presence list ``[{id, name}]`` (houseguests in the player's
    room); ``elsewhere`` the same for people nearby (a claim may be ABOUT them); ``open_items`` the engine's still-open
    entries for those here. Returns how many writes the engine ACCEPTED. Never raises."""
    try:
        people = [p for p in present if isinstance(p, dict) and isinstance(p.get("id"), str) and p["id"]]
        if not people or len(narration or "") < _MIN_NARRATION_CHARS:
            return 0
        away = [p for p in (elsewhere or []) if isinstance(p, dict) and isinstance(p.get("id"), str) and p["id"]]
        opens = [o for o in (open_items or []) if isinstance(o, dict) and isinstance(o.get("id"), str) and isinstance(o.get("text"), str)]
        roster = "\n".join(f"- {p['id']}: {str(p.get('name') or 'someone')[:60]}" for p in people)
        user = f"PRESENT:\n{roster}\n(the player is: player)\n"
        if away:
            user += "\nELSEWHERE:\n" + "\n".join(f"- {p['id']}: {str(p.get('name') or 'someone')[:60]}" for p in away[:15]) + "\n"
        if opens and resolve is not None:
            user += "\nOPEN:\n" + "\n".join(f"- {o['id']}: {o['text'][:TEXT_MAX_CHARS]}" for o in opens[:5]) + "\n"
        reply = await llm([
            {"role": "system", "content": _SYSTEM},
            {"role": "user", "content": f"{user}\nTHE NARRATION:\n{narration[:1800]}\n\nJSON:"},
        ])
        parsed = _parse(reply or "")
        known = {p["id"]: str(p.get("name") or "") for p in people + away}
        accepted = 0
        for entry in clean_entries(parsed, {p["id"] for p in people}, known):
            try:  # review of #2721: one failing write must not discard the rest or misreport the count
                res = await write(entry)
            except Exception as e:
                logger.debug(f"[open-ledger] write skipped: {e}")
                continue
            if isinstance(res, dict) and res.get("accepted") is True:
                accepted += 1
        if resolve is not None and opens:
            for r in clean_resolutions(parsed, {o["id"] for o in opens}):
                try:
                    res = await resolve(r)
                except Exception as e:
                    logger.debug(f"[open-ledger] resolve skipped: {e}")
                    continue
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
        import os
        # review of #2692 / #2721: ORWELL_OPEN_LEDGER=0 (the engine's flag, default on) also skips the whereabouts read and the extraction model call
        if str(os.environ.get("ORWELL_OPEN_LEDGER", "")).strip().lower() in ("0", "false", "no", "off"):
            return 0
        from src.llm_core import llm_call_async
        from src import orwell_engine as _oe

        wa = await _oe.whereabouts(user=owner)
        present = (wa.get("present") if isinstance(wa, dict) else None) or []
        elsewhere = [p for r in ((wa.get("nearby") if isinstance(wa, dict) else None) or []) if isinstance(r, dict)
                     for p in (r.get("present") or [])]
        try:
            open_items = await _oe.open_ledger_here(user=owner)
        except Exception as e:  # failsoft-ok: open-ledger-optional-read (resolution is optional; new entries still go ahead)
            open_items = []
            try:
                from src import log_rings
                log_rings.record_soft_failure("open-ledger:open-read-failed", e, corrected="no resolutions this turn", user=owner)
            except Exception:  # failsoft-ok: recorder-self
                pass

        async def _llm(messages: list) -> str:
            return await llm_call_async(url=endpoint_url, model=model, messages=messages, headers=headers,
                                        temperature=0.2, max_tokens=700, timeout=30,
                                        call_class="utility-extraction", user=(owner or "default"))

        async def _write(payload: dict) -> dict:
            return await _oe.record_open_ledger(payload, user=owner)

        async def _resolve(payload: dict) -> dict:
            return await _oe.resolve_open_ledger(payload, user=owner)

        return await capture_open_ledger(narration, present, _llm, _write, elsewhere, open_items, _resolve)
    except Exception as e:
        logger.debug(f"[open-ledger] hook skipped: {e}")
        try:
            from src import log_rings
            log_rings.record_soft_failure("open-ledger:hook-failed", e, corrected="the show goes on without it", user=owner)
        except Exception:  # failsoft-ok: recorder-self
            pass
        return 0
