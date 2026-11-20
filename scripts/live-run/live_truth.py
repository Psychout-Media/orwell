"""ORW-109 - ENGINE TRUTH for the full-week tier: turn the engine's own state reads into the per-turn record the comparator judges, find what the engine COMMITTED between two
reads, and judge the run-level rules (a committed result the narration never told, a silent retcon, skipped time). Pure: no network, no model.

The state is what a player's BROWSER can read, composed by `screen_view` from the three routes the screens use (ORW-768, after the ORW-707/733 wall): GET /api/orwell/state (the closed
browser shape: board, house tiles, day schedule, time-of-day band), GET /api/orwell/status (the HUD and the decision card: the pending card with its options, the winner) and GET
/api/orwell/whereabouts (the presence strip: who is in the room, the headcounts). Nothing here reads a hidden or planned field: what a screen cannot show is NOT JUDGED (see
NOT_JUDGED). Roles only.
"""
from __future__ import annotations

import re

HOUR = 60.0
RESULT_WINDOW = 2   # a committed result must be told within this many turns of the one that committed it (the pass bar's untold-result rule, set by the coordinator ruling 11-19)
SKIP_BANDS = 1      # more than this many parts of the day in one message needs a sanctioned reason (a bed, a nap, a ceremony, a staged competition). No screen shows minutes, so the clock is judged by day part.
BANDS = ("morning", "afternoon", "evening", "night", "late-night")   # the HUD's time-of-day bands, in order within one in-game day
# What the browser cannot show, so the run does not judge it (listed in every report beside the other "not covered" lines).
NOT_JUDGED = ["T9 at minute precision (no screen shows minutes: the clock is judged by day part, a skip over a whole part of the day is caught, a skip inside one is not)",
              "the planned or hidden state behind any result (who the engine planned to nominate, a ballot, a relationship): the browser never receives it, so no check reads it"]

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


# The exact keys this tier reads from each browser route, as paths (`[]` = a list element). `frontend/tests/test_orw768_harness_reads_screens.py` holds /state's to `_BROWSER_STATE_SHAPE`, so a key the
# wall drops can never again be read here silently.
STATE_READS = ("phase", "week", "timeOfDay", "dayNumber", "finished", "daySchedule.due", "daySchedule.next", "daySchedule.minutesUntil", "player.id", "player.name", "pending.kind",
               "house[].id", "house[].name", "house[].status", "ceremony.hoh.id", "ceremony.hoh.name", "ceremony.nominees[].id", "ceremony.nominees[].name", "ceremony.veto.holder.id",
               "ceremony.veto.holder.name")
STATUS_READS = ("hoh", "nominees", "veto", "pending", "finished", "winner")   # the HUD and the decision card read these from /api/orwell/status
WHEREABOUTS_READS = ("present", "counts")                                       # the presence strip reads these from /api/orwell/whereabouts


def screen_view(state, status=None, whereabouts=None):
    """ORW-768: the ONE read a player's screens make, composed from the three browser routes. `state` = GET /api/orwell/state, `status` = GET /api/orwell/status (the HUD and the decision
    card: the pending card with its options, the board, the winner), `whereabouts` = GET /api/orwell/whereabouts ({"whereabouts": view}) or the bare view. A route that failed is None
    and its keys are simply absent (an absent key is read as unknown, never as empty). Returns the flat dict `facts` reads. Never adds a key a route did not send."""
    st = dict(state) if isinstance(state, dict) else {}
    s = status if isinstance(status, dict) else {}
    cer = dict(st.get("ceremony") or {}) if isinstance(st.get("ceremony"), dict) else {}
    if "hoh" in s or "nominees" in s or "veto" in s:   # the HUD's board wins over the state's own public ceremony facts
        cer.update({k: s[k] for k in ("hoh", "nominees", "veto") if k in s})
    if cer:
        st["ceremony"] = cer
    if "pending" in s:   # the decision card reads the status route; the state carries only the card's kind
        st["pending"] = s["pending"]
    for k in ("winner", "finished", "dayNumber", "timeOfDay", "earlyMorning", "lastEviction"):
        if k in s and k not in st:
            st[k] = s[k]
    w = whereabouts.get("whereabouts") if isinstance(whereabouts, dict) and "whereabouts" in whereabouts else whereabouts
    if isinstance(w, dict):
        st["whereabouts"] = w
    return st


def clock_label(st):
    """The clock as a player sees it: the HUD's day part and the day number ("morning, Day 2"). None while no clock runs."""
    band, day = st.get("timeOfDay"), st.get("dayNumber")
    if not isinstance(band, str) or not band:
        return None
    return f"{band}, Day {day}" if isinstance(day, int) else band


def band_position(label):
    """A monotonic position of a clock label on the day-part ladder (5 parts a day), or None. 'late-night' belongs to the Day it is shown with, as the HUD does."""
    m = re.match(r"^([a-z-]+)(?:, Day (\d+))?$", (label or "").strip())
    if not m or m.group(1) not in BANDS:
        return None
    return (int(m.group(2) or 1) - 1) * len(BANDS) + BANDS.index(m.group(1))


def facts(st):
    """The comparable facts of one screen read (`screen_view`): who holds what, as plain names."""
    st = st or {}
    cer = st.get("ceremony") or {}
    hoh = cer.get("hoh") if isinstance(cer.get("hoh"), dict) else st.get("hoh")
    noms = st.get("nominees") or cer.get("nominees") or []
    veto = st.get("veto") or cer.get("veto") or {}
    house = [h for h in (st.get("house") or []) if isinstance(h, dict)]
    pl = st.get("player")
    return {
        "phase": st.get("phase"), "week": st.get("week"), "clock": clock_label(st), "ds": st.get("daySchedule") or {},
        "hoh": _name(hoh), "nominees": [n for n in (_name(x) for x in noms) if n],
        "veto_holder": _name(veto.get("holder")) if isinstance(veto, dict) else None,
        "cast": [h["name"] for h in house if h.get("name")],
        "evicted": [h["name"] for h in house if h.get("name") and h.get("status") not in (None, "active")],
        "player": _name(pl), "winner": _name(st.get("winner")), "finished": bool(st.get("finished")),
        "pending": st.get("pending") or None, "counts": (st.get("whereabouts") or {}).get("counts"),
        "present": [h["name"] for h in ((st.get("whereabouts") or {}).get("present") or []) if isinstance(h, dict) and h.get("name")],
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


def time_findings(turns):
    """T9: more than SKIP_BANDS parts of the day inside one message with no sanctioned reason (a bed or nap message, a committed event, a phase move). Day-part precision only."""
    out = []
    for t in turns:
        a, b = band_position(t.get("clock_before")), band_position(t.get("clock"))
        if a is None or b is None or b - a <= SKIP_BANDS:
            continue
        if NAP_RE.search(t.get("msg") or "") or t.get("events") or t.get("phase") != t.get("phase_before"):
            continue
        out.append({"id": f"T9-time-skip[{t['label']}]", "ok": False, "severity": "fail", "detail": f"the clock moved {b - a} parts of the day in one message with no bed, nap, event or phase change"})
    return out
