"""ORW-997 - the premiere toast circle: a released batch is committed BEFORE the reply, voiced once, and never handed to the narrator again on a no-advance turn; nothing upcoming is handed over.
Drives the real turn path (`note_premiere_turn` -> `maybe_release_premiere_arrival` -> the moment-prompt flag) turn by turn against a stubbed engine board. Roles only; invented labels; no model."""
import asyncio
import importlib

import pytest

ch = importlib.import_module("routes.chat_helpers")
al = importlib.import_module("src.agent_loop")
oe = importlib.import_module("src.orwell_engine")

USER = "u-orw997"
NAMES = [f"Guest{chr(65 + i)} Role{chr(65 + i)}" for i in range(15)]
ITEMS = ["host"] + NAMES[:7] + ["player"] + NAMES[7:]  # the engine's toast list: two per batch, the player's slot among them
BATCH = 2


class Board:
    """The engine's toast: `spoke` items released so far; one more advance after the last closes the circle."""

    def __init__(self):
        self.spoke = 0
        self.last = 0
        self.advances = 0
        self.closed = False

    def advance(self, k=1):
        self.advances += 1
        if self.spoke >= len(ITEMS):
            self.closed = True
            return
        n = min(len(ITEMS) - self.spoke, BATCH * max(1, k))
        self.spoke += n
        self.last = n

    def state(self):
        if self.closed:
            return {"phase": "premiere", "pending": None, "premiere": {"entrance": {"stage": "done", "index": 16, "total": 16, "arrivedNames": NAMES}}}
        ent = {"stage": "toast", "index": 16, "total": 16, "playerPosition": 4, "arrivedNames": NAMES}
        if self.spoke:
            rel = ITEMS[self.spoke - self.last:self.spoke]
            ent["speakers"] = [{"name": "The host", "host": True} if x == "host" else ({"id": "me", "name": "Player", "isPlayer": True} if x == "player" else {"id": x, "name": x}) for x in rel]
            ent["toastRemaining"] = len([x for x in ITEMS[self.spoke:] if x != "host"])
        return {"phase": "premiere", "pending": None, "premiere": {"entrance": ent}}

    def released(self):
        return {x for x in ITEMS[:self.spoke] if x not in ("host", "player")}


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
        board.advance(kw.get("toast_batches") or 1)
        return {"event": {"beat": "premiere-toast"}}

    async def fetch(user, retry=False):
        return board.state()

    monkeypatch.setattr(oe, "advance_game", advance_game)
    monkeypatch.setattr(ch, "_fetch_game_state", fetch)
    ch._ARRIVALS_NAMED[ch._runway_key(USER)] = set(NAMES)  # ORW-1140: the entrances were voiced before the circle (this board starts at the toast)


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


def test_one_next_plays_several_batches_and_the_whole_circle_in_a_few_turns_each_toast_once_in_order(monkeypatch):
    board = Board()
    _wire(monkeypatch, board)
    heard = []
    turns = 0
    while not board.closed and turns < 10:
        before = board.released()
        handed, voiced = _turn(board, "next")
        turns += 1
        assert not voiced
        assert set(handed) <= board.released(), "only committed speakers are ever handed over"
        assert not (set(handed) & before), "a speaker already voiced is never handed over again"
        heard += handed
    assert board.closed
    assert heard == NAMES, "every houseguest toasts exactly once, in order"
    assert turns <= 4, "a Continue plays several batches, not one speaker per message"
    assert board.advances == turns, "one commit per turn, before the reply"


def test_a_no_advance_turn_hands_the_narrator_nothing_to_re_voice(monkeypatch):
    board = Board()
    _wire(monkeypatch, board)
    _turn(board, "next")
    adv = board.advances
    for msg in ("what is she like", "is that everyone", "tell me more"):
        ch.mark_pre_resolved_advance(USER)  # something else already advanced this turn: the release stands down
        s = board.state()
        ch.note_premiere_turn(USER, s)
        asyncio.run(ch.maybe_release_premiere_arrival(USER, s, retry=False, player_msg=msg))
        assert oe._ENTRANCE_VOICED.get(USER) is True, "the batch on the board was voiced: the prompt is told so, and no speaker is handed over"
    assert board.advances == adv, "a turn that does not advance commits nothing"


def test_the_players_own_message_gets_one_batch_and_the_order_to_act_in_the_same_reply(monkeypatch):
    board = Board()
    _wire(monkeypatch, board)
    handed, voiced = _turn(board, "let us look around the rooms")
    assert board.spoke == BATCH and not voiced and handed == NAMES[:1]  # the host plus one houseguest: one batch, the circle keeps flowing
    steer = ch._SCHEDULE_STEER.get(ch._runway_key(USER)) or ""
    assert "OWN MESSAGE COMES FIRST" in steer and "never repeat it" in steer
    ch._SCHEDULE_STEER.clear()
    _turn(board, "next")
    assert "OWN MESSAGE COMES FIRST" not in (ch._SCHEDULE_STEER.get(ch._runway_key(USER)) or ""), "an explicit next carries no player action"


def test_a_batch_the_reply_never_named_is_handed_again_once_then_given_up(monkeypatch):
    board = Board()
    _wire(monkeypatch, board)
    _turn(board, "next", narrate=False)  # a release, the reply never names it
    first = board.spoke
    handed, voiced = _turn(board, "next", narrate=False)  # not named: not resolved, no release, handed again
    assert board.spoke == first and not voiced and handed, "an unvoiced release is owed again"
    handed, voiced = _turn(board, "next", narrate=False)  # handed twice: given up, so the next release goes out
    assert board.spoke > first and not voiced


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
