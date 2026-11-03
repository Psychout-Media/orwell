"""Role-claim screening — the pure core (A-15 rehearsal root-cause, item A).

WHY: in the 2026-11-03 live rehearsal the narrator voiced ceremonies as host-PA quotes —
    **"The winner of the Power of Veto..."**  /  **"...is Rowan."**
    **"...the houseguest leaving the Big Brother house tonight is..."**  /  **"...Maddox Baskerville."**
— and the closed-set claim detectors (subject-verb templates like "X wins the Power of Veto") never matched, so a wrong
veto winner and a wrong evictee aired. Adding templates just moves the gap (the narrator will find the next
phrasing), so this screens on NAME + ROLE CO-OCCURRENCE instead:

  1. One announcement = one unit: an ellipsis is not a sentence end, and a trailing-ellipsis half carries its role cue to the
     continuation (across stream chunks, via a small per-turn carry).
  2. A ROLE CUE (veto won/held/used, Head of Household, nominated / on the block, evicted / leaving / farewell, a ballot readout)
     BINDS only the houseguest(s) grammatically attached to it (subject before, object after — within a short gap, no clause break
     between). Those bound names are compared with the engine's COMMITTED role:
        role uncommitted and the unit asserts it  -> strip
        role committed and the bound name differs -> strip
        hypothetical / conditional / future / past reference IN THE CUE'S OWN CLAUSE -> pass
  3. Closed-set only (who holds which title is engine truth). Creative prose with no role cue is never touched (ADR 0005
     principle #1). Fail-open: any doubt passes.

UNITS are made of the SAME parts `_mirror_wall_drop` splits on (`(?<=[.!?\\n])`), so a stripped unit is always a union of whole
mirror parts and the persisted round text stays in lockstep with what streamed.

PURE: no I/O. `screen_role_units(text, sig, carry)` returns (kept_text, stripped_units, new_carry). Roles only; the roster comes
from the live board signature."""
from __future__ import annotations

import re
from typing import Iterable, Optional

_ELL = "‥"  # internal marker for an ellipsis, so "..." never reads as three sentence ends
_ELLIPSIS_RE = re.compile(r"\.{3,}|…")
_SPEAKER_TAG_RE = re.compile(r"@\[[^\]]+\]\s*[—\-:]*\s*")
_EVICTION_PHASES = ("eviction", "final-eviction")
# ballots/tallies cannot exist before the veto ceremony day: the live run aired "eight votes for X, four for Y" DURING the veto ceremony
_BALLOT_PHASES = ("eviction", "veto-ceremony")

_OBJ_DET = r"(?:(?:the|her|his|their|a|an|that|this)\s+)?"
_VETO_OBJ = r"(?:medal(?:lion)?|power\s+of\s+veto|veto|PoV)"
_HOHW = r"(?:head\s+of\s+(?:the\s+)?household|HOH)(?!\s+(?:competition|comp|room|ceremony|reign|week|key))"
_HOHW_WIN = r"(?:head\s+of\s+(?:the\s+)?household|HOH)(?!\s+(?:room|ceremony|reign|week|key))"  # "wins the HOH competition" IS a claim

# (role, regex, bind direction, max gap in chars between the cue and the bound name)
_CUES: "list[tuple]" = [  # (role, regex, bind, gap[, dash_ok])
    # ── veto: who WON / HOLDS it ───────────────────────────────────────────────────────────────────────────────────
    ("veto-hold", re.compile(r"\b(?:wins?|won|winning|holds?(?:\s+up)?|holding|clutch\w*|grips?|gripp\w*|lifts?|lifted|lifting|raises?|raised|"
                            r"wears?|wearing|claims?|claimed|earns?|earned|takes?(?!\s+place)|took|taken)\s+" + _OBJ_DET + r"(?:[A-Za-z'’-]+\s+){0,2}?" + _VETO_OBJ + r"\b",
                            re.IGNORECASE), "before", 30),
    ("veto-hold", re.compile(r"\b(?:has|had|held|keeps?|kept|owns?)\s+" + _OBJ_DET + r"(?:[A-Za-z'’-]+\s+){0,2}?" + _VETO_OBJ + r"\b(?!\s+(?:ceremony|meeting|competition|comp|room|players?|field|draw|bag))",
                            re.IGNORECASE), "before", 30),
    ("veto-hold", re.compile(r"\b" + _VETO_OBJ + r"\s+(?:goes\s+to|belongs?\s+to|is\s+(?:now\s+)?(?:with|held\s+by|worn\s+by|won\s+by)|was\s+won\s+by)\s*",
                            re.IGNORECASE), "after", 6),
    ("veto-hold", re.compile(r"\b(?:winner|holder|champion)\s+of\s+the\s+" + _VETO_OBJ + r"(?:\s+competition|\s+comp)?(?:\s+(?:is|was)|\s*:)?\s*",
                            re.IGNORECASE), "after", 8),
    ("veto-hold", re.compile(r"\bveto\s+(?:holder|winner)\s*(?:is|:)?\s*", re.IGNORECASE), "after", 8),
    ("veto-hold", re.compile(r"\b" + _VETO_OBJ + r"\b[^.!?\n]{0,25}\bin\s+(?:his|her|their)\s+hand", re.IGNORECASE), "before", 60),
    ("veto-hold", re.compile(r"\b" + _VETO_OBJ + r"\s+(?:hangs?|rests?)\s+(?:around|on|from|with)\s*", re.IGNORECASE), "after", 8),
    ("veto-use", re.compile(r"\b(?:(?:does(?:\s+not|n['’]t)|did(?:\s+not|n['’]t)|will\s+not|won['’]t|not)\s+(?:be\s+)?us(?:e|ing)|us(?:es|ed|ing))\s+" + _OBJ_DET + _VETO_OBJ + r"\b",
                            re.IGNORECASE), "before", 25),
    # ── Head of Household ──────────────────────────────────────────────────────────────────────────────────────────
    ("hoh", re.compile(r"\b(?:is|are|as|becomes?|became|crowned|named)\s+" + _OBJ_DET + r"(?:new\s+|next\s+|latest\s+|current\s+|reigning\s+)?" + _HOHW, re.IGNORECASE), "before", 25),
    ("hoh", re.compile(r"['’](?:re|s)\s+" + _OBJ_DET + r"(?:new\s+|next\s+|latest\s+|current\s+|reigning\s+)?" + _HOHW, re.IGNORECASE), "before", 2),
    ("hoh", re.compile(r"\b(?:wins?|won|winning|claims?|earns?)\s+" + _OBJ_DET + r"(?:first\s+|new\s+|next\s+)?" + _HOHW_WIN, re.IGNORECASE), "before", 25),
    ("hoh", re.compile(r"\b(?:new|next|latest)\s+" + _HOHW + r"\s*(?:is|was|:)\s*", re.IGNORECASE), "after", 6),
    ("hoh", re.compile(r"\b" + _HOHW + r"\s+(?:is|goes\s+to|winner|champion)\s*", re.IGNORECASE), "after", 6),
    ("hoh", re.compile(r"\b(?:the\s+)?(?:power|crown|keys?|HOH\s+room|nomination\s+keys?)(?:\s+(?:is|are)|'s|’s)\s+(?:now\s+|all\s+)?", re.IGNORECASE), "after", 6),
    # ── nominees ───────────────────────────────────────────────────────────────────────────────────────────────────
    ("nominee", re.compile(r"\b(?:nominates?|nominated|nominating|puts?\s+up|put\s+up)\b\s*", re.IGNORECASE), "after", 70),
    ("nominee", re.compile(r"\b(?:on\s+the\s+block|up\s+for\s+eviction)\b", re.IGNORECASE), "before", 40),
    ("nominee", re.compile(r"\bthe\s+nominees?\s+(?:are|is)\s*", re.IGNORECASE), "after", 6),
    # ── ceremony ADDRESS (A-15 follow-up: the narrator invented different nominees in dialogue — "Eli, Jeremy — you'll make your case
    # tonight" — while the engine's were someone else; phrasing carries no "nominate"/"on the block") ───────────────────────────
    ("nominee", re.compile(r"\b(?:up\s+tonight|facing\s+eviction|in\s+the\s+hot\s+seat)\b", re.IGNORECASE), "before", 40),
    ("nominee", re.compile(r"\bthe\s+(?:two\s+)?nominees?\s*[,:\u2014\u2013-]\s*", re.IGNORECASE), "after", 8, True),
    ("nominee-addr", re.compile(r"\b(?:make|makes|making|state|states|stating|plead|pleads|pleading|campaign|campaigns|campaigning)\s+(?:(?:his|her|their|your)\s+)?(?:final\s+)?case\b"
                               r"(?=[^.!?\n]{0,40}\b(?:tonight|to\s+the\s+(?:house|room)|before\s+the\s+vote|one\s+last\s+time)\b)", re.IGNORECASE), "before", 45, True),
    ("nominee-addr", re.compile(r"\b(?:plead|pleads|pleading|beg|begs|begging|pitch|pitches|pitching)\b[^.!?\n]{0,25}\bto\s+(?:stay|be\s+saved|keep\s+(?:him|her|them))\b", re.IGNORECASE), "before", 45, True),
    # a vote readout names ONLY the real nominees — before AND after the engine has revealed ballots (eviction phase)
    ("vote-for", re.compile(r"\b(?:votes?\s+(?:for|to\s+evict)|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)\s+(?:votes?\s+)?for)\s*", re.IGNORECASE), "after", 4),
    # ── eviction RESULTS (the bare event noun — "the eviction is tonight", "a vote to evict X" — is NOT a cue) ───────────
    ("evict", re.compile(r"\b(?:evicted|voted\s+out|sent\s+home|going\s+home|leaving\s+the\s+(?:big\s+brother\s+)?house|leaves\s+the\s+(?:big\s+brother\s+)?house|"
                         r"left\s+the\s+(?:big\s+brother\s+)?house|out\s+of\s+the\s+(?:big\s+brother\s+)?house)\b", re.IGNORECASE), "both", 30),
    ("evict", re.compile(r"\b(?:the\s+)?houseguest\s+(?:who\s+is\s+)?leaving\b[^.!?\n]{0,40}?\b(?:is|:)\s*", re.IGNORECASE), "after", 6),
    ("evict", re.compile(r"\b(?:eviction|evictee)\s*(?:goes\s+to|result\s*[:—\-]|is|:)\s*", re.IGNORECASE), "after", 4),
    ("evict-weak", re.compile(r"\b(?:good-?byes?|farewell|packing\s+(?:her|his|their)\s+bags|packs?\s+(?:her|his|their)\s+bags|packed\s+(?:her|his|their)\s+bags|"
                              r"walks?\s+out\s+(?:the|of\s+the)\s+(?:front\s+)?door|out\s+the\s+(?:front\s+)?door|bag\s+is\s+(?:already\s+)?at\s+the\s+door|"
                              r"the\s+door\s+(?:closes|clicks|shuts)\s+behind)\b", re.IGNORECASE), "both", 40),
]

# ballots — a READOUT of the secret ballot, judged only against the ENGINE's revealed-ballot count (unit-level, no binding)
_BALLOT_RE = re.compile(
    r"\b(?:votes?|ballots?)\s+(?:for|to\s+evict)\b|\bvote\s+to\s+evict\b|\b(?:last|final|next|first|second|third)\s+(?:vote|ballot)\b|"
    r"\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)\s+votes?\b|"
    r"\breads?\s+(?:the\s+)?(?:next\s+)?(?:votes?|ballots?)\b|\bthe\s+envelope\s+opens\b", re.IGNORECASE)

# hypothetical / conditional / future / past-reference wording — scoped to the cue's OWN clause
_HYPO_RE = re.compile(
    r"\b(?:if|whether|unless|whoever|will|would|might|may|could|should|shall|going\s+to|gonna|hope[sd]?|wish(?:es)?|want(?:s|ed)?\s+to|"
    r"trying\s+to|try(?:ing)?\s+to|plans?\s+to|need(?:s)?\s+to|can|can['’]t|cannot|someone|somebody|anyone|no\s+one|nobody)\b|\?", re.IGNORECASE)
_PAST_REF_RE = re.compile(r"\b(?:last\s+week|last\s+night|earlier|previous(?:ly)?|before|ago|remember)\b", re.IGNORECASE)
_CLAUSE_BREAK = ",;:—–"


def _norm(text: str) -> str:
    return _ELLIPSIS_RE.sub(_ELL, text)


def _strip_wrappers(s: str) -> str:
    return re.sub(r"[*_\"“”‘’`]+", "", s)


def _clean(unit: str) -> str:
    """The string cues AND names are both measured on (speaker tag removed — it is who TALKS, not who the sentence is about)."""
    return _strip_wrappers(_SPEAKER_TAG_RE.sub(" ", unit))


# ── units: the SAME parts `_mirror_wall_drop` splits on, grouped into logical sentences ──────────────────────────────
def split_units(text: str) -> "list[tuple[str, str]]":
    """(original_span, normalised) units. Physical parts are `re.split(r"(?<=[.!?\\n])")` — identical to the mirror — and a unit is a
    run of whole parts ending at a REAL terminator (an ellipsis dot is not one) or a newline. A stripped unit is therefore always
    a union of whole mirror parts, so `_mirror_wall_drop` stays in lockstep with what streamed."""
    parts = [p for p in re.split(r"(?<=[.!?\n])", text) if p]
    ell_idx: "set[int]" = set()
    for m in _ELLIPSIS_RE.finditer(text):
        ell_idx.update(range(m.start(), m.end()))
    units: "list[tuple[str, str]]" = []
    cur: "list[str]" = []
    pos = 0
    for p in parts:
        cur.append(p)
        last = pos + len(p) - 1
        real_end = p.endswith("\n") or (p[-1] in ".!?" and last not in ell_idx)
        pos += len(p)
        if real_end:
            u = "".join(cur)
            units.append((u, _norm(u)))
            cur = []
    if cur:
        u = "".join(cur)
        units.append((u, _norm(u)))
    return units


# ── names ────────────────────────────────────────────────────────────────────────────────────────────────────────
def _name_patterns(names: Iterable[str]) -> "list[tuple[str, re.Pattern]]":
    """(canonical full name, pattern) — full names always; a first OR last token alone only when it is unique in the roster and long
    enough to be a name (so 'Noah' and 'Noah Reeve' both resolve, but two Noahs resolve only by full name)."""
    full = sorted({str(n).strip() for n in names if str(n).strip()}, key=len, reverse=True)
    firsts: "dict[str, list[str]]" = {}
    for n in full:
        for tok in set(n.split()):
            if len(tok) >= 3:
                firsts.setdefault(tok, []).append(n)
    pats: "list[tuple[str, re.Pattern]]" = []
    for n in full:
        pats.append((n, re.compile(r"(?<![\w'’])" + re.escape(n) + r"(?![\w])")))
    for tok, owners in firsts.items():
        if len(owners) == 1:
            pats.append((owners[0], re.compile(r"(?<![\w'’])" + re.escape(tok) + r"(?:['’]s)?(?![\w])")))
    return pats


_SECOND_PERSON_RE = re.compile(r"(?<![\w'’])(?:you|your|yours|yourself)(?![\w])|(?<![\w'’])you(?:'re|’re|'ve|’ve|'ll|’ll|'d|’d)(?![\w])", re.IGNORECASE)


def name_spans(s: str, names: Iterable[str], player: Optional[str] = None) -> "list[tuple[str, int, int]]":
    """(canonical name, start, end) for every occurrence in `s`; longer matches mask shorter ones. With `player`, the second person
    ("you", "you're", "yours") IS the player — the live rehearsal told the player "the power's yours" for an HOH the engine gave
    someone else, which no third-person name check ever sees."""
    taken: "list[tuple[int, int]]" = []
    out: "list[tuple[str, int, int]]" = []
    if player:
        for m in _SECOND_PERSON_RE.finditer(s):
            out.append((player, m.start(), m.end()))
            taken.append((m.start(), m.end()))
    for canon, pat in _name_patterns(names):
        for m in pat.finditer(s):
            if any(m.start() < b and m.end() > a for a, b in taken):
                continue
            taken.append((m.start(), m.end()))
            out.append((canon, m.start(), m.end()))
    return sorted(out, key=lambda t: t[1])


def names_in(unit: str, names: Iterable[str], player: Optional[str] = None) -> "list[str]":
    seen: "list[str]" = []
    for canon, _a, _b in name_spans(_clean(unit), names, player):
        if canon not in seen:
            seen.append(canon)
    return seen


# ── cues ─────────────────────────────────────────────────────────────────────────────────────────────────────────
def _clause_bounds(s: str, a: int, b: int) -> "tuple[int, int]":
    lo = max([s.rfind(ch, 0, a) for ch in _CLAUSE_BREAK] + [-1]) + 1
    hi_c = [s.find(ch, b) for ch in _CLAUSE_BREAK]
    hi = min([x for x in hi_c if x != -1] + [len(s)])
    return lo, hi


def _non_assertive(s: str, a: int, b: int) -> bool:
    lo, hi = _clause_bounds(s, a, b)
    clause = s[lo:hi]
    return bool(_HYPO_RE.search(clause) or _PAST_REF_RE.search(clause)) or "?" in s


def cue_instances(unit: str, phase: str) -> "list[dict]":
    """Every role cue in the unit with its span, bind direction and gap (hypothetical cues are dropped)."""
    s = _clean(unit)
    ph = str(phase or "").lower()
    out: "list[dict]" = []
    for role, rx, bind, gap, *_flags in _CUES:
        if role == "evict-weak" and not ph.startswith(_EVICTION_PHASES):
            continue
        if role in ("nominee-addr", "vote-for") and not ph.startswith(_BALLOT_PHASES):
            continue
        for m in rx.finditer(s):
            if _non_assertive(s, m.start(), m.end()):
                continue
            out.append({"role": role, "a": m.start(), "b": m.end(), "bind": bind, "gap": gap, "dash": bool(_flags and _flags[0])})
    if ph.startswith(_BALLOT_PHASES) and _BALLOT_RE.search(s) and "?" not in s:
        out.append({"role": "ballot", "a": 0, "b": len(s), "bind": "all", "gap": len(s)})
    return out


def cues_in(unit: str, phase: str) -> "set[str]":
    return {c["role"] for c in cue_instances(unit, phase)}


_LIST_JOIN_RE = re.compile(r"^\s*(?:,|&|and|or)?\s*$", re.IGNORECASE)


def _bound(s: str, cue: dict, spans: "list[tuple[str, int, int]]") -> "list[str]":
    """The names attached to this cue: the NEAREST subject before it and/or object after it (extended over a plain list —
    "A and B" / "A, B, and C"), within the cue's gap and with no clause break between. A farther, unrelated name is not bound."""
    if cue["bind"] == "all":
        return [n for n, _a, _b in spans]
    got: "list[str]" = []

    breaks = ".!?" if cue.get("dash") else ";:\u2014\u2013.!?"  # an address cue ("Eli, Jeremy — you'll make your case") reads across a dash

    def _clear(between: str) -> bool:
        return not any(ch in between for ch in breaks)

    if cue["bind"] in ("before", "both"):
        before = [t for t in spans if t[2] <= cue["a"]]
        if before:
            near = before[-1]
            if cue["a"] - near[2] <= cue["gap"] and _clear(s[near[2]:cue["a"]]):
                got.append(near[0])
                prev = near
                for t in reversed(before[:-1]):
                    if _LIST_JOIN_RE.match(s[t[2]:prev[1]]):
                        got.append(t[0]); prev = t
                    else:
                        break
    if cue["bind"] in ("after", "both"):
        after = [t for t in spans if t[1] >= cue["b"]]
        if after:
            near = after[0]
            if near[1] - cue["b"] <= cue["gap"] and _clear(s[cue["b"]:near[1]]):
                got.append(near[0])
                prev = near
                for t in after[1:]:
                    if _LIST_JOIN_RE.match(s[prev[2]:t[1]]):
                        got.append(t[0]); prev = t
                    else:
                        break
    return got


def _is_bare_names(unit: str, roster: Iterable[str]) -> bool:
    """True when the unit is nothing but the given names (plus quotes/ellipsis/punctuation/speaker tag) — a ballot readout line."""
    s = _clean(unit).replace(_ELL, " ")
    for _canon, pat in _name_patterns(roster):
        s = pat.sub(" ", s)
    s = re.sub(r"(?i)\b(?:the\s+(?:last|final|next|first)\s+vote|and|or|a\s+vote\s+to\s+evict)\b", " ", s)
    return not re.sub(r"[\s.,;:!?\-—–()\[\]]+", "", s)


def _matches_any(name: str, candidates: Iterable[Optional[str]]) -> bool:
    n = (name or "").strip().lower()
    return any(c and str(c).strip().lower() == n for c in candidates)


def judge(unit: str, instances: "list[dict]", roster: "list[str]", sig: dict, carried: "set[str] | None" = None) -> Optional[str]:
    """A short reason when this unit asserts a role the engine did not commit to the person it is bound to, else None."""
    phase = str(sig.get("phase") or "").lower()
    if not instances and not carried and not phase.startswith(_BALLOT_PHASES):
        return None
    s = _clean(unit)
    player = sig.get("playerName")
    spans = name_spans(s, roster, player)
    if not spans:
        return None
    veto_holder, hoh = sig.get("vetoHolderName"), sig.get("hohName")
    noms = list(sig.get("nomNames") or [])
    evicted = list(sig.get("evictedNames") or [])
    if sig.get("playerStatus") not in (None, "active") and player:
        evicted = evicted + [player]
    by_role: "dict[str, list[str]]" = {}
    spans_third = name_spans(s, roster)  # no second person: "Eli, Jeremy — you'll make your case" addresses the NAMED, not the player
    for c in instances:
        use = spans_third if c["role"] in ("nominee", "nominee-addr", "vote-for") else spans
        by_role.setdefault(c["role"], []).extend(_bound(s, c, use))
    for role in (carried or set()):
        if _non_assertive(s, 0, 0):
            continue
        by_role.setdefault(role, []).extend(n for n, _a, _b in spans)  # the continuation half: the whole unit is the answer
    if "ballot" not in by_role and phase.startswith(_BALLOT_PHASES) and _is_bare_names(unit, sig.get("nomNames") or []):
        by_role["ballot"] = [n for n, _a, _b in spans]
    if by_role.get("ballot") and phase.startswith(_BALLOT_PHASES) and sig.get("evictionBallots") == 0:
        return "ballot readout before the engine revealed any ballot (the player's vote is not yet cast)"
    for role in ("veto-hold", "veto-use"):
        bad = [n for n in by_role.get(role, []) if not _matches_any(n, [veto_holder])]
        if bad:
            return "veto uncommitted" if not veto_holder else "veto holder is not " + ", ".join(sorted(set(bad)))
    bad = [n for n in by_role.get("hoh", []) if not _matches_any(n, [hoh])]
    if bad:
        return "HOH uncommitted" if not hoh else "HOH is not " + ", ".join(sorted(set(bad)))
    if noms:  # only judged once the engine HAS committed nominees (before that the unit is lobbying or speculation)
        bad = [n for n in by_role.get("nominee-addr", []) + by_role.get("vote-for", []) if not _matches_any(n, noms)]
        if bad:
            return "named a non-nominee at the eviction: " + ", ".join(sorted(set(bad)))
    bad = [n for n in by_role.get("nominee", []) if not _matches_any(n, noms)]
    if bad:
        return "nominees uncommitted" if not noms else "named a non-nominee: " + ", ".join(sorted(set(bad)))
    for role in ("evict", "evict-weak"):
        bound = by_role.get(role, [])
        if bound and not any(_matches_any(n, evicted) for n in bound):
            if role == "evict" or phase.startswith(_EVICTION_PHASES):
                return "evictee uncommitted or different"
    return None


def screen_role_units(text: str, sig: dict, carry: Optional[dict] = None):
    """Screen `text`. Returns (kept_text, stripped, new_carry). `carry` = {"roles": set, "ttl": int} from a prior chunk whose
    last unit ended on an ellipsis with a role cue (the host-PA split). Pure; never raises (fail-open)."""
    try:
        if not text or not isinstance(sig, dict):
            return text, [], carry
        roster = list(sig.get("activeNames") or []) + list(sig.get("evictedNames") or [])
        if sig.get("playerName"):
            roster.append(sig["playerName"])
        phase = str(sig.get("phase") or "")
        carry = dict(carry) if isinstance(carry, dict) else {"roles": set(), "ttl": 0}
        kept: "list[str]" = []
        stripped: "list[dict]" = []
        drop_closers = False
        for orig, unit in split_units(text):
            if drop_closers and unit.strip() and not _strip_wrappers(unit).strip():
                # the stripped unit's own closing quotes/asterisks (`"**`) — a whole mirror part, never left dangling. Reported so the
                # raw round buffer drops it too (the caller mirrors every reported unit).
                stripped.append({"unit": orig, "roles": [], "reason": "closing wrapper of a stripped unit"})
                continue
            if not unit.strip():
                kept.append(orig)
                continue
            drop_closers = False
            inst = cue_instances(unit, phase)
            names = names_in(unit, roster, sig.get("playerName"))
            starts_cont = bool(re.match(r"^[\s*_\"“”‘’`]*" + _ELL, unit))
            carried = set(carry["roles"]) if (carry["ttl"] > 0 and (starts_cont or names)) else set()
            reason = judge(unit, inst, roster, sig, carried) if names else None
            if reason:
                stripped.append({"unit": orig, "roles": sorted({c["role"] for c in inst} | carried), "reason": reason})
                if starts_cont or names:
                    carry = {"roles": set(), "ttl": 0}  # a named continuation (stripped or not) consumes the carry
                drop_closers = True
                continue
            kept.append(orig)
            drop_closers = False
            roles = {c["role"] for c in inst}
            ends_open = bool(re.search(_ELL + r"[\s*_\"“”‘’`]*$", unit.rstrip()))
            if roles and ends_open and not names:
                carry = {"roles": set(roles), "ttl": 3}
            elif carry["ttl"] > 0:
                carry["ttl"] -= 1
                if names or starts_cont:
                    carry = {"roles": set(), "ttl": 0}
        return "".join(kept), stripped, carry
    except Exception:  # failsoft-ok: role-claim-guard — fail-open BY DESIGN (the text passes untouched; the sentence-level guards still run)
        return text, [], carry


def phantom_role_claims(text: str, board: dict) -> "list[dict]":
    """The stable entry point for other checks (e.g. the N-6 aside truth check): the units in `text` that assert a
    veto/HOH/nominee/evictee role the engine has not committed to the named person, judged against `board` (a beat
    signature: hohName, vetoHolderName, nomNames, activeNames, evictedNames, playerName, phase). [] when clean.
    Hypothetical / conditional / future / past-reference wording is exempt. Never raises."""
    _kept, out, _carry = screen_role_units(text, board, None)
    return out
