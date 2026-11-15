#!/usr/bin/env python3
"""deploy/smoke_turn.py — one REAL turn through the deployed system (B71/ops A7).

Creates a game through the FRONT-END's guarded route (which must reach the token-enforcing
engine — the B67 contract, end-to-end), advances the live loop on the engine's authed player
channel until a player decision pends, and resolves it through the front-end's sanctioned
/api/orwell/decision route. Prints TURN OK on success; any gap (FE can't reach the engine,
the loop can't advance, the decision can't bind) fails loudly.
"""
import json
import os
import sys

import time
import httpx

FE = os.environ["ORWELL_SMOKE_FE"].rstrip("/")
ENGINE = os.environ["ORWELL_SMOKE_ENGINE"].rstrip("/")
TOKEN = os.environ["ORWELL_SMOKE_TOKEN"]
AUTH = {"authorization": f"Bearer {TOKEN}"}


def engine_call(name: str, args: dict | None = None) -> dict:
    r = httpx.post(f"{ENGINE}/player/call", json={"name": name, "args": args or {}}, headers=AUTH, timeout=30)
    r.raise_for_status()
    return r.json()["result"]


def end_held_night() -> None:
    for i in range(800):
        tod = (engine_call("gameStatus") or {}).get("timeOfDay")
        if tod in ("evening", "night", "late-night"):
            engine_call("turnIn")
            return
        engine_call("noteMessage", {"messageId": f"smoke-held-{i}-{time.time()}"})
    engine_call("turnIn")


def main() -> int:
    # 1) Create through the FE (its engine client must carry the token — B67).
    r = httpx.post(f"{FE}/api/orwell/new-game", json={"playerName": "Smoke", "confirm": True}, timeout=60)
    if r.status_code != 200 or not r.json().get("started"):
        print(f"FAIL: new-game via the FE -> {r.status_code} {r.text[:200]}")
        return 1
    state = httpx.get(f"{FE}/api/orwell/state", timeout=30).json()
    if not state.get("started"):
        print("FAIL: the FE does not see the started game")
        return 1
    print("create: ok (through the front-end, engine auth on)")

    # 2) Advance the live loop until a player decision pends (the agent path's tool).
    pending = None
    for _ in range(120):
        adv = engine_call("advanceGame")
        if adv.get("pending"):
            pending = adv["pending"]
            break
        if adv.get("held"):
            # ORW-116/ORW-236: the night is never auto-run - an advance that would roll it comes back `held`. Do what a real player does: let time pass
            # (player messages, ~5 in-game minutes each) until it is evening, then turn in.
            end_held_night()
    if not pending:
        print("FAIL: no player decision pended within the advance budget")
        return 1
    print(f"advance: ok (pending {pending['kind']})")

    # 3) Resolve it through the FE's sanctioned decision route (the C20 confirm path).
    kind = pending["kind"]
    body: dict = {"kind": kind}
    options = pending.get("options") or []
    if kind == "nominations":
        body["choice"] = [options[0]["id"], options[1]["id"]]
    elif kind == "veto-decision":
        body["use"] = False
    elif kind == "comp-intent":
        body["intent"] = "compete"
    elif kind == "finale-statement":
        body["statement"] = "smoke"
    elif kind == "finale-answer":
        body["appeal"] = (pending.get("appeals") or ["own-game"])[0]
    elif options:
        body["vote"] = options[0]["id"]
        body["replacement"] = options[0]["id"]
    r = httpx.post(f"{FE}/api/orwell/decision", json=body, timeout=30)
    if r.status_code != 200:
        print(f"FAIL: decision via the FE -> {r.status_code} {r.text[:200]}")
        return 1
    out = r.json()
    if out.get("pending") and out["pending"].get("kind") == kind:
        print("FAIL: the decision did not bind (the same kind still pends)")
        return 1
    print("decision: ok (bound through the front-end)")
    print("TURN OK")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # any transport gap is a smoke failure, loudly
        print(f"FAIL: {type(e).__name__}: {e}")
        sys.exit(1)
