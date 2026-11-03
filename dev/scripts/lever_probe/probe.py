#!/usr/bin/env python3
"""A-12 lever-call probe — step 2: for each exported scenario, call the model K times with the game build's real
tool schemas and count how often it calls the expected lever (tool_choice=auto), vs prose-only.

Stateless (one request chain per trial, no game state); stdlib HTTP, but the tool schemas are imported from
frontend/src, so run it with the frontend venv (frontend/.venv/bin/python) so its imports resolve. The key comes from the environment ONLY and is never
written anywhere. A hard spend cap aborts the run.

  DEEPSEEK_API_KEY=... python3 dev/scripts/lever_probe/probe.py scenarios.json --trials 6 [--model deepseek-flash]
Run from the repo root with frontend/ on the path (the real tool schemas are imported from frontend/src).
"""
import argparse, json, os, sys, time, urllib.error, urllib.request, importlib

# deepseek-flash list price per 1M tokens (USD); a deliberately generous ceiling so the cap is conservative.
PRICE_IN, PRICE_OUT = 0.30, 0.60


DEAL_DESC = ("Call IMMEDIATELY when the player's own move completes a handshake in the scene — do not gather "
             "npcVoice/getGameState first, and note recordInteraction does NOT create a deal.")


def load_tools(variant="base"):
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "frontend"))
    importlib.import_module("src.agent_tools")
    ts = importlib.import_module("src.tool_schemas")
    # NOTE: a curated SUBSET of the production menu (the levers the narrator chooses among on these beats); the
    # send-time `with_deal_depth_kinds` transform is not applied. Rates are therefore comparable run to run, not an
    # exact replay of production's menu.
    keep = {"advanceGame", "submitDecision", "makeDeal", "confide", "recordInteraction", "getGameState",
            "npcVoice", "whereabouts", "moveTo", "socialRead", "askProducers", "socialInitiatives", "diaryRoom"}
    tools = [t for t in ts.FUNCTION_TOOL_SCHEMAS if t["function"]["name"] in keep]
    if variant == "deal-desc":  # candidate makeDeal description reword (harness-only override; no product change)
        import copy
        tools = copy.deepcopy(tools)
        for t in tools:
            if t["function"]["name"] == "makeDeal":
                t["function"]["description"] = t["function"]["description"].replace(
                    "Call when a handshake actually happens in the scene.", DEAL_DESC)
    return tools


REMINDER = ("LEVER CHECK before you write a word: if the player's move strikes a deal, call makeDeal; if it presses "
            "someone to open up, call confide; if it asks to proceed or the beat is a competition/ceremony, call "
            "advanceGame. Call the tool FIRST, then narrate its result.")


SCOPED_BEATS = {"deal", "veto-ceremony", "eviction"}  # never confide: the reminder hurt there (first-round pass)

STUB = {
    "npcVoice": {"persona": "wry, guarded", "knows": [], "suspects": [], "mood": "even"},
    "getGameState": {"week": 1, "note": "state unchanged since the system prompt"},
    "whereabouts": {"room": "living room", "present": []},
}


def call(base, key, model, system, user, tools, tool_choice, hard, variant="base", scid=""):
    msgs = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    if hard:
        msgs.append({"role": "system", "content": hard})
    if variant == "tail-reminder" or (variant == "scoped" and scid in SCOPED_BEATS):
        msgs.append({"role": "system", "content": REMINDER})
    return msgs


def complete(base, key, model, msgs, tools, tool_choice):
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
    ap.add_argument("--rounds", type=int, default=1, help="max model rounds per trial (stubbed tool results between)")
    ap.add_argument("--only", default="", help="comma-separated scenario ids to run")
    ap.add_argument("--variant", default="base", choices=["base", "tail-reminder", "scoped", "deal-desc"], help="base | scoped | tail-reminder (a short last-message lever reminder)")
    ap.add_argument("--tool-choice", default="auto", choices=["auto", "required"],
                    help="auto | required (required = an ANY-tool baseline: the model may satisfy it with any available tool)")
    ap.add_argument("--price-in", type=float, default=PRICE_IN, help="USD per 1M prompt tokens (defaults: DeepSeek flash)")
    ap.add_argument("--price-out", type=float, default=PRICE_OUT, help="USD per 1M completion tokens")
    a = ap.parse_args()
    if "deepseek" not in a.model.lower() and (a.price_in, a.price_out) == (PRICE_IN, PRICE_OUT):
        sys.exit("non-DeepSeek model: pass --price-in/--price-out explicitly so the spend cap is real")
    key = os.environ.get("DEEPSEEK_API_KEY")
    if not key:
        sys.exit("DEEPSEEK_API_KEY not set in the environment (never pass it on the command line or write it to a file)")
    tools = load_tools(a.variant)
    scenarios = json.load(open(a.scenarios))
    if a.only:
        scenarios = [x for x in scenarios if x["id"] in a.only.split(",")]
    spent, rows, errors = 0.0, [], 0
    for sc in scenarios:
        hit = any_call = 0
        hist = {}
        for _ in range(a.trials):
            msgs = call(a.base, key, a.model, sc["system"], sc["user"], tools, a.tool_choice, sc.get("hard"), a.variant, sc["id"])
            landed = False
            first = True
            for rnd in range(a.rounds):  # the real loop is multi-round: a lever landing by round N counts
                try:
                    resp = complete(a.base, key, a.model, msgs, tools, a.tool_choice)
                except urllib.error.HTTPError as e:
                    if e.code in (401, 402, 403):  # auth / balance: every trial would "miss" — abort, don't report 0%
                        sys.exit(f"aborted: HTTP {e.code} from the endpoint (check the key / balance); no rates reported")
                    print("  trial error: HTTP", e.code, file=sys.stderr)
                    errors += 1
                    time.sleep(1)
                    break
                except Exception as e:  # transport hiccup: counted separately, not a crash
                    print("  trial error:", type(e).__name__, file=sys.stderr)
                    errors += 1
                    time.sleep(1)
                    break
                u = resp.get("usage", {})
                spent += u.get("prompt_tokens", 0) / 1e6 * a.price_in + u.get("completion_tokens", 0) / 1e6 * a.price_out
                m = resp["choices"][0]["message"]
                calls = m.get("tool_calls") or []
                names = [c["function"]["name"] for c in calls]
                if first:
                    any_call += bool(names); first = False
                for n in (names or ["(prose)"]):
                    hist[n] = hist.get(n, 0) + 1
                if sc["expect"] in names:
                    landed = True
                    break
                if not calls:
                    break  # prose-only turn ends the loop without the lever
                msgs.append({"role": "assistant", "content": m.get("content") or "", "tool_calls": calls})
                for c in calls:
                    out = STUB.get(c["function"]["name"], {"ok": True})
                    msgs.append({"role": "tool", "tool_call_id": c["id"], "content": json.dumps(out)})
                if spent > a.cap_usd:
                    break
            hit += landed
            if spent > a.cap_usd:
                print(json.dumps({"aborted": "spend cap", "spentUsd": round(spent, 3), "rows": rows}))
                sys.exit(3)
        rows.append({"scenario": sc["id"], "expect": sc["expect"], "trials": a.trials, "hit": hit, "anyToolCall": any_call, "calls": hist})
        print(f"{sc['id']:18} expect={sc['expect']:12} hit {hit}/{a.trials}  anyTool {any_call}/{a.trials}", file=sys.stderr)
    print(json.dumps({"model": a.model, "toolChoice": a.tool_choice, "variant": a.variant, "spentUsd": round(spent, 3), "erroredRounds": errors, "rows": rows}, indent=1))


if __name__ == "__main__":
    main()
