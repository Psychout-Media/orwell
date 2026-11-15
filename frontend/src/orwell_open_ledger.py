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
import os
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
    "addressed or be a party; about may also be someone from the ELSEWHERE list. addressedTo may be empty. "
    "Copy what was said; invent nothing. Skip small talk and anything already finished in the scene. "
    "A formal agreement between the player and one houseguest (a mutual deal to protect, vote, or go to the end together) is "
    "recorded elsewhere as a deal: leave it out, do not extract it as a pact or a promise. "
    "resolutions: ONLY for entries in the OPEN list, ONLY when this narration clearly shows that promise or claim kept, "
    "broken or taken back. "
    'Most turns have none: reply {"entries":[],"resolutions":[]} when unsure.'
)


def _system_prompt() -> str:
    """The extraction prompt behind the repo's untrusted-data fence: the narration quotes the player's own words, so
    text addressed to the extractor is data to judge, never an instruction (same fence as the other extractions)."""
    from src.agent_loop import _EXTRACTION_UNTRUSTED_FENCE
    return _EXTRACTION_UNTRUSTED_FENCE + _SYSTEM


def _record_full(user: Optional[str]) -> None:
    """The engine refused a write because the ledger is full (either bound). Loud, not silent: one soft failure with a
    stable id, so it shows on the admin status page. Called at most once per turn."""
    from src import log_rings
    log_rings.record_soft_failure("open-ledger:full", RuntimeError("the engine refused an open-ledger write: full"),
                                  corrected="the entry was not kept; resolve or withdraw old ones", user=user)


# ── grounding: is an extracted entry really in the narration? ────────────────────────────────────────────────────────────
# The extraction is a second model. "Copy what was said; invent nothing" is an instruction, not a guarantee, and an entry the
# narration never contained would be remembered by the engine as something that was said. Each entry is therefore compared
# with the narration the extractor was given. What to DO with a weak one is the owners' call (a strict rule also drops
# faithful entries when the narration reports speech indirectly and the extractor turns it into a quote), so the default
# only measures: mode `report` keeps every entry and records how many were weak; `strict` drops them; `off` skips the check.
GROUNDING_MIN = 0.6
_GROUND_WORD = re.compile(r"[^\W_]{3,}")


def _plain(t: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[\"'\u2018\u2019\u201c\u201d`*_]+", "", (t or "").lower())).strip()


def grounding(text: str, narration: str) -> float:
    """How much of an entry's wording is in the narration it came from, 0.0 to 1.0: 1.0 when the sentence appears there as
    written (case, quote marks, spacing and a closing full stop aside); otherwise the share of its words of three letters or
    more that occur anywhere in the narration. Says nothing about meaning: a faithful paraphrase scores low. In a script
    written without spaces a sentence is one run of letters, so anything not as written scores about 0: `strict` would drop
    nearly every such entry."""
    a, b = _plain(text), _plain(narration)
    if not a:
        return 0.0
    core = a.rstrip(".!?").strip()
    # as written, on whole words: a short entry ("ok") must not count as present because it sits inside another word ("broke")
    if core and re.search(r"(?<![^\W_])" + re.escape(core) + r"(?![^\W_])", b):
        return 1.0
    words = _GROUND_WORD.findall(a)
    if not words:
        return 0.0
    have = set(_GROUND_WORD.findall(b))
    return sum(1 for w in words if w in have) / len(words)


def grounding_mode() -> str:
    """`ORWELL_OPEN_LEDGER_GROUNDING`: `report` (default: keep every entry, record the weak ones), `strict` (drop the weak
    ones), `off` (no check)."""
    v = str(os.environ.get("ORWELL_OPEN_LEDGER_GROUNDING", "")).strip().lower()
    return v if v in ("strict", "off") else "report"


def _record_weak_grounding(user: Optional[str], weak: int, total: int, lowest: float, dropped: bool) -> None:
    """One admin-visible observation per turn that had a weakly grounded entry: counts and the lowest score only, never the
    entry's text. Not a failure (nothing went wrong in the pipeline), so it is not RED."""
    try:
        what = "dropped" if dropped else "kept (report mode)"
        logger.info(f"[open-ledger] grounding: {weak} of {total} extracted entr{'y' if total == 1 else 'ies'} under {GROUNDING_MIN:.0%} "
                    f"word overlap with the narration (lowest {lowest:.0%}); {what}")
        from src import log_rings
        log_rings.record_overseer(
            "observation", "open-ledger:weak-grounding",
            f"{weak} of {total} extracted entries share under {GROUNDING_MIN:.0%} of their words with the narration "
            f"(lowest {lowest:.0%}); {what}",
            lever=("drop" if dropped else None), ok=True, user=user)
    except Exception:  # failsoft-ok: recorder-self
        pass


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
        seen.add(t.lower())
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
                              resolve: Optional[WriteFn] = None, owner: Optional[str] = None) -> int:
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
            {"role": "system", "content": _system_prompt()},
            {"role": "user", "content": f"{user}\nTHE NARRATION:\n{narration[:1800]}\n\nJSON:"},
        ])
        parsed = _parse(reply or "")
        known = {p["id"]: str(p.get("name") or "") for p in people + away}
        accepted = 0
        refused_full = False
        mode = grounding_mode()
        entries = clean_entries(parsed, {p["id"] for p in people}, known)
        weak, lowest = 0, 1.0
        for entry in entries:
            if mode != "off":
                score = grounding(entry["text"], narration[:1800])  # against exactly what the extractor was shown
                if score < GROUNDING_MIN:
                    weak += 1
                    lowest = min(lowest, score)
                    if mode == "strict":
                        continue
            res = await write(entry)
            if isinstance(res, dict) and res.get("accepted") is True:
                accepted += 1
            elif isinstance(res, dict) and res.get("reason") == "full":
                refused_full = True
        if refused_full:
            _record_full(owner)  # once per turn, however many writes were refused
        if weak:
            _record_weak_grounding(owner, weak, len(entries), lowest, dropped=(mode == "strict"))
        if resolve is not None and opens:
            for r in clean_resolutions(parsed, {o["id"] for o in opens}):
                res = await resolve(r)
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
        from src import orwell_engine as _oe0
        if not _oe0.engine_flag("openLedger", default=True):  # the engine has it off: every write would be refused. Unknown flag: carry on
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

        return await capture_open_ledger(narration, present, _llm, _write, elsewhere, open_items, _resolve, owner=owner)
    except Exception as e:
        logger.debug(f"[open-ledger] hook skipped: {e}")
        try:
            from src import log_rings
            log_rings.record_soft_failure("open-ledger:hook-failed", e, corrected="the show goes on without it", user=owner)
        except Exception:  # failsoft-ok: recorder-self
            pass
        return 0
