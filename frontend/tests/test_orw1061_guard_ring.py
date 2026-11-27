"""ORW-1061 (audit 11-26 A6): every applied drop by an editing guard also lands in a bounded audit ring (guard, reason, user, sentences, chars, time), so a
guard's false positives can be sampled by turn and user. The sentence text is never kept. Roles only; no live model."""
import asyncio

from routes import chat_helpers as ch
from src import orwell_engine as oe
from src import orwell_sync_ledger as led


def _run(c):
    return asyncio.new_event_loop().run_until_complete(c)


def _fresh():
    led._GUARD_SAMPLES.clear()


def test_the_presence_wall_drop_is_sampled_without_its_text(monkeypatch):
    _fresh()

    async def gs(user=None):
        return {"whereabouts": {"room": "kitchen", "present": [{"id": "npc:1", "name": "Ava Ray"}], "nearby": []},
                "house": [{"name": "Ava Ray", "status": "active"}, {"name": "Ben Cole", "status": "active"}]}
    monkeypatch.setattr(oe, "get_game_state", gs)
    out = _run(ch.screen_presence_wall("u-ring", '@[Ben Cole] — "Hi there." Ben waves.\n\n@[Ava Ray] — "Morning."', carry={}))
    assert "Hi there" not in out
    rows = led.get_guard_samples()
    assert len(rows) == 1 and rows[0]["guard"] == "presence-wall" and rows[0]["reason"] == "phantom-placement" and rows[0]["sentences"] == 1 and rows[0]["chars"] > 0
    assert "Hi there" not in repr(rows) and "Ben" not in repr(rows), "no sentence text and no names in the ring"


def test_the_confession_guard_drop_is_sampled():
    _fresh()
    u = "u-ring-conf"
    ch._GAME_WAS_ACTIVE.add(u)
    oe.clear_disclosure_turn(u)
    out, ops = ch.screen_invented_confession(u, 'Dex pours coffee. Mara leans in. "I have never told anyone this. I did time in prison for fraud." Dex gasps.')
    assert ops
    rows = led.get_guard_samples()
    assert [(r["guard"], r["sentences"]) for r in rows] == [("invented-confession", len(ops))]
    assert "prison" not in repr(rows)


def test_the_ring_is_bounded_and_newest_last():
    _fresh()
    for i in range(led._GUARD_SAMPLES_MAX + 25):
        led.note_guard_sample("u", "presence-wall", "phantom-placement", 1, i)
    rows = led.get_guard_samples(led._GUARD_SAMPLES_MAX + 100)
    assert len(rows) == led._GUARD_SAMPLES_MAX and rows[-1]["chars"] == led._GUARD_SAMPLES_MAX + 24
    assert len(led.get_guard_samples(5)) == 5
    _fresh()
