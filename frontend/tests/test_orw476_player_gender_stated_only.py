"""ORW-476 — the player has no gender unless they stated one. A genderPresentation the model files with
updateCasting / createCharacter (or via the `gender` / `pronouns` aliases) is kept only when the player's own words
say it; a guess from the name never reaches the engine."""
import asyncio
import importlib
import json

import pytest

importlib.import_module("src.agent_tools")
import src.orwell_engine as oe  # noqa: E402
import src.tool_implementations as ti  # noqa: E402


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@pytest.fixture
def words():
    toks = []

    def _set(text):
        toks.append(ti.PLAYER_OWN_WORDS.set(text))
    yield _set
    while toks:
        ti.PLAYER_OWN_WORDS.reset(toks.pop())


@pytest.fixture
def seen(monkeypatch):
    rec = {"casting": [], "create": []}

    async def _uc(fields=None, user=None):
        rec["casting"].append(dict(fields or {}))
        return {"known": [], "missing": [], "ready": False}

    async def _cc(player_name=None, **kw):
        rec["create"].append(kw)
        return {"started": False}

    async def _noop(*a, **k):
        return None
    monkeypatch.setattr(oe, "update_casting", _uc)
    monkeypatch.setattr(oe, "create_character", _cc)
    monkeypatch.setattr(ti, "_refresh_after_model_progression", _noop)
    return rec


@pytest.mark.parametrize("key", ["genderPresentation", "gender", "pronouns"])
def test_guess_from_name_is_dropped(words, seen, key):
    words("My name is Brianna. I used to be a barista and I want to play it loyal.")
    _run(ti.do_update_casting(json.dumps({"playerName": "Brianna", key: "woman"})))
    assert seen["casting"] == [{"playerName": "Brianna"}]


def test_stated_gender_is_kept(words, seen):
    words("I'm a woman, and I want to play loyal.")
    _run(ti.do_update_casting(json.dumps({"playerName": "Sam", "genderPresentation": "woman"})))
    assert seen["casting"][0].get("genderPresentation") == "woman"


def test_stated_pronouns_kept_and_mismatch_dropped(words, seen):
    words("call me Sam, my pronouns are they/them")
    _run(ti.do_update_casting(json.dumps({"genderPresentation": "nonbinary"})))
    _run(ti.do_update_casting(json.dumps({"genderPresentation": "woman"})))
    assert seen["casting"] == [{"genderPresentation": "nonbinary"}, {}]


def test_no_player_words_drops_it(seen):
    _run(ti.do_update_casting(json.dumps({"genderPresentation": "woman"})))
    assert seen["casting"] == [{}]


def test_create_character_drops_a_name_guess(words, seen):
    words("Brianna. Loyal player.")
    _run(ti.do_create_character(json.dumps({"playerName": "Brianna", "genderPresentation": "woman"})))
    assert seen["create"] and seen["create"][0].get("gender_presentation") is None


def test_create_character_keeps_a_stated_gender(words, seen):
    words("I am a guy and proud")
    _run(ti.do_create_character(json.dumps({"playerName": "Alex", "genderPresentation": "man"})))
    assert seen["create"][0].get("gender_presentation") == "man"


@pytest.mark.parametrize("text,expected", [
    ("I'm a woman", {"woman"}), ("I’m non-binary", {"nonbinary"}), ("he/him", {"man"}),
    ("Brianna from Ohio, I love my sister, she is a girl scout", set()),
    ("my brother is a guy who plays chess", set()),
])
def test_stated_detector(text, expected):
    assert ti.player_stated_genders(text) == expected


def test_player_own_words_collects_every_typed_turn_but_no_production_cue():
    import src.agent_loop as al
    cue = al._PRODUCTION_CUE_PREFIX + " continue the casting interview"
    msgs = [
        {"role": "user", "content": "I'm a woman"},
        {"role": "assistant", "content": "Noted, he/him?"},
        {"role": "user", "content": cue},
        {"role": "user", "content": [{"type": "text", "text": "call me Sam"}]},
    ]
    got = al._player_own_words(msgs)
    assert "I'm a woman" in got and "call me Sam" in got
    assert "continue the casting interview" not in got and "he/him" not in got
