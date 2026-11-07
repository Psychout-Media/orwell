"""ORW-184: per-dial repair of an authored VOICE, so one bad field no longer costs the whole voice.

Pure and deterministic (no I/O, no model, no engine call). `orwell_cast_authoring` computes the reason
codes (which field failed which check) and calls `repair_voice` with the SEEDED dials it read back from the
houseguest's roster card. The engine still receives a whole, well-formed voice (its `sanitizeAuthoredVoice`
whole-or-nothing contract is unchanged); what changes is that the FE mends the object before sending it
instead of discarding it.

Repair rules, per failing field:

* a dial (register / rhythm / energy / directness / humor / stressTell): replaced by the SEEDED dial for that
  houseguest, when the card clause provides one that itself passes the check. Otherwise unrepairable.
* `signature`: unrepairable (the card carries no seeded signature).
* `lexicon[i]`: the entry is removed. If no entry survives, unrepairable (the engine needs one).
* `catchphrases[i]`: the entry is removed (catchphrases are optional; an empty list drops the key).

An unrepairable voice is returned as `None`: the caller drops it whole, exactly like the legacy check.
Vault-free by construction: a voice is public persona, and the reason codes name fields, never prose.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional

# The six rendered dials, in the order `voiceFingerprint` (src/engine/voice.ts) prints them.
SEEDED_DIAL_KEYS = ("register", "rhythm", "directness", "energy", "humor", "stressTell")

# Reason codes (public, stable; they appear in logs and the admin failure ledger).
REASON_SCRIPT = "script"
REASON_DEGENERATE = "degenerate"
REASON_GENDER = "gender-descriptor"

# Repair actions.
ACTION_SEEDED = "seeded"
ACTION_REMOVED = "removed"

_ENTRY_RE = re.compile(r"^(lexicon|catchphrases)\[(\d+)\]$")

# The roster clause format, the exact inverse of the engine's `voiceFingerprint`:
#   talks in a {register}, {rhythm}, {directness} voice — {energy}, {humor} humor; under pressure {stressTell}
# Seeded values come from a closed vocabulary with no commas, so the split counts are exact. Anything that
# does not split into exactly 3 + 2 parts is ambiguous (e.g. an AUTHORED clause whose dial has a comma) and
# is refused: no floor is better than a wrong floor.
# The engine prints the humor dial "none" as "no humor" (`HUMOR_WORDS` in src/engine/voice.ts); read it back as "none".
_HUMOR_FROM_WORD = {"no": "none"}
_HEAD = "talks in a "
_VOICE_SEP = " voice — "
_HUMOR_SEP = " humor; under pressure "


def parse_voice_clause(clause: Optional[str]) -> Optional[dict]:
    """Read the six seeded dials back out of a roster-card `voice` clause. `None` when absent/ambiguous."""
    if not isinstance(clause, str) or not clause.startswith(_HEAD):
        return None
    body = clause[len(_HEAD):]
    if body.count(_VOICE_SEP) != 1 or body.count(_HUMOR_SEP) != 1:
        return None
    head, rest = body.split(_VOICE_SEP)
    mid, tell = rest.split(_HUMOR_SEP)
    head_parts = head.split(", ")
    mid_parts = mid.split(", ")
    if len(head_parts) != 3 or len(mid_parts) != 2:
        return None
    register, rhythm, directness = (p.strip() for p in head_parts)
    energy, humor = (p.strip() for p in mid_parts)
    humor = _HUMOR_FROM_WORD.get(humor, humor)
    out = {"register": register, "rhythm": rhythm, "directness": directness,
           "energy": energy, "humor": humor, "stressTell": tell.strip()}
    if not all(out.values()):
        return None
    return out


@dataclass(frozen=True)
class VoiceRepair:
    """The outcome of one repair pass. `voice` is the mended voice, or None when it cannot be mended."""
    voice: Optional[dict]
    reasons: tuple = ()        # ((field, code), ...) as found
    actions: tuple = ()        # ((field, code, action), ...) applied
    unrepairable: tuple = ()   # ((field, code), ...) that could not be mended

    @property
    def repaired(self) -> bool:
        return self.voice is not None and bool(self.actions)


def format_reasons(items) -> str:
    """`humor=degenerate, catchphrases[2]=script` (field names and codes only, never prose)."""
    return ", ".join(f"{f}={c}" for f, c, *_ in items)


def format_actions(actions) -> str:
    """`register=gender-descriptor->seeded; catchphrases[2]=script->removed`."""
    return "; ".join(f"{f}={c}->{a}" for f, c, a in actions)


def repair_voice(voice: dict, reasons, floor_dials: Optional[dict]) -> VoiceRepair:
    """Mend `voice` field by field. `reasons` are the (field, code) pairs the check found; `floor_dials` are
    the seeded dials that already passed the same check for this houseguest (missing keys = no floor)."""
    reasons = tuple(reasons or ())
    if not isinstance(voice, dict):
        return VoiceRepair(voice=None, reasons=reasons, unrepairable=reasons)
    if not reasons:
        return VoiceRepair(voice=dict(voice), reasons=())
    floor = floor_dials or {}
    out = {k: (list(v) if isinstance(v, list) else v) for k, v in voice.items()}
    actions: list = []
    unrepairable: list = []
    drop_entries: dict = {"lexicon": set(), "catchphrases": set()}
    for field, code in reasons:
        if field in SEEDED_DIAL_KEYS:
            seeded = floor.get(field)
            if isinstance(seeded, str) and seeded.strip():
                out[field] = seeded
                actions.append((field, code, ACTION_SEEDED))
            else:
                unrepairable.append((field, code))
            continue
        m = _ENTRY_RE.match(field)
        if m:
            drop_entries[m.group(1)].add(int(m.group(2)))
            actions.append((field, code, ACTION_REMOVED))
            continue
        unrepairable.append((field, code))  # `signature` (no seeded signature on the card) or unknown
    for key, idxs in drop_entries.items():
        if not idxs or not isinstance(out.get(key), list):
            continue
        kept = [x for i, x in enumerate(out[key]) if i not in idxs]
        if kept:
            out[key] = kept
        elif key == "catchphrases":
            out.pop(key, None)  # optional: an empty set is simply omitted (the engine's own rule)
        else:
            out[key] = []
            unrepairable.append((key, "empty"))
    if unrepairable:
        return VoiceRepair(voice=None, reasons=reasons, actions=tuple(actions), unrepairable=tuple(unrepairable))
    return VoiceRepair(voice=out, reasons=reasons, actions=tuple(actions))
