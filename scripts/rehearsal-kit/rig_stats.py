#!/usr/bin/env python3
"""Per-run numbers for a rehearsal run (ORW-332): the SENT SIZE per model call / turn and the E22 rate. Reads the slot's model-call archive and the run's fe.log; never a key.

  python3 rig_stats.py LLM_IO_JSONL RUN_DIR      -> writes RUN_DIR/rig-stats.md and prints it

Sent size = the call's input tokens (what was sent), with the cached share. Per turn = the calls of one player turn when turns.jsonl is present, else the whole run.
E22 rate = `E22 guard` fallback-digest lines in fe.log per player turn (the guard fires when a game turn was narrated with no engine write).
"""
import json, re, statistics, sys
from spend_guard import usage_of, row_usd


def main(llm, run):
    calls = []
    try:
        for ln in open(llm, encoding="utf-8", errors="replace"):
            try: row = json.loads(ln)
            except ValueError: continue
            c = usage_of(row)
            if c["in"] or c["out"]: calls.append({"kind": row.get("kind") or "", "in": c["in"], "cached": c["cached"], "out": c["out"], "usd": row_usd(c)})
    except OSError: pass
    turns = 0
    try: turns = sum(1 for l in open(f"{run}/turns.jsonl") if l.strip())
    except OSError: pass
    e22 = 0
    try: e22 = len(re.findall(r"E22 guard: game turn narrated with no engine write", open(f"{run}/fe.log", encoding="utf-8", errors="replace").read()))  # real firings only; "stood down" lines are the guard NOT firing
    except OSError: pass
    ins = sorted(c["in"] for c in calls)
    def pct(p): return ins[min(len(ins) - 1, int(p * len(ins)))] if ins else 0
    chat = [c for c in calls if "chat" in c["kind"] or not c["kind"]]
    out = ["# Rig run stats", "",
           f"- model calls: {len(calls)} (chat-kind: {len(chat)}); player turns: {turns or 'n/a'}",
           f"- estimated spend: ${sum(c['usd'] for c in calls):.3f}",
           f"- sent size per call (input tokens): median {int(statistics.median(ins)) if ins else 0}, p95 {pct(0.95)}, max {ins[-1] if ins else 0}; cached share {100 * sum(c['cached'] for c in calls) / max(1, sum(c['in'] for c in calls)):.0f}%",
           f"- sent size per turn (input tokens, sum of that turn's calls, mean): {int(sum(c['in'] for c in calls) / turns) if turns else 'n/a'}",
           f"- E22 guard firings: {e22}; per turn: {(e22 / turns) if turns else float('nan'):.3f}", "",
           "## Input tokens per call, in order", "", ", ".join(str(c["in"]) for c in calls) or "(none)", ""]
    text = "\n".join(out); open(f"{run}/rig-stats.md", "w").write(text); print(text)


if __name__ == "__main__":
    if len(sys.argv) < 3: print(__doc__); sys.exit(2)
    main(sys.argv[1], sys.argv[2])
