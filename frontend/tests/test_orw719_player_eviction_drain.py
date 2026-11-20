"""ORW-719: the voted-out PLAYER's night owes beats (the house's goodbyes, the exit interview) before any card exists. The post-turn drain walks them, bounded and
success-gated, and stops the moment a card is open. Stub engine, roles only."""
import asyncio
import importlib
import inspect

ch = importlib.import_module("routes.chat_helpers")
oe = importlib.import_module("src.orwell_engine")
led = importlib.import_module("src.orwell_sync_ledger")


class Engine:
    """A stub engine: the player is the evictee; `owed` advances precede the exit-interview card."""
    def __init__(self, owed, move=True):
        self.owed, self.move, self.seq, self.calls = owed, move, 100, 0

    def state(self):
        card = {"kind": "exit-interview"} if self.owed == 0 else None
        return {"beatSeq": self.seq, "pending": card, "eviction": {"stage": "goodbye", "evictee": {"id": "player", "name": "P"}}}

    async def get_game_state(self, user=None, timeout=None):
        return self.state()

    async def advance_game(self, expected_beat_seq=None, idempotency_key=None, user=None):
        self.calls += 1
        if self.move and self.owed > 0:
            self.owed -= 1
            self.seq += 1
        return {"beatSeq": self.seq, "event": {"beat": "eviction-goodbye", "content": "a goodbye", "participants": [{"id": "npc:1", "name": "H"}]}}


def run(monkeypatch, eng):
    fires = []
    monkeypatch.setattr(oe, "get_game_state", eng.get_game_state)
    monkeypatch.setattr(oe, "advance_game", eng.advance_game)
    monkeypatch.setattr(led, "note_belt_fire", lambda user, belt, n=1: fires.append((belt, n)))
    return asyncio.run(ch.drain_player_eviction_to_card("u")), fires


def test_advances_until_the_exit_interview_card_is_up_then_stops(monkeypatch):
    eng = Engine(owed=3)
    moved, fires = run(monkeypatch, eng)
    assert moved == 3 and eng.owed == 0 and eng.state()["pending"]["kind"] == "exit-interview"
    assert fires == [("player-eviction-drain", 3)]


def test_idempotent_once_a_card_is_open(monkeypatch):
    eng = Engine(owed=0)
    moved, fires = run(monkeypatch, eng)
    assert (moved, eng.calls, fires) == (0, 0, [])


def test_success_gated_a_beat_that_does_not_move_is_no_fire_and_no_loop(monkeypatch):
    eng = Engine(owed=3, move=False)
    moved, fires = run(monkeypatch, eng)
    assert (moved, eng.calls, fires) == (0, 1, [])


def test_bounded_by_the_one_documented_constant(monkeypatch):
    eng = Engine(owed=10_000)
    moved, _ = run(monkeypatch, eng)
    assert moved == ch.EVICTED_PLAYER_DRAIN_MAX_ADVANCES == eng.calls


def test_only_the_players_own_eviction(monkeypatch):
    eng = Engine(owed=3)
    eng.state = lambda: {"beatSeq": 1, "pending": None, "eviction": {"stage": "goodbye", "evictee": {"id": "npc:2"}}}
    moved, fires = run(monkeypatch, eng)
    assert (moved, eng.calls, fires) == (0, 0, [])


def test_the_agent_loop_runs_it_before_the_surface_the_pending_belt():
    al = importlib.import_module("src.agent_loop")
    src = inspect.getsource(al)
    assert src.index("drain_player_eviction_to_card(owner)") < src.index("the SURFACE-THE-PENDING belt")
    assert "_evicted_drained or not (_turn_tool_names & _PROGRESSION_TOOLS)" in src
