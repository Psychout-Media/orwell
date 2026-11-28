"""ORW-419 - the intent-first move seam (FE half): the engine resolves the player's own move BEFORE the narrator.

Roles only. The helper is fail-soft, success-gated, and runs ahead of the narrator's prompt build."""
import asyncio
import inspect
import re
from pathlib import Path

from src import orwell_player_move as pm


class _Engine:
    def __init__(self, res=None, boom=False):
        self.res, self.boom, self.calls = res, boom, []

    async def resolve_player_move(self, text, key, user=None):
        self.calls.append((text, key, user))
        if self.boom:
            raise RuntimeError("engine down")
        return self.res


def run(coro):
    return asyncio.run(coro)  # closes its loop (review of #2724)


def test_returns_the_engines_move_and_keys_the_call_by_message_id():
    eng = _Engine({"playerMove": {"from": "backyard", "to": "kitchen"}, "beatSeq": 4})
    out = run(pm.resolve_player_move_before_narrator("I go to the kitchen", "u", "m1", engine=eng))
    assert out == {"from": "backyard", "to": "kitchen"}
    assert eng.calls == [("I go to the kitchen", "move:m1", "u")]


def test_no_move_or_refusal_or_failure_is_soft():
    assert run(pm.resolve_player_move_before_narrator("hello", "u", "m", engine=_Engine({"playerMove": None}))) is None
    assert run(pm.resolve_player_move_before_narrator("", "u", "m", engine=_Engine({}))) is None
    assert run(pm.resolve_player_move_before_narrator("x", "u", "m", engine=_Engine(boom=True))) is None
    refused = {"playerMove": {"refused": True, "reason": "gathered"}}
    assert run(pm.resolve_player_move_before_narrator("go", "u", "m", engine=_Engine(refused)))["refused"] is True


def test_belt_telemetry_is_success_gated():
    from src import orwell_sync_ledger as led
    user = "orw419-belt"
    before = led.get_belt_totals(user).get(pm.BELT_NAME, 0) if isinstance(led.get_belt_totals(user), dict) else 0
    run(pm.resolve_player_move_before_narrator("hi", user, "m", engine=_Engine({"playerMove": None})))
    run(pm.resolve_player_move_before_narrator("go", user, "m", engine=_Engine({"playerMove": {"refused": True, "reason": "r"}})))
    mid = led.get_belt_totals(user).get(pm.BELT_NAME, 0)
    assert mid == before  # no move / a refusal is not an applied correction
    run(pm.resolve_player_move_before_narrator("go", user, "m", engine=_Engine({"playerMove": {"from": "a", "to": "b"}})))
    assert led.get_belt_totals(user).get(pm.BELT_NAME, 0) == before + 1


def test_the_call_runs_before_the_narrator_prompt_is_built():
    """Mutation guard: the resolve must precede apply_game_framing (which builds the moment prompt the narrator reads)."""
    src = (Path(__file__).resolve().parents[1] / "routes" / "chat_helpers.py").read_text()
    i = src.index("resolve_player_move_before_narrator(message")
    j = src.index("await apply_game_framing(", i)
    assert i < j
    assert src.index("await note_player_message(client_msg_id, user") < i  # ORW-1159: the call also passes session_id; the order is the rule


def test_stub_narrator_prompt_shows_the_new_room_and_playerMove():
    """The resolve then the prompt build: a stub engine whose moment prompt reflects the move only if resolved first."""
    state = {"room": "backyard", "playerMove": None}

    class Eng(_Engine):
        async def resolve_player_move(self, text, key, user=None):
            state.update(room="kitchen", playerMove={"from": "backyard", "to": "kitchen"})
            return {"playerMove": state["playerMove"]}

    def prompt():
        return f"room={state['room']} playerMove={state['playerMove']}"

    async def turn(resolve_first):
        if resolve_first:
            await pm.resolve_player_move_before_narrator("I go to the kitchen", "u", "m", engine=Eng())
        p = prompt()
        if not resolve_first:
            await pm.resolve_player_move_before_narrator("I go to the kitchen", "u", "m", engine=Eng())
        return p

    good = run(turn(True))
    assert "room=kitchen" in good and "'to': 'kitchen'" in good
    state.update(room="backyard", playerMove=None)
    assert "room=backyard" in run(turn(False))  # resolve-after-narrator: the prompt is stale -> the test above goes red
