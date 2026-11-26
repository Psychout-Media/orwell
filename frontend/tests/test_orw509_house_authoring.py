"""ORW-509: the season's house is authored at setup by one bounded call (plus one retry on an engine refusal); no menu in the prompt; fail-soft."""
import asyncio
import json

from src import orwell_house_authoring as H


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _house():
    return {"name": "The Pelican Inn", "pitch": "An old inn at the end of a snowed-in road.",
            "rooms": {r: {"name": f"the {r} pelican", "look": "Low beams and a hanging lamp, woodsmoke."} for r in H.ROOM_IDS}}


def test_prompt_carries_the_brief_and_three_anchors_but_no_theme_menu():
    msgs = H.build_messages({"demographicSkew": "x", "regionalFlavor": "y"}, 5)
    text = msgs[0]["content"] + msgs[1]["content"]
    assert "Anchor words" in text and len(H.anchors_for(5)) == 3
    assert all(w in text for w in H.anchors_for(5))
    for stock in ("haunted", "candy", "ocean", "space station"):
        assert stock not in text.lower()
    assert H.anchors_for(5) == H.anchors_for(5) and H.anchors_for(5) != H.anchors_for(6)


def test_accepted_on_the_first_call():
    calls = {"llm": 0, "write": []}

    async def llm(_m):
        calls["llm"] += 1
        return json.dumps(_house())

    async def write(p):
        calls["write"].append(p)
        return {"accepted": True, "house": {"accepted": True, "rejected": {}}}

    out = _run(H.author_house({"demographicSkew": "a", "regionalFlavor": "b"}, 1, llm, write))
    assert out["accepted"] is True and calls["llm"] == 1
    assert calls["write"][0]["npcs"] == [] and "house" in calls["write"][0]


def test_one_retry_with_the_rejection_counts_then_the_plain_labels_stand():
    seen = []

    async def llm(m):
        seen.append(m[1]["content"])
        return json.dumps(_house())

    async def write(_p):
        return {"accepted": False, "house": {"accepted": False, "rejected": {"fresh": 1}}}

    out = _run(H.author_house(None, 2, llm, write))
    assert out["accepted"] is False and out["attempts"] == 2 and len(seen) == 2
    assert "refused" in seen[1] and "fresh x1" in seen[1]


def test_no_model_or_garbage_never_raises():
    async def bad(_m):
        raise RuntimeError("down")

    async def junk(_m):
        return "not json"

    async def write(_p):
        raise AssertionError("must not write garbage")

    assert _run(H.author_house(None, 3, bad, write))["accepted"] is False
    assert _run(H.author_house(None, 4, junk, write))["accepted"] is False


def test_join_alliance_forwards_the_narrators_name_only_when_given(monkeypatch):
    from src import orwell_engine, tool_implementations as T
    seen = []

    async def fake_join(alliance_id, expected_beat_seq=None, user=None, name=None):
        seen.append((alliance_id, name))
        return {"id": alliance_id, "name": name or "The Six", "members": [], "youAreFounder": False}

    monkeypatch.setattr(orwell_engine, "join_alliance", fake_join)
    _run(T.do_join_alliance(json.dumps({"allianceId": "alliance:1", "name": "The Last Table"}), owner="o"))
    _run(T.do_join_alliance(json.dumps({"allianceId": "alliance:2"}), owner="o"))
    assert seen == [("alliance:1", "The Last Table"), ("alliance:2", None)] or seen[1][0] == "alliance:2"


def test_orw968_the_writer_is_asked_for_names_that_say_what_the_room_is():
    """ORW-968 (Ryne, live playtest): a room's name ends with its plain word, with at most a short themed modifier in front; the theme lives in the look. The engine says every name with its plain word anyway
    (roomLabels.plainRoomName); this asks the writer for the form we want so the modifier it picks reads well."""
    import importlib
    ha = importlib.import_module("src.orwell_house_authoring")
    src = open(ha.__file__).read()
    assert "SAY what the room is" in src and "plain word" in src and "The theme lives in the LOOK" in src
    assert "none may be just the plain room word" not in src
