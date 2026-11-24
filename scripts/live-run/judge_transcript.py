#!/usr/bin/env python3
"""Judge a game someone already played (ORW-109): read a played run's turn log and write the same pass-bar report a live run writes.

Fable (or anyone) plays through the real browser with the rehearsal kit's play daemon (scripts/rehearsal-kit/daemon.py). Since ORW-109 the daemon appends every turn
to `turns.jsonl` in its run dir: the player's message, the new public bubbles, the card, and the three screen reads (/api/orwell/state, /status, /whereabouts). This script
rebuilds each turn exactly as the live full-week driver does (`live_truth.screen_view` + `live_truth.turn_record`) and runs the same judge (`live_full_eval.judge_run`):
every per-turn check in the vault note "Live Run Pass Bar" that the screens can answer, the stall and livelock rules, untold results, retcons and skipped time.

It reads files only: no model call, no game, no network, no key. The report is anonymised the same way (cast names become a role word, no transcript).

    python3 scripts/live-run/judge_transcript.py --run-dir ~/.cache/fable-play/run [--out DIR] [--build SHA] [--model NAME]

Exit 0 PASS or NOTE, 1 FAIL, 2 could not run (no turns.jsonl, or no player turn in it).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "rehearsal-kit"))

import live_full_eval as ev  # noqa: E402
import live_truth as lt  # noqa: E402

EXIT = {"PASS": 0, "NOTE": 0, "FAIL": 1, "COULD NOT RUN": 2, "CAPPED": 4}


def load_turns(path):
    """The daemon's turn log: one JSON object per line. A line that does not parse is skipped and counted (a half-written last line after a crash)."""
    entries, bad = [], 0
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                bad += 1
    entries.sort(key=lambda e: e.get("n", 0))
    return entries, bad


def _view(w):
    return w.get("whereabouts") if isinstance(w, dict) and "whereabouts" in w else w


def _room(w):
    v = _view(w)
    return v.get("room") if isinstance(v, dict) and isinstance(v.get("room"), str) else None


def _room_names(w):
    v = _view(w)
    return v.get("roomNames") if isinstance(v, dict) and isinstance(v.get("roomNames"), dict) else {}


def rows_from_log(entries):
    """The judge's turn records, built as live_full.run builds them. A card answer is not a player turn: it only moves the 'before' screen on (as the live driver's
    decide step does). A turn whose screen reads failed keeps those keys absent (unknown), never invented."""
    rows, prev, prev_w = [], None, None
    for e in entries:
        st = lt.screen_view(e.get("state"), e.get("status"), e.get("whereabouts"))
        msg = e.get("msg")
        if msg:
            text = "\n\n".join(b for b in (e.get("bubbles") or []) if isinstance(b, str))
            error = None if text.strip() else "no new public bubble after the message"
            row = lt.turn_record(f"turn-{e.get('n', len(rows) + 1)}", msg, prev, st, text, e.get("secs"), error)
            row["early_morning"] = st.get("earlyMorning") if isinstance(st.get("earlyMorning"), bool) else None   # T14: the engine's flag...
            row["hud_tod"] = e.get("hud_tod")                                                                     # ...and the label the player saw
            row["room_before"], row["room_after"] = _room(prev_w), _room(e.get("whereabouts"))                    # T19: the presence strip's room, before and after
            row["room_names"] = _room_names(e.get("whereabouts"))
            rows.append(row)
        prev, prev_w = st, e.get("whereabouts")
    return rows


def judge(entries, meta, out_dir=None):
    rows = rows_from_log(entries)
    if not rows:
        return "COULD NOT RUN", "", {"error": "no player turn in the log"}, rows
    findings, stats = ev.judge_run(rows, None)
    names = sorted({n for t in rows for n in (t.get("cast") or [])})
    word = ev.verdict(findings, stats, None, False, True)
    budget = {"spent_usd": "n/a (played by hand)", "max_spend_usd": "n/a", "turns": len(rows), "max_turns": "n/a"}
    md, data = ev.build_report(meta, rows, findings, stats, budget, word, None, names, (), True)
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
        ev.write_report(out_dir, md, data)
    return word, md, data, rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--run-dir", required=True, help="the play daemon's run dir (holds turns.jsonl)")
    ap.add_argument("--out", help="where to write report.md / report.json / plane-comment.html (default: <run-dir>/judge)")
    ap.add_argument("--build", default="?", help="the build that was played (commit sha), for the report header")
    ap.add_argument("--model", default="?", help="the narrator model, for the report header")
    a = ap.parse_args(argv)
    path = os.path.join(a.run_dir, "turns.jsonl")
    if not os.path.exists(path):
        print(f"JUDGE COULD-NOT-RUN no turns.jsonl in {a.run_dir} (the play daemon writes it since ORW-109)")
        return EXIT["COULD NOT RUN"]
    entries, bad = load_turns(path)
    now = dt.datetime.now(dt.timezone.utc)
    meta = {"build": a.build, "model": a.model, "tier": "a played transcript (judged afterwards)", "started_utc": now.strftime("%Y-%m-%d %H:%M"),
            "started_az": (now - dt.timedelta(hours=7)).strftime("%Y-%m-%d %H:%M"), "unparsed_lines": bad}
    out = a.out or os.path.join(a.run_dir, "judge")
    word, _md, _data, rows = judge(entries, meta, out)
    print(f"JUDGE {word.replace(' ', '-')} turns={len(rows)} unparsed={bad} report={out}/report.md")
    return EXIT.get(word, 2)


if __name__ == "__main__":
    sys.exit(main())
