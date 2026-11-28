"""ORW-1149: an UNNAMED narrated exit ("She slips out into the hall...") must move the houseguest who
actually left, not a guessed speaker; a move the engine refuses is re-grounded, never silently contradicted.
SYNC tests (run_until_complete)."""
import asyncio
import importlib

al = importlib.import_module("src.agent_loop")
orwell_engine = importlib.import_module("src.orwell_engine")
llm_core = importlib.import_module("src.llm_core")
ch = importlib.import_module("routes.chat_helpers")

_HOUSE = [{"id": "npc:1", "name": "Ava Bunn"}, {"id": "npc:2", "name": "Jace Herndon"},
          {"id": "npc:3", "name": "Valerie Houle"}]
_NARR = (
    '@[Ava Bunn] — "Anybody who\'s here to be on television."\n\n'
    '@[Jace Herndon] — "They get real quiet when it turns."\n\n'
    "She slips out into the hall with her toiletry bag, and the room goes quiet.\n\n"
    '@[Ava Bunn] — "She\'s right, though."'
)


def _run(c):
    return asyncio.get_event_loop().run_until_complete(c)


def _wire(monkeypatch, extraction, calls, status="moved"):
    async def fake_llm(*a, **k):
        return extraction

    async def fake_move(hid, room, user=None):
        calls.append((hid, room))
        return {"status": status, "whereabouts": {"room": room, "present": [], "nearby": []}}

    async def fake_wa(user=None):
        return {"room": "bedroom-c", "present": [{"id": h["id"]} for h in _HOUSE], "nearby": []}

    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    monkeypatch.setattr(orwell_engine, "move_houseguest", fake_move)
    monkeypatch.setattr(orwell_engine, "whereabouts", fake_wa)


def test_unnamed_exit_moves_the_one_who_left_not_a_speaker(monkeypatch):
    calls = []
    _wire(monkeypatch, '{"moves":[{"id":"npc:1","room":"hallway"}]}', calls)  # extractor guessed Ava
    out = _run(al._auto_move_npc(_NARR, "x", _HOUSE, "u", "m", {}, "owner"))
    assert out == 1
    assert calls == [("npc:3", "hallway")]  # by elimination: Valerie


def test_speaker_after_exit_with_no_candidate_is_not_moved(monkeypatch):
    calls = []
    _wire(monkeypatch, '{"moves":[{"id":"npc:1","room":"hallway"}]}', calls)
    narr = _NARR + '\n\n@[Valerie Houle] — "Hm."'
    out = _run(al._auto_move_npc(narr, "x", _HOUSE, "u", "m", {}, "owner"))
    assert out == 0 and calls == []


def test_engine_refusal_enqueues_a_reground(monkeypatch):
    calls, q = [], []
    _wire(monkeypatch, '{"moves":[{"id":"npc:3","room":"hallway"}]}', calls, status="illegal")
    monkeypatch.setattr(ch, "_reground_enqueue", lambda key, d: q.append(d) or True)
    _run(al._auto_move_npc(_NARR, "x", _HOUSE, "u", "m", {}, "owner"))
    assert q and "Valerie Houle" in q[0]
