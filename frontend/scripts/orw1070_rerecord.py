#!/usr/bin/env python3
"""ORW-1070: re-record the confide / expose / trade regression fixtures against a live model.

Spends real money (about 60 short extraction calls), so it refuses to run without --yes-spend. Run it on dev
(CT 204) or anywhere the endpoint is reachable. The endpoint is read from the environment, never the repo:

    ORW_RERECORD_URL    chat-completions base url
    ORW_RERECORD_MODEL  model name (default deepseek-flash)
    ORW_RERECORD_KEY    bearer key

    python3 frontend/scripts/orw1070_rerecord.py --yes-spend [--belt expose]

It replays each case through the real belt code (prompts included), stores the raw reply and the prompt hash in
tests/fixtures/orw1070_extractor_cases.json, and prints precision and recall per belt (gate on, as in the pipeline).
"""
import argparse
import asyncio
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FE = os.path.dirname(HERE)
sys.path.insert(0, FE)
sys.path.insert(0, os.path.join(FE, "tests"))
import _orw1070_replay as rp  # noqa: E402


class _MP:
    """The slice of pytest's monkeypatch the replay uses."""
    def setattr(self, obj, name, val):
        setattr(obj, name, val)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--yes-spend", action="store_true", help="confirm the approved small spend")
    ap.add_argument("--belt", choices=("confide", "expose", "trade"))
    args = ap.parse_args()
    if not args.yes_spend:
        sys.exit("refusing to make live calls without --yes-spend (about 60 short calls)")
    url, key = os.environ.get("ORW_RERECORD_URL"), os.environ.get("ORW_RERECORD_KEY")
    model = os.environ.get("ORW_RERECORD_MODEL", "deepseek-flash")
    if not url or not key:
        sys.exit("set ORW_RERECORD_URL and ORW_RERECORD_KEY")
    from src.llm_core import llm_call_async
    import src.agent_loop as al
    import src.orwell_engine as oe
    fx = rp.load()
    house = rp.house_of(fx)
    mp = _MP()
    sem = asyncio.Semaphore(4)
    for belt in ([args.belt] if args.belt else ["confide", "expose", "trade"]):
        got = []
        for case in fx["cases"][belt]:
            sent = []

            async def llm(messages):
                sent.append(messages)
                async with sem:
                    return await llm_call_async(url=url, model=model, messages=messages,
                                                headers={"Authorization": f"Bearer {key}"},
                                                temperature=0.1, max_tokens=1200, timeout=60,
                                                call_class="utility-extraction") or ""

            # the pipeline: only gated lines reach the model, so only those are re-recorded
            if rp.gate_pass(al, belt, case["u"], house):
                async def rec(messages):
                    raw = await llm(messages)
                    case["raw"] = (raw or "")[:600]
                    return raw
                levers, _ = await rp.run_case(al, oe, belt, case, fx, rec, mp)
                got.append(rp.outcome(belt, levers))
                if sent:
                    fx["meta"]["prompt_sha"][belt] = rp.prompt_sha(sent[0])
            else:
                got.append(None)
        print(belt, rp.score(belt, fx["cases"][belt], got))
    fx["meta"]["recorded"] = __import__("datetime").date.today().isoformat()
    fx["meta"]["recorded_against"] = f"model {model}, prompts at prompt_sha"
    with open(rp.FIXTURE, "w", encoding="utf-8") as fh:
        json.dump(fx, fh, indent=1)
        fh.write("\n")


asyncio.run(main())
