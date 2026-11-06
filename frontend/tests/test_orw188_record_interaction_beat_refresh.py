"""ORW-188: a MODEL-driven recordInteraction commits in the engine (bumps beatSeq) and echoes the post-commit token; the FE must adopt it, or the next mutating call in the same turn
(advanceGame) carries a stale token, is refused with a stale-beat 409 and costs a reconcile round. Roles only. SYNC tests (run_until_complete)."""
import asyncio
import importlib
import json

ti = importlib.import_module("src.tool_implementations")
orwell_engine = importlib.import_module("src.orwell_engine")
ch = importlib.import_module("routes.chat_helpers")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


def test_record_interaction_tool_adopts_the_token(monkeypatch):
    ch._LAST_BEAT_SEQ.clear()
    ch._refresh_beat_seq("o1", {"beatSeq": 10})

    async def fake(text, user=None, **kw):
        return {"eventId": "e1", "beatSeq": 11}

    monkeypatch.setattr(orwell_engine, "record_interaction", fake)
    _run(ti.do_record_interaction('{"content":"a scene"}', owner="o1"))
    assert ch.last_beat_seq("o1") == 11


def test_record_interaction_then_advance_makes_no_stale_409(monkeypatch):
    """The live shape: recordInteraction (10 -> 11) then advanceGame in the same turn. The engine refuses an advance whose token is not the committed one."""
    ch._LAST_BEAT_SEQ.clear()
    ch._refresh_beat_seq("o2", {"beatSeq": 10})
    engine = {"seq": 10}
    advance_tokens = []
    stale_refusals = []

    async def fake_record(text, user=None, **kw):
        engine["seq"] += 1
        return {"eventId": "e1", "beatSeq": engine["seq"]}

    async def fake_advance(expected_beat_seq=None, idempotency_key=None, user=None):
        advance_tokens.append(expected_beat_seq)
        if expected_beat_seq is not None and expected_beat_seq != engine["seq"]:
            stale_refusals.append(expected_beat_seq)
            raise orwell_engine.EngineToolError(
                f"stale-beat (now {engine['seq']})", status=409, code="stale-beat", beat_seq=engine["seq"])
        engine["seq"] += 1
        return {"advanced": True, "beatSeq": engine["seq"]}

    monkeypatch.setattr(orwell_engine, "record_interaction", fake_record)
    monkeypatch.setattr(orwell_engine, "advance_game", fake_advance)
    _run(ti.do_record_interaction('{"content":"a scene"}', owner="o2"))
    out = _run(ti.do_advance_game("{}", owner="o2"))
    assert stale_refusals == [], "advanceGame carried a stale token after recordInteraction"
    assert advance_tokens == [11]
    assert out.get("exit_code") == 0 and json.loads(out["output"])["advanced"] is True
