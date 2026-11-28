"""ORW-1156 part 3 - the labelled corpus of real player messages, as CODES, and each gate's miss rate.

No chat text is ever stored. A corpus row is `{"code": <short hash>, "acts": [<act codes>], "gates": {<gate>: <fired>}}`:
  * `acts`   what the message really led to, taken from the turn itself and never from a guess about the words: an act the engine COMMITTED (a turnIn or nap, a claimBed, a moveTo or an applied
             player move, a search), plus an act the narration CLAIMED (`claim_commit.extract_claims`), because a claim with no commit is exactly the miss this class is about.
  * `gates`  what each gate decided on that message when the builder ran the CURRENT gate code over it (`gate_decisions`). Re-running the builder re-measures after a gate is fixed.
A MISS for a gate is a row whose acts include one of the gate's own acts and where the gate said no (`fired` False). The rate is misses over the rows with such an act.
`miss_report()` is what the admin health page shows (`gates.corpus`); `scripts/build_gate_corpus.py` builds the file from transcript exports on a machine that may read them.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Iterable, Optional

ACTS = ("sleep", "bed", "move", "search")
# gate -> the acts it must let through. A gate that is not listed is logged but not measured here (plain-acts is positive-only; the belt nudge gates have no message).
GATE_ACTS = {
    "bed-intent": ("sleep",),
    "act-first-prefilter": ACTS,
    "act-first-no-cue": ACTS,
    "act-first-ungrounded": ACTS,
    "search-cue": ("search",),
    "move-veto": ("move",),
    "bed-veto": ("bed",),
    "step-veto": ("sleep",),
}
_TOOL_ACT = {"turnIn": "sleep", "nap": "sleep", "claimBed": "bed", "moveTo": "move", "searchForHouseguest": "search", "search": "search"}
_CLAIM_ACT = {"claim-sleep": "sleep", "claim-bed": "bed"}


def corpus_path() -> Path:
    p = os.environ.get("ORWELL_GATE_CORPUS", "").strip()
    if p:
        return Path(p)
    try:
        from src.config import get_config
        return Path(get_config().data_dir) / "gate_corpus.json"
    except Exception:  # failsoft-ok: the default location
        return Path("data") / "gate_corpus.json"


def acts_of_turn(tool_names: Iterable[str], narration: str = "", moved: bool = False) -> "list[str]":
    """The act codes one turn really carried: committed tools, an applied player move, and the acts the narration claimed."""
    out = {_TOOL_ACT[t] for t in tool_names if t in _TOOL_ACT}
    if moved:
        out.add("move")
    try:
        from src import claim_commit
        out |= {_CLAIM_ACT[c.kind] for c in claim_commit.extract_claims(narration or "") if c.kind in _CLAIM_ACT}
    except Exception:  # failsoft-ok: labels from tools alone
        pass
    return sorted(out)


def gate_decisions(text: str, *, rooms: Optional[Iterable[str]] = None, people: Optional[Iterable[str]] = None) -> "dict[str, bool]":
    """Each measured gate's decision (True = lets the act through) on one message, from the current gate code. Offline and deterministic. Rooms default to the whole house; the people are
    the capitalised words in the message (the closest a transcript without a roster gets to 'a houseguest is named')."""
    from src import act_first as af
    from src.agent_loop import _player_means_going_to_bed
    from src.house_rooms import HOUSE_ROOMS
    rooms = list(rooms if rooms is not None else HOUSE_ROOMS)
    people = list(people if people is not None else re.findall(r"(?<![.!?]\s)(?<!^)\b([A-Z][a-z]{2,})\b", text or ""))
    ctx = {"here": None, "people": people, "room_names": None, "pending_kind": None, "sleep_ok": True}
    clean = af.clean_text(text)
    return {
        "bed-intent": bool(_player_means_going_to_bed(text)),
        "act-first-prefilter": af.prefilter(text) is None,
        "act-first-no-cue": bool(af.has_cue(text)),
        "act-first-ungrounded": not af.can_commit_nothing(clean, rooms, ctx),
        "search-cue": bool(af.search_cue(clean, people)),
        "move-veto": not af.move_vetoed(clean),
        "bed-veto": not af.bed_vetoed(clean),
        "step-veto": not af.step_vetoed(clean, "turnIn"),
    }


def row_for(text: str, acts: Iterable[str], **kw) -> dict:
    from src.gate_log import code_of
    return {"code": code_of(text), "acts": sorted(set(acts)), "gates": gate_decisions(text, **kw)}


def miss_rates(rows: "list[dict]") -> "dict[str, dict[str, Any]]":
    out: "dict[str, dict[str, Any]]" = {}
    for gate, acts in GATE_ACTS.items():
        pos = [r for r in rows if set(r.get("acts") or ()) & set(acts)]
        miss = [r for r in pos if not (r.get("gates") or {}).get(gate, True)]
        out[gate] = {"acts": list(acts), "positives": len(pos), "misses": len(miss), "missRate": round(len(miss) / len(pos), 4) if pos else None}
    return out


def load(path: Optional[Path] = None) -> "list[dict]":
    p = Path(path) if path else corpus_path()
    data = json.loads(p.read_text())
    rows = data.get("rows") if isinstance(data, dict) else data
    return [r for r in rows if isinstance(r, dict)]


def miss_report(path: Optional[Path] = None) -> "Optional[dict[str, Any]]":
    """The per-gate miss rates and the row counts for the admin page; None when there is no corpus file yet."""
    try:
        rows = load(path)
    except Exception:  # failsoft-ok: no corpus yet is a normal state, shown as such
        return None
    return {"rows": len(rows), "withAct": sum(1 for r in rows if r.get("acts")), "gates": miss_rates(rows)}
