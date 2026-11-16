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


STATED = [
    ("woman", "woman"), ("female", "woman"), ("male", "man"), ("man", "man"), ("non-binary", "nonbinary"), ("enby", "nonbinary"),
    ("they", "nonbinary"), ("he", "man"), ("she", "woman"), ("Woman.", "woman"), ("pronouns: he", "man"),
    ("I'm a dad of two", "man"), ("I'm a mom", "woman"), ("I am a husband", "man"), ("I'm a wife and a nurse", "woman"),
    ("I'm a father", "man"), ("I'm a mother of 3", "woman"), ("I'm a son", "man"), ("I'm a daughter", "woman"),
    ("I'm a brother", "man"), ("I'm a sister", "woman"), ("I'm a guy", "man"), ("I'm a girl", "woman"),
    ("I'm a dude", "man"), ("I'm a lady", "woman"), ("I'm a 45 year old woman", "woman"), ("I'm Alex, a man", "man"),
    ("I'm a gurl", "woman"), ("I'm a woamn", "woman"), ("I'm a femlae", "woman"), ("I'm a trans woman", "woman"),
    ("actually I go by they", "nonbinary"), ("call me she", "woman"), ("my pronouns are they/them", "nonbinary"),
    ("I'm a woman", "woman"), ("I’m non-binary", "nonbinary"), ("he/him", "man"),
    ("I'm a guy\nsorry, I'm a woman", "woman"), ("I'm a woman\nactually I'm a guy", "man"),
    ("I'm a woman\nI'm not a man", "woman"),
    # ORW-476 review 2: more natural shapes
    ("non binary", "nonbinary"), ("female here", "woman"), ("just a regular dude", "man"), ("I'm a she", "woman"), ("I'm a they", "nonbinary"),
    ("Mom of two", "woman"), ("Woman and proud", "woman"), ("As a woman, I know how this goes", "woman"), ("I'm from Ohio, a mom of two", "woman"),
    ("I'm a woman\nI'm going to find the guy\nactually I'm a man", "man"),
    # review 3: shapes the heal's lexicon covers and the gate now reads
    ("trans woman", "woman"), ("cis woman", "woman"), ("I'm a trans woman", "woman"), ("she/they", "woman"), ("they/she", "nonbinary"),
    ("he him", "man"), ("him/he", "man"), ("she her", "woman"), ("nb", "nonbinary"), ("I'm nb", "nonbinary"), ("genderfluid", "nonbinary"),
    ("gender fluid", "nonbinary"), ("agender", "nonbinary"), ("M", "man"), ("F", "woman"), ("30F", "woman"), ("25 m", "man"),
    ("name's Dana, woman", "woman"), ("I'm a queen", "woman"), ("I'm a king", "man"), ("I'm a bloke", "man"), ("I'm a chick", "woman"),
    ("identifies as male", "man"), ("I identify as female", "woman"),
]
NOT_STATED = [
    "Brianna", "My name is Brianna", "Brianna from Ohio, I love my sister, she is a girl scout", "my brother is a guy who plays chess",
    "I'm a barista and my husband is a man", "I'm not a man", "I'm not a woman", "I'm other than expected", "I'm in a boy band",
    "I'm a girl scout", "I'm lazy", "I'm a lazy person", "I'm rude", "I'm a barista", "call me Sam", "",
    # ORW-476 review 2: the noun must be the predicate of "I'm", and a lone him / her / them is not an answer
    "I'm looking for the girl", "I'm the new guy", "I'm a father figure", "use her name", "as a guy would", "I'm going to find the guy",
    "I'm talking to the lady by the door", "him", "her", "them", "tell him/her", "I told him he was wrong", "I'm the queen of this house", "I'm here for the boy", "Mom is great", "man the grill",
]


@pytest.mark.parametrize("text,expected", STATED)
def test_stated_detector_accepts_how_players_really_say_it(text, expected):
    from src.orwell_player_gender import stated_gender
    assert stated_gender(text) == expected


@pytest.mark.parametrize("text", NOT_STATED)
def test_stated_detector_rejects_what_is_not_a_statement(text):
    from src.orwell_player_gender import stated_gender
    assert stated_gender(text) is None


@pytest.mark.parametrize("text,value", [(t, v) for t, v in STATED])
def test_filed_value_is_kept_only_when_it_matches_the_latest_statement(words, seen, text, value):
    words(text)
    other = "woman" if value != "woman" else "man"
    _run(ti.do_update_casting(json.dumps({"genderPresentation": value})))
    _run(ti.do_update_casting(json.dumps({"genderPresentation": other})))
    assert seen["casting"] == [{"genderPresentation": value}, {}]


def test_a_name_alone_never_sets_it(words, seen):
    words("Brianna")
    _run(ti.do_update_casting(json.dumps({"playerName": "Brianna", "genderPresentation": "woman"})))
    assert seen["casting"] == [{"playerName": "Brianna"}]


def test_a_houseguest_line_or_production_cue_never_sets_it():
    import src.agent_loop as al
    cue = al._PRODUCTION_CUE_PREFIX + " she is a woman. I'm a woman"
    own = al._player_own_words([
        {"role": "assistant", "content": "I'm a woman, says Dana. She/her"},
        {"role": "user", "content": cue},
        {"role": "user", "content": "call me Sam"},
    ])
    from src.orwell_player_gender import stated_gender
    assert stated_gender(own) is None


GENDERISH = [
    "trans woman", "cis woman", "she/they", "he him", "him/he", "nb", "30F", "M", "F", "name's Dana, woman", "I'm a queen", "I'm a bloke",
    "I'm a chick", "identifies as male", "genderfluid", "agender", "I'm a woman", "I'm going to find the guy", "tell them I said hi",
    "I'm queer", "masc", "femme", "my wife and I", "I love my daughter", "he said it was fine", "pronouns are whatever",
]
NO_GENDERISH = ["I'm Brianna and I love this", "My name is Dana. I want to play loyal.", "I used to be a barista", "I'm Sam", "Let's go", "42 and ready",
                "call me Sam", "I'm 30, from Ohio"]


@pytest.mark.parametrize("words", GENDERISH)
def test_the_heal_never_clears_when_any_gender_ish_token_appears(monkeypatch, words):
    import src.agent_loop as al
    sent = []

    async def _state(user=None, timeout=None):
        return {"started": True, "player": {"genderPresentation": "woman"}}

    async def _uc(fields=None, user=None):
        sent.append(dict(fields))
        return {}
    monkeypatch.setattr(oe, "get_game_state", _state)
    monkeypatch.setattr(oe, "update_casting", _uc)
    al._GENDER_HEAL_DONE.discard(al._belt_key("uh"))
    assert _run(al._heal_unstated_player_gender("uh", words)) is False
    assert sent == []


@pytest.mark.parametrize("words", NO_GENDERISH)
def test_the_heal_clears_when_there_is_no_gender_ish_token_at_all(monkeypatch, words):
    import src.agent_loop as al
    sent = []

    async def _state(user=None, timeout=None):
        return {"started": True, "player": {"genderPresentation": "woman"}}

    async def _uc(fields=None, user=None):
        sent.append(dict(fields))
        return {}
    monkeypatch.setattr(oe, "get_game_state", _state)
    monkeypatch.setattr(oe, "update_casting", _uc)
    al._GENDER_HEAL_DONE.discard(al._belt_key("uh"))
    assert _run(al._heal_unstated_player_gender("uh", words)) is True
    assert sent == [{"genderPresentation": "unset"}]


def test_the_heal_runs_with_no_owner_single_tenant(monkeypatch):
    import src.agent_loop as al
    sent = []

    async def _state(user=None, timeout=None):
        return {"started": True, "player": {"genderPresentation": "man"}}

    async def _uc(fields=None, user=None):
        sent.append((dict(fields), user))
        return {}
    monkeypatch.setattr(oe, "get_game_state", _state)
    monkeypatch.setattr(oe, "update_casting", _uc)
    al._GENDER_HEAL_DONE.discard(al._belt_key(None))
    assert _run(al._heal_unstated_player_gender(None, "I'm Sam")) is True
    assert sent == [({"genderPresentation": "unset"}, None)]
    assert _run(al._heal_unstated_player_gender(None, "I'm Sam")) is False  # once per process


def test_heal_edge_cases_unchanged(monkeypatch):
    import src.agent_loop as al

    async def _state(user=None, timeout=None):
        return {"started": True, "player": {}}  # nothing saved: nothing to clear
    monkeypatch.setattr(oe, "get_game_state", _state)
    al._GENDER_HEAL_DONE.discard(al._belt_key("ue"))
    assert _run(al._heal_unstated_player_gender("ue", "I'm Sam")) is False
    al._GENDER_HEAL_DONE.discard(al._belt_key("ue2"))
    assert _run(al._heal_unstated_player_gender("ue2", "")) is False  # no words at all: silence is not evidence


def test_unset_passes_the_gate_but_a_value_cannot_be_set_post_season(words, seen):
    words("nothing about gender")
    _run(ti.do_update_casting(json.dumps({"genderPresentation": "unset"})))
    assert seen["casting"] == [{"genderPresentation": "unset"}]


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
