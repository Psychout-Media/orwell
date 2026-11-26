"""ORW-725 - the player-voice net: narration never speaks for the player, and never hands the player's own words to a houseguest.

The player is plugged in: what they say, do and decide is only what they typed this turn. A playtest showed two model failures the prompt rule alone cannot close:
  A  the narrator writes the player in the FIRST person (an action, then a quoted answer the player never typed), or narrates a decision the player never made;
  B  a houseguest's quoted line is the player's own message, recited back as that houseguest's speech.

This module is a narrow, pure, fail-open DETECTOR over the sentence-buffered chunks the stream already emits (the same shape as the knowledge/presence wall guards): it WITHHOLDS a whole offending sentence
before it is shown and never authors, rewrites or substitutes text. It cannot judge intent: it catches the shapes below only, and anything else streams as before.

  player-speech   `You say, \"...\"` where the quote is not in the player's own message
  first-person    an unquoted sentence that starts "I <physical action verb>" (a narrator-as-host never does these), plus the unattributed quoted line that follows it
  decision        "you decide / agree / accept / choose / vote / promise / resolve" (outside quotes, not hedged, not a question) when the player's own message holds no such verb
  recitation      a labelled houseguest quote that opens with, or contains, a run of the player's own message words (a houseguest QUESTION that repeats >= 8 opening words, or >= 10 words in a row, of a question the player typed; statements and deal terms are never judged)

Off by `ORWELL_PLAYER_VOICE_GUARD=0`; default on. Pure, no rng, no I/O.
"""
from __future__ import annotations

import os
import re
from typing import Any, List, Optional, Tuple

from src.predisplay_check import _HEDGE_RE, _parts, _scan_quotes  # reuse the checker's lossless sentence split and quote scan

FACT_FIRST_PERSON = "first-person"
FACT_SPEECH = "player-speech"
FACT_DECISION = "decision"
FACT_RECITATION = "recitation"

_OPEN_RUN = 8    # a houseguest question OPENING with this many of the player's own question words in a row
_CROSS_RUN = 10  # or this many in a row across sentences of the same speech


def enabled() -> bool:
    return os.environ.get("ORWELL_PLAYER_VOICE_GUARD", "1").strip().lower() not in ("0", "false", "off", "no")


# "I" + a physical or narrated action: narration in the player's first person. A casting producer's speech is quoted-free first person too, so the caller only runs this in a started game.
_FP_ACT = (r"(?:lean(?:ed)?|settle[sd]?|pour(?:ed)?|nod(?:ded)?|shrug(?:ged)?|glance[sd]?|lift(?:ed)?|tip(?:ped)?|fold(?:ed)?|slide|slid|"
           r"set\s+(?:my|the|down)|push(?:ed)?\s+(?:back|away|off|through)|cross(?:ed)?\s+(?:to|the|over)|step(?:ped)?\s+(?:out|back|in|over|aside|forward)|"
           r"turn(?:ed)?\s+(?:to|toward|back|away)|sit\s+(?:down|back|on|beside|by)|sat\s+(?:down|back|on|beside|by)|stand\s+up|stood\s+up|reach(?:ed)?\s+(?:for|out|across)|"
           r"let\s+(?:the|my|a)|gave?\s+[A-Z]|excuse[sd]?\s+myself|head(?:ed)?\s+(?:to|for|into|over)|walk(?:ed)?\s+(?:to|over|across|into|through|out|back)|shake\s+(?:my|the)|shook\s+(?:my|the))")
_FP_RE = re.compile(r"^\s*(?:\*+|_+)?I\s+" + _FP_ACT + r"\b")
_DECISION_RE = re.compile(r"\byou\s+(?:(?:decide|agree|accept|choose|vote|promise|resolve)|(?:decided|agreed|accepted|chose|voted|promised|resolved))\b", re.IGNORECASE)
_YOU_SAY_RE = re.compile(r"(?:^|[.!?\n]\s*|,\s*|\b(?:and|then)\s+)you\s+(?:say|said|reply|replied|answer|answered|tell|told|whisper|whispered|ask|asked|add|added)\b[^\"\u201c\n]{0,40}[:,]?\s*[\"\u201c]", re.IGNORECASE)
# ORW-1062: whole-word verb forms (a stem substring let "devote" excuse "you vote" and "agreement" excuse "you agreed")
_DECISION_FORMS = {
    "decide": {"decide", "decides", "decided", "deciding"}, "agree": {"agree", "agrees", "agreed", "agreeing"}, "accept": {"accept", "accepts", "accepted", "accepting"},
    "choose": {"choose", "chooses", "chose", "chosen", "choosing"}, "vote": {"vote", "votes", "voted", "voting"}, "promise": {"promise", "promises", "promised", "promising"},
    "resolve": {"resolve", "resolves", "resolved", "resolving"},
}
_DECISION_VERB_OF = {f: k for k, forms in _DECISION_FORMS.items() for f in forms}
# a conditional, a modal or a future fact is not a decision the narrator made for the player ("Whatever you decide, ...", "You vote tomorrow.")
_COND_BEFORE_RE = re.compile(r"\b(?:whatever|whichever|whoever|however|whenever|if|when|once|unless|before|until|whether|should|would|could|might|may|can|will|won't|shall|going\s+to|about\s+to|have\s+to|need\s+to|must)\b[^.!?]*$", re.IGNORECASE)
_FUTURE_AFTER_RE = re.compile(r"^[^.!?]*\b(?:tomorrow|later|soon|eventually|next\s+\w+|in\s+the\s+morning|at\s+the\s+(?:next|upcoming))\b", re.IGNORECASE)
_ECHO_RE = re.compile(r"\b(?:repeat(?:s|ed|ing)?|echo(?:es|ed|ing)?|parrot(?:s|ed|ing)?|mimic(?:s|ked|king)?|asks?\s+it\s+back|throws?\s+it\s+back|hands?\s+it\s+back|back\s+at\s+you)\b", re.IGNORECASE)


def _decision_is_a_fact(outside: str, m: "re.Match[str]", pm_words: List[str]) -> bool:
    """True when the unquoted text states a decision the narrator made for the player: a main-clause, unconditional, not-future `you <decision verb>` the player's own message does not hold as a whole word."""
    if _COND_BEFORE_RE.search(outside[:m.start()]) or _FUTURE_AFTER_RE.match(outside[m.end():]):
        return False
    verb = _DECISION_VERB_OF.get(m.group(0).split()[-1].lower())
    return not (verb and any(w in _DECISION_FORMS[verb] for w in pm_words))


_ATTRIB_RE = re.compile(r"\byou(?:'ve|\s+have)?\s+(?:said|told|asked|wrote|typed|say|mentioned|put\s+it|called|promised)\b", re.IGNORECASE)
_LABELLED_QUOTE_RE = re.compile(r"[\w'’.\- ]{2,40}[—–-]\s*[\"“]")  # `Name — "` the speaker label in front of a houseguest line


def _norm_words(s: Any) -> List[str]:
    return re.sub(r"[^a-z0-9\s]", "", str(s or "").lower().replace("’", "'").replace("'", "")).split()


def _player_questions(msg: Any) -> List[List[str]]:
    """The word lists of the question sentences in the player's own message."""
    return [_norm_words(x) for x in re.findall(r"[^.!?\n]*\?", str(msg or ""))]


def _has_run(words: List[str], player: List[List[str]], n: int, must_touch_from: int = 0) -> bool:
    """True when `words` holds n consecutive words that also appear consecutively in `player`; the run must END at or after index `must_touch_from` (so it includes new words)."""
    if len(words) < n:
        return False
    grams = {tuple(q[i:i + n]) for q in player for i in range(len(q) - n + 1)}
    return any(tuple(words[i:i + n]) in grams for i in range(max(0, must_touch_from - n + 1), len(words) - n + 1))


def _quoted_spans(unit: str, in_quote: bool) -> List[str]:
    """The text inside quotes in `unit` (an open quote at the unit start counts; a dangling open quote runs to the end)."""
    out: List[str] = []
    cur: List[str] = []
    open_q = in_quote
    for ch in unit:
        if ch in '"“' and not open_q:
            open_q = True
        elif ch in '"”“' and open_q:
            open_q = False
            out.append("".join(cur))
            cur = []
        elif open_q:
            cur.append(ch)
    if open_q and cur:
        out.append("".join(cur))
    return out


class PlayerVoiceState:
    """Per-turn carry across the streamed chunks: a first-person line just withheld (its unattributed quote follows), whether a withheld quote is still open, the recent words already shown."""

    def __init__(self) -> None:
        self.after_first_person = False
        self.dropping_quote = False
        self.recent_words: List[str] = []


def screen(text: str, player_msg: Any, state: Optional[PlayerVoiceState] = None, *, in_quote: bool = False) -> Tuple[str, List[Tuple[str, str]]]:
    """(kept text, [(fact, withheld sentence)]). Whole sentences only; the kept text is the original minus those sentences. Fail-open: any problem returns the text unchanged."""
    try:
        if not text or not enabled() or not str(player_msg or "").strip():
            return text, []
        st = state if state is not None else PlayerVoiceState()
        pm_words = _norm_words(player_msg)
        pm_norm = " ".join(pm_words)
        pm_q = _player_questions(player_msg)
        kept: List[str] = []
        dropped: List[Tuple[str, str]] = []
        q_open = in_quote or st.dropping_quote  # a quote being withheld is open in the raw stream even though its opening mark was never shown
        for part in _parts(text):
            outside, q_after = _scan_quotes(part, q_open)
            blank = not part.strip()
            fact: Optional[str] = None
            if st.dropping_quote:
                fact = FACT_FIRST_PERSON  # the rest of a quoted answer the player never typed
                st.dropping_quote = bool(q_after)
            elif st.after_first_person and not blank:
                st.after_first_person = False
                if re.match(r"^\s*[\"\u201c]", part) and not _LABELLED_QUOTE_RE.match(part):
                    inner = " ".join(_norm_words(" ".join(_quoted_spans(part, False))))
                    if inner and inner not in pm_norm:  # an unlabelled quoted line straight after a first-person line: the player's answer, never typed
                        fact = FACT_FIRST_PERSON
                        st.dropping_quote = bool(q_after)
            if fact is None and not q_open and _FP_RE.match(outside):
                fact = FACT_FIRST_PERSON
                st.after_first_person = True
                st.dropping_quote = bool(q_after)  # an opening quote glued to the end of the sentence belongs to the answer that follows
            if fact is None and not q_open:
                ys = _YOU_SAY_RE.search(part)
                if ys and "you" in outside.lower():
                    inner = " ".join(_norm_words(" ".join(_quoted_spans(part[ys.end() - 1:], False))))
                    if inner and inner not in pm_norm:  # a line the narrator wrote for the player
                        fact = FACT_SPEECH
                        st.dropping_quote = bool(q_after)
            if fact is None and not q_open and "?" not in outside and not _HEDGE_RE.search(outside):
                m = _DECISION_RE.search(outside)
                if m and _decision_is_a_fact(outside, m, pm_words):
                    fact = FACT_DECISION
            if fact is None and (q_open or '"' in part or "\u201c" in part or "\u201d" in part):
                qw = _norm_words(" ".join(_quoted_spans(part, q_open)))
                if qw and pm_q and "?" in part and not _ATTRIB_RE.search(part) and not _ECHO_RE.search(text):  # ORW-1062: a houseguest echoing a question back is normal speech
                    opening = bool(_LABELLED_QUOTE_RE.search(part)) and len(qw) >= _OPEN_RUN and _has_run(qw[:_OPEN_RUN], pm_q, _OPEN_RUN)
                    cross = _has_run(st.recent_words + qw, pm_q, _CROSS_RUN, must_touch_from=len(st.recent_words))
                    if opening or cross:
                        fact = FACT_RECITATION
            if fact is not None:
                dropped.append((fact, part))
            else:
                kept.append(part)
                st.recent_words = (st.recent_words + _norm_words(" ".join(_quoted_spans(part, q_open))))[-40:]
            q_open = q_after
        if not dropped:
            return text, []
        return "".join(kept), dropped
    except Exception:  # failsoft-ok: player-voice detector (fail-open: the text is emitted as today)
        return text, []
