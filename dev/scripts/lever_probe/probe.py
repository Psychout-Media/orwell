#!/usr/bin/env python3
"""A-12 lever-call probe — step 2: for each exported scenario, call the model K times with the game build's real
tool schemas and count how often it calls the expected lever (tool_choice=auto), vs prose-only.

Stateless (one request per trial, no game state), stdlib only. The key comes from the environment ONLY and is never
written anywhere. A hard spend cap aborts the run.

  DEEPSEEK_API_KEY=... python3 dev/scripts/lever_probe/probe.py scenarios.json --trials 6 [--model deepseek-flash]
Run from the repo root with frontend/ on the path (the real tool schemas are imported from frontend/src).
"""
import argparse, json, os, sys, time, urllib.request, importlib

# deepseek-flash list price per 1M tokens (USD); a deliberately generous ceiling so the cap is conservative.
PRICE_IN, PRICE_OUT = 0.30, 0.60


def load_tools():
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "frontend"))
    importlib.import_module("src.agent_tools")
    ts = importlib.import_module("src.tool_schemas")
    keep = {"advanceGame", "submitDecision", "makeDeal", "confide", "recordInteraction", "getGameState",
            "npcVoice", "whereabouts", "moveTo", "socialRead", "askProducers", "socialInitiatives", "diaryRoom"}
    return [t for t in ts.FUNCTION_TOOL_SCHEMAS if t["function"]["name"] in keep]


REMINDER = ("LEVER CHECK before you write a word: if the player's move strikes a deal, call makeDeal; if it presses "
            "someone to open up, call confide; if it asks to proceed or the beat is a competition/ceremony, call "
            "advanceGame. Call the tool FIRST, then narrate its result.")


def call(base, key, model, system, user, tools, tool_choice, hard, variant="base"):
    msgs = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    if hard:
        msgs.append({"role": "system", "content": hard})
    if variant == "tail-reminder":
        msgs.append({"role": "system", "content": REMINDER})
    body = {"model": model, "messages": msgs, "tools": tools, "tool_choice": tool_choice,
            "max_tokens": 800, "temperature": 0.7}
    req = urllib.request.Request(base.rstrip("/") + "/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("scenarios")
    ap.add_argument("--trials", type=int, default=6)
    ap.add_argument("--model", default="deepseek-flash")
    ap.add_argument("--base", default="https://api.deepseek.com")
    ap.add_argument("--cap-usd", type=float, default=1.5)
    ap.add_argument("--variant", default="base", help="base | tail-reminder (a short last-message lever reminder)")
    ap.add_argument("--tool-choice", default="auto", help="auto | required (floor measurement)")
    a = ap.parse_args()
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        sys.exit("DEEPSEEK_API_KEY not set in the environment (never pass it on the command line or write it to a file)")
    tools = load_tools()
    scenarios = json.load(open(a.scenarios))
    spent, rows = 0.0, []
    for sc in scenarios:
        hit = any_call = 0
        hist = {}
        for _ in range(a.trials):
            try:
                resp = call(a.base, key, a.model, sc["system"], sc["user"], tools, a.tool_choice, sc.get("hard"), a.variant)
            except Exception as e:  # transport hiccup: counted as a miss, not a crash
                print("  trial error:", type(e).__name__, file=sys.stderr)
                time.sleep(1)
                continue
            u = resp.get("usage", {})
            spent += u.get("prompt_tokens", 0) / 1e6 * PRICE_IN + u.get("completion_tokens", 0) / 1e6 * PRICE_OUT
            calls = (resp["choices"][0]["message"].get("tool_calls") or [])
            names = [c["function"]["name"] for c in calls]
            any_call += bool(names)
            for n in (names or ["(prose)"]):
                hist[n] = hist.get(n, 0) + 1
            hit += sc["expect"] in names
            if spent > a.cap_usd:
                print(json.dumps({"aborted": "spend cap", "spentUsd": round(spent, 3), "rows": rows}))
                sys.exit(3)
        rows.append({"scenario": sc["id"], "expect": sc["expect"], "trials": a.trials, "hit": hit, "anyToolCall": any_call, "calls": hist})
        print(f"{sc['id']:18} expect={sc['expect']:12} hit {hit}/{a.trials}  anyTool {any_call}/{a.trials}", file=sys.stderr)
    print(json.dumps({"model": a.model, "toolChoice": a.tool_choice, "variant": a.variant, "spentUsd": round(spent, 3), "rows": rows}, indent=1))


if __name__ == "__main__":
    main()
