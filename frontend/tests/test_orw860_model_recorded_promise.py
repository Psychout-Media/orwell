"""ORW-860: a casual promise typed on a turn the MODEL recorded itself is still written (the scene belt only ran when the model recorded nothing, and the model's own recordInteraction
seldom carries `assurance` / `promise`). Closed-set only; the promiser is always the player; the back-fill folds no relationship impact (no kind). Stubbed llm and engine, roles only."""
import asyncio
import importlib
import inspect
import json

al = importlib.import_module("src.agent_loop")
ag = importlib.import_module("src.agent_gates")
fl = importlib.import_module("src.fold_ledger")
oe = importlib.import_module("src.orwell_engine")
llm_core = importlib.import_module("src.llm_core")

HOUSE = [{"id": f"npc:{n}", "name": f"Houseguest {n}"} for n in range(1, 4)]


def _run(coro):
    return asyncio.run(coro)


def test_gate_fires_only_on_a_recorded_turn_whose_call_carried_no_promise():
    commits = lambda: True  # noqa: E731
    assert ag.want_promise_backfill(recorded=True, model_carried_promise=False, turn_promise_nudges=0, max_promise_nudges=1, player_message_commits=commits)
    assert not ag.want_promise_backfill(recorded=False, model_carried_promise=False, turn_promise_nudges=0, max_promise_nudges=1, player_message_commits=commits)  # the scene belt owns it
    assert not ag.want_promise_backfill(recorded=True, model_carried_promise=True, turn_promise_nudges=0, max_promise_nudges=1, player_message_commits=commits)
    assert not ag.want_promise_backfill(recorded=True, model_carried_promise=False, turn_promise_nudges=1, max_promise_nudges=1, player_message_commits=commits)
    assert not ag.want_promise_backfill(recorded=True, model_carried_promise=False, turn_promise_nudges=0, max_promise_nudges=1, player_message_commits=lambda: False)


def test_commit_prefilter_reads_the_players_own_typed_words():
    assert al._player_message_commits("You're safe with me this week, I promise.")
    assert al._player_message_commits("I won't put you up.")
    assert not al._player_message_commits("What do you think of the kitchen?")
    assert not al._player_message_commits("")
    assert not al._player_message_commits(None)


def test_model_carried_detection_reads_the_recordinteraction_args():
    ev = lambda cmd, code=0: {"tool": "recordInteraction", "command": json.dumps(cmd), "exit_code": code}  # noqa: E731
    assert not al._model_recorded_a_promise([ev({"content": "x", "withIds": ["npc:1"]})])
    assert al._model_recorded_a_promise([ev({"content": "x", "assurance": {"kind": "safe"}})])
    assert al._model_recorded_a_promise([ev({"content": "x", "promise": {"what": "no-nominate"}})])
    assert not al._model_recorded_a_promise([ev({"content": "x", "assurance": {"kind": "safe"}}, code=1)])  # a refused record wrote nothing
    assert not al._model_recorded_a_promise([{"tool": "advanceGame", "command": "{}"}])


def _stub(monkeypatch, reply, present=("npc:1", "npc:2")):
    async def fake_llm(**kw):
        fake_llm.seen = kw["messages"]
        return reply

    async def fake_wb(user=None):
        return {"present": [{"id": i} for i in present]}

    monkeypatch.setattr(llm_core, "llm_call_async", fake_llm)
    monkeypatch.setattr(oe, "whereabouts", fake_wb)
    fl._PENDING.clear()
    return fake_llm


def test_a_typed_casual_promise_is_staged_content_only_with_the_player_as_promiser(monkeypatch):
    _stub(monkeypatch, '{"withIds":["npc:1"],"assurance":{"kind":"safe","by":"npc:2"}}')
    ok = _run(al._auto_record_promise("You're safe with me this week.", HOUSE, "u", "m", {}, "owner", session_id="s"))
    assert ok is True
    q = fl._PENDING[fl._key("owner", "s")]
    assert len(q) == 1
    assert q[0]["assurance"] == {"kind": "safe"}  # a model-named `by` never reaches it: the words are the player's
    assert q[0]["kind"] is None and q[0]["consequence"] is None  # no relationship fold: the model's own scene already did that
    assert q[0]["with_ids"] == ["npc:1"] and q[0]["content"] == "You're safe with me this week."
    fl._PENDING.clear()


def test_a_typed_promise_term_is_staged_and_wins_over_the_assurance(monkeypatch):
    _stub(monkeypatch, '{"withIds":["npc:1"],"assurance":{"kind":"safe"},"promise":{"what":"no-nominate"}}')
    assert _run(al._auto_record_promise("I won't put you up.", HOUSE, "u", "m", {}, "owner", session_id="s"))
    q = fl._PENDING[fl._key("owner", "s")]
    assert q[0]["promise"] == {"what": "no-nominate"} and not q[0]["assurance"]
    fl._PENDING.clear()


def test_nothing_staged_when_no_promise_or_nobody_present_or_off_roster(monkeypatch):
    _stub(monkeypatch, '{"withIds":[]}')
    assert not _run(al._auto_record_promise("I promise nothing at all, honestly I'll see.", HOUSE, "u", "m", {}, "owner", session_id="s"))
    _stub(monkeypatch, '{"withIds":["npc:3"],"assurance":{"kind":"safe"}}', present=("npc:1",))
    assert not _run(al._auto_record_promise("You're safe with me.", HOUSE, "u", "m", {}, "owner", session_id="s"))  # npc:3 was not in the room
    _stub(monkeypatch, '{"withIds":["npc:1"],"assurance":{"kind":"bribe"}}')
    assert not _run(al._auto_record_promise("You're safe with me.", HOUSE, "u", "m", {}, "owner", session_id="s"))  # closed kind set
    assert fl._PENDING.get(fl._key("owner", "s")) in (None, [])
    fl._PENDING.clear()


def test_no_llm_call_without_commitment_words(monkeypatch):
    f = _stub(monkeypatch, '{"withIds":["npc:1"],"assurance":{"kind":"safe"}}')
    f.seen = None
    assert not _run(al._auto_record_promise("How was your day?", HOUSE, "u", "m", {}, "owner", session_id="s"))
    assert f.seen is None


def test_finishing_block_wires_the_backfill_with_success_gated_telemetry():
    src = inspect.getsource(al)
    assert "_gates.want_promise_backfill(recorded=_recorded" in src
    assert '_note_belt(owner, "auto-record-promise")' in src
    assert "_turn_promise_nudges = 0" in src
