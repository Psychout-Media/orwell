"""ab_analyze.py RUN -> JSON-ish summary: turns, latency, strips by class, leaks, tokens (narrator model only)."""
import json, re, sys, collections, sqlite3
RUN = sys.argv[1]
TURN = re.compile(r"^t\d+ ([\d.]+)s ")   # only real turn lines: "timeout at N" has no duration and must not shift the pairing
ab = [l for l in open(f"{RUN}/ab.log") if TURN.match(l)]
secs = [float(TURN.match(l).group(1)) for l in ab]
game = [s for l, s in zip(ab, secs) if "phase=premiere" not in l]
fe = open(f"{RUN}/fe.log", errors="ignore").read().splitlines()
strips = [l for l in fe if "role-claim guard STRIPPED" in l or "pre-emission" in l.lower() and "corrected" in l.lower()]
def units(l):
    """A role-claim line can carry several stripped units, joined by '; ': each is classified and counted on its own."""
    m = re.search(r"STRIPPED \d+ unit\(s\) for user=\w+: (.*?) ←", l)
    return [u for u in (m.group(1).split("; ") if m else [l]) if u.strip()] or [l]
def cls(r):
    for k, v in (("veto", "veto winner/holder"), ("HOH", "HOH"), ("evictee", "evictee"), ("ballot", "ballot/tally"), ("nominee", "nominee"), ("closing wrapper", "wrapper")):
        if k in r: return v
    return "other"
c = collections.Counter(cls(u) for l in strips if "role-claim" in l for u in units(l))
c.pop("wrapper", None)
other_guards = {"scene circuit-breaker cuts": sum(1 for l in fe if "circuit-breaker HELD" in l), "sentence-guard drops/corrections": sum(1 for l in fe if "pre-emission" in l.lower() or "phantom board" in l.lower() and "circuit" not in l),
                "interlude": sum(1 for l in fe if "technical interlude" in l), "host cooled": sum(1 for l in fe if "host cooled" in l)}
import os
def _wt_from_slot_env(run):
    import shlex
    try:
        for ln in open(f"{run}/slot.env"):
            k, _, v = ln.strip().partition("=")
            if k == "WT" and v: return shlex.split(v)[0]
    except OSError: pass
    return None
WT = os.environ.get("WT") or _wt_from_slot_env(RUN) or os.path.join(os.environ.get("ORWELL_RIG_HOME") or os.path.expanduser("~"), "orwell-rehearsal")  # slot 1 by default; the run's own slot worktree first (a slot-2 run), else slot 1
db = sqlite3.connect(f"file:{WT}/frontend/data/app.db?mode=ro", uri=True)
msgs = [r[0] or "" for r in db.execute("select content from chat_messages where role='assistant'")]
LEAK = re.compile(r"(?i)</?think|\bnpc:\d|\bas an ai\b|\bi (?:cannot|can't) (?:help|comply)|\badvanceGame\b|\bgetGameState\b|\bBOARD\b|engine-committed|\bsystem prompt\b|\btool[_ ]call\b|\"toolCalls\"|^\s*\{\s*\"")
leaks = [m[:90].replace("\n", " ") for m in msgs if LEAK.search(m)]
tok = collections.Counter(); calls = 0
for l in open(f"{WT}/frontend/data/llm-io.jsonl"):
    try: r = json.loads(l)
    except Exception: continue
    if r.get("kind") != "stream": continue
    u = ((r.get("response") or {}).get("usage") or {}) if isinstance(r.get("response"), dict) else {}
    calls += 1
    for k in ("input_tokens", "output_tokens", "cached_tokens", "cost"):
        tok[k] += (u.get(k) or 0)
    tok["model:" + str(r.get("model"))] += 1
print(json.dumps({"turns_total": len(ab), "game_turns": len(game), "median_secs": (sorted(game)[len(game)//2] if len(game) % 2 else (sorted(game)[len(game)//2 - 1] + sorted(game)[len(game)//2]) / 2) if game else None,
  "mean_secs": round(sum(game)/max(1,len(game)), 1), "strips_by_class": dict(c), "strips_total": sum(c.values()),
  "per_turn": round(sum(c.values())/max(1, len(game)), 3), "leak_msgs": leaks[:8], "leaks": len(leaks), "other": other_guards,
  "narrator_stream_calls": calls, "tokens": dict(tok), "assistant_msgs": len(msgs)}, indent=1))
