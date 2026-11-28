"""ORW-1135 / 1136 / 1137, prod 2026-11-28 (Ryne's session, as codes: turns be1cebf4, 8edc219f, aae9c979; folds 03:34:38 and 03:47:59). No player or narrator text from prod is quoted: the cases below are written fresh in the same shapes,
with invented names.

1135  a QUESTION about a houseguest (where they sleep, whose bed, what they think) is not an order to search the house; an order or a where-is request still is. The search walks at most SEARCH_MAX_LEGS legs.
1136  a search whose target is already in the player's room is a success ('right here'), not BLOCKED; the narration may not write the setting as a bedroom when the engine room is not one.
1137  an alliance fold is recorded only on the player's own yes, never on a houseguest's offer, and never after he argued against it.
"""
import asyncio
import importlib
import json

import pytest

af = importlib.import_module("src.act_first")
pd = importlib.import_module("src.predisplay_check")
al = importlib.import_module("src.agent_loop")
oe = importlib.import_module("src.orwell_engine")

ROOMS = ["kitchen", "living-room", "dining-room", "backyard", "hallway", "bedroom-a", "bedroom-b", "bedroom-c", "bathroom", "lounge", "hoh-room", "storage-room", "diary-room", "landing"]
PEOPLE = ["Dana Park", "Levi Stone"]
CTX = {"here": "bedroom-c", "people": PEOPLE, "room_names": {}}

# (text, is_order). Question-vs-order pairs, same people and rooms: the prod pair (be1cebf4 and its resend 8edc219f) is the first question shape.
CASES = [
    ("Does Dana sleep in this room?", False),
    ("Is Dana sleeping in here tonight?", False),
    ("Which bed is Dana's?", False),
    ("Where does Dana sleep?", False),
    ("Where is Dana sleeping tonight?", False),
    ("What does Dana think about the alliance?", False),
    ("Do you know where Dana is?", False),
    ("Has anyone seen Dana?", False),
    ("Did you find Dana?", False),
    ("I can't find Dana anywhere, did you see her?", False),
    ("Why does Dana always look for trouble?", False),
    ("I think Dana would find that funny.", False),
    ("Is Dana in the room with us?", False),
    ("Does Dana share a bed with Levi?", False),
    ("Wait, is Dana staying in this bedroom?", False),
    ("Do you want to look for Dana?", False),
    ('Levi said "go find Dana" and left it at that.', False),
    ("Go find Dana", True),
    ("I look for Dana.", True),
    ("Let's look for Dana", True),
    ("Where is Dana?", True),
    ("Where's Dana?", True),
    ("Where did Dana go?", True),
    ("I need to find Dana", True),
    ("Can you find Dana for me?", True),
    ("I'm going to search for Dana", True),
    ("Find Dana", True),
    ("I go looking for Dana", True),
    ("please find Dana", True),
    ("Okay, I'll go look for Dana", True),
    ("Track down Dana", True),
    ("Hey, go and find Dana now", True),
    ("I head off to look for Dana", True),
]


@pytest.mark.parametrize("text,order", CASES)
def test_a_search_is_an_order_or_a_where_is_never_a_question(text, order):
    assert len(CASES) >= 20
    assert af.is_search_order(text, "Dana Park") is order


@pytest.mark.parametrize("text,order", CASES)
def test_the_validator_commits_a_search_only_for_an_order_even_when_the_model_calls_search(text, order):
    got = af.validate_calls([{"name": "search", "arguments": {"who": "Dana"}}], text=text, rooms=ROOMS, ctx=CTX)
    assert got == ([("search", {"who": "Dana Park"})] if order else [])


def test_the_prefilter_spends_no_call_on_a_question_about_a_person():
    assert af.can_commit_nothing("What does Dana think about all this?", ROOMS, CTX) is True
    assert af.can_commit_nothing("Go find Dana", ROOMS, CTX) is False


def test_the_search_cap_is_three_legs():
    assert af.SEARCH_MAX_LEGS == 3


class _Eng:
    def __init__(self, search):
        self.calls = []
        self._search = search

    async def game_status(self, user=None):
        return {"pending": {}, "timeOfDay": "night", "started": True}

    async def whereabouts(self, user=None, **k):
        return {"room": "bedroom-c"}

    async def get_game_state(self, user=None, **k):
        return {"house": [{"name": "Dana Park", "status": "active"}]}

    async def resolve_player_move(self, text, key=None, user=None, previous_reply=None, skip=None, max_legs=None):
        self.calls.append((text, key, skip, max_legs))
        if text.startswith("I look for"):
            return {"playerMove": None, "whereabouts": {}, "search": self._search}
        return {"playerMove": None, "whereabouts": {}}


class _Sess:
    endpoint_url = "https://api.deepseek.com"
    model = "deepseek-flash"


def _slot(text, search, monkeypatch):
    pm = importlib.import_module("src.orwell_player_move")
    monkeypatch.setenv("ORWELL_ACT_FIRST", "1")
    af.reset_stats()
    af._STASH.clear()
    eng = _Eng(search)

    async def call(**k):
        return [{"name": "search", "arguments": {"who": "Dana"}}]

    ok = asyncio.run(pm.act_first_before_narrator(text, "u", "m1", sess=_Sess(), engine=eng, call=call))
    return ok, eng, af.take_stash("u")


def test_a_question_commits_no_search_and_walks_nobody(monkeypatch):
    ok, eng, st = _slot("Does Dana sleep in this room?", {"outcome": "found", "legs": []}, monkeypatch)
    assert ok is True and st["done"] == [] and st["blocked"] == []
    assert [c for c in eng.calls if c[0].startswith("I look for")] == []


def test_an_order_commits_the_search_with_the_leg_cap(monkeypatch):
    ok, eng, st = _slot("Go find Dana", {"outcome": "found", "legs": [{"room": "hallway"}]}, monkeypatch)
    search_calls = [c for c in eng.calls if c[0].startswith("I look for")]
    assert len(search_calls) == 1 and search_calls[0][3] == af.SEARCH_MAX_LEGS
    assert st["done"][0][2] is True and st["blocked"] == []


def test_a_target_already_here_is_a_success_not_blocked(monkeypatch):
    """ORW-1136 (aae9c979): the engine answers 'found, no legs, right here'; the commit was read as BLOCKED and the narrator was told the game refused."""
    ok, eng, st = _slot("Where is Dana?", {"outcome": "found", "legs": [], "reason": "Dana Park is right here"}, monkeypatch)
    assert st["blocked"] == [] and st["done"][0][2] is True
    assert any("right here" in n and "no walk" in n for n in st["notes"]) and not any("BLOCKED" in n for n in st["notes"])


def test_a_capped_search_tells_the_narrator_where_it_stopped(monkeypatch):
    ok, eng, st = _slot("Go find Dana", {"outcome": "stopped", "legs": [{"room": "a"}, {"room": "b"}, {"room": "c"}], "reason": "the player stopped looking here"}, monkeypatch)
    assert st["done"][0][2] is True and any("ended early" in n for n in st["notes"])


# ── ORW-1136: the narrated setting against the engine room ───────────────────────────────────────────────────────────────────────────
_STORAGE = {"whereabouts": {"room": "storage-room"}}


@pytest.mark.parametrize("sentence", [
    "Four of you crowd together in a bedroom that smells of lavender.",
    "Everyone settles in the bedroom, the lamp low.",
    "Dana lowers her voice inside this bedroom.",
])
def test_a_setting_written_as_a_bedroom_in_a_storage_room_is_held(monkeypatch, sentence):
    monkeypatch.setattr(pd, "_fresh_state", lambda owner: (_STORAGE, False))
    got = pd.split_at_first_conflict("Dana looks up. " + sentence, "o1136")
    assert got is not None and [c.fact for c in got.conflicts] == [pd.FACT_PLAYER_ROOM] and got.conflicts[0].detail == "the storage room"


@pytest.mark.parametrize("sentence", [
    "Dana walks down the hall toward the bedroom.",
    "You hear laughter from the bedroom.",
    "She slept in the bedroom last night.",
    "Dana was in the bedroom earlier.",
    "Four of you crowd together among the shelves of the storage room.",
    'Dana says, "We could talk in the bedroom."',
])
def test_a_bedroom_that_is_somewhere_else_or_another_time_is_left_alone(monkeypatch, sentence):
    monkeypatch.setattr(pd, "_fresh_state", lambda owner: (_STORAGE, False))
    assert pd.split_at_first_conflict(sentence, "o1136") is None


def test_in_a_real_bedroom_the_word_is_fine(monkeypatch):
    monkeypatch.setattr(pd, "_fresh_state", lambda owner: ({"whereabouts": {"room": "bedroom-c"}}, False))
    assert pd.split_at_first_conflict("Four of you crowd together in the bedroom.", "o1136") is None


# ── ORW-1137: an alliance needs the player's own yes ───────────────────────────────────────────────────────────────────────────────────
ROSTER = [{"id": f"npc:{n}", "name": f"Houseguest {n}"} for n in (1, 9, 10)]


class _Env:
    def __init__(self, monkeypatch):
        self.writes = []
        monkeypatch.setattr(oe, "_RETRY_ATTEMPTS", 0)

        async def whereabouts(user=None):
            return {"room": "kitchen", "present": [{"id": h["id"]} for h in ROSTER]}

        async def state(owner=None, **k):
            return {"asleep": [], "pending": None}

        async def backfill(owner, fn, *args, **kw):
            self.writes.append(kw)
            return {"ok": True}

        monkeypatch.setattr(oe, "whereabouts", whereabouts)
        monkeypatch.setattr(oe, "get_game_state", state)
        monkeypatch.setattr(al, "_backfill_with_cas", backfill)
        monkeypatch.setattr(al, "_note_belt", lambda owner, belt, n=1: None)

    def record(self, said, kind="alliance"):
        obj = {"withIds": ["npc:10", "npc:9"], "kind": kind, "content": "The houseguests agreed to work together.", "feltMinutes": 60,
               "consequence": {"edges": [{"toward": "npc:10", "direction": "more-aligned", "emphasis": "notable"}, {"toward": "npc:9", "direction": "more-aligned", "emphasis": "notable"}]}}
        return asyncio.get_event_loop_policy().get_event_loop().run_until_complete(al._auto_record_scene("They all nod together.", said, ROSTER, "http://x", "m", {}, "o", raw=json.dumps(obj)))


YES = ["Yes, I'm in.", "Count me in.", "I'm in, let's do it.", "Okay, I accept. We're an alliance.", "Deal.", "Sign me up."]
NOT_YES = [
    "Where are we meeting later?",                                            # a question, before any answer (fold 03:34:38 shape)
    "Interesting. Tell me more about who else is in.",                         # no answer yet
    "I think exclusive groups are unwise this early, the house needs numbers.",  # argued against (fold 03:47:59 shape)
    "I'm not sure yet, let me think about it.",
    "No, I'd rather keep it open.",
    "Are we really doing this? Am I in?",
    "I'm in the kitchen if you want me.",                                       # 'in' alone is not a yes... the phrase needs a join word
]


@pytest.mark.parametrize("said", YES)
def test_the_players_own_yes_is_a_yes(said):
    assert al._player_says_yes_to_binding(said) is True


@pytest.mark.parametrize("said", NOT_YES)
def test_no_yes_in_the_players_own_words_is_not_a_yes(said):
    assert al._player_says_yes_to_binding(said) is False


@pytest.mark.parametrize("said", NOT_YES)
def test_an_alliance_kind_without_the_players_yes_is_recorded_as_strategy_with_no_aligned_edges(monkeypatch, said):
    env = _Env(monkeypatch)
    assert env.record(said) is True
    assert env.writes[0]["kind"] == "strategy"
    assert [e for e in (env.writes[0].get("consequence") or {}).get("edges", []) if e.get("direction") == "more-aligned"] == []


@pytest.mark.parametrize("said", YES)
def test_the_players_own_yes_keeps_the_alliance(monkeypatch, said):
    env = _Env(monkeypatch)
    assert env.record(said) is True
    assert env.writes[0]["kind"] == "alliance" and len(env.writes[0]["consequence"]["edges"]) == 2


def test_other_kinds_are_untouched(monkeypatch):
    env = _Env(monkeypatch)
    assert env.record("I think exclusive groups are unwise.", kind="bonding") is True
    assert env.writes[0]["kind"] == "bonding"


# ── the replay corpus rows (also fed to the dev replay harness): tests/fixtures/orw1014/search_vs_question.json ─────────────────────────────
def test_the_replay_corpus_rows_agree_with_the_validator():
    import pathlib
    rows = json.loads((pathlib.Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "orw1014" / "search_vs_question.json").read_text())
    assert len(rows) >= 23 and any(r["cls"] == "prod-code" for r in rows)
    for r in rows:
        got = af.validate_calls([{"name": "search", "arguments": {"who": "Dana"}}], text=r["text"], rooms=ROOMS, ctx=r["ctx"])
        assert (got != []) == bool(r["exp"]), r["id"]
