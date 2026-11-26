"""ORW-997 - the premiere toast circle: a released batch is committed BEFORE the reply, voiced once, and never handed to the narrator again on a no-advance turn; nothing upcoming is handed over.
Drives the real turn path (`note_premiere_turn` -> `maybe_release_premiere_arrival` -> the moment-prompt flag) turn by turn against a stubbed engine board. Roles only; invented labels; no model."""
import asyncio
import importlib

import pytest

ch = importlib.import_module("routes.chat_helpers")
al = importlib.import_module("src.agent_loop")
oe = importlib.import_module("src.orwell_engine")

USER = "u-orw997"
BATCHES = [["host", "Alpha Role"], ["Bravo Role", "Charlie Role"], ["Delta Role", "player"], ["Echo Role", "Foxtrot Role"]]
ALL_PEOPLE = [x for b in BATCHES for x in b if x not in ("host", "player")]


class Board:
    """The engine's toast: `idx` batches released; one more advance closes the circle."""

    def __init__(self):
        self.idx = 0
        self.advances = 0

    def state(self):
        if self.idx > len(BATCHES):
            return {"phase": "premiere", "pending": None, "premiere": {"entrance": {"stage": "done", "index": 16, "total": 16, "arrivedNames": ALL_PEOPLE}}}
        ent = {"stage": "toast", "index": 16, "total": 16, "playerPosition": 4, "arrivedNames": ALL_PEOPLE}
        if self.idx:
            ent["speakers"] = [{"name": "The host", "host": True} if x == "host" else ({"id": "me", "name": "Player", "isPlayer": True} if x == "player" else {"id": x, "name": x}) for x in BATCHES[self.idx - 1]]
            ent["toastRemaining"] = len([x for b in BATCHES[self.idx:] for x in b if x != "host"])
        return {"phase": "premiere", "pending": None, "premiere": {"entrance": ent}}

    def released(self):
        return {x for b in BATCHES[:self.idx] for x in b if x not in ("host", "player")}


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    stores = [ch._ARRIVALS_NAMED, ch._ARRIVALS_FRAMED, ch._ARRIVAL_VOICE_HOLDS, ch._SCHEDULE_STEER, ch._CEREMONY_UNVOICED, ch._PREMIERE_ENTRANCE_STAGE, ch._PRE_RESOLVED_ADVANCE,
              al._TURNS_SINCE_PROGRESS, ch._PREMIERE_RELEASED_THIS_TURN, ch._TOAST_BATCH_NAMED, ch._PREMIERE_TOAST_SPEAKERS, ch._ENTRANCE_FRAMES, oe._ENTRANCE_VOICED]
    for d in stores:
        d.clear()
    yield
    for d in stores:
        d.clear()


def _wire(monkeypatch, board):
    async def advance_game(**kw):
        board.idx += 1
        board.advances += 1
        return {"event": {"beat": "premiere-toast"}}

    async def fetch(user, retry=False):
        return board.state()

    monkeypatch.setattr(oe, "advance_game", advance_game)
    monkeypatch.setattr(ch, "_fetch_game_state", fetch)


def _turn(board, msg, narrate=True):
    """One framed player turn. Returns (names handed to the narrator as a fresh batch, whether the prompt is told the batch was voiced)."""
    ch._PRE_RESOLVED_ADVANCE.clear()  # the end-of-turn backstop consumes the mark every turn
    s = board.state()
    ch.note_premiere_turn(USER, s)
    out = asyncio.run(ch.maybe_release_premiere_arrival(USER, s, retry=False, player_msg=msg))
    voiced = bool(oe._ENTRANCE_VOICED.get(USER))
    ent = out["premiere"]["entrance"]
    handed = [] if voiced else [x["name"] for x in (ent.get("speakers") or []) if not x.get("host") and not x.get("isPlayer")]
    if narrate and not voiced and ent.get("speakers"):
        ch.note_premiere_narration(USER, "The host calls it. " + " ".join(handed))
    return handed, voiced


def test_one_next_per_batch_plays_every_toast_once_in_order_and_nothing_is_voiced_before_its_commit(monkeypatch):
    board = Board()
    _wire(monkeypatch, board)
    heard = []
    for _ in range(len(BATCHES)):
        before = board.released()
        handed, voiced = _turn(board, "next")
        assert not voiced
        assert set(handed) <= board.released(), "only committed speakers are ever handed over"
        assert not (set(handed) & before), "a speaker already voiced is never handed over again"
        heard += handed
    assert heard == ALL_PEOPLE, "every houseguest toasts exactly once, in order"
    assert board.advances == len(BATCHES), "one committed batch per turn, before the reply"
    _turn(board, "next")  # the closing advance
    assert board.state()["premiere"]["entrance"]["stage"] == "done"


def test_a_no_advance_turn_hands_the_narrator_nothing_to_re_voice(monkeypatch):
    board = Board()
    _wire(monkeypatch, board)
    _turn(board, "next")
    _turn(board, "next")
    adv = board.advances
    for msg in ("what is she like", "is that everyone", "tell me more"):
        handed, voiced = _turn(board, msg)
        assert voiced and handed == [], "the batch on the board was voiced: it is marked so, and no speaker is handed over"
    assert board.advances == adv, "a non-cue turn commits nothing"
    assert board.released() == {"Alpha Role", "Bravo Role", "Charlie Role"}


def test_a_batch_the_reply_never_named_is_handed_again_once_then_given_up(monkeypatch):
    board = Board()
    _wire(monkeypatch, board)
    _turn(board, "next", narrate=False)  # batch 1 released, the reply never names it
    handed, voiced = _turn(board, "next", narrate=False)  # batch 1 not named: not resolved, no release
    assert board.idx == 1 and not voiced and handed == ["Alpha Role"], "an unvoiced batch is owed again"
    handed, voiced = _turn(board, "next", narrate=False)  # handed twice: given up, so the next one is released
    assert board.idx == 2 and not voiced


def test_the_moment_prompt_call_carries_the_flag(monkeypatch):
    seen = []

    async def fake_call(name, args, **kw):
        seen.append((name, dict(args)))
        return {"systemPrompt": "p"}

    monkeypatch.setattr(oe, "_call", fake_call)
    asyncio.run(oe.get_moment_prompt(user=USER))
    assert "entranceVoiced" not in seen[-1][1]
    oe.set_entrance_voiced(USER, True)
    asyncio.run(oe.get_moment_prompt(user=USER))
    assert seen[-1][1].get("entranceVoiced") is True
