"""ORW-1182 - a competition is told once. Two deterministic cuts on the narrator's reply while a staged competition is live:

1. a houseguest an EARLIER reply already voiced going out is not narrated falling again (a sentence that names them with a fall cue is cut);
2. a sentence that repeats VERBATIM one of the last five replies of this competition (or an earlier chunk of this same reply) is cut.

Engine truth is the only input: the exits come from the game state's competition floor (``ceremony.competition.out``), read at the END of every turn, so
"already voiced" means "out when the previous reply finished". Pure functions plus a small per-user memory ledger (memory-only, like the engine's own told
list: a restart forgets it and the cuts simply stand down). Never raises into the turn; never touches game state.
"""
from __future__ import annotations

import logging
import re
from collections import deque
from typing import Iterable, Optional

logger = logging.getLogger(__name__)

RECENT_REPLIES = 5
_MIN_WORDS = 4  # a short stock reply ("Okay.") is not a repeat worth cutting

_SENT_RE = re.compile(r".+?(?:[.!?…]+[\"”’')\]]*(?:\s+|$)|$)", re.S)
_FALL_RE = re.compile(
    r"\b(?:out|eliminat\w*|falls?|fell|falling|drops?|dropped|knocked|misses|missed|slips?|slipped|stumbl\w*|tumbl\w*|goes?\s+down|went\s+down|"
    r"steps?\s+(?:back|off|out)|stepped\s+(?:back|off|out)|loses|lost|disqualif\w*|splash\w*|crash\w*|wipes?\s*out|wiped\s+out|first\s+to\s+go|done)\b",
    re.I)


def split_sentences(text: str) -> list:
    """Sentences with their trailing whitespace kept, so ''.join(parts) == text."""
    return [m.group(0) for m in _SENT_RE.finditer(text or "") if m.group(0)]


def normalize(sentence: str) -> str:
    return " ".join(re.findall(r"[a-z0-9']+", (sentence or "").lower()))


def _name_patterns(names: Iterable[str]) -> list:
    pats = []
    for n in names:
        n = str(n or "").strip()
        if not n:
            continue
        forms = {n}
        first = n.split()[0]
        if len(first) >= 3:
            forms.add(first)
        pats.append(re.compile(r"\b(?:" + "|".join(re.escape(f) for f in sorted(forms, key=len, reverse=True)) + r")\b"))
    return pats


def cut_repeats(text: str, told_names: Iterable[str], recent: Iterable[set], this_turn: Optional[set] = None) -> "tuple[str, list]":
    """Return (kept text, [(reason, sentence)...]). `recent` is an iterable of per-reply sets of normalized sentences (the last five replies);
    `this_turn` (mutated) holds the normalized sentences already let through earlier in this reply."""
    parts = split_sentences(text)
    if not parts:
        return text, []
    pats = _name_patterns(told_names)
    seen = set().union(*recent) if recent else set()
    cur = this_turn if this_turn is not None else set()
    kept, dropped = [], []
    for p in parts:
        norm = normalize(p)
        words = len(norm.split())
        if pats and _FALL_RE.search(p) and any(pt.search(p) for pt in pats):
            dropped.append(("told-exit", p.strip()))
            continue
        if words >= _MIN_WORDS and (norm in seen or norm in cur):
            dropped.append(("verbatim", p.strip()))
            continue
        if words >= _MIN_WORDS:
            cur.add(norm)
        kept.append(p)
    if not dropped:
        return text, []
    return "".join(kept), dropped


class _Ledger:
    def __init__(self) -> None:
        self.told: set = set()
        self.recent: deque = deque(maxlen=RECENT_REPLIES)
        self.this_turn: set = set()


_LEDGERS: dict = {}


def _led(user) -> _Ledger:
    k = user if user else "_"
    if k not in _LEDGERS:
        _LEDGERS[k] = _Ledger()
    return _LEDGERS[k]


def reset(user=None) -> None:
    _LEDGERS.pop(user if user else "_", None)


def screen(user, text: str) -> "tuple[str, list]":
    """Cut one streamed chunk against the ledger. No ledger content (no earlier reply of a live competition) => the text is returned untouched."""
    try:
        led = _LEDGERS.get(user if user else "_")
        if led is None or not (led.told or led.recent):
            return text, []
        return cut_repeats(text, led.told, led.recent, led.this_turn)
    except Exception as e:  # failsoft-ok: a guard never gags a healthy turn
        logger.debug(f"[comp-repeat] screen skipped: {e}")
        return text, []


def comp_out_names(state) -> Optional[list]:
    """The names out of the live staged competition in a game-state read, or None when no competition floor is live (nothing out yet counts as none)."""
    try:
        comp = ((state or {}).get("ceremony") or {}).get("competition")
        if not isinstance(comp, dict):
            return None
        out = [str(p.get("name")) for p in (comp.get("out") or []) if isinstance(p, dict) and p.get("name")]
        return out or None
    except Exception:
        return None


def record_turn(user, narration: str, state) -> None:
    """End of a reply: if a staged competition is live with exits, fold this reply into the ledger (its exits become 'already voiced', its sentences
    join the last-five record); otherwise forget the competition entirely."""
    try:
        out = comp_out_names(state)
        if out is None:
            reset(user)
            return
        led = _led(user)
        led.told = set(out)
        led.recent.append({n for n in (normalize(s) for s in split_sentences(narration or "")) if len(n.split()) >= _MIN_WORDS})
        led.this_turn = set()
    except Exception as e:  # failsoft-ok: bookkeeping only
        logger.debug(f"[comp-repeat] record skipped: {e}")


async def after_turn(narration: str, owner) -> None:
    """The live hook (end of every narrated turn): read the competition floor from the engine, then fold the reply in. Fail-soft."""
    try:
        from src import orwell_engine as _oe
        state = await _oe.get_game_state(user=owner)
        record_turn(owner, narration, state)
    except Exception as e:  # failsoft-ok: bookkeeping only
        logger.debug(f"[comp-repeat] hook skipped: {e}")
