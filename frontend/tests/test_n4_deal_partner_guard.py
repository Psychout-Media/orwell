"""N-4 — makeDeal partner/term guard: a wrong partner (the player's words name a different houseguest)
is REFUSED before the engine call; a term the player never spoke is dropped."""
import asyncio
import importlib
import json

importlib.import_module("src.agent_tools")
import src.orwell_engine as oe  # noqa: E402
import src.tool_implementations as ti  # noqa: E402

ROSTER = [
    {"id": "npc:12", "name": "Alpha Quill", "status": "active"},
    {"id": "npc:13", "name": "Bravo Stone", "status": "active"},
]


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


_TOKENS = []


def request_cleanup(tok):
    _TOKENS.append(tok)


@__import__('pytest').fixture(autouse=True)
def _reset_turn_text():
    yield
    while _TOKENS:
        ti.PLAYER_TURN_TEXT.reset(_TOKENS.pop())


PRESENT = {"id": "npc:13", "name": "Bravo Stone"}


def _setup(monkeypatch, text):
    calls = []

    async def _fake(with_id, kind, terms, leverage=None, traded_secret=None, user=None, **kw):
        calls.append((with_id, kw))
        return {"id": "deal:1"}

    async def _gs(user=None, timeout=None):
        return {"house": ROSTER}

    async def _wa(user=None):
        return {"room": "kitchen", "present": [PRESENT]}

    monkeypatch.setattr(oe, "whereabouts", _wa)

    monkeypatch.setattr(oe, "make_deal", _fake)
    monkeypatch.setattr(oe, "get_game_state", _gs)
    tok = ti.PLAYER_TURN_TEXT.set(text)
    request_cleanup(tok)
    return calls


def _deal(with_id, **extra):
    return _run(ti.do_make_deal(json.dumps({"with": with_id, "kind": "safety", "terms": "t", **extra}), owner="u"))


def test_wrong_partner_refused_and_engine_not_called(monkeypatch):
    calls = _setup(monkeypatch, "Bravo, deal? I keep you safe, you keep me safe.")
    res = _deal("npc:12")
    assert res["exit_code"] == 1 and "makeDeal refused" in res["error"]
    assert "Bravo Stone" in res["error"] and "Alpha Quill" in res["error"]
    assert calls == []


def test_matching_partner_passes(monkeypatch):
    calls = _setup(monkeypatch, "Bravo, deal? I keep you safe.")
    assert _deal("npc:13")["exit_code"] == 0
    assert calls[0][0] == "npc:13"


def test_unnamed_partner_not_in_scene_is_refused(monkeypatch):
    """The A-14 shape: the player names no one; one houseguest is present, the model passes an absent one."""
    calls = _setup(monkeypatch, "deal? you keep me safe, I keep you safe")
    res = _deal("npc:12")
    assert res["exit_code"] == 1 and "makeDeal refused" in res["error"]
    assert "Alpha Quill" in res["error"] and "Bravo Stone" in res["error"]
    assert calls == []


def test_unnamed_partner_in_scene_passes(monkeypatch):
    calls = _setup(monkeypatch, "deal? you keep me safe, I keep you safe")
    assert _deal("npc:13")["exit_code"] == 0
    assert calls[0][0] == "npc:13"


def test_unreadable_presence_fails_open(monkeypatch):
    calls = _setup(monkeypatch, "deal? handshake on it")

    async def _boom(user=None):
        raise RuntimeError("down")

    monkeypatch.setattr(oe, "whereabouts", _boom)
    assert _deal("npc:12")["exit_code"] == 0
    assert calls and calls[0][0] == "npc:12"


def test_unspoken_term_is_dropped(monkeypatch):
    calls = _setup(monkeypatch, "Bravo, deal. No fine print, just a handshake.")
    _deal("npc:13", term={"weeks": 1})
    assert "term" not in calls[0][1]


def test_spoken_term_is_forwarded(monkeypatch):
    calls = _setup(monkeypatch, "Bravo, we're safe with each other for two weeks.")
    _deal("npc:13", term={"weeks": 2})
    assert calls[0][1]["term"] == {"weeks": 2}
