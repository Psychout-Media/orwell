#!/usr/bin/env python3
"""Fidelity read for the terminal KNOWLEDGE SCOPE cap (ORW-349 step 2). Reads a slot's model-call archive (llm-io.jsonl) and answers: do NPCs still reference what they know that is OLDER than the newest N items?

  python3 fidelity_read.py LLM_IO_JSONL [--newest 5] [--json]

For every big narration call it takes each present houseguest's full list from GAME CONTEXT ("WHAT EACH HOUSEGUEST IN THE ROOM LEGITIMATELY KNOWS", the list the cap never touches), treats the last N entries as the newest (the engine lists oldest to
newest), and checks the narration that came back for a reference to each OLDER entry. A reference is a heuristic: at least 2 distinctive words of the item (4+ letters, not the houseguest's own name, not stop words) appear in the reply, or 1 if the item has only one. It is
a RATE to compare before and after on the same kind of week, never an exact count. Also reports the ceiling check: items in the terminal block that are NOT in the houseguest's full list (must be 0). Reads text only; never a key.
"""
import json, re, sys

STOP = set("that this with from they them their there have were what when about into just only over under then than your been will would could said says like some more also each every still very much even back down away".split())


def msgs(r):
    return [x for x in (r.get("request") or {}).get("messages") or [] if isinstance(x, dict)]


def text_of(x):
    c = x.get("content"); return c if isinstance(c, str) else ""


def block(r, prefix):
    for x in msgs(r):
        c = text_of(x)
        if x.get("role") == "system" and c.startswith(prefix): return c
    return ""


def parse_items(seg_lines):
    """name -> list of items, from the '· Name:' / 'knows:' sub-lines of the GAME CONTEXT block or the '· Name — knows: a; b' lines of the terminal one."""
    out = {}; cur = None
    for ln in seg_lines:
        m = re.match(r"\s+· (.+?)(?::| — )(.*)$", ln)
        if m and not ln.strip().startswith(("knows:", "suspects", "now ")):
            cur = m.group(1).strip(); out.setdefault(cur, [])
            rest = m.group(2)
            km = re.search(r"knows: (.*?)(?:; suspects.*)?$", rest)
            if km: out[cur] += [i.strip() for i in re.split(r"; (?=\(|[A-Za-z])", km.group(1)) if i.strip()]
            continue
        km = re.match(r"\s+knows: (.*)$", ln)
        if km and cur: out[cur] += [i.strip() for i in re.split(r"; (?=\(|[A-Za-z])", km.group(1)) if i.strip()]
    return out


def ctx_lists(g):
    k = g.find("WHAT EACH HOUSEGUEST IN THE ROOM")
    if k < 0: return {}
    seg = g[k:]; nxt = re.search(r"\n- [A-Z]", seg[10:]); seg = seg[: nxt.start() + 10] if nxt else seg
    return parse_items(seg.split("\n")[1:])


def terminal_lists(b):
    k = b.find("KNOWLEDGE SCOPE")
    if k < 0: return {}
    e = b.find("- BOARD", k); seg = b[k: e if e > 0 else len(b)]
    return parse_items(seg.split("\n")[1:])


def words(item, own):
    ws = [w.lower() for w in re.findall(r"[A-Za-z']{4,}", item)]
    ownw = {w.lower() for w in re.findall(r"[A-Za-z']+", own)}
    return [w for w in dict.fromkeys(ws) if w not in STOP and w not in ownw and w not in ("overheard", "muffled", "feeling", "around", "house")]


def referenced(item, own, reply):
    ws = words(item, own)
    if not ws: return False
    low = reply.lower(); hit = sum(1 for w in ws if w in low)
    return hit >= min(2, len(ws))


def main(argv):
    if not argv: print(__doc__); return 2
    n = int(argv[argv.index("--newest") + 1]) if "--newest" in argv else 5
    rows = [json.loads(l) for l in open(argv[0], encoding="utf-8", errors="replace") if l.strip()]
    big = [r for r in rows if r.get("kind") == "stream" and len(json.dumps(r.get("request"))) > 100000]
    older_total = older_ref = calls_with_older = calls_ref = ceiling_bad = 0
    for r in big:
        g, b = block(r, "GAME CONTEXT"), block(r, "SHOW BRIEF")
        reply = (r.get("response") or {}).get("text") or ""
        if not g or not reply: continue
        full = ctx_lists(g); term = terminal_lists(b)
        for name, items in term.items():
            allowed = set(full.get(name, []))
            if allowed and any(i not in allowed for i in items): ceiling_bad += 1
        hit_call = False; has_older = False
        for name, items in full.items():
            older = items[:-n] if len(items) > n else []
            if not older: continue
            has_older = True
            for it in older:
                older_total += 1
                if referenced(it, name, reply): older_ref += 1; hit_call = True
        calls_with_older += has_older; calls_ref += hit_call
    res = {"newest": n, "big_calls": len(big), "calls_with_older_items": calls_with_older, "calls_referencing_an_older_item": calls_ref, "older_items_seen": older_total, "older_items_referenced": older_ref,
           "older_ref_rate_per_call": round(calls_ref / calls_with_older, 3) if calls_with_older else None, "terminal_items_outside_full_list": ceiling_bad}
    print(json.dumps(res) if "--json" in argv else "\n".join(f"{k}: {v}" for k, v in res.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
