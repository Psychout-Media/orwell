"""ORW-109 - ENGINE TRUTH for the full-week tier: turn the engine's own state reads into the per-turn record the comparator judges, find what the engine COMMITTED between two
reads, and judge the run-level rules (a committed result the narration never told, a silent retcon, skipped time). Pure: no network, no model.

The state is the engine's `getGameState` as the front end serves it (GET /api/orwell/state, houseguest cards already cut to id / name / status). Roles only.
"""
from __future__ import annotations

import re

HOUR = 60.0
RESULT_WINDOW = 2   # a committed result must be told within this many turns of the one that committed it (the pass bar's untold-result rule, set by the coordinator ruling 11-19)
SKIP_HOURS = 1.0    # more than this in one message needs a sanctioned reason (a bed, a nap, a ceremony, a staged competition)

KEYWORDS = {
    "hoh": re.compile(r"(?i)head of household|\bhoh\b|\bcrown|new (?:head|hoh)"),
    "nominations": re.compile(r"(?i)nominat|on the block|up for eviction"),
    "veto": re.compile(r"(?i)\bveto\b"),
    "eviction": re.compile(r"(?i)evict|voted out|\bvotes?\b|goodbye|leaves the house|walks out"),
    "winner": re.compile(r"(?i)winner|\bwins?\b|\bwon\b|crowned|jury"),
}
NAP_RE = re.compile(r"(?i)\b(?:nap|lie down|rest)\b|goodnight|go to (?:bed|sleep)|turn in")


def _name(x):
    if isinstance(x, dict):
        return x.get("name")
    return x if isinstance(x, str) else None


def facts(st):
    """The comparable facts of one engine read: who holds what, as plain names."""
    st = st or {}
    cer = st.get("ceremony") or {}
    hoh = cer.get("hoh") if isinstance(cer.get("hoh"), dict) else st.get("hoh")
    noms = st.get("nominees") or cer.get("nominees") or []
    veto = st.get("veto") or cer.get("veto") or {}
    house = [h for h in (st.get("house") or []) if isinstance(h, dict)]
    pl = st.get("player")
    return {
        "phase": st.get("phase"), "week": st.get("week"), "clock": st.get("clockLabel"), "ds": st.get("daySchedule") or {},
        "hoh": _name(hoh), "nominees": [n for n in (_name(x) for x in noms) if n],
        "veto_holder": _name(veto.get("holder")) if isinstance(veto, dict) else None,
        "cast": [h["name"] for h in house if h.get("name")],
        "evicted": [h["name"] for h in house if h.get("name") and h.get("status") not in (None, "active")],
        "player": _name(pl), "winner": _name(st.get("winner")), "finished": bool(st.get("finished")),
        "pending": st.get("pending") or None, "counts": (st.get("whereabouts") or {}).get("counts"),
        "veto_holder_raw": veto.get("holder") if isinstance(veto, dict) else None,
    }


def committed_events(a, b):
    """What the engine committed between two reads (a before, b after): [{kind, subjects}]. A fact that was empty or different and is now set is a new commitment."""
    fa, fb = facts(a), facts(b)
    ev = []
    if fb["hoh"] and fb["hoh"] != fa["hoh"]:
        ev.append({"kind": "hoh", "subjects": [fb["hoh"]]})
    new_noms = [n for n in fb["nominees"] if n not in fa["nominees"]]
    if new_noms:
        ev.append({"kind": "nominations", "subjects": new_noms})
    if fb["veto_holder"] and fb["veto_holder"] != fa["veto_holder"]:
        ev.append({"kind": "veto", "subjects": [fb["veto_holder"]]})
    gone = [n for n in fb["evicted"] if n not in fa["evicted"]]
    if gone:
        ev.append({"kind": "eviction", "subjects": gone})
    if (fb["winner"] and fb["winner"] != fa["winner"]) or (fb["finished"] and not fa["finished"]):
        ev.append({"kind": "winner", "subjects": [fb["winner"]] if fb["winner"] else []})
    return ev


def turn_record(label, msg, st0, st, reply, secs=None, error=None):
    """The record live_compare.compare_turn and the run-level rules read. `reply` is the PUBLIC bubble text of the turn (reasoning is kept apart by the transport)."""
    f0, f1 = facts(st0), facts(st)
    return {"label": label, "msg": (msg or "")[:120], "text": reply or "", "secs": secs, "error": error,
            "phase": f1["phase"], "phase_before": f0["phase"], "week": f1["week"], "clock": f1["clock"], "clock_before": f0["clock"], "ds": f1["ds"],
            "nominees": f1["nominees"], "veto_holder": f1["veto_holder_raw"], "hoh_name": f1["hoh"], "evicted": f1["evicted"], "cast": f1["cast"], "player": f1["player"],
            "winner": f1["winner"], "finished": f1["finished"], "finalists": [], "engine_pending": bool(f1["pending"]), "pending_before": bool(f0["pending"]),
            "counts_start": f0["counts"], "counts": f1["counts"], "events": committed_events(st0, st)}


def _first(n):
    return (n or "").split()[0].lower() if n else ""


def names_in(text, names):
    low = (text or "").lower()
    return [n for n in names if n and (n.lower() in low or re.search(r"\b" + re.escape(_first(n)) + r"\b", low))]


def told(event, texts, player=None):
    """True when the narration of the window names the event's subject or uses the event's own words. The player's own result is told by the words alone (the player is 'you')."""
    blob = "\n".join(texts)
    if KEYWORDS[event["kind"]].search(blob):
        return True
    return bool(names_in(blob, [s for s in event["subjects"] if s]))


def missing_results(turns, window=RESULT_WINDOW):
    """Findings for every committed result the narration never told within `window` turns. A result committed too near the run's end to judge is a NOTE (unjudged)."""
    out = []
    for i, t in enumerate(turns):
        for ev in t.get("events") or []:
            span = turns[i:i + window + 1]
            subject = ", ".join(ev["subjects"]) or "-"
            mine = ev["subjects"] and t.get("player") and any(s == t["player"] for s in ev["subjects"])
            if told(ev, [x.get("text") or "" for x in span], t.get("player")):
                continue
            judged = len(span) == window + 1
            out.append({"id": f"R1-missing-result[{t['label']}]", "ok": not judged, "severity": "fail" if judged else "note", "kind": ev["kind"],
                        "detail": f"the engine committed {ev['kind']}" + (" for the player" if mine else "") + f" ({subject}) and {len(span)} turn(s) of narration never told it"
                                  + ("" if judged else " (the run ended inside the window: not judged)")})
    return out


def retcons(turns):
    """T4: a fact the engine committed for a week changes later in the same week (a different head of household or veto holder)."""
    out, seen = [], {}
    for t in turns:
        wk = t.get("week")
        for key, val in (("hoh", t.get("hoh_name")), ("veto", (t.get("veto_holder") or {}).get("name") if isinstance(t.get("veto_holder"), dict) else t.get("veto_holder"))):
            if not val:
                continue
            prev = seen.get((wk, key))
            if prev and prev != val:
                out.append({"id": f"T4-retcon[{t['label']}]", "ok": False, "severity": "fail", "detail": f"the committed {key} for week {wk} changed to a different houseguest"})
            seen[(wk, key)] = val
    return out


def _abs_hours(label):
    m = re.match(r"^(\d{1,2}):(\d{2})\s?(am|pm),? Day (\d+)$", (label or "").strip(), re.I)
    if not m:
        return None
    h = int(m.group(1)) % 12 + (12 if m.group(3).lower() == "pm" else 0) + int(m.group(2)) / 60
    return (int(m.group(4)) - 1) * 24 + h + (24 if h < 8 else 0)


def time_findings(turns):
    """T9: more than an hour of in-game time inside one message with no sanctioned reason (a bed or nap message, a committed event, a phase move)."""
    out = []
    for t in turns:
        a, b = _abs_hours(t.get("clock_before")), _abs_hours(t.get("clock"))
        if a is None or b is None or b - a <= SKIP_HOURS:
            continue
        if NAP_RE.search(t.get("msg") or "") or t.get("events") or t.get("phase") != t.get("phase_before"):
            continue
        out.append({"id": f"T9-time-skip[{t['label']}]", "ok": False, "severity": "fail", "detail": f"the clock moved {round(b - a, 1)} h in one message with no bed, nap, event or phase change"})
    return out
