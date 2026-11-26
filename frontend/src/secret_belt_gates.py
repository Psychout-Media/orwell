"""ORW-1070 / ORW-1071: the gates around the confide, expose and trade back-fill belts.

Two jobs, both free of any model call.

1. A structural signal that widens the regex prefilter. The regexes in agent_loop name phrasings; a player
   who words the move another way was never offered to the extractor (pipeline recall 0.56 to 0.73 in the
   A6 audit while the extractor alone read 0.91 to 1.0). The structural signal is a roster name in the
   player's line, which every miss in the audit carried. The extractor and the engine stay the gatekeepers.
2. Engine-fact checks run on what an extractor returned, before the one-shot secret is spent: who holds
   the secret (the player), who is present to hear it, and every party a fact names, not only its subject.

Skips are counted per belt with a small sampled ring, so a miss is visible (the old gate counted nothing).
"""
from __future__ import annotations

import collections
import os
import re
from typing import Iterable, Optional

_RING_EVERY = 10
_RING_MAX = 20
_skips: dict = collections.defaultdict(int)
_seen: dict = collections.defaultdict(int)
_ring: dict = collections.defaultdict(lambda: collections.deque(maxlen=_RING_MAX))
_refusals: dict = collections.defaultdict(int)

# Words that make a line with a roster name worth an extraction call. Broad stems, not phrasings: the regexes in
# agent_loop name phrasings, these only say "this line is about opening up / airing / exchanging".
_CONFIDE_WORDS_RE = re.compile(
    r"\b(?:listening|okay|ok|wrong|weigh\w*|upset|quiet|worr\w*|notice\w*|feel\w*|struggl\w*|hurt\w*|open\w*|"
    r"talk\w*|tell|trust|honest|truth|really|bother\w*|hiding|alone|here for)\b", re.I)
_EXPOSE_WORDS_RE = re.compile(
    r"\b(?:everyone|everybody|everyone's|house|y'?all|all of you|blast|out|reveal\w*|spill\w*|announc\w*|listen up|expos\w*|"
    r"whole|public\w*|broadcast\w*)\b", re.I)
_TRADE_WORDS_RE = re.compile(
    r"\b(?:secret|intel|dirt|info|trade\w*|swap\w*|barter\w*|owe|exchange|return|favou?r|for a|for your|for my|"
    r"hand over|name for)\b", re.I)
_MIN_WORDS = 4


def enabled() -> bool:
    return os.environ.get("ORW_SECRET_BELT_STRUCTURAL", "1").strip().lower() not in ("0", "false", "off", "no")


def _first_names(house: Iterable[dict]) -> list:
    out = []
    for h in house or []:
        name = (h.get("name") if isinstance(h, dict) else None) or ""
        name = name.strip()
        if len(name) >= 2:
            out.append(name)
            first = name.split()[0]
            if first != name and len(first) >= 3:
                out.append(first)
    return out


def names_in_line(line: str, house: Iterable[dict]) -> list:
    """The roster names (full or first) that the player's line mentions as whole words."""
    text = line or ""
    hits = []
    for n in _first_names(house):
        if re.search(r"(?<![A-Za-z0-9])" + re.escape(n) + r"(?![A-Za-z0-9])", text, re.I):
            hits.append(n)
    return hits


def structural_signal(belt: str, line: str, house: Iterable[dict]) -> bool:
    """True when the player's line names a houseguest and carries a word of the move's kind (opening up, airing
    something to the room, exchanging something). Cheap and wide on purpose: the extractor and the engine decide."""
    if not enabled():
        return False
    line = line or ""
    if len(line.split()) < _MIN_WORDS or not names_in_line(line, house):
        return False
    rx = {"confide": _CONFIDE_WORDS_RE, "expose": _EXPOSE_WORDS_RE, "trade": _TRADE_WORDS_RE}.get(belt)
    return bool(rx and rx.search(line))


def gate(belt: str, regex_hit: bool, nudges: int, line: str, house, owner=None) -> bool:
    """The call-site gate: the old regex OR the structural signal, under the per-turn cap. A turn that
    neither signal admits is counted (and sampled) as a skip."""
    if nudges >= 1:
        return False
    _seen[belt] += 1
    if regex_hit or structural_signal(belt, line, house):
        return True
    _skips[belt] += 1
    if _skips[belt] % _RING_EVERY == 1:
        _ring[belt].append((line or "")[:120])
    return False


def stats() -> dict:
    return {"seen": dict(_seen), "skips": dict(_skips), "refusals": dict(_refusals),
            "ring": {k: list(v) for k, v in _ring.items()}}


def note_refusal(belt: str, reason: str) -> None:
    _refusals[f"{belt}:{reason}"] += 1


def reset_stats() -> None:
    _skips.clear(); _seen.clear(); _ring.clear(); _refusals.clear()


# ── engine-fact checks on an extractor's answer ───────────────────────────────────────────────────

def _name_forms(name: str) -> set:
    return {n for n in {name, (name or "").split(" ")[0]} if len(n) >= 3}


def fact_party_ids(fact: dict, roster: dict) -> set:
    """Every houseguest a fact is about: its subject, plus any houseguest the text joins to the subject as a
    co-party ("X and Y", either order). A houseguest the text merely names (the victim of a nomination, say)
    is not a party, so the secret can still be traded to them."""
    parties = set()
    subj = (fact or {}).get("subject")
    if isinstance(subj, str):
        parties.add(subj)
    content = (fact or {}).get("content") or ""
    if not isinstance(subj, str) or subj not in (roster or {}):
        return parties
    for hid, name in roster.items():
        if hid == subj or not name:
            continue
        for sn in _name_forms(roster[subj]):
            for n in _name_forms(name):
                pair = (re.escape(sn), re.escape(n))
                if (re.search(rf"(?<![A-Za-z0-9]){pair[0]}\s+(?:and|&|with)\s+{pair[1]}(?![A-Za-z0-9])", content, re.I)
                        or re.search(rf"(?<![A-Za-z0-9]){pair[1]}\s+(?:and|&|with)\s+{pair[0]}(?![A-Za-z0-9])", content, re.I)):
                    parties.add(hid)
    return parties


def present_ids(whereabouts: Optional[dict]) -> Optional[set]:
    """Ids of the houseguests in the player's room, or None when the engine gave no usable answer."""
    if not isinstance(whereabouts, dict):
        return None
    pres = whereabouts.get("present")
    if not isinstance(pres, list):
        return None
    ids = set()
    for p in pres:
        if isinstance(p, dict) and isinstance(p.get("id"), str):
            ids.add(p["id"])
        elif isinstance(p, str):
            ids.add(p)
    return ids


def trade_refusal(fact: dict, to_id: str, roster: dict, present: Optional[set]) -> Optional[str]:
    """Why a trade must not be spent, or None. The recipient may not be any party of the fact; the
    recipient must be present (when the engine's presence is known)."""
    if to_id in fact_party_ids(fact, roster):
        return "recipient-is-a-party"
    if present is not None and to_id not in present:
        return "recipient-not-present"
    return None


def expose_refusal(fact: dict, roster: dict, present: Optional[set]) -> Optional[str]:
    """Why an expose must not be spent, or None. Outing needs an audience: at least two houseguests in
    the room (one listener is a private disclosure, which is not an expose)."""
    if present is not None and len(present) < 2:
        return "no-audience"
    return None
