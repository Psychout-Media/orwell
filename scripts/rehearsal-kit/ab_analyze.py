"""ab_analyze.py RUN -> JSON-ish summary: turns, latency, strips by class, leaks, tokens (narrator model only)."""
import json, re, sys, collections, sqlite3
RUN = sys.argv[1]
ab = [l for l in open(f"{RUN}/ab.log") if l.startswith("t")]
secs = [float(re.search(r" ([\d.]+)s ", l).group(1)) for l in ab]
game = [s for l, s in zip(ab, secs) if "phase=premiere" not in l]
fe = open(f"{RUN}/fe.log", errors="ignore").read().splitlines()
strips = [l for l in fe if "role-claim guard STRIPPED" in l or "pre-emission" in l.lower() and "corrected" in l.lower()]
def cls(l):
    m = re.search(r"STRIPPED \d+ unit\(s\) for user=\w+: (.*?) ←", l)
    r = (m.group(1) if m else l)
    for k, v in (("veto", "veto winner/holder"), ("HOH", "HOH"), ("evictee", "evictee"), ("ballot", "ballot/tally"), ("nominee", "nominee"), ("closing wrapper", "wrapper")):
        if k in r: return v
    return "other"
c = collections.Counter(cls(l) for l in strips if "role-claim" in l)
c.pop("wrapper", None)
other_guards = {"scene circuit-breaker cuts": sum(1 for l in fe if "circuit-breaker HELD" in l), "sentence-guard drops/corrections": sum(1 for l in fe if "pre-emission" in l.lower() or "phantom board" in l.lower() and "circuit" not in l),
                "interlude": sum(1 for l in fe if "technical interlude" in l), "host cooled": sum(1 for l in fe if "host cooled" in l)}
import os
WT = os.environ.get("WT", "/home/ryne/orwell-rehearsal")  # the slot's worktree (slot 1 by default)
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
print(json.dumps({"turns_total": len(ab), "game_turns": len(game), "median_secs": sorted(game)[len(game)//2] if game else None,
  "mean_secs": round(sum(game)/max(1,len(game)), 1), "strips_by_class": dict(c), "strips_total": sum(c.values()),
  "per_turn": round(sum(c.values())/max(1, len(game)), 3), "leak_msgs": leaks[:8], "leaks": len(leaks), "other": other_guards,
  "narrator_stream_calls": calls, "tokens": dict(tok), "assistant_msgs": len(msgs)}, indent=1))
