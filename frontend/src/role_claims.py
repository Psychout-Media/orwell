"""Role-claim screening — the pure core (A-15 rehearsal root-cause, item A).

WHY: in the 2026-11-03 live rehearsal the narrator voiced ceremonies as host-PA quotes —
    **"The winner of the Power of Veto..."**  /  **"...is Rowan."**
    **"...the houseguest leaving the Big Brother house tonight is..."**  /  **"...Maddox Baskerville."**
— and the closed-set claim detectors (subject-verb templates like "X wins the Power of Veto") never matched, so a wrong
veto winner and a wrong evictee aired. Adding templates just moves the gap (the narrator will find the next
phrasing), so this screens on NAME + ROLE CO-OCCURRENCE instead:

  1. Normalise ellipsis / quote-splits so ONE announcement is ONE unit (a trailing-ellipsis half carries its role cue to the
     next fragment, even across chunk boundaries, via a small per-turn carry).
  2. A unit that has a ROLE CUE (veto won/held/used, Head of Household, on the block, evicted/leaving/farewell) AND names a
     houseguest is an assertion about that person's role. Compare it with the engine's COMMITTED role:
        role uncommitted and the unit asserts it  -> strip
        role committed and the name differs       -> strip
        hypothetical / conditional / future       -> pass
  3. Closed-set only (who holds which title is engine truth). Creative prose with no role cue is never touched
     (ADR 0005 principle #1). Fail-open: any doubt passes.

PURE: no I/O. `screen_role_units(text, sig, carry)` returns (kept_text, stripped_units, new_carry).
Roles only; no names are hard-coded (the roster comes from the live board signature)."""
from __future__ import annotations

import re
from typing import Iterable, Optional

_ELL = "‥"  # internal marker for an ellipsis, so "..." never reads as three sentence ends

_ELLIPSIS_RE = re.compile(r"\.{3,}|…")
_SPEAKER_TAG_RE = re.compile(r"@\[[^\]]+\]\s*[—\-:]*\s*")

# ── role cues ──────────────────────────────────────────────────────────────────────────────────────
# veto — who WON/HOLDS it, and who USES it (only the holder can use it)
_VETO_WORD = r"(?:power\s+of\s+veto|veto(?:\s+(?:medal|competition|comp|holder|winner|meeting|ceremony))?|\bPoV\b)"
_VETO_HOLD_RE = re.compile(
    r"(?:\b(?:winner|champion|holder)\s+of\s+the\s+" + _VETO_WORD + r")"
    r"|(?:\bwins?\s+the\s+" + _VETO_WORD + r")|(?:\bwon\s+the\s+" + _VETO_WORD + r")"
    r"|(?:\bwinning\s+the\s+" + _VETO_WORD + r")"
    r"|(?:\b(?:holds?|holding|held|clutch(?:es|ing)?|wears?|grips?|has|takes?|took|claims?|earned|earns?)\s+(?:the\s+|her\s+|his\s+|their\s+)?" + _VETO_WORD + r")"
    r"|(?:\b(?:veto|medal)\b[^.!?\n]{0,30}\b(?:goes|went|belongs?|is|was)\s+(?:to|with))"
    r"|(?:\b(?:medal|veto)\b[^.!?\n]{0,25}\bin\s+(?:his|her|their)\s+hand)"
    r"|(?:\bthe\s+(?:medal|veto)\s+goes\s+to)"
    r"|(?:\bveto\s+(?:holder|winner)\b)",
    re.IGNORECASE)
_VETO_USE_RE = re.compile(
    r"\b(?:does(?:\s+not|n['’]t)|did(?:\s+not|n['’]t)|do(?:es)?\s+not|will\s+not|won['’]t|not)\s+(?:be\s+)?us(?:e|ing)\s+the\s+" + _VETO_WORD
    + r"|\b(?:uses?|used|using)\s+the\s+" + _VETO_WORD
    + r"|\bnot\s+using\s+the\s+" + _VETO_WORD, re.IGNORECASE)
_HOH_WORD = r"(?:head\s+of\s+(?:the\s+)?household|\bHOH\b)"
_HOH_RE = re.compile(
    r"(?:\b(?:new|next|latest|first|reigning|current|outgoing)\s+" + _HOH_WORD + r")"
    r"|(?:\b(?:crowned|wins?|won|winning|named|becomes?|became|is|are|as)\s+(?:the\s+)?(?:new\s+)?" + _HOH_WORD + r")"
    r"|(?:\b" + _HOH_WORD + r"\s+(?:is|goes\s+to|winner|champion))", re.IGNORECASE)
_NOM_RE = re.compile(
    r"\b(?:nominat(?:e|es|ed|ing|ion|ions)|on\s+the\s+block|up\s+for\s+eviction|put\s+up|the\s+block)\b", re.IGNORECASE)
# eviction — STRONG cues are unambiguous house-level exits; WEAK cues only count on eviction night
_EVICT_STRONG_RE = re.compile(
    r"\b(?:evict(?:s|ed|ion)?|voted\s+out|sent\s+home|going\s+home|leaving\s+the\s+(?:big\s+brother\s+)?house|leaves\s+the\s+(?:big\s+brother\s+)?house|"
    r"left\s+the\s+(?:big\s+brother\s+)?house|out\s+of\s+the\s+(?:big\s+brother\s+)?house|(?:the\s+)?houseguest\s+(?:who\s+is\s+)?leaving|"
    r"is\s+(?:the\s+)?(?:next\s+)?(?:one\s+)?(?:leaving|going))\b", re.IGNORECASE)
_EVICT_WEAK_RE = re.compile(
    r"\b(?:good-?byes?|farewell|packing\s+(?:her|his|their)\s+bags|pack(?:s|ed)?\s+(?:her|his|their)\s+bags|walks?\s+out\s+(?:the|of\s+the)\s+(?:front\s+)?door|"
    r"out\s+the\s+(?:front\s+)?door|bag\s+is\s+(?:already\s+)?at\s+the\s+door|the\s+door\s+(?:closes|clicks|shuts)\s+behind)\b", re.IGNORECASE)

# assertion-vs-hypothetical: these make a unit non-assertive (pass)
_HYPO_RE = re.compile(
    r"\b(?:if|whether|unless|whoever|who(?:ever)?\s+wins|will|would|might|may|could|should|shall|going\s+to|gonna|"
    r"hope[sd]?|wish(?:es)?|want(?:s|ed)?\s+to|trying\s+to|try(?:ing)?\s+to|plans?\s+to|need(?:s)?\s+to|can|can['’]t|cannot|"
    r"someone|somebody|anyone|no\s+one|nobody)\b|\?", re.IGNORECASE)
_PAST_REF_RE = re.compile(r"\b(?:last\s+week|last\s+night|earlier|previous(?:ly)?|before|ago|remember)\b", re.IGNORECASE)

_EVICTION_PHASES = ("eviction", "final-eviction")


def _norm(text: str) -> str:
    return _ELLIPSIS_RE.sub(_ELL, text)


def _strip_wrappers(s: str) -> str:
    return re.sub(r"[*_\"“”‘’`]+", "", s)


def split_units(text: str) -> "list[tuple[str, str]]":
    """Split `text` into (original_span, normalised_unit) fragments. A fragment ends at a real sentence terminator or a
    paragraph break; an ellipsis is NOT a terminator. The original span keeps its exact bytes (delimiters included) so
    stripping a unit leaves every other character untouched."""
    t = _norm(text)
    out: "list[tuple[str, str]]" = []
    for m in re.finditer(r"[^.!?\n]*[.!?]+[\"'”’*)\]_]*\s*|[^\n]*\n+|[^.!?\n]+$", t):
        if not m.group(0):
            continue
        out.append((m.group(0), m.group(0)))
    # map back to the original text by length (the normalisation is length-changing, so re-split the original in lockstep)
    res: "list[tuple[str, str]]" = []
    pos = 0
    orig = text
    for span, unit in out:
        # translate the normalised span length back to original: count markers inside the span
        n_markers = span.count(_ELL)
        # each marker came from an ellipsis of unknown length; walk the original until we've consumed the same structure
        j = pos
        consumed_norm = 0
        while consumed_norm < len(span) and j < len(orig):
            m = _ELLIPSIS_RE.match(orig, j)
            if m:
                j = m.end(); consumed_norm += 1
            else:
                j += 1; consumed_norm += 1
        res.append((orig[pos:j], unit))
        pos = j
    if pos < len(orig):
        res.append((orig[pos:], _norm(orig[pos:])))
    return res


def _name_patterns(names: Iterable[str]) -> "list[tuple[str, re.Pattern]]":
    """(canonical full name, pattern) — full names always; a first OR last token alone only when it is unique in the roster
    and long enough to be a name (so 'Noah' and 'Noah Reeve' both resolve, but two Noahs resolve only by full name)."""
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


def names_in(unit: str, names: Iterable[str]) -> "list[str]":
    s = _strip_wrappers(_SPEAKER_TAG_RE.sub(" ", unit))  # a speaker tag is who TALKS, not who the sentence is about
    found: "list[str]" = []
    for canon, pat in _name_patterns(names):
        if pat.search(s) and canon not in found:
            found.append(canon)
    return found


def cues_in(unit: str, phase: str) -> "set[str]":
    s = _strip_wrappers(unit)
    cues: "set[str]" = set()
    if _VETO_HOLD_RE.search(s):
        cues.add("veto-hold")
    if _VETO_USE_RE.search(s):
        cues.add("veto-use")
    if _HOH_RE.search(s):
        cues.add("hoh")
    if _NOM_RE.search(s):
        cues.add("nominee")
    if _EVICT_STRONG_RE.search(s):
        cues.add("evict")
    elif _EVICT_WEAK_RE.search(s) and str(phase or "").lower().startswith(_EVICTION_PHASES):
        cues.add("evict-weak")
    return cues


def _is_assertive(unit: str) -> bool:
    s = _strip_wrappers(unit)
    return not (_HYPO_RE.search(s) or _PAST_REF_RE.search(s))


def _matches_any(name: str, candidates: Iterable[Optional[str]]) -> bool:
    n = (name or "").strip().lower()
    return any(c and str(c).strip().lower() == n for c in candidates)


def judge(unit: str, roles: "set[str]", names: "list[str]", sig: dict) -> Optional[str]:
    """Return a short reason string when this unit asserts a role the engine did not commit to the named person, else None."""
    if not names or not roles or not _is_assertive(unit):
        return None
    phase = str(sig.get("phase") or "").lower()
    player = sig.get("playerName")
    # who each role is COMMITTED to
    veto_holder = sig.get("vetoHolderName")
    hoh = sig.get("hohName")
    noms = list(sig.get("nomNames") or [])
    evicted = list(sig.get("evictedNames") or [])
    if sig.get("playerStatus") not in (None, "active") and player:
        evicted = evicted + [player]
    if "veto-hold" in roles or "veto-use" in roles:
        # only the HOLDER holds/uses it; during the veto COMPETITION nobody holds it yet
        if any(not _matches_any(n, [veto_holder]) for n in names):
            if not veto_holder:
                return "veto uncommitted"
            return "veto holder is not " + ", ".join(n for n in names if not _matches_any(n, [veto_holder]))
    if "hoh" in roles:
        if any(not _matches_any(n, [hoh]) for n in names):
            if not hoh:
                return "HOH uncommitted"
            return "HOH is not " + ", ".join(n for n in names if not _matches_any(n, [hoh]))
    if "nominee" in roles and "evict" not in roles:
        # nominees: every named person asserted on the block must be a committed nominee; only judge once a set exists
        # or when the unit is plainly a nomination announcement and none is committed
        if noms and any(not _matches_any(n, noms + [hoh]) for n in names):
            return "named a non-nominee on the block"
    if "evict" in roles or "evict-weak" in roles:
        committed = [n for n in names if _matches_any(n, evicted)]
        if not committed:
            if "evict" in roles or phase.startswith(_EVICTION_PHASES):
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
        for orig, unit in split_units(text):
            body = unit.strip()
            if not body:
                kept.append(orig)
                continue
            roles = cues_in(unit, phase)
            names = names_in(unit, roster)
            starts_cont = bool(re.match(r"^[\s*_\"“”‘’`]*" + _ELL, unit))
            eff = set(roles)
            if carry["ttl"] > 0 and (starts_cont or names):
                eff |= set(carry["roles"])
            reason = judge(unit, eff, names, sig) if names else None
            if reason:
                stripped.append({"unit": orig, "roles": sorted(eff), "reason": reason})
                # a stripped continuation consumes the carry
                if starts_cont:
                    carry = {"roles": set(), "ttl": 0}
                continue
            kept.append(orig)
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
