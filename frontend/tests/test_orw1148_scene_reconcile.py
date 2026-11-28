"""ORW-1148 (prod 2026-11-28 03:54-04:05Z): the player's scene disagrees with the board and the game loops, every reply re-grounding the narrator and the beat never moving.

The replay is the prod shape as codes, no player or narrator text: the engine has the player alone in bedroom-c and three houseguests (npc:1, npc:10, npc:15) in other rooms; the story and the
player have all three in the player's room, turn after turn. The stub narrator below does what the prod narrator did: while a RE-GROUND directive is pending it spends the turn re-grounding
and the beat does not advance; with no re-ground pending it plays on and advances the beat. It stages the three in the player's room every turn (that is the player's scene).
On main the loop never ends; with the fix the repeat is resolved through real engine moves (or explained once) and the beat advances within two turns."""
import asyncio
import importlib
import json

import pytest

ch = importlib.import_module("routes.chat_helpers")
sr = importlib.import_module("src.scene_reconcile")
oe = importlib.import_module("src.orwell_engine")

USER = "u-orw1148"
ROOM = "bedroom-c"
NAMES = {"npc:1": "Aaa Role", "npc:10": "Bbb Role", "npc:15": "Ccc Role"}
STORY = "Aaa Role sits on the bunk and nods. Bbb Role leans against the wall and grins. Ccc Role crosses her arms near the door."


class FakeEngine:
    def __init__(self, rooms, asleep=()):
        self.rooms = {"player": ROOM, **rooms}
        self.asleep = set(asleep)
        self.moves = []
        self.seq = 178

    def state(self):
        here = [{"id": i, "name": n} for i, n in NAMES.items() if self.rooms.get(i) == ROOM]
        return {"whereabouts": {"room": ROOM, "present": here, "nearby": []},
                "house": [{"id": i, "name": n, "status": "active"} for i, n in NAMES.items()],
                "asleep": [{"id": i, "name": NAMES[i]} for i in self.asleep]}

    async def get_game_state(self, user=None, **k):
        return self.state()

    async def move_houseguest(self, hid, room, user=None):
        self.moves.append((hid, room))
        if self.rooms.get(hid) == room:
            return {"status": "noop"}
        self.rooms[hid] = room
        self.seq += 1
        return {"status": "moved", "beatSeq": self.seq}


@pytest.fixture
def eng(monkeypatch):
    def make(rooms, asleep=()):
        e = FakeEngine(rooms, asleep)
        monkeypatch.setattr(oe, "get_game_state", e.get_game_state)
        monkeypatch.setattr(oe, "move_houseguest", e.move_houseguest)
        return e
    dk = ch._desync_key(USER)
    ch._DESYNC_REGROUND.pop(dk, None); ch._LAST_BEAT_SIG.pop(dk, None); sr.reset_all()
    yield make
    ch._DESYNC_REGROUND.pop(dk, None); ch._LAST_BEAT_SIG.pop(dk, None); sr.reset_all()


class Game:
    """One narrator turn per `turn()`: pre-turn drain of the re-ground queue, the story stages the three in the player's room, the wall and the post-turn check run."""
    def __init__(self):
        self.beat = 178
        self.dk = ch._desync_key(USER)
        self.voiced = []

    async def turn(self):
        self.dk = ch._desync_key(USER)
        ch._LAST_BEAT_SIG[self.dk] = {"room": ROOM}   # a fresh signature per turn, as the turn-start capture makes
        pending = ch._DESYNC_REGROUND.pop(self.dk, None)
        self.voiced.append(pending or "")
        shown = await ch.screen_presence_wall(USER, STORY)
        await ch.record_post_turn_presence_check(USER, STORY)
        if not (pending and "RE-GROUND" in pending):
            self.beat += 1   # nothing pinned the narrator back: the story moves
        return shown


def run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def play(game, n):
    return [run(game.turn()) for _ in range(n)]


def test_the_prod_shape_beat_advances_within_two_turns_after_the_bad_turn(eng):
    e = eng({"npc:1": "kitchen", "npc:10": "lounge", "npc:15": "bedroom-a"})
    g = Game()
    run(g.turn())               # 03:54Z: the bad turn; the board disagrees, the first sighting is re-grounded once
    start = g.beat
    play(g, 2)                  # two more turns
    assert g.beat > start, "the beat must advance within 2 turns of the disagreement standing"
    assert {e.rooms[i] for i in NAMES} == {ROOM}, "the three were walked over through real engine moves"
    assert sorted(m[0] for m in e.moves) == sorted(NAMES)


def test_each_fact_is_re_grounded_once_not_every_turn(eng):
    eng({"npc:1": "kitchen", "npc:10": "lounge", "npc:15": "bedroom-a"})
    g = Game()
    play(g, 5)
    plain = [v for v in g.voiced if "RE-GROUND ON WHO IS IN THE ROOM" in v]
    assert len(plain) == 1


def test_an_unreachable_person_is_explained_once_with_the_real_options(eng):
    e = eng({"npc:1": "kitchen", "npc:10": "lounge", "npc:15": "bedroom-a"}, asleep=["npc:15"])
    g = Game()
    start_beat = None
    for i in range(6):
        run(g.turn())
        if i == 0:
            start_beat = g.beat
    said = [v for v in g.voiced if "SAY THIS ONCE" in v]
    assert len(said) == 1 and "asleep" in said[0] and "walk over" in said[0] and "wait" in said[0]
    assert e.rooms["npc:15"] == "bedroom-a", "the sleeper is never teleported"
    assert e.rooms["npc:1"] == ROOM and e.rooms["npc:10"] == ROOM
    assert g.beat > start_beat
    assert sum("RE-GROUND ON WHO IS IN THE ROOM" in v for v in g.voiced) == 1


def test_a_one_turn_slip_that_does_not_repeat_moves_nobody(eng):
    e = eng({"npc:1": "kitchen", "npc:10": "lounge", "npc:15": "bedroom-a"})
    g = Game()
    run(g.turn())
    dk = ch._desync_key(USER)
    ch._LAST_BEAT_SIG[dk] = {"room": ROOM}
    run(ch.record_post_turn_presence_check(USER, "The room is quiet and nobody speaks."))   # the next turn is clean
    run(g.turn())
    assert e.moves == []


def test_too_far_is_not_walked(eng):
    assert sr.hops("bedroom-c", "hoh-room") == 4
    assert sr.hops("bedroom-c", "kitchen") == 3 and sr.hops("bedroom-a", ROOM) == 2


def test_the_walk_graph_is_the_engines_own():
    parsed = sr.parse_engine_adjacency()
    assert parsed is None or {k: tuple(v) for k, v in parsed.items()} == {k: tuple(v) for k, v in sr._FALLBACK_ADJACENCY.items()}


def test_ops_regroup_dry_run_then_apply_is_logged(eng, tmp_path, monkeypatch):
    e = eng({"npc:1": "kitchen", "npc:10": "lounge", "npc:15": "bedroom-a"})
    monkeypatch.setenv("ORWELL_OPS_LOG", str(tmp_path / "ops.jsonl"))
    dry = run(sr.regroup(USER, ROOM, ["npc:1", "Bbb Role", "npc:99"], oe, reason="orw-1148 test", apply=False))
    assert e.moves == [] and [p["result"] for p in dry["people"]] == ["would-move", "would-move", "unknown"]
    done = run(sr.regroup(USER, ROOM, ["npc:1", "Bbb Role"], oe, reason="orw-1148 test", apply=True))
    assert [p["result"] for p in done["people"]] == ["moved", "moved"] and e.rooms["npc:1"] == ROOM
    rows = [json.loads(x) for x in (tmp_path / "ops.jsonl").read_text().splitlines()]
    assert len(rows) == 2 and rows[1]["apply"] is True and rows[1]["reason"] == "orw-1148 test"
