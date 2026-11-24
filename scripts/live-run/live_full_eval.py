"""ORW-109 - the full-week tier's JUDGE: every turn against the pass bar (the vault note "Live Run Pass Bar", checks T1-T20) plus the run-level rules, and the anonymised report.
Pure: no network, no model, no browser. Unit-tested offline in frontend/tests/test_live_full.py with a planted positive control for every finding class.

A turn is the dict live_truth.turn_record builds. A finding is {id, turn, check, category, severity, detail}. Categories (the coordinator cards these):
  contradictions   the narration disagrees with the engine (phase, nominees, veto holder, evictee, winner, a sealed ballot, a headcount, a clock, a silent retcon, skipped time)
  stand-in         a canned engine line (or a refusal / apology shell) shown as the reply
  missing-results  a result the engine committed that the narration never told
  wall-leaks       reasoning, a raw npc id, an operator aside, machinery names, the narrator prompt's own text, the narrator writing the player's words
  unanswered       a player message that got no real reply
  stalls           a due event that did not fire within the stall rule, or the same reply three times in a row
"""
from __future__ import annotations

import html
import json
import re

import live_compare as lc
import live_detect as ld
import live_truth as lt
from live_short import COMP_PLAY_RE, LEAK_RE, PHANTOM_CER_RE, SHELL_RE, ZERO_CLOCK_RE, headcount_claims

CATEGORIES = ("contradictions", "stand-in", "missing-results", "wall-leaks", "unanswered", "stalls")
MIN_SCENE_CHARS = 40          # under this a reply is a header or a one-liner, not a scene (the bar's T1)
THIN_SCENE_CHARS = 200        # under this it is only a NOTE
COMP_PHASES = ("hoh-competition", "veto-competition", "final-hoh", "final-competition")
BAR = {"B1": "T3", "B2": "T3", "B3": "T3", "B5": "T3", "B4": "T7", "B6": "T6"}
BAR_CATEGORY = {"T2": "contradictions", "T3": "contradictions", "T4": "contradictions", "T7": "wall-leaks", "T9": "contradictions", "T13": "contradictions", "T14": "contradictions", "T16": "contradictions", "T19": "contradictions",
                "T1": "stand-in", "T5": "unanswered", "T6": "wall-leaks", "T11": "wall-leaks", "R1": "missing-results", "S1": "stalls", "L1": "stalls"}
NOT_COVERED = ["T8 choices go through the card (the driver answers every card itself; a choice taken without one is not observable from the chat)",
               "T10 invented confession (needs the engine's disclosure log, which the player channel never shows)",
               "T14 early-morning label: judged only when the run logs the HUD's day-part label (the played-transcript judge, judge_transcript.py, does; this driver does not)",
               "T19 the engine moves first: judged only when the run logs the presence strip's room (the played-transcript judge does); the narrator voicing the exit and the arrival is not judged (a reader's call)",
               "T12 premiere toasts, T15 awake list, T17 recap per bedtime and T18 naps: the driver plays a nap but does not judge them",
               "T20 early sleepers wake alone",
               "two windows (the bar's full-week addition): one window is played",
               "T7 hidden information beyond a sealed ballot named to a voter, and T11 perspective leaks: those need a reader (the narration-fidelity audit), not a regex"]
NOT_JUDGED = lt.NOT_JUDGED   # ORW-768: what no screen shows, so no check reads it (the browser wall: ORW-707 / ORW-733 / ORW-768). Listed in every report.


def _f(turn, check, severity, detail, cid=None, category=None):
    return {"id": f"{cid or check}[{turn.get('label')}]", "turn": turn.get("label"), "check": check, "category": category or BAR_CATEGORY.get(check, "contradictions"),
            "severity": severity, "detail": detail}


def judge_turn(t, table=None):
    """Every finding for one turn (failing or noted). Passing checks are not listed; counts are kept by the caller."""
    out, text = [], t.get("text") or ""
    # T1 / T5: a real scene that answers the message
    stand = ld.stand_in_hits(text, table)
    if t.get("error") and not text.strip():
        out.append(_f(t, "T5", "fail", f"no reply to the player's message ({t['error']})", "T5-no-reply"))
    elif not text.strip():
        out.append(_f(t, "T5", "fail", "the player's message got an empty reply", "T5-empty-reply"))
    elif ld.stand_in_only(text, table):
        out.append(_f(t, "T1", "fail", f"the whole reply is a canned line: {', '.join(stand)}", "T1-stand-in-only", "stand-in"))
        out.append(_f(t, "T5", "fail", "the player's message was answered with a canned line, not a scene", "T5-canned-answer", "unanswered"))
    elif stand:
        out.append(_f(t, "T1", "fail", f"the reply carries a canned line: {', '.join(stand)}", "T1-stand-in-inside", "stand-in"))
    elif ld.refusal_only(text) or SHELL_RE.search(text):
        out.append(_f(t, "T1", "fail", "the reply is a refusal or apology shell, not a scene", "T1-shell", "stand-in"))
    elif len(text.strip()) < MIN_SCENE_CHARS:
        out.append(_f(t, "T1", "fail", f"the reply is {len(text.strip())} characters: a header or a one-liner, not a scene", "T1-thin"))
    elif len(text.strip()) < THIN_SCENE_CHARS:
        out.append(_f(t, "T1", "note", f"a thin reply ({len(text.strip())} characters)", "T1-short"))
    # T2: the narration is in the engine's phase
    phase = t.get("phase")
    ds = t.get("ds") or {}
    m = COMP_PLAY_RE.search(text)
    if m and phase not in COMP_PHASES and not ds.get("due") and phase_known(phase):
        out.append(_f(t, "T2", "fail", f"competition play is narrated ({m.group(0)!r}) while the engine is at {phase}", "T2-phase-comp"))
    m = PHANTOM_CER_RE.search(text)
    if m and phase in ("hoh-competition", "veto-competition", "premiere", "setup") and phase_known(phase):
        out.append(_f(t, "T2", "fail", f"a ceremony is voiced ({m.group(0)!r}) while the engine is at {phase}", "T2-phase-ceremony"))
    # T3 / T6 / T7: the comparator (board claims, sealed ballots, reasoning and operator text)
    for c in lc.compare_turn(t):
        if c["ok"]:
            continue
        rule = c["id"].split("[")[0].split("-")[0]
        chk = BAR.get(rule, "T3")
        out.append(_f(t, chk, "fail", c["detail"], c["id"].split("[")[0], BAR_CATEGORY.get(chk, "contradictions") if chk != "T6" else "wall-leaks"))
    # T6: wall leaks the comparator does not know (npc ids, operator asides, machinery, the narrator prompt's own text)
    for kind, snip in ld.wall_leaks(text, None, LEAK_RE):
        if kind == "reasoning":
            continue
        out.append(_f(t, "T6", "fail", f"a {kind} reached the public bubble" + (f": {snip!r}" if kind in ("machinery", "raw-npc-id") else ""), f"T6-{kind}", "wall-leaks"))
    for fact in ld.player_voice_hits(text, t.get("msg")):
        out.append(_f(t, "T11", "fail", f"the narrator speaks for the player ({fact})", "T11-player-voice", "wall-leaks"))
    # T13: zero clocks; T16: headcounts include the player
    m = ZERO_CLOCK_RE.search(text)
    if m:
        out.append(_f(t, "T13", "fail", f"the reply states a clock time ({m.group(0)!r})", "T13-clock"))
    for sev, n, said, explicit in headcount_claims(text):
        truth = {c.get("house") for c in (t.get("counts_start"), t.get("counts")) if isinstance(c, dict) and isinstance(c.get("house"), int)}
        rooms = {c.get("room") for c in (t.get("counts_start"), t.get("counts")) if isinstance(c, dict)}
        if not truth or n in truth or (not explicit and n in rooms):
            continue
        out.append(_f(t, "T16", "fail" if sev == "fail" else "note", f"the reply says {said!r}; the engine counts {sorted(truth)} in the house, the player included", "T16-headcount"))
    return out


def early_morning_findings(turns):
    """T14 (Ryne 11-15, ORW-392): before the house's wake-up the HUD's day part reads "Early morning", the mirror of "Late night", and never otherwise. Judged on a turn only when
    both the engine's flag (`early_morning`, from the status route) and the label the player saw (`hud_tod`, the HUD's rendered text) were logged; otherwise not judged."""
    out = []
    for t in turns:
        flag, shown = t.get("early_morning"), t.get("hud_tod")
        if not isinstance(flag, bool) or not isinstance(shown, str) or not shown.strip():
            continue
        says = "early morning" in shown.lower()
        if flag and not says:
            out.append(_f(t, "T14", "fail", f"the engine says it is before the wake-up, but the HUD shows {shown.strip()!r}, not \"Early morning\"", "T14-not-early"))
        elif says and not flag:
            out.append(_f(t, "T14", "fail", f"the HUD shows {shown.strip()!r} while the engine says it is not before the wake-up", "T14-false-early"))
    return out


MOVE_TO_RE = re.compile(r"\b(?:i|we)(?:'ll| will)?\s+(?:go|head|walk|move|wander|step|slip|duck|make my way)\s+(?:out\s+|back\s+|over\s+|up\s+|down\s+)?"
                        r"(?:to|into|toward|towards|in to)\s+(?:the\s+)?([a-z][a-z' -]{2,30})", re.I)
LEAVE_RE = re.compile(r"\b(?:i|we)(?:'ll| will)?\s+(?:leave|exit|walk out of|step out of|head out of|get out of)\s+(?:the\s+)?([a-z][a-z' -]{2,30})", re.I)


def _rooms_named(words, room_names):
    """The engine rooms a player's words name: by the room id's own words ("living room" -> living-room) or this season's themed name (roomNames). A word naming more than one
    room ("bedroom") names none, so it is never judged."""
    w = " " + re.sub(r"[^a-z ]", " ", (words or "").lower()) + " "
    hits = set()
    for rid in ROOMS:
        plain = rid.replace("-", " ")
        if f" {plain} " in w or (plain.endswith(" room") and f" {plain[:-5]} " in w and plain[:-5] not in ("living", "dining", "storage")):
            hits.add(rid)
        themed = (room_names or {}).get(rid)
        if isinstance(themed, str) and themed.strip() and f" {re.sub(r'[^a-z ]', ' ', themed.lower()).strip()} " in w:
            hits.add(rid)
    return hits


ROOMS = ("kitchen", "living-room", "dining-room", "backyard", "hallway", "bedroom-a", "bedroom-b", "bedroom-c", "bathroom", "lounge", "hoh-room", "storage-room", "diary-room", "landing")


def engine_moves_first_findings(turns):
    """T19 (Ryne 11-15, ORW-418/419): when the player clearly moves themselves, the engine has moved them by the time the reply shows. Judged only when the presence strip's
    room was logged before and after the turn, never on a question, with a card open or an event due (the house may be gathered), and a destination is held to only when the
    words name exactly one room. The narrator voicing the exit and arrival is a reader's call and is not judged here."""
    out = []
    for t in turns:
        before, after, msg = t.get("room_before"), t.get("room_after"), t.get("msg") or ""
        if not before or not after or "?" in msg or t.get("engine_pending") or t.get("pending_before") or (t.get("ds") or {}).get("due"):
            continue
        names = t.get("room_names") or {}
        m_to, m_leave = MOVE_TO_RE.search(msg), LEAVE_RE.search(msg)
        if m_to:
            dest = _rooms_named(m_to.group(1), names)
            if len(dest) == 1:
                want = next(iter(dest))
                if want != before and after != want:
                    out.append(_f(t, "T19", "fail", f"the player moved themselves ({m_to.group(0)!r}); the engine still has them in {after!r}, not {want!r}", "T19-not-moved"))
            elif after == before and not dest:
                continue   # an unnamed or unknown place: not judged
        elif m_leave:
            left = _rooms_named(m_leave.group(1), names)
            if left == {before} and after == before:
                out.append(_f(t, "T19", "fail", f"the player left the room ({m_leave.group(0)!r}); the engine still has them in {after!r}", "T19-not-left"))
    return out


def phase_known(phase):
    return bool(phase) and phase not in ("setup", "premiere")


def judge_run(turns, table=None):
    """(findings, stats): every per-turn finding plus the run-level rules (stall, livelock, untold results, retcon, skipped time)."""
    findings = [f for t in turns for f in judge_turn(t, table)]
    for c in lc.detect_stall(turns):
        findings.append({"id": c["id"], "turn": c["id"].split("[")[1].rstrip("]"), "check": "S1", "category": "stalls", "severity": "fail", "detail": c["detail"]})
    for c in lc.detect_livelock(turns):
        findings.append({"id": c["id"], "turn": c["id"].split("[")[1].rstrip("]"), "check": "L1", "category": "stalls", "severity": "fail", "detail": c["detail"]})
    findings += early_morning_findings(turns)
    findings += engine_moves_first_findings(turns)
    for c in lt.missing_results(turns) + lt.retcons(turns) + lt.time_findings(turns):
        chk = c["id"].split("-")[0]
        findings.append({"id": c["id"], "turn": c["id"].split("[")[1].rstrip("]"), "check": chk, "category": BAR_CATEGORY.get(chk, "contradictions"), "severity": c["severity"], "detail": c["detail"]})
    return findings, stats_of(turns, findings)


def longest_due_wait(turns):
    """The longest run of consecutive turns in which the engine said an event was due and nothing was committed (the bar's 'longest wait for a due event')."""
    best = run = 0
    for t in turns:
        ds = t.get("ds") or {}
        due = bool(ds.get("due")) and t.get("phase") == t.get("phase_before") and not t.get("engine_pending")
        run = run + 1 if due else 0
        best = max(best, run)
    return best


def stats_of(turns, findings):
    n = len(turns)
    counts = {}
    for f in findings:
        if f["severity"] == "fail":
            counts[f["check"]] = counts.get(f["check"], 0) + 1
    t1_turns = {f["turn"] for f in findings if f["check"] == "T1" and f["severity"] == "fail"}
    return {"turns": n, "fail_counts": counts, "t1_fail_turns": len(t1_turns), "longest_due_wait": longest_due_wait(turns), "stall": any(f["check"] == "S1" for f in findings),
            "livelock": any(f["check"] == "L1" for f in findings)}


def verdict(findings, stats, error=None, capped=False, reached_end=True):
    """PASS only with zero FAIL on T2-T13/T16, no stall, no livelock, the planned end reached and T1 failing on at most 1 turn in 50 (the bar). NOTE = nothing failed but findings were noted."""
    if error:
        return "COULD NOT RUN"
    n = max(1, stats["turns"])
    hard = [f for f in findings if f["severity"] == "fail" and f["check"] != "T1"]
    t1_ok = stats["t1_fail_turns"] * 50 <= n
    if hard or not t1_ok or stats["stall"] or stats["livelock"]:
        return "FAIL"
    if capped or not reached_end:
        return "CAPPED" if capped else "FAIL"
    return "NOTE" if any(f["severity"] == "note" for f in findings) or stats["t1_fail_turns"] else "PASS"


def scrub_all(text, names, secrets=()):
    """Cast names to a role word, and every secret string (the account's name, the server address) out of anything a report prints."""
    out = lc.scrub(text, names)
    for s in sorted({x for x in secrets if x and len(x) >= 3}, key=len, reverse=True):
        out = out.replace(s, "[redacted]")
    return out


def build_report(meta, turns, findings, stats, budget, verdict_word, error=None, names=(), secrets=(), reached_end=True):
    """(markdown, json-dict): anonymised (cast names -> role word, secrets out), no transcript."""
    S = lambda x: scrub_all(str(x), names, secrets)  # noqa: E731
    grouped = {c: [f for f in findings if f["category"] == c and f["severity"] == "fail"] for c in CATEGORIES}
    notes = [f for f in findings if f["severity"] == "note"]
    data = {"verdict": verdict_word, "meta": {k: S(v) for k, v in meta.items()}, "budget": budget, "stats": stats, "reached_end": reached_end, "error": S(error) if error else None,
            "findings": {c: [{"turn": f["turn"], "check": f["check"], "detail": S(f["detail"])} for f in v] for c, v in grouped.items()},
            "notes": [{"turn": f["turn"], "check": f["check"], "detail": S(f["detail"])} for f in notes], "not_covered": NOT_COVERED, "not_judged": NOT_JUDGED}
    nfail = sum(len(v) for v in grouped.values())
    L = [f"# Live run (full-week tier) - {verdict_word}", "",
         f"- Verdict: **{verdict_word}** - {nfail} failing finding(s) over {stats['turns']} turn(s); stall: {'YES' if stats['stall'] else 'no'}; livelock: {'YES' if stats['livelock'] else 'no'}; "
         f"planned end reached: {'yes' if reached_end else 'no'}" + (f"; stopped: {S(error)}" if error else ""),
         f"- Build: {S(meta.get('build', '?'))}; tier: {S(meta.get('tier', 'full week'))}; model: {S(meta.get('model', '?'))}; started (UTC): {S(meta.get('started_utc', '?'))}; Arizona: {S(meta.get('started_az', '?'))}",
         f"- Spend: ${budget.get('spent_usd', '?')} of a ${budget.get('max_spend_usd', '?')} cap; turns: {budget.get('turns', '?')} of {budget.get('max_turns', '?')}", ""]
    L += ["## Checks (count of failing turns)", "", "| Check | Failing |", "|---|---|"]
    for c in sorted(set(list(stats["fail_counts"]) + ["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T9", "T11", "T13", "T16", "R1", "S1", "L1"])):
        L.append(f"| {c} | {stats['fail_counts'].get(c, 0)} |")
    L += ["", f"- Longest wait for a due event: {stats['longest_due_wait']} turn(s) (the rule allows 3, 1 after an explicit ask)", f"- T1 failing turns: {stats['t1_fail_turns']} of {stats['turns']} (the allowance is 1 in 50)", ""]
    for c in CATEGORIES:
        L += [f"## Findings: {c} ({len(grouped[c])})", ""]
        L += [f"- turn {f['turn']} `{f['check']}` - {S(f['detail'])}" for f in grouped[c]] or ["- none"]
        L.append("")
    if notes:
        L += ["## Notes (not failures)", ""] + [f"- turn {f['turn']} `{f['check']}` - {S(f['detail'])}" for f in notes] + [""]
    L += ["## What this run did not cover", ""] + [f"- {x}" for x in NOT_COVERED] + [""]
    L += ["## Not judged (no screen shows it)", ""] + [f"- {x}" for x in NOT_JUDGED] + [""]
    return "\n".join(L), data


def plane_comment_html(data):
    b = data["budget"]
    rows = "".join(f"<li>turn {html.escape(str(f['turn']))} <code>{html.escape(f['check'])}</code> ({html.escape(c)}) - {html.escape(f['detail'])}</li>" for c, v in data["findings"].items() for f in v[:8])
    return (f"<p><strong>Live run (full-week tier): {html.escape(data['verdict'])}</strong> - {data['stats']['turns']} turns, spend ${b.get('spent_usd', '?')} of ${b.get('max_spend_usd', '?')}.</p>"
            + (f"<ul>{rows}</ul>" if rows else "<p>No failing findings.</p>"))


def write_report(out_dir, md, data):
    open(f"{out_dir}/report.md", "w").write(md)
    json.dump(data, open(f"{out_dir}/report.json", "w"), indent=1)
    open(f"{out_dir}/plane-comment.html", "w").write(plane_comment_html(data))
