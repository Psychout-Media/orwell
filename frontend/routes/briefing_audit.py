"""ORW-409: audit the final narrator briefing for blocks that contradict each other.

Pure and Vault-free: it only reads the text of the message list about to be sent and reports contradictions on these facts: part of day, whether the next event is
due now, who is present with the player, who is asleep (a sleeper named as present, arriving or interrupting), the player's room and the day number. When the turn's `Briefing` is passed, each
fact the prompt states is also checked against it. It parses the blocks the front end itself generates (the engine's GAME CONTEXT lines, the production call / not-yet
steers, the hang-out steer, the movement cue). Report-only: it never edits the prompt.
"""
import re
from typing import Iterable

_PARTS = {"morning", "afternoon", "evening", "night", "late night", "early morning", "midday"}
_TOD_RE = re.compile(r"^\s*-\s*(?:(?:Time of day|Part of the day):|The night is over: it is now)\s*([A-Za-z -]+?)(?:\s*[(.]|$)", re.IGNORECASE | re.MULTILINE)
_DUE_NOW_RE = re.compile(r"production is calling everyone|production calls everyone|the scheduled event is on now|^\s*-\s*IT IS TIME:[^\n]*is starting NOW", re.IGNORECASE | re.MULTILINE)  # the last form is the GAME CONTEXT's own daySchedule line (momentPrompts.ts)
_IMMINENT_RE = re.compile(r"production gives notice|is about to be called", re.IGNORECASE)
_NOT_DUE_RE = re.compile(r"production hasn'?t called|is not due until|^\s*-\s*COMING UP:", re.IGNORECASE | re.MULTILINE)
_WITH_RE = re.compile(r"^\s*With you:\s*(.+?)\.?\s*$", re.IGNORECASE | re.MULTILINE)
_LEFT_RE = re.compile(r"MOVEMENT IN THE ROOM[^\n]*?—\s*([^\n]*?)(?:\.\s+Voice it as a natural beat|$)", re.MULTILINE)  # the clauses only: the cue's own instruction sentence holds a ";" that must not be read as a clause
_ASLEEP_RE = re.compile(r"Still asleep \(\d+\):\s*(.+?)\.\s", re.IGNORECASE)
_INTERRUPT_RE = re.compile(r"AN INTERRUPTION \(engine-decided\):\s*(.+?) steps into")
_ROOM_RE = re.compile(r"^\s*Your room: the ([A-Za-z -]+?) \(", re.MULTILINE)
_MOVE_ROOM_RE = re.compile(r"(?:left|come into) the ([A-Za-z -]+?)(?:;|\.\s|$)")
_GONE_RE = re.compile(r"\b(?:left|gone to sleep)\b")  # a movement clause whose people are no longer awake in the room
_DAY_RE = re.compile(r"-\s*Clock:[^\n]*?\bDay (\d+)", re.IGNORECASE)


def _text(messages: Iterable) -> str:
    out = []
    for m in messages or []:
        c = m.get("content") if isinstance(m, dict) else None
        if isinstance(c, str):
            out.append(c)
        elif isinstance(c, list):
            out.extend(p.get("text", "") for p in c if isinstance(p, dict) and isinstance(p.get("text"), str))
    return "\n\n".join(out)


def _names(s: str) -> set:
    return {n.strip() for n in re.split(r",|\band\b", re.sub(r"\([^)]*\)", "", s)) if n.strip()}


def audit_briefing(messages, briefing=None) -> list:
    """Return [{"fact": "part-of-day"|"event-due"|"presence"|"asleep"|"player-room"|"day", "detail": str}, ...]; empty when the blocks agree (and with `briefing`, agree with it). Report-only."""
    t = _text(messages)
    found = []
    parts = {v for v in (re.sub(r"[-\s]+", " ", x.lower()).strip() for x in _TOD_RE.findall(t)) if v in _PARTS}
    if len(parts) > 1:
        found.append({"fact": "part-of-day", "detail": "blocks name different parts of the day: " + ", ".join(sorted(parts))})
    if _DUE_NOW_RE.search(t) and _NOT_DUE_RE.search(t):
        found.append({"fact": "event-due", "detail": "one block says the event is on now, another says production has not called it"})
    w = _WITH_RE.search(t)
    mv = _LEFT_RE.search(t)
    if w and mv:
        here = _names(w.group(1)) if not w.group(1).lower().startswith("no one") else set()
        left, came = set(), set()
        for clause in mv.group(1).split(";"):
            who = _names(re.sub(r"\s+(?:has|have)\s+(?:left|come into|gone to sleep)\b.*", "", clause))
            (left if _GONE_RE.search(clause) else came).update(who)
        bad = sorted((left & here) | (came - here))
        if bad:
            found.append({"fact": "presence", "detail": "movement cue and 'With you' disagree about: " + ", ".join(bad)})
    found.extend(_audit_asleep_room_day(t, w, mv, briefing))
    if briefing is not None:
        found.extend(_audit_against(t, parts, briefing))
    return found


def _audit_asleep_room_day(t: str, w, mv, briefing) -> list:
    out = []
    a = _ASLEEP_RE.search(t + " ")
    asleep = _names(a.group(1)) if a else set(briefing.asleep if briefing is not None else ())
    if asleep:
        talking = set()
        if w and not w.group(1).lower().startswith("no one"):
            talking |= _names(w.group(1))
        if mv:
            for clause in mv.group(1).split(";"):
                if not _GONE_RE.search(clause):
                    talking |= _names(re.sub(r"\s+(?:has|have)\s+come into\b.*", "", clause))
        i = _INTERRUPT_RE.search(t)
        if i:
            talking |= _names(i.group(1))
        bad = sorted(asleep & talking)
        if bad:
            out.append({"fact": "asleep", "detail": "listed as asleep and also present, arriving or interrupting: " + ", ".join(bad)})
    rooms = {r.strip().lower() for r in _ROOM_RE.findall(t)}
    if mv:
        rooms |= {r.strip().lower() for r in _MOVE_ROOM_RE.findall(mv.group(1))}
    if len(rooms) > 1:
        out.append({"fact": "player-room", "detail": "blocks name different rooms for the player: " + ", ".join(sorted(rooms))})
    days = set(_DAY_RE.findall(t))
    if len(days) > 1:
        out.append({"fact": "day", "detail": "blocks name different days: " + ", ".join(sorted(days))})
    return out


def _audit_against(t: str, parts: set, b) -> list:
    out = []
    if b.part_of_day and parts and parts != {b.part_of_day.lower()}:
        out.append({"fact": "part-of-day", "detail": "a block's part of day differs from the briefing's (" + b.part_of_day + ")"})
    if b.next_day == "tomorrow" and _IMMINENT_RE.search(t):
        out.append({"fact": "event-due", "detail": "a block says the event is about to be called but the briefing says it is tomorrow"})
    if b.due is False and _DUE_NOW_RE.search(t):
        out.append({"fact": "event-due", "detail": "a block says the event is on now but the briefing says it is not due"})
    if b.location:
        rooms = {r.strip().lower().replace(" ", "-") for r in _ROOM_RE.findall(t)}
        if rooms and rooms != {b.location.lower()}:
            out.append({"fact": "player-room", "detail": "a block's room differs from the briefing's (" + b.location + ")"})
    if b.day is not None:
        days = set(_DAY_RE.findall(t))
        if days and days != {str(b.day)}:
            out.append({"fact": "day", "detail": f"a block's day differs from the briefing's ({b.day})"})
    # The engine's "With you" line lists AWAKE people only (src/engine/momentPrompts.ts:1280-1296 renders `whereabouts.present`, which the adapter builds with the awake filter at
    # src/adapters/engine/GameSessionAdapter.ts:5761-5765); sleepers are named by the front end's own "Still asleep" line. So it is compared with the awake set, never with everyone in the room.
    here = {n.lower() for n in b.awake_present}
    wm = _WITH_RE.search(t)
    if wm:
        said = set() if wm.group(1).lower().startswith("no one") else {n.lower() for n in _names(wm.group(1))}  # review of #2755: "No one" is the empty set, compared like any other
        if b.location and said != here:
            out.append({"fact": "presence", "detail": "'With you' differs from the briefing's present list"})
    return out
