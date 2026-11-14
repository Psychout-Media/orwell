#!/usr/bin/env python3
"""Spend guard for a paid rehearsal run (ORW-344 / ORW-332). Watches the slot's model-call archive and STOPS the run (by PID file, never pkill) when the estimated spend reaches the cap.

  python3 spend_guard.py LLM_IO_JSONL CAP_USD RUN_DIR [--interval 15] [--once]

Spend per call: the provider's own `usage.cost` when it reports one, otherwise an estimate from the token counts at a deliberately HIGH flash-tier rate (so the cap trips early, never late):
$0.30 / M uncached input, $0.03 / M cached input, $1.20 / M output (override with RIG_PRICE_IN_PER_M / RIG_PRICE_CACHED_PER_M / RIG_PRICE_OUT_PER_M).
Writes RUN_DIR/spend.json every pass; on the cap it writes RUN_DIR/SPEND-CAP-HIT and kills daemon/fe/engine/driver by PID file. Exit 3 on the cap, 0 on --once / a clean stop. Reads usage counts only; never a key.
"""
import json, os, signal, sys, time

PRICE_IN = float(os.environ.get("RIG_PRICE_IN_PER_M", "0.30")) / 1e6
PRICE_CACHED = float(os.environ.get("RIG_PRICE_CACHED_PER_M", "0.03")) / 1e6
PRICE_OUT = float(os.environ.get("RIG_PRICE_OUT_PER_M", "1.20")) / 1e6


def usage_of(row):
    u = row.get("usage") if isinstance(row, dict) else None
    u = u if isinstance(u, dict) else {}
    def i(*ks):
        for k in ks:
            v = u.get(k)
            if isinstance(v, (int, float)): return int(v)
        return 0
    ptd = u.get("prompt_tokens_details") or {}
    cached = u.get("cached_tokens") if isinstance(u.get("cached_tokens"), (int, float)) else (ptd.get("cached_tokens") or 0)
    return {"in": i("input_tokens", "prompt_tokens"), "cached": int(cached or 0), "out": i("output_tokens", "completion_tokens"), "cost": float(u.get("cost") or 0.0)}


def row_usd(c):
    if c["cost"] > 0: return c["cost"]
    return max(0, c["in"] - c["cached"]) * PRICE_IN + c["cached"] * PRICE_CACHED + c["out"] * PRICE_OUT


def totals(path):
    n = tin = tcached = tout = 0; usd = 0.0
    try:
        for ln in open(path, encoding="utf-8", errors="replace"):
            ln = ln.strip()
            if not ln: continue
            try: row = json.loads(ln)
            except ValueError: continue
            c = usage_of(row)
            if not (c["in"] or c["out"] or c["cost"]): continue
            n += 1; tin += c["in"]; tcached += c["cached"]; tout += c["out"]; usd += row_usd(c)
    except OSError: pass
    return {"calls": n, "input_tokens": tin, "cached_tokens": tcached, "output_tokens": tout, "usd_estimate": round(usd, 4)}


def stop_run(run):
    for name in ("driver", "daemon", "fe", "engine"):
        try: os.kill(int(open(f"{run}/{name}.pid").read().strip()), signal.SIGTERM)
        except (OSError, ValueError): pass


def main(argv):
    if len(argv) < 3: print(__doc__); return 2
    path, cap, run = argv[0], float(argv[1]), argv[2]
    interval = 15.0; once = "--once" in argv
    if "--interval" in argv: interval = float(argv[argv.index("--interval") + 1])
    while True:
        t = totals(path); t["cap_usd"] = cap
        json.dump(t, open(f"{run}/spend.json", "w"))
        if t["usd_estimate"] >= cap:
            open(f"{run}/SPEND-CAP-HIT", "w").write(json.dumps(t)); stop_run(run); return 3
        if once: return 0
        time.sleep(interval)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
