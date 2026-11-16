"""ORW-501 / ORW-502: the retro review calls that were decided as CHANGES. Roles only.

  * a room word inside quoted speech does not exempt an adjacent houseguest the narration puts in the player's room;
  * "Two of them are inside, while the rest ..." is a subgroup, not the arrival total;
  * a model-called moveTo result says the opening HARD ROSTER was for the room the player left;
  * a live game's narrator stays on its selected model (no configured fallback is handed to the outage wrapper).
"""
import asyncio
import importlib
import json

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")

_FACTS = {"adjacent": {"Cleo"}, "adjacent_rooms": ["backyard"], "evicted": set(), "active_offscene": set(), "exempt": set()}


def _stages(sentence):
    counts = chat_helpers._first_name_counts({"Cleo", "Alice"})
    return chat_helpers._sentence_stages_absent_npc(sentence, _FACTS, counts)


def test_a_room_word_in_the_dialogue_does_not_exempt_the_adjacent_houseguest_acting_in_the_room():
    assert _stages('Cleo leans against the kitchen counter and says, "Let\'s go to the backyard."') == "Cleo"
    assert _stages('Cleo leans against the kitchen counter and says, “Let\'s go to the backyard.”') == "Cleo"


@pytest.mark.parametrize("sentence", [
    "Cleo laughs out in the backyard, and you hear it from here.",
    'From the backyard Cleo calls, "Come out here!"',
    'Alice says, "Cleo is out in the backyard."',          # named only inside the quote: unchanged (never a new drop)
    "Somebody laughs in the kitchen.",
])
def test_a_real_overhear_or_a_quote_only_mention_still_streams(sentence):
    assert _stages(sentence) is None


@pytest.mark.parametrize("sentence", [
    "Two of them are inside, while the rest chat in the yard.",
    "Three of you are inside, and the others are still outside.",
    "Four of them are in, everyone else is still on the lawn.",
])
def test_a_subgroup_beside_the_rest_is_not_the_arrival_total(sentence):
    assert not chat_helpers._headcount_claims(sentence), sentence


def test_a_plain_total_is_still_a_claim():
    assert chat_helpers._headcount_claims("Eleven of them are inside now.")


def test_move_to_result_tells_the_narrator_the_opening_roster_was_the_old_room(monkeypatch):
    from src import orwell_engine, tool_implementations as ti

    async def fake_move_to(room, user=None):
        return {"room": "kitchen", "present": [{"name": "Cleo"}], "nearby": []}

    monkeypatch.setattr(orwell_engine, "move_to", fake_move_to)
    out = asyncio.run(ti.do_move_to(json.dumps({"room": "kitchen"}), owner="o1"))
    body = json.loads(out["output"])
    assert "HARD ROSTER" in body["rosterNote"] and body["present"][0]["name"] == "Cleo"

    async def noop(room, user=None):
        return {"status": "noop"}

    monkeypatch.setattr(orwell_engine, "move_to", noop)
    assert "rosterNote" not in json.loads(asyncio.run(ti.do_move_to("{}", owner="o1"))["output"])


def test_a_live_game_narrator_is_never_handed_a_fallback_model(monkeypatch):
    from src import agent_loop as al
    seen = []

    async def fake_stream(candidates, messages, **kw):
        seen.append(list(candidates))
        yield 'data: ' + json.dumps({"delta": "The kitchen goes quiet."}) + '\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setenv("ORWELL_GAME_BUILD", "1")
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: default)
    import src.tool_index as ti
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)
    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)

    async def run():
        async for _ in al.stream_agent_loop(
                "https://api.openai.com/v1/chat/completions", "deepseek/deepseek-v4-pro",
                [{"role": "system", "content": "You are Big Brother, the narrator."}, {"role": "user", "content": "Look around."}],
                max_rounds=2, game_mode="game", owner=None,
                fallbacks=[("https://other.example/v1/chat/completions", "other/model", {})]):
            pass

    asyncio.run(run())
    assert seen and all(len(c) == 1 and c[0][1] == "deepseek/deepseek-v4-pro" for c in seen)
