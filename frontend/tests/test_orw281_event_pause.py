"""ORW-281 slice 5: the fresh-pause hold is ONE event-pause hold any multi-step house event sets (comp round, eviction reveal step, ...)."""
import asyncio
import json

from routes import chat_helpers as ch
from src import tool_implementations as ti


def test_any_event_kind_holds_stall_nudge_and_model_levers_the_same_way():
    u = "u281ev"
    ch.event_pause_clear(u)
    assert not ch.event_pause_holds(u) and not ch.production_is_holding(u)
    ch.event_pause_begin(u, "eviction")
    try:
        assert ch.event_pause_kind(u) == "eviction"
        assert ch.event_pause_holds(u) and ch.comp_pause_holds(u), "the comp name is an alias of the one hold"
        assert ch.production_is_holding(u), "the stall-nudge reads production_is_holding"
        out = asyncio.run(ti.do_advance_game("{}", owner=u))
        assert json.loads(out["output"])["held"] is True
        out2 = asyncio.run(ti.do_submit_decision(json.dumps({"kind": "comp-round", "intent": "compete"}), owner=u))
        assert json.loads(out2["output"])["held"] is True
    finally:
        ch.event_pause_clear(u)
    assert not ch.event_pause_holds(u) and not ch.production_is_holding(u)
