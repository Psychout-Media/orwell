"""ORW-1128: act-first must resolve what the player plainly says (a bedroom by its display name, 'a bed in here', 'go look at the bedrooms'), and a noAction must never
drop a move silently. The model is mocked; no call is made."""
import asyncio
import importlib
import json

import pytest

af = importlib.import_module("src.act_first")
ROOMS = ["kitchen", "living-room", "dining-room", "backyard", "hallway", "bedroom-a", "bedroom-b", "bedroom-c", "bathroom", "lounge", "hoh-room", "storage-room", "diary-room", "landing"]
# the engine's themed names for Ryne's season (bedrooms are Blossom / Press / Barrel)
NAMES = {"kitchen": "Cider Kitchen", "bedroom-a": "Blossom Bedroom", "bedroom-b": "Press Bedroom", "bedroom-c": "Barrel Bedroom", "landing": "Cider Landing"}
BUNK = dict(NAMES, **{"bedroom-b": "the Bunk Room"})
NOACT = [{"name": "noAction", "arguments": {}}]


def ctx(here="kitchen", names=NAMES):
    return {"here": here, "people": ["Levi Stone"], "room_names": names}


def run(text, calls, **kw):
    async def call(**k):
        return calls
    return asyncio.run(af.decide(text, ROOMS, ctx=ctx(**kw), fence="", call=call))


@pytest.mark.parametrize("text,room", [("Lets check out barrel", "bedroom-c"), ("lets go to the Barrel", "bedroom-c"), ("I will head to Blossom", "bedroom-a"),
                                       ("I am going into Press", "bedroom-b")])
def test_a_room_said_by_its_display_name_moves_even_when_the_model_says_noAction(text, room):
    d = run(text, NOACT, here="kitchen")
    assert d["acts"] == [("moveTo", {"room": room})], d


def test_the_bunk_room_resolves_by_its_display_name_spaced_or_not():
    for text in ("lets check out the bunk room", "lets check out the bunkroom"):
        assert run(text, NOACT, names=BUNK)["acts"] == [("moveTo", {"room": "bedroom-b"})], text


def test_the_model_naming_the_themed_room_is_grounded():
    d = run("Lets check out barrel", [{"name": "moveTo", "arguments": {"rooms": ["bedroom-c"]}}])
    assert d["acts"] == [("moveTo", {"room": "bedroom-c"})]


@pytest.mark.parametrize("text", ["I think I'll chose a bed in here", "I will grab a bed in Barrel"])
def test_a_bed_in_the_room_they_stand_in_or_name_is_claimed(text):
    d = run(text, NOACT, here="bedroom-c")
    assert d["acts"] == [("claimBed", {"room": "bedroom-c", "kind": "any"})], d


def test_a_bed_in_a_named_bedroom_from_elsewhere_moves_then_claims():
    d = run("I will grab a bed in Barrel", NOACT, here="kitchen")
    assert d["acts"] == [("moveTo", {"room": "bedroom-c"}), ("claimBed", {"room": "bedroom-c", "kind": "any"})]


@pytest.mark.parametrize("text", ["Lets go look at the different bedrooms", "Im going to go pick a bed. Maybe the bunkroom?"])
def test_going_to_look_at_the_bedrooms_actually_moves_to_a_bedroom(text):
    d = run(text, NOACT, here="kitchen")
    assert d["acts"] == [("moveTo", {"room": "bedroom-a"})], d


@pytest.mark.parametrize("text", ["Should I check out barrel?", "I don't want to go to Barrel", "Dana says lets check out barrel", "Nice to meet you all, my name is Ryne."])
def test_questions_refusals_and_talk_still_commit_nothing(text):
    assert run(text, NOACT, here="kitchen")["acts"] == []


# ── defence in depth: a noAction hands the message to the engine's ordinary parser ───────────────────────────────
class _Eng:
    def __init__(self, names=None):
        self.calls, self._names = [], names

    async def game_status(self, user=None):
        return {"pending": {}, "timeOfDay": "afternoon", "started": True}

    async def whereabouts(self, user=None, **k):
        return {"room": "kitchen", **({"roomNames": self._names} if self._names else {})}

    async def get_game_state(self, user=None, **k):
        return {"house": [{"name": "Levi Stone", "status": "active"}]}

    async def resolve_player_move(self, text, key=None, user=None, previous_reply=None, skip=None):
        self.calls.append((text, key, skip))
        return {"playerMove": None}


class _Sess:
    endpoint_url = "https://api.deepseek.com"
    model = "deepseek-flash"


def _slot(text, calls, monkeypatch, eng):
    pm = importlib.import_module("src.orwell_player_move")
    ti = importlib.import_module("src.tool_implementations")
    moved = []

    async def fake_move(content, owner=None):
        room = json.loads(content)["room"]
        moved.append(room)
        return {"output": json.dumps({"room": room}), "exit_code": 0}

    monkeypatch.setattr(ti, "do_move_to", fake_move)
    monkeypatch.setenv("ORWELL_ACT_FIRST", "1")
    af.take_stash("u")

    async def call(**k):
        return calls
    return asyncio.run(pm.act_first_before_narrator(text, "u", "m1", sess=_Sess(), engine=eng, call=call)), moved


def test_noAction_hands_the_message_to_the_ordinary_parser(monkeypatch):
    ok, moved = _slot("Hmm, something about the ceiling", NOACT, monkeypatch, _Eng())
    assert ok is False and moved == []  # not owned: the caller runs the engine's own move + bed parse
    assert af.take_stash("u")["outcome"] in ("noAction", "skipped")


def test_the_slot_reads_the_themed_names_from_this_turns_whereabouts(monkeypatch):
    """The turn's framing has not pinned the names yet when this slot runs: they come from the whereabouts it just read."""
    eng = _Eng(names=NAMES)
    ok, moved = _slot("Lets check out barrel", NOACT, monkeypatch, eng)
    assert ok is True and moved == ["bedroom-c"]
    assert eng.calls[0][2] == ["move", "bed"]


def test_move_tool_is_restored_when_act_first_committed_nothing(monkeypatch):
    al = importlib.import_module("src.agent_loop")
    monkeypatch.setenv("ORWELL_ACT_FIRST", "1")
    af.take_stash("u")
    narrowed = [t for t in al.FUNCTION_TOOL_SCHEMAS if t["function"]["name"] in ("getGameState", "advanceGame")]
    out = al._restore_move_tools_for_act_first(narrowed, "u")
    assert "moveTo" in [t["function"]["name"] for t in out]
    af.put_stash("u", {"outcome": "acted"})
    assert al._restore_move_tools_for_act_first(narrowed, "u") == narrowed  # act-first moved them: nothing to restore
    af.take_stash("u")
    assert al._restore_move_tools_for_act_first(narrowed, "u", {"moveTo"}) == narrowed  # a deliberate disable is respected
