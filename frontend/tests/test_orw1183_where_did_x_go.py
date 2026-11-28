"""ORW-1183 — "where did X go" reads the engine's whereabouts before the narrator answers, and the presence wall drops a verbless placement ("Jace by the crates") of ANY houseguest the engine has elsewhere,
not only the one the player named. Roles only; no model calls; no engine."""
import asyncio
import importlib

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
_USER = "u-orw1183"


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _async(value):
    async def _c(*a, **k):
        return value
    return _c()


@pytest.fixture(autouse=True)
def _clean():
    dkey = chat_helpers._desync_key(_USER)
    for k in (dkey, None, "default"):
        chat_helpers._LAST_BEAT_SIG.pop(k, None)
        chat_helpers._DESYNC_REGROUND.pop(k, None)
    yield


@pytest.mark.parametrize("msg", ["Where did Kai go?", "where'd Kai go", "Where did Kai Smith go?", "where has Kai gone", "Where Kai went?", "I wonder where did he go"])
def test_where_did_x_go_is_a_house_search(msg):
    assert chat_helpers._is_house_search(msg), msg


@pytest.mark.parametrize("msg", ["I go where Kai went to school", "Where do you want to go?", "I tell Kai where I went"])
def test_ordinary_lines_are_not_searches(msg):
    assert not chat_helpers._is_house_search(msg), msg


def test_where_did_x_go_answer_is_built_from_the_search_view():
    wa = {"search": {"houseguests": [{"name": "Kai Smith", "fact": "was last seen in the backyard", "status": "awake"}], "rooms": []}}
    out = chat_helpers._house_search_directive(wa, "Where did Kai go?")
    assert "Kai Smith: was last seen in the backyard" in out
    assert "answer it in your first sentence" in out
    plain = chat_helpers._house_search_directive(wa, "Where is Kai?")
    assert "answer it in your first sentence" not in plain


def test_wall_drops_a_verbless_placement_of_another_speaker(monkeypatch):
    from src import orwell_engine
    state = {"whereabouts": {"room": "landing", "present": [{"id": "npc:Dana", "name": "Dana"}], "nearby": []},
             "house": [{"name": n, "status": "active"} for n in ("Dana", "Jace", "Valerie", "Kai")]}
    monkeypatch.setattr(orwell_engine, "get_game_state", lambda user=None: _async(state))
    text = ("Dana waits at the rail. Jace by the crates, Valerie on the bench. "
            "Kai isn't on the landing. The stairs creak.")
    out = _run(chat_helpers.screen_presence_wall(_USER, text))
    assert "Jace" not in out and "Valerie" not in out
    assert "Dana waits at the rail" in out
    assert "Kai isn't on the landing" in out  # a negation places nobody
    assert "The stairs creak" in out
