"""ORW-1156 part 1 - "no claim without commit".

The narration is free to say what happened. The engine is the only thing that makes it happen. This module is the second reader that joins the two: after generation and before display it
extracts the STATE CLAIMS in a reply (the player goes to sleep, a bed is claimed, an alliance or deal is formed, the player is in a room, time passes) and checks each against what the engine
committed this turn (the turn's tool events, plus the Vault-free state read the pre-display check already holds). Pure functions, fail-open, no rng, no model call.

  * `extract_claims(text)`            the claims a sentence of narration makes, outside quoted speech. Modals, questions, plans, the past and the future claim nothing.
  * `claim_conflicts(text, state, owner)`  the claims with NO commit behind them, as predisplay `Conflict`-shaped (fact, detail) pairs. `predisplay_check.conflict_details` appends them, so the existing
                                      withhold -> regenerate-against-the-real-state -> drop-what-still-conflicts path (ORW-408) handles them with no second mechanism.
  * `commit_plan(...)`                when the PLAYER explicitly asked for the claimed change (their own message), the real tool that commits it: a bed -> claimBed, a move -> moveTo (sleep is ORW-1154's).
                                      Never an alliance or a deal (the player's own yes is the only commit; a claim of one with no commit is regenerated, never committed).
  * The turn's commits are noted by `CommitList`, a drop-in for the loop's `tool_events` list, so no call site needs a second bookkeeping line.
  * Time: the time-passing rule is ORW-1150's `predisplay_check.time_jump_conflict`; this module CALLS it (when present) and never restates it.

Every check is logged ("[claim-check] kind outcome") and counted (`stats()`, on /api/admin/health as `claimCommit`). Numbers and kind names only; no text, no names.
"""
from __future__ import annotations

import logging
import re
import threading
from typing import Any, Iterable, NamedTuple, Optional

logger = logging.getLogger(__name__)

CLAIM_SLEEP = "claim-sleep"
CLAIM_BED = "claim-bed"
CLAIM_ALLIANCE = "claim-alliance"
CLAIM_DEAL = "claim-deal"
CLAIM_ROSTER = "claim-roster"  # ORW-1178: a group the narration names by the engine's own alliance name, with houseguests the engine does not hold in it
KINDS = (CLAIM_BED, CLAIM_ALLIANCE, CLAIM_DEAL, CLAIM_ROSTER)  # sleep is NOT checked here: ORW-1154 (#3496) holds an unbacked sleep claim; this module keeps only what it does not cover
FACTS = frozenset(KINDS)
# the claim kinds the existing pre-display facts already cover (counted here as claims too, so one ledger shows every class)
EXTERNAL_KINDS = ("move", "time", "presence")


class Claim(NamedTuple):
    kind: str
    sentence: str


# ── what the engine committed this turn ─────────────────────────────────────────────────────────────────────────────
_LOCK = threading.Lock()
_TURN: "dict[str, dict]" = {}  # owner -> {"ok": {tool: n}, "failed": {tool: n}}; cleared by `end_turn`
_MAX_OWNERS = 64
_BAD_OUT = re.compile(r'"(?:refused|illegal|held|error)"\s*:\s*(?!false|null)|\b(?:held|refused|not allowed|could not)\b', re.IGNORECASE)
_BED_TOOLS = ("claimBed",)
_ALLIANCE_TOOLS = ("formAlliance", "joinAlliance")
_DEAL_TOOLS = ("makeDeal", "submitDecision")


def _okey(owner: Any) -> str:
    return "" if owner is None else str(owner)


def event_applied(ev: Any) -> bool:
    """True when a tool event is a tool that RAN and was not refused. Admin-only `engine_result` (the full result) is read when present; the direct belts carry only an exit code."""
    if not isinstance(ev, dict) or not ev.get("tool"):
        return False
    if ev.get("exit_code") not in (0, None):
        return False
    for key in ("engine_result", "output"):
        v = ev.get(key)
        if v and _BAD_OUT.search(v if isinstance(v, str) else str(v)[:4000]):
            return False
    return True


def note_event(owner: Any, ev: Any) -> None:
    try:
        if not isinstance(ev, dict) or not ev.get("tool"):
            return
        with _LOCK:
            if len(_TURN) >= _MAX_OWNERS and _okey(owner) not in _TURN:
                _TURN.pop(next(iter(_TURN)), None)
            t = _TURN.setdefault(_okey(owner), {"ok": {}, "failed": {}})
            d = t["ok" if event_applied(ev) else "failed"]
            d[str(ev["tool"])] = d.get(str(ev["tool"]), 0) + 1
    except Exception:  # failsoft-ok: bookkeeping only; a missed note can only cost a regenerate, never a wrong commit
        pass


class CommitList(list):
    """A `tool_events` list that tells the claim check what the engine committed. Behaves exactly like a list."""

    def __init__(self, owner: Any = None):
        super().__init__()
        self._owner = owner

    def append(self, ev):  # type: ignore[override]
        super().append(ev)
        note_event(self._owner, ev)


def committed(owner: Any, tools: Iterable[str]) -> bool:
    with _LOCK:
        ok = (_TURN.get(_okey(owner)) or {}).get("ok") or {}
        return any(ok.get(t) for t in tools)


def end_turn(owner: Any) -> None:
    with _LOCK:
        _TURN.pop(_okey(owner), None)


# ── extracting claims ───────────────────────────────────────────────────────────────────────────────────────────────
# A sentence claims a change only in the plain indicative: no modal, question, wish, plan, condition, negation or past/future marker.
_NOT_A_CLAIM = re.compile(
    r"\w+n['\u2019]t\b|\b(?:could|would|might|may|should|can|can't|cannot|won't|will|shall|if|whether|unless|want\w*|wish\w*|hope\w*|plan\w*|try\w*|about\s+to|ready\s+to|"
    r"not|never|nobody|no\s+one|yet|almost|nearly|until|tomorrow|tonight|later|someday|once|when|as\s+soon\s+as|imagin\w+|dream\w*\s+of|rather|instead|had|has\s+been\s+offered|offers?|pitch\w*|propos\w+|ask\w*|suggest\w*)\b|\?",
    re.IGNORECASE)
# ORW-1190: a reference to something the engine already holds (a past act, a time marker), someone else's act, speech with a tag outside the quotes, and ordinary nouns are not NEW claims.
_BACK_REF = re.compile(
    r"\b(?:yesterday|last|ago|earlier|since|still|already|previously|formerly|once\s+more|week\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)|day\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)|"
    r"(?:first|second|third|opening|other)\s+(?:day|night|week)|this\s+(?:morning|afternoon|evening)|the\s+(?:other|next)\s+(?:day|night)|weeks?|months?|nights?\s+ago|that\s+(?:night|day|morning)|remember\w*|recall\w*)\b",
    re.IGNORECASE)
_SPEECH_TAG = re.compile(r",\s+(?:\w+\s+){0,2}?(?:says|said|asks|asked|whispers|whispered|replies|replied|murmurs|murmured|mutters|muttered|tells\s+you|told\s+you|answers|answered|adds|added|"
                         r"announces|announced|laughs|laughed|grins|grinned|calls|called|cheers|cheered|beams|beamed|declares|declared)\b", re.IGNORECASE)
_OTHERS_ACT = re.compile(r"\bbetween\b(?!.*\byou\b)", re.IGNORECASE)
_NOT_PERSON_OBJ = re.compile(r"\b(?:deal|bargain|agreement|promise|pact)\s+(?:with|for|about|over|on)\s+(?:the|a|an|my|your|his|her|their|its|this|that|some|yourself|myself|himself|herself|themselves|me)\b|"
                             r"\b(?:yourself|myself|himself|herself|themselves)\b|\b(?:crew|squad|core)\s+of\s+(?:two|the\s+house)\b|\bthe\s+core\s+of\b|\b(?:bed|bunk)s?\s+(?:sheets?|frames?|linens?|spreads?|posts?|time|side|head|roll)\b|"
                             r"\b(?:bed|bunk)s?\s+from\s+the\s+(?:storage|closet|garage|attic|shed|pile|cupboard)\b", re.IGNORECASE)


def _not_a_new_claim(sent: str) -> bool:
    return bool(_NOT_A_CLAIM.search(sent) or _BACK_REF.search(sent) or _SPEECH_TAG.search(sent) or _OTHERS_ACT.search(sent) or _NOT_PERSON_OBJ.search(sent))


_YOU = r"(?:you(?:['’]ve|\s+have)?|your\s+body)"
_SLEEP_RE = re.compile(
    r"\b" + _YOU + r"\s+(?:\w+ly\s+|finally\s+|soon\s+|quickly\s+|just\s+)*(?:fall|fell|drift|drifted|doze|dozed|slip|slipped|sink|sank|nod|nodded)s?\s+(?:off|asleep|into\s+(?:a\s+|an\s+)?(?:deep\s+|heavy\s+|fitful\s+|easy\s+)?(?:sleep|slumber))\b|"
    r"\b" + _YOU + r"\s+(?:\w+ly\s+|finally\s+|then\s+)*(?:turn|turned|call\s+it|called\s+it)\s+(?:in|a\s+night)\b|"
    r"\b" + _YOU + r"\s+(?:\w+ly\s+|finally\s+|then\s+)*(?:go|went|head|headed|climb|climbed|crawl|crawled|tuck|tucked|settle|settled)\s+(?:\w+\s+){0,2}?(?:to\s+bed|to\s+sleep|into\s+(?:your\s+|the\s+|a\s+)?(?:own\s+)?(?:bed|bunk)|in\s+for\s+the\s+night)\b|"
    r"\b(?:sleep|slumber|exhaustion)\s+(?:takes|claims|finds|pulls|carries|overtakes)\s+you\b|\bthe\s+lights?\s+(?:go|went)\s+out\s+for\s+you\b|"
    r"\b" + _YOU + r"\s+(?:\w+\s+)?(?:sleep|slept)\s+(?:through|until|till|soundly|deeply|well|badly|fitfully)\b",
    re.IGNORECASE)
_BED_RE = re.compile(
    r"\b" + _YOU + r"\s+(?:\w+ly\s+|quickly\s+|finally\s+|then\s+)*(?:claim|claimed|take|took|grab|grabbed|pick|picked|choose|chose|stake|staked|snag|snagged|secure|secured|settle\s+(?:on|into)|settled\s+(?:on|into))\s+"
    r"(?:\w+\s+){0,3}?(?:bed|bunk|bunks|beds|(?:double|single)(?=\s*(?:[.,;!?:]|$|bed\b|bunk\b|in\b|by\b|near\b|at\b|on\b|for\b|of\b|and\b|but\b)))\b|\b(?:the|that|this)\s+(?:\w+\s+)?(?:bed|bunk)\s+(?:is|becomes|now\s+is|belongs\s+to)\s+(?:yours|now\s+yours|you)\b|"
    r"\b(?:calls?|called)\s+dibs\b[^.!?]{0,30}\b(?:bed|bunk)\b",
    re.IGNORECASE)
_ALLIANCE_NOUN = r"(?:alliance|pact|trio|quartet|final\s+(?:two|three|four)|crew|squad)"
_ALLIANCE_RE = re.compile(
    r"\b" + _YOU + r"\s+(?:\w+\s+){0,2}?(?:form|formed|forge|forged|seal|sealed|join|joined|agree\s+to|agreed\s+to|swear|swore|shake\s+on|shook\s+on)\s+(?:\w+\s+){0,3}?" + _ALLIANCE_NOUN + r"\b|"
    r"\b(?:the|an?|your|new|their|our)\s+(?:\w+\s+){0,2}?" + _ALLIANCE_NOUN + r"\s+(?:is|was|has\s+been|is\s+now|becomes|became)\s+(?:formed|sealed|official|born|made|set)\b|"
    r"\bwelcome\s+to\s+the\s+" + _ALLIANCE_NOUN + r"\b|\b" + _YOU + r"(?:['’]re|\s+are)\s+(?:now\s+)?(?:in|part\s+of|a\s+member\s+of)\s+(?:the|an?)\s+(?:\w+\s+){0,2}?" + _ALLIANCE_NOUN + r"\b",
    re.IGNORECASE)
_DEAL_RE = re.compile(
    r"\b" + _YOU + r"\s+(?:\w+\s+){0,2}?(?:strike|struck|make|made|seal|sealed|close|closed|shake\s+on|shook\s+on|agree\s+to|agreed\s+to|cut)\s+(?:\w+\s+){0,3}?(?:deal|bargain|agreement|promise)\b|"
    r"\b(?:the|a|your)\s+(?:\w+\s+)?(?:deal|bargain|agreement)\s+(?:is|was|has\s+been)\s+(?:struck|sealed|made|done|set|agreed)\b|\bit['’]s\s+a\s+deal\b",
    re.IGNORECASE)
_RULES = ((CLAIM_BED, _BED_RE), (CLAIM_ALLIANCE, _ALLIANCE_RE), (CLAIM_DEAL, _DEAL_RE))


def sleep_claims(text: str, *, in_quote: bool = False) -> "list[Claim]":
    """The sleep claims in narration. NOT part of the check (ORW-1154 owns an unbacked sleep claim); the gate corpus uses it to label what a turn narrated."""
    try:
        return [Claim(CLAIM_SLEEP, s.strip()) for s in _narration(text, in_quote) if not _NOT_A_CLAIM.search(s) and _SLEEP_RE.search(s)]
    except Exception:  # failsoft-ok: labels only
        return []


def _narration(text: str, in_quote: bool) -> "list[str]":
    from src import predisplay_check as pd
    return pd._sentences(pd._outside_quotes(text or "", in_quote))


def extract_claims(text: str, *, in_quote: bool = False) -> "list[Claim]":
    """The state claims the narration makes (one per sentence per kind). Quoted speech is a character talking, never the narrator stating what happened. Fail-open: any hiccup => []."""
    out: "list[Claim]" = []
    try:
        for sent in _narration(text, in_quote):
            if _not_a_new_claim(sent):
                continue
            for kind, rx in _RULES:
                if rx.search(sent):
                    out.append(Claim(kind, sent.strip()))
    except Exception:  # failsoft-ok: an unreadable check never holds narration
        return []
    return out


# ── checking claims against the committed state ─────────────────────────────────────────────────────────────────────


def _holds(kind: str, state: Any) -> bool:
    """ORW-1190: the engine's STANDING state already holds the thing (a bed the player owns, an alliance the player is in, a deal the player is party to). A reference to it is backed."""
    try:
        st = state if isinstance(state, dict) else {}
        if kind == CLAIM_BED:
            wh = st.get("whereabouts") if isinstance(st.get("whereabouts"), dict) else {}
            return bool(wh.get("playerBed") or st.get("playerBed"))
        if kind == CLAIM_ALLIANCE:
            return any(isinstance(a, dict) and (not a.get("members") or any(isinstance(m, dict) and m.get("id") == "player" for m in a.get("members") or [])) for a in (st.get("alliances") or []))
        if kind == CLAIM_DEAL:
            return any(isinstance(d, dict) and d.get("status", "open") in ("open", "kept") for d in (st.get("deals") or []))
    except Exception:  # failsoft-ok: no standing state read means the turn's commits decide
        return False
    return False


def backed(kind: str, state: Any, owner: Any) -> bool:
    if kind == CLAIM_BED:
        return committed(owner, _BED_TOOLS) or _holds(kind, state)
    if kind == CLAIM_ALLIANCE:
        return committed(owner, _ALLIANCE_TOOLS) or _holds(kind, state)
    if kind == CLAIM_DEAL:
        return committed(owner, _DEAL_TOOLS) or _holds(kind, state)
    return True


def unbacked(text: str, state: Any, owner: Any, *, in_quote: bool = False) -> "list[Claim]":
    return [c for c in extract_claims(text, in_quote=in_quote) if not backed(c.kind, state, owner)]


def _norm_group(t: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", re.sub(r"^the\s+", "", str(t or "").strip().lower())).strip()


def roster_conflict(text: str, state: Any, *, in_quote: bool = False) -> str:
    """ORW-1178: "" when fine, else the engine's real roster ("A, B, C") of an alliance the narration names but whose members it speaks wrongly.
    A sentence that names one of the engine's alliances (the player's own, or one pitched to them) AND names a houseguest the engine does not hold in that alliance is a roster the engine contradicts.
    Pure, fail-open, no model. The player is never a "named houseguest" here."""
    try:
        st = state if isinstance(state, dict) else {}
        groups = [g for k in ("alliances", "alliancePitches") for g in (st.get(k) or []) if isinstance(g, dict) and g.get("name")]
        if not groups:
            return ""
        from src import predisplay_check as pd
        people = {str(h.get("name")) for h in (st.get("house") or []) if isinstance(h, dict) and h.get("name")}
        for g in groups:
            people |= {str(m.get("name")) for m in (g.get("members") or []) if isinstance(m, dict) and m.get("name")}
        for sent in _narration(text, in_quote):
            low = _norm_group(sent)
            for g in groups:
                gname = _norm_group(g.get("name"))
                if not gname or not re.search(r"(?<![a-z0-9])" + re.escape(gname) + r"(?![a-z0-9])", low):
                    continue
                members = [str(m.get("name")) for m in (g.get("members") or []) if isinstance(m, dict) and m.get("name")]
                held = {f.lower() for n in members for f in pd._name_forms(n)}
                for person in sorted(people):
                    forms = pd._name_forms(person)
                    if any(f.lower() in held for f in forms):
                        continue
                    if any(re.search(r"(?<![A-Za-z])" + re.escape(f) + r"(?![A-Za-z])", sent) for f in forms):
                        return ", ".join(members)
        return ""
    except Exception:  # failsoft-ok: an unreadable check never holds narration
        return ""


def claim_conflicts(text: str, state: Any, owner: Any, *, in_quote: bool = False) -> "list[tuple[str, str]]":
    """[(fact, detail)] for each distinct claim kind in `text` that has no commit behind it. The detail is the engine's real value the correction names ("" when there is none)."""
    try:
        seen: "dict[str, str]" = {}
        st = state if isinstance(state, dict) else {}
        for c in unbacked(text, st, owner, in_quote=in_quote):
            if c.kind in seen:
                continue
            seen[c.kind] = ""
        roster = roster_conflict(text, st, in_quote=in_quote)  # ORW-1178: the narrated members must equal the engine's, committed or not
        if roster:
            seen[CLAIM_ROSTER] = roster
        return list(seen.items())
    except Exception:  # failsoft-ok: an unreadable check never holds narration
        return []


def correction_for(fact: str, detail: str = "") -> str:
    if fact == CLAIM_BED:
        return "The narration gave the player a bed but the game has not recorded a claim. Do not say a bed is claimed or theirs; show the beds as they are and leave the choice to the player."
    if fact == CLAIM_ALLIANCE:
        return "The narration formed an alliance but the player has not agreed to one and the game recorded none. Do not form, seal or join an alliance in the narration; houseguests may pitch one and the player answers."
    if fact == CLAIM_ROSTER:
        return ("The narration named the members of a group differently from the game. " + (f"The game holds exactly these in it: {detail}. " if detail else "")
                + "Name the group's members only as the game holds them; do not add a houseguest the game does not have in it.")
    if fact == CLAIM_DEAL:
        return "The narration struck a deal but the game recorded none. Do not say a deal is made; a houseguest may offer terms and the player answers."
    return ""


# ── committing what the player really asked for ─────────────────────────────────────────────────────────────────────
_ASK_BLOCK = re.compile(r"\b(?:should i|can i|do i|may i|am i|what if|don'?t|do not|won'?t|not going|never|refuse|instead of|rather than|can'?t|cannot|if\b)", re.IGNORECASE)
_ASK_SLEEP = re.compile(r"\b(?:go(?:ing)?\s+to\s+(?:bed|sleep)|turn(?:ing)?\s+in\b|(?:i\s+)?sleep\b|bed\b|good\s*night|lights\s+out|call\s+it\s+a\s+night|(?:i['’]m|i\s+am)\s+(?:going|heading)\s+to\s+(?:bed|sleep))", re.IGNORECASE)
_ASK_BED = re.compile(r"\b(?:claim|take|grab|pick|choose|get|dibs\s+on)\b[^.!?]{0,25}?\b(?:bed|beds|bunk|bunks)\b", re.IGNORECASE)


_BARE_SLEEP = re.compile(r"^\W*(?:(?:ok(?:ay)?|alright)[,\s]+)?(?:please\s+)?(?:sleep|bed|go\s+to\s+(?:sleep|bed)|time\s+(?:for|to)\s+(?:bed|sleep)|good\s*night|lights\s+out)(?:\s+now)?(?:[,\s]+please)?\W*$", re.IGNORECASE)


def _asked_sentence(user_text: str) -> str:
    from src import act_first as af
    t = af.strip_quotes(af.clean_text(user_text or "")).strip()
    if not t or _ASK_BLOCK.search(t) or "?" in t:
        return ""
    return t if (af._P1.search(t) or _BARE_SLEEP.match(t)) else ""


def commit_plan(conflicts: "Iterable[Any]", user_text: str, *, rooms: Iterable[str] = (), room_names: Any = None, here: Optional[str] = None,
                claimed_room_id: Optional[str] = None) -> "list[tuple[str, dict]]":
    """The (tool, args) that commit what the player EXPLICITLY asked for and the narration claimed without a commit. Only first-person, plain, present-tense asks count; a question, a refusal,
    a condition or speech never does. A bed -> claimBed in the bedroom the words name, a move -> moveTo the room the words name. An alliance or a deal is never in this plan.
    The tool itself still applies the game's own checks (a held turnIn stays held); the caller runs it through the normal dispatcher and the narrator voices the result."""
    try:
        from src import act_first as af
        facts = {getattr(c, "fact", c) for c in conflicts}
        asked = _asked_sentence(user_text)
        if not asked:
            return []
        out: "list[tuple[str, dict]]" = []
        if CLAIM_BED in facts and _ASK_BED.search(asked):
            present = {str(r).lower() for r in rooms}
            named = [r for r in af.rooms_named(asked, room_names) if r in af.BEDROOMS and r in present and af.grounded_strict(r, asked, room_names)]
            room = named[0] if named else (here if here in af.BEDROOMS and af._HERE_STRICT.search(asked) else None)
            if room:
                kind = "single" if re.search(r"\bsingle\b", asked, re.I) else "double" if re.search(r"\bdouble\b", asked, re.I) else "any"
                if room != here:
                    out.append(("moveTo", {"room": room}))
                out.append(("claimBed", {"room": room, "kind": kind}))
        if "player-room" in facts and claimed_room_id and not any(t == "moveTo" for t, _ in out):
            present = {str(r).lower() for r in rooms}
            if claimed_room_id in present and claimed_room_id != here and af.grounded_strict(claimed_room_id, asked, room_names) and not af.room_vetoed(claimed_room_id, asked, {"here": here, "room_names": room_names}):
                out.append(("moveTo", {"room": claimed_room_id}))
        return out[:2]
    except Exception:  # failsoft-ok: no commit is the safe answer; the regenerate path stands
        return []


def claimed_room(text: str, whereabouts: Any, *, in_quote: bool = False) -> Optional[str]:
    """The room id the narration placed the player in (when it is not their real room), for `commit_plan`; None when unclear."""
    try:
        from src import predisplay_check as pd
        from src.house_rooms import rooms_named_in
        if not isinstance(whereabouts, dict) or not whereabouts.get("room"):
            return None
        room = str(whereabouts["room"])
        names = whereabouts.get("roomNames") if isinstance(whereabouts.get("roomNames"), dict) else None
        for sent in pd._sentences(pd._outside_quotes(text, in_quote)):
            if pd._PLAYER_NOT_PLACED_RE.search(sent):
                continue
            m = pd._PLAYER_PLACED_RE.search(sent)
            if m:
                named = rooms_named_in(sent[m.start():], names)
                if named and not any(room in rs for rs in named) and len(named[0]) == 1:
                    return next(iter(named[0]))
        return None
    except Exception:  # failsoft-ok
        return None


# ── the ledger: every check is logged and counted ──────────────────────────────────────────────────────────────────
OUTCOMES = ("checked", "backed", "unbacked", "regenerated", "committed", "dropped")
_STATS: "dict[str, dict[str, int]]" = {k: {o: 0 for o in OUTCOMES} for k in (*KINDS, *EXTERNAL_KINDS)}
_RING: "list[dict]" = []
_RING_MAX = 200
_EXTERNAL_FACT_KIND = {"player-room": "move", "time-jump": "time", "part-of-day": "time", "absent-present": "presence", "sleeper-room": "presence"}


def _kind_of(fact: str) -> Optional[str]:
    return fact if fact in FACTS else _EXTERNAL_FACT_KIND.get(fact)


def note(fact: str, outcome: str, owner: Any = None) -> None:
    """Count one claim-check outcome (and log it). `fact` is a claim kind or a pre-display fact id that is a claim of the same class."""
    k = _kind_of(fact)
    if k is None or outcome not in OUTCOMES:
        return
    with _LOCK:
        _STATS[k][outcome] += 1
        _RING.append({"kind": k, "outcome": outcome})
        del _RING[:-_RING_MAX]
    logger.info("[claim-check] kind=%s outcome=%s", k, outcome)


def tally_chunk(text: str, state: Any, owner: Any, *, in_quote: bool = False, external_facts: "Iterable[str]" = ()) -> None:
    """Count the claims one SHOWN chunk made: each is `checked` and then `backed` or `unbacked`. The external facts (a wrong room, a time jump) are claims already found by the pre-display facts."""
    try:
        for c in extract_claims(text, in_quote=in_quote):
            note(c.kind, "checked", owner)
            note(c.kind, "backed" if backed(c.kind, state, owner) else "unbacked", owner)
        for f in external_facts:
            if _kind_of(f) in EXTERNAL_KINDS:
                note(f, "checked", owner)
                note(f, "unbacked", owner)
    except Exception:  # failsoft-ok: counter only
        pass


def stats() -> "dict[str, Any]":
    with _LOCK:
        by = {k: dict(v) for k, v in _STATS.items()}
    tot = {o: sum(v[o] for v in by.values()) for o in OUTCOMES}
    return {"byKind": by, "total": tot, "unbackedShown": max(0, tot["unbacked"] - tot["regenerated"] - tot["committed"] - tot["dropped"])}


def reset_stats() -> None:
    with _LOCK:
        for v in _STATS.values():
            for o in OUTCOMES:
                v[o] = 0
        _RING.clear()
