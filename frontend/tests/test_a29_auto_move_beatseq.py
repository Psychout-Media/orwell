"""A29: an APPLIED auto-moved NPC commits in the engine (bumps beatSeq). The belt must ADOPT the post-commit beatSeq the engine returns, so the FE's last-seen token is not
left stale (which made the NEXT compare-and-swap call - the deferred scene-fold settle - a self-inflicted stale-beat 409: 7 in the P0d run). Roles only. SYNC tests (run_until_complete)."""
import asyncio
import importlib

al = importlib.import_module("src.agent_loop")
orwell_engine = importlib.import_module("src.orwell_engine")
llm_core = importlib.import_module("src.llm_core")
ch = importlib.import_module("routes.chat_helpers")

_HOUSE = [{"id": "npc:1", "name": "Houseguest One"}, {"id": "npc:2", "name": "Houseguest Two"}]


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def _wire(monkeypatch, extraction_json, results):
    seq = iter(results)

    async def fake_llm(*a, **k):
        return extraction_json

    async def fake_move(houseguest_id, room, user=None):
        return next(seq)

    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    monkeypatch.setattr(orwell_engine, "move_houseguest", fake_move)


def test_an_applied_move_adopts_the_returned_beat_seq(monkeypatch):
    ch._LAST_BEAT_SEQ.clear()
    ch._refresh_beat_seq("owner29", {"beatSeq": 10})
    _wire(monkeypatch, '{"moves":[{"id":"npc:1","room":"kitchen"}]}', [{"status": "moved", "whereabouts": {}, "beatSeq": 11}])
    out = _run(al._auto_move_npc("Houseguest One heads to the kitchen.", "I stay", _HOUSE, "url", "m", {}, "owner29"))
    assert out == 1
    assert ch.last_beat_seq("owner29") == 11, "the token must follow the engine's post-commit beatSeq"


def test_several_moves_end_on_the_last_token(monkeypatch):
    ch._LAST_BEAT_SEQ.clear()
    ch._refresh_beat_seq("owner29b", {"beatSeq": 10})
    _wire(monkeypatch, '{"moves":[{"id":"npc:1","room":"kitchen"},{"id":"npc:2","room":"backyard"}]}',
          [{"status": "moved", "whereabouts": {}, "beatSeq": 11}, {"status": "moved", "whereabouts": {}, "beatSeq": 12}])
    assert _run(al._auto_move_npc("Both walk out.", "I stay", _HOUSE, "url", "m", {}, "owner29b")) == 2
    assert ch.last_beat_seq("owner29b") == 12


def test_a_noop_move_leaves_the_token_alone(monkeypatch):
    ch._LAST_BEAT_SEQ.clear()
    ch._refresh_beat_seq("owner29c", {"beatSeq": 10})
    _wire(monkeypatch, '{"moves":[{"id":"npc:1","room":"kitchen"}]}', [{"status": "noop", "whereabouts": {}}])
    assert _run(al._auto_move_npc("Houseguest One is already there.", "I stay", _HOUSE, "url", "m", {}, "owner29c")) == 0
    assert ch.last_beat_seq("owner29c") == 10
