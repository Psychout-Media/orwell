"""ORW-835 shared harness: drive the REAL `stream_agent_loop` against a STATEFUL engine stand-in for the three secret levers (confide / exposeSecret / tradeSecret).
The narrator's own tool call goes through the real tool-result handling (only `execute_tool_block` is stubbed, and it calls the real `do_*` implementation, which calls the stand-in lever).
The stand-in changes state only when a lever is called and refuses the way the engine does (null for an unknown houseguest; a typed `refused` for expose / trade). The belt's
extraction call is the only model stub. No state is set by hand. Roles only."""
import asyncio
import json

ROSTER = [{"id": "npc:1", "name": "Contestant Alpha", "status": "active"},
          {"id": "npc:2", "name": "Contestant Beta", "status": "active"},
          {"id": "npc:3", "name": "Contestant Gamma", "status": "active"}]
SCENE = "Contestant Alpha leans in and lowers a voice, and Contestant Beta watches from across the room."
FACTS = [{"factId": "fact:a", "content": "a rival bribed a judge", "subject": "npc:2"},
         {"factId": "fact:b", "content": "a rival faked an injury", "subject": "npc:3"}]
MARKERS = {"confide": "pressing ONE specific houseguest", "expose": "OUTING/EXPOSING", "trade": "TRADING a secret"}
USER_MSG = {"confide": "You can tell me what's really going on. Level with me.",
            "expose": "I'm going to expose them and tell the house everything.",
            "trade": "I'll trade you the secret in exchange for your vote."}


def reset_loop_state():
    from src import agent_loop as al
    from routes import chat_helpers as ch
    for name in ("_SILENT_FORCE_ADVANCE_STREAK", "_ADVANCE_STALL_LEVEL", "_ADVANCE_STALL_FLAGS", "_TURNS_SINCE_PROGRESS", "_ANTI_STALE_CAP_HOLDS", "_LOOP_STREAK"):
        d = getattr(al, name, None)
        if isinstance(d, dict):
            d.clear()
    al._forget_season_pacing("u")
    ch._forget_season_pacing("u")


def drive(monkeypatch, *, belt, model_calls, extraction, silent=(), spent=(), capped=False, unknown=("npc:9",), decline=(), unlearned=()):
    """`belt`: 'confide' | 'expose' | 'trade'. `model_calls`: the narrator's own tool calls in round 1. `extraction`: what the belt's utility call returns.
    `silent`: houseguests who answer a confide with `{disclosed:false}` (a taken, normal result). `spent`: facts already exposed/traded. `capped`: the engine refuses the whole lever.
    `unlearned`: facts the player's view still lists but the engine no longer lets them wield (a typed `not-learned`). `decline`: (fact, recipient) pairs the recipient declines (a taken, adjudicated trade). Returns (engine, belts)."""
    from src import agent_loop as al
    import src.orwell_engine as oe
    import src.tool_index as ti
    import src.llm_core as lc

    monkeypatch.setenv("ORWELL_GAME_BUILD", "1")
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: default)
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)
    monkeypatch.setattr(al, "_loop_break_streak_update", lambda *a, **k: False)

    known = {f["factId"] for f in FACTS}
    engine = {"calls": [], "told": [], "exposed": [], "traded": [], "spent": set(spent)}

    async def fake_state(*a, **k):
        return {"phase": "hoh-competition", "moment": "social", "week": 1, "beatSeq": 1, "pending": None, "house": ROSTER, "started": True}

    async def fake_visible(*a, **k):
        return {"knowledge": [dict(f) for f in FACTS if f["factId"] not in engine["spent"]]}

    async def fake_confide(npc_id, expected_beat_seq=None, idempotency_key=None, user=None):
        engine["calls"].append(("confide", npc_id))
        if npc_id in unknown:
            return None  # the engine's refusal: an unknown / departed houseguest has no confidence path
        if npc_id in silent:
            return {"disclosed": False, "tier": "none"}  # taken: the engine rolled and kept the secret
        engine["told"].append(npc_id)
        return {"disclosed": True, "tier": "full", "content": "a thing they carry"}

    async def fake_expose(fact_id=None, bluff=False, subject=None, expected_beat_seq=None, idempotency_key=None, user=None):
        engine["calls"].append(("expose", fact_id if not bluff else ("bluff", subject)))
        if capped:
            return {"exposed": False, "refused": "capped"}
        if bluff:
            if not subject:
                return {"exposed": False, "refused": "no-subject"}
            engine["exposed"].append(("bluff", subject))
            return {"exposed": True}
        if fact_id in engine["spent"]:
            return {"exposed": False, "refused": "already-spent"}
        if fact_id not in known or fact_id in unlearned:
            return {"exposed": False, "refused": "not-learned"}
        engine["spent"].add(fact_id)
        engine["exposed"].append(fact_id)
        return {"exposed": True}

    async def fake_trade(to_npc_id, fact_id=None, bluff=False, subject=None, ask_kind=None, expected_beat_seq=None, idempotency_key=None, user=None):
        engine["calls"].append(("trade", fact_id, to_npc_id))
        if capped:
            return {"accepted": False, "refused": "capped"}
        if to_npc_id not in {h["id"] for h in ROSTER}:
            return {"accepted": False, "refused": "no-recipient"}
        if fact_id in engine["spent"]:
            return {"accepted": False, "refused": "already-spent"}
        if fact_id not in known or fact_id in unlearned:
            return {"accepted": False, "refused": "not-learned"}
        if (fact_id, to_npc_id) in decline:
            return {"accepted": False, "refused": "declined", "narratable": "they didn't bite"}
        engine["traded"].append((fact_id, to_npc_id))
        return {"accepted": True, "narratable": "they took the trade"}

    async def fake_advance(*a, **k):
        return {"beatSeq": 2, "pending": None, "event": None}

    monkeypatch.setattr(oe, "get_game_state", fake_state)
    monkeypatch.setattr(oe, "get_visible_state", fake_visible)
    monkeypatch.setattr(oe, "confide", fake_confide)
    monkeypatch.setattr(oe, "expose_secret", fake_expose)
    monkeypatch.setattr(oe, "trade_secret", fake_trade)
    monkeypatch.setattr(oe, "advance_game", fake_advance)

    async def fake_llm(*a, **k):
        sysmsg = " ".join(str(m.get("content")) for m in (k.get("messages") or []))
        return extraction if MARKERS[belt] in sysmsg else ""

    monkeypatch.setattr(lc, "llm_call_async", fake_llm)

    async def fake_exec(block, **k):  # the narrator's own lever call, carried out by the real tool implementation against the stand-in engine
        from src import tool_implementations as impl
        fn = {"confide": impl.do_confide, "exposeSecret": impl.do_expose_secret, "tradeSecret": impl.do_trade_secret}.get(block.tool_type)
        if fn is None:
            return block.tool_type, {"output": "{}", "exit_code": 0}
        return block.tool_type, await fn(block.content, owner="u")

    monkeypatch.setattr(al, "execute_tool_block", fake_exec)

    async def _no(*a, **k):
        return False

    for n in ("_auto_record_scene", "_auto_record_deal", "_auto_alliance", "_auto_promise", "_auto_move_player", "_auto_move_npc", "_auto_answer_deal_offer"
              ) + tuple(n for n in ("_auto_confide", "_auto_expose_secret", "_auto_trade_secret") if n != {"confide": "_auto_confide", "expose": "_auto_expose_secret", "trade": "_auto_trade_secret"}[belt]):
        monkeypatch.setattr(al, n, _no)
    belts = []
    monkeypatch.setattr(al, "_note_belt", lambda owner, name, *a, **k: belts.append(name))

    rounds = {"n": 0}

    async def fake_stream(candidates, messages, **kwargs):
        rounds["n"] += 1
        if rounds["n"] == 1 and model_calls:
            calls = [{"id": f"c{i}", "name": n, "arguments": json.dumps(a)} for i, (n, a) in enumerate(model_calls)]
            yield 'data: ' + json.dumps({"type": "tool_calls", "calls": calls}) + '\n\n'
            yield 'data: ' + json.dumps({"type": "finish", "reason": "tool_calls"}) + '\n\n'
        else:
            yield 'data: ' + json.dumps({"delta": SCENE}) + '\n\n'
            yield 'data: ' + json.dumps({"type": "finish", "reason": "stop"}) + '\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)

    async def run():
        gen = al.stream_agent_loop("https://api.deepseek.com/chat/completions", "deepseek-flash",
                                   [{"role": "system", "content": "You are the narrator."}, {"role": "user", "content": USER_MSG[belt]}],
                                   max_rounds=4, game_mode="game", owner="u")
        async for _ in gen:
            pass

    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(run())
    finally:
        loop.close()
    return engine, belts
