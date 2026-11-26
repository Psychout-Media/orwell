"""ORW-750 (2) - a promise the narrator VOICES but the model never records must reach the engine's ledger, driven through the REAL
`stream_agent_loop` (the ORW-780 pattern for promises). Fable's week-1 playtest: six houseguests were voiced saying they would keep a nominee and
the engine held NO assurance for any of them, so ORW-723 (a kept promise binds the vote) had nothing to act on. The belt `_auto_promise` records
the omission through the existing typed-promise path on recordInteraction; the engine stand-in is STATEFUL (the ledger changes only when the
engine accepts, and it refuses the way the engine does), so no test sets the outcome by hand. Success-gated telemetry (`auto-promise` counts only a
promise the ledger GAINED), a refusal records nothing, a narration with no promise costs no model call, an already-recorded promise stands the belt
down, and the engine alone rolls sincerity (the belt never sends one). No model: the extraction call is a stub. Roles only.
"""
import asyncio
import json

import pytest

ROSTER = [{"id": "npc:1", "name": "Contestant Alpha", "status": "active"},
          {"id": "npc:2", "name": "Contestant Beta", "status": "active"},
          {"id": "npc:3", "name": "Contestant Gamma", "status": "active"}]
SCENE = 'Contestant Alpha leans in. "I promise you, I will vote to keep Contestant Beta. You have my word."'
QUIET = "Contestant Alpha shrugs and goes back to the dishes while the kettle ticks."
EXTRACT = '{"promises":[{"by":"npc:1","about":"npc:2","kind":"vote","line":"I will vote to keep Contestant Beta."}]}'


@pytest.fixture(autouse=True)
def _reset(monkeypatch):
    from src import agent_loop as al
    from routes import chat_helpers as ch
    for name in ("_SILENT_FORCE_ADVANCE_STREAK", "_ADVANCE_STALL_LEVEL", "_ADVANCE_STALL_FLAGS",
                 "_TURNS_SINCE_PROGRESS", "_ANTI_STALE_CAP_HOLDS", "_LOOP_STREAK"):
        d = getattr(al, name, None)
        if isinstance(d, dict):
            d.clear()
    al._forget_season_pacing("u")
    ch._forget_season_pacing("u")
    yield


def _drive(monkeypatch, *, scene=SCENE, extraction=EXTRACT, engine_accepts=True, ledger=()):
    from src import agent_loop as al
    import src.orwell_engine as oe
    import src.tool_index as ti
    import src.llm_core as lc

    monkeypatch.setenv("ORWELL_GAME_BUILD", "1")
    monkeypatch.setattr(al, "get_setting", lambda key, default=None: default)
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)
    monkeypatch.setattr(al, "_loop_break_streak_update", lambda *a, **k: False)

    engine = {"ledger": list(ledger), "calls": []}

    async def fake_state(*a, **k):
        return {"phase": "nominations", "moment": "social", "week": 1, "beatSeq": 1, "pending": None, "house": ROSTER, "started": True}

    async def fake_ledger(*a, **k):
        return [dict(e) for e in engine["ledger"]]

    async def fake_record(content, with_ids=None, initiator="player", kind=None, consequence=None, **k):
        engine["calls"].append({"content": content, "with": list(with_ids or []), "kind": kind, "promise": k.get("promise"), "assurance": k.get("assurance")})
        pr = k.get("promise")
        if engine_accepts and isinstance(pr, dict):  # the engine validates, then writes the open-ledger entry (and rolls sincerity itself)
            engine["ledger"].append({"id": f"ol:{len(engine['ledger']) + 1}", "text": content, "speaker": pr["from"], "parties": [pr["from"], "player"],
                                     "kind": "promise", **({"about": pr["subject"]} if pr.get("subject") else {})})
        return {"eventId": "evt:1"}

    async def fake_advance(*a, **k):
        return {"beatSeq": 2, "pending": None, "event": None}

    monkeypatch.setattr(oe, "get_game_state", fake_state)
    monkeypatch.setattr(oe, "open_ledger_here", fake_ledger)
    monkeypatch.setattr(oe, "record_interaction", fake_record)
    monkeypatch.setattr(oe, "advance_game", fake_advance)

    extractions = []

    async def fake_llm(*a, **k):
        sysmsg = " ".join(str(m.get("content")) for m in (k.get("messages") or []))
        if "voiced in this Big Brother scene about how they will vote" not in sysmsg:
            return ""
        extractions.append(k.get("call_class"))
        return extraction

    monkeypatch.setattr(lc, "llm_call_async", fake_llm)

    async def _no(*a, **k):
        return False

    for n in ("_auto_record_scene", "_auto_record_deal", "_auto_confide", "_auto_expose_secret", "_auto_trade_secret",
              "_auto_move_player", "_auto_move_npc", "_auto_answer_deal_offer", "_auto_alliance"):
        monkeypatch.setattr(al, n, _no)
    belts = []
    monkeypatch.setattr(al, "_note_belt", lambda owner, name, *a, **k: belts.append(name))

    async def fake_stream(candidates, messages, **kwargs):
        yield 'data: ' + json.dumps({"delta": scene}) + '\n\n'
        yield 'data: ' + json.dumps({"type": "finish", "reason": "stop"}) + '\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)

    async def drive():
        gen = al.stream_agent_loop(
            "https://api.deepseek.com/chat/completions", "deepseek-flash",
            [{"role": "system", "content": "You are the narrator."}, {"role": "user", "content": "I ask Alpha where they stand."}],
            max_rounds=3, game_mode="game", owner="u")
        async for _ in gen:
            pass

    asyncio.get_event_loop().run_until_complete(drive())
    return engine, belts, extractions


def test_a_voiced_vote_promise_is_recorded_through_the_typed_promise_path(monkeypatch):
    engine, belts, extractions = _drive(monkeypatch)
    assert len(extractions) == 1
    assert len(engine["calls"]) == 1
    call = engine["calls"][0]
    assert call["promise"] == {"what": "no-evict-vote", "from": "npc:1", "subject": "npc:2"}
    assert call["with"] == ["npc:1"] and call["kind"] is None, "a carrier record only: no relationship kind, so no fold of its own"
    assert call["content"] == "I will vote to keep Contestant Beta.", "the promiser's own words, never authored by the engine or the belt"
    assert [e["speaker"] for e in engine["ledger"]] == ["npc:1"]
    assert belts.count("auto-promise") == 1


def test_a_promise_to_the_player_carries_no_subject_and_no_sincerity(monkeypatch):
    engine, belts, _ = _drive(monkeypatch, extraction='{"promises":[{"by":"npc:3","about":"player","kind":"loyal","line":"I will not put you up."}]}')
    assert engine["calls"][0]["promise"] == {"what": "no-nominate", "from": "npc:3"}
    assert "sincerity" not in json.dumps(engine["calls"]), "the engine rolls sincerity; the belt never authors it"
    assert belts.count("auto-promise") == 1


def test_an_engine_refusal_records_nothing_and_is_not_counted(monkeypatch):
    engine, belts, _ = _drive(monkeypatch, engine_accepts=False)
    assert len(engine["calls"]) == 1 and engine["ledger"] == []
    assert "auto-promise" not in belts


def test_no_voiced_promise_costs_no_model_call(monkeypatch):
    engine, belts, extractions = _drive(monkeypatch, scene=QUIET)
    assert extractions == [] and engine["calls"] == [] and belts == []


def test_a_promise_the_ledger_already_holds_stands_the_belt_down(monkeypatch):
    held = {"id": "ol:1", "text": "x", "speaker": "npc:1", "parties": ["npc:1", "player"], "kind": "promise", "about": "npc:2"}
    engine, belts, _ = _drive(monkeypatch, ledger=(held,))
    assert engine["calls"] == [] and belts == []


def test_an_invented_id_or_a_promise_by_the_player_is_never_sent(monkeypatch):
    engine, belts, _ = _drive(monkeypatch, extraction='{"promises":[{"by":"npc:404","about":"npc:2","kind":"vote","line":"x"},'
                                                      '{"by":"player","about":"npc:2","kind":"vote","line":"y"},'
                                                      '{"by":"npc:1","about":"npc:404","kind":"vote","line":"z"},'
                                                      '{"by":"npc:1","about":"npc:2","kind":"safe","line":"w"}]}')
    assert engine["calls"] == [] and belts == []


def test_a_model_recorded_promise_for_that_houseguest_stands_the_belt_down():
    from src import agent_loop as al
    items = [{"by": "npc:1", "about": "npc:2", "kind": "vote", "line": "I will vote to keep Contestant Beta."}]
    assert al._validate_voiced_promises(items, {"npc:1", "npc:2"}, set(), None) != []
    assert al._validate_voiced_promises(items, {"npc:1", "npc:2"}, set(), {"npc:1"}) == []
    src = open(al.__file__).read()
    assert "_turn_promise_by.add(_by)" in src, "a model-driven recordInteraction with a promise or assurance fills the stand-down set"
