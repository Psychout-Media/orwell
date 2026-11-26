"""ORW-310 - the BEDTIME under-call belt. When the player clearly goes to bed and the board allows it, the
narrator under-called `turnIn` (premiere night: "I sleep." produced zero tool calls and the narrator narrated a
whole morning while the engine sat on Day 1 late-night). The FE error-corrects the OMISSION only: it FORCES the
`turnIn` call on the wire before narration (the #1154 family; rejecter models get the textual twin line), and a
pre-emission guard drops a narrated "morning has come" while the engine clock still reads night. Telemetry is
success-gated: a count means an APPLIED turnIn (never a bedtime-gate `held`, a no-op or an error).

Stubbed LLM, no network, no engine. Roles only.
"""
import asyncio
import json

import pytest

pytestmark = [pytest.mark.usefixtures("non_game_text_routing"), pytest.mark.usefixtures("zero_clocks_off")]

OR_URL = "https://openrouter.ai/api/v1/chat/completions"
GLM = "z-ai/glm-4.7"
DEEPSEEK = "deepseek/deepseek-v4-pro"

TURN_IN_FORCE = {"type": "function", "function": {"name": "turnIn"}}

# The three live phrasings that produced no tool call.
POSITIVES = [
    "I sleep.",
    "I walk down the hall to bedroom A, get into my bed, and fall asleep.",
    "Goodnight everyone. I'm done for the day - I turn in and sleep until morning.",
    "I'm going to bed.",
    "Okay, I'll go to sleep now.",
    "Time to call it a night, I'm heading to bed.",
    "I climb into bed and drift off... I fall asleep.",
    "Let's turn in for the night.",
]

# Talk ABOUT bed/sleep, not going to bed.
NEGATIVES = [
    "I can't sleep.",
    "She sleeps late every day.",
    "Do you want to go to bed?",
    "What time do you go to bed?",
    "I'm not going to bed yet.",
    "I'll go to bed after the competition.",
    "Marcus says he is going to bed.",
    "Nice bed.",
    "I look at the bed and sigh.",
    "I watch her fall asleep on the couch.",
    "If I go to bed now I will miss the party.",
    "I don't want to sleep.",
    "He told me a story about falling asleep in a pool.",
    "I turn in my vote to the HOH.",
    "Goodnight everyone.",
    "",
    "I never go to bed early.",
    "Maybe I'll sleep later.",
    # ORW-310b precision set (Coordinator 2026-11-12): the FE now ACTS for the player, so a false positive is worse than a miss.
    "I'm going to bed soon.",
    "Should I sleep?",
    "She went to bed.",
    "I'm not going to sleep.",
    "I'm going to bed tonight after the comp.",
    "He's going to bed.",
    "Would you go to bed now?",
]


@pytest.mark.parametrize("text", POSITIVES)
def test_clear_bedtime_declarations_are_detected(text):
    from src.agent_loop import _player_means_going_to_bed
    assert _player_means_going_to_bed(text) is True, text


@pytest.mark.parametrize("text", NEGATIVES)
def test_talk_about_bed_or_sleep_is_not_going_to_bed(text):
    from src.agent_loop import _player_means_going_to_bed
    assert _player_means_going_to_bed(text) is False, text


def test_ooc_aside_is_ignored():
    from src.agent_loop import _player_means_going_to_bed
    assert _player_means_going_to_bed("((I go to bed now)) What is everyone doing?") is False


# ── the pure gate ────────────────────────────────────────────────────────────────────────────────
_NIGHT = {"timeOfDay": "late-night", "pending": None, "started": True}


def _gate(text="I sleep.", fired=(), status=_NIGHT, tools=("turnIn", "advanceGame")):
    from src.agent_loop import _forced_tool_choice_for_bedtime
    return _forced_tool_choice_for_bedtime(set(fired), player_text=text, status=status, tools_sent=list(tools))


def test_gate_forces_turn_in_at_night_and_late_night():
    assert _gate() == TURN_IN_FORCE
    assert _gate(status={**_NIGHT, "timeOfDay": "night"}) == TURN_IN_FORCE


@pytest.mark.parametrize("tod", ["morning", "afternoon", "evening", ""])
def test_gate_stands_down_where_the_engine_would_hold(tod):
    # morning/afternoon (and the evening in message mode) are refused by the engine's bedtime gate; also covers
    # "already asleep" (after a turnIn the clock reads morning).
    assert _gate(status={**_NIGHT, "timeOfDay": tod}) is None


def test_gate_stands_down_with_a_pending_decision_open():
    assert _gate(status={**_NIGHT, "pending": {"kind": "comp-round"}}) is None


def test_gate_stands_down_before_the_game_starts_or_after_it_ends():
    assert _gate(status={**_NIGHT, "started": False}) is None
    assert _gate(status={**_NIGHT, "finished": True}) is None
    assert _gate(status=None) is None


def test_gate_stands_down_when_the_model_already_called_turn_in():
    assert _gate(fired={"turnIn"}) is None


def test_gate_requires_turn_in_on_the_wire():
    assert _gate(tools=("advanceGame",)) is None


def test_gate_ignores_non_bedtime_text():
    assert _gate(text="I can't sleep.") is None


def test_gate_kill_switch(monkeypatch):
    monkeypatch.setenv("ORWELL_FORCE_BEDTIME", "0")
    assert _gate() is None


# ── applied-result classification (the telemetry gate) ───────────────────────────────────────────
def _res(status_tod, **extra):
    return {"output": json.dumps({"status": {"timeOfDay": status_tod}, **extra}), "exit_code": 0}


def test_turn_in_applied_only_when_the_clock_left_the_night():
    from src.agent_loop import _turn_in_applied
    assert _turn_in_applied(_res("morning")) is True
    assert _turn_in_applied(_res("late-night")) is False                      # no-op
    assert _turn_in_applied(_res("morning", held={"next": "bedtime", "minutesUntil": 60})) is False
    assert _turn_in_applied({"error": "engine error", "exit_code": 1}) is False
    assert _turn_in_applied({"output": "not json", "exit_code": 0}) is False
    assert _turn_in_applied(None) is False


# ── the loop, driven for real with a stubbed model ───────────────────────────────────────────────
_LAST_CHUNKS: list = []  # ORW-395: the raw SSE chunks of the last _drive run


def _drive(monkeypatch, *, text, model=GLM, status=None, scripts=None, owner="orw310", turn_in_result=None,
           force_setting=True, max_rounds=3, system="narrator"):
    """Run stream_agent_loop with a scripted model. `scripts` = list of per-round dicts
    {"deltas": [...], "calls": [{"name","arguments"}]}. Returns (captures, belts, forced_outcomes, executed)."""
    from src import agent_loop as al
    from src import orwell_engine as oe
    from routes import chat_helpers as ch
    import src.tool_index as ti

    monkeypatch.delenv("ORWELL_GAME_BUILD", raising=False)
    real = al.get_setting
    monkeypatch.setattr(al, "get_setting",
                        lambda k, d=None: force_setting if k == "force_tool_choice_at_beats" else real(k, d))
    monkeypatch.setattr(ti, "get_tool_index", lambda: None)
    ch._LAST_FRAMED_BEAT_KEY.pop(owner, None)
    ch._LAST_FRAMED_REQUIRED_LEVER.pop(owner, None)

    async def fake_status(user=None):
        return dict(status if status is not None else _NIGHT)

    monkeypatch.setattr(oe, "game_status", fake_status)
    # The loop's OTHER engine reads (whereabouts, ...) have no engine behind them here: without this each one retried against a closed port with 0.5 s+ backoffs (~7 s per drive).
    monkeypatch.setattr(oe, "_RETRY_ATTEMPTS", 0)

    rounds: list = []
    scripts = list(scripts if scripts is not None else [{"deltas": ["ok"]}])

    async def fake_stream(candidates, messages, **kwargs):
        rounds.append({"tool_choice": kwargs.get("tool_choice"),
                       "tools": [t["function"]["name"] for t in (kwargs.get("tools") or [])],
                       "n_system": sum(1 for m in messages if m.get("role") == "system"),
                       "msgs": [dict(m) for m in messages]})
        sc = scripts.pop(0) if scripts else {"deltas": ["done"]}
        for d in sc.get("deltas", []):
            yield f'data: {json.dumps({"delta": d})}\n\n'
        if sc.get("calls"):
            yield f'data: {json.dumps({"type": "tool_calls", "calls": sc["calls"]})}\n\n'
        yield "data: [DONE]\n\n"

    monkeypatch.setattr(al, "stream_llm_with_fallback", fake_stream)

    async def _no_side_llm(*a, **k):  # the overseer / judge / extraction side calls would hit the unreachable test URL and wait out their timeouts (~7 s per drive)
        return ""

    import src.llm_core as _lc
    monkeypatch.setattr(_lc, "llm_call_async", _no_side_llm)

    executed: list = []

    async def fake_exec(block, **kw):
        executed.append(block.tool_type)
        return block.tool_type, (turn_in_result if turn_in_result is not None else {"output": "{}", "exit_code": 0})

    monkeypatch.setattr(al, "execute_tool_block", fake_exec)

    belts: dict = {}
    forced: list = []
    monkeypatch.setattr(al, "_note_belt", lambda o, b, n=1: belts.__setitem__(b, belts.get(b, 0) + n))
    monkeypatch.setattr(al, "_note_forced_choice", lambda o, t, honored: forced.append((t, honored)))

    async def go():
        out = []
        async for chunk in al.stream_agent_loop(
            OR_URL, model,
            [{"role": "system", "content": system}, {"role": "user", "content": text}],
            max_rounds=max_rounds, game_mode="game", owner=owner,
            pinned_tools={"turnIn", "advanceGame"},
        ):
            out.append(chunk)
        _LAST_CHUNKS[:] = out
        return out

    try:
        asyncio.get_event_loop().run_until_complete(go())
    finally:
        ch._LAST_FRAMED_BEAT_KEY.pop(owner, None)
    return rounds, belts, forced, executed


_TURN_IN_CALL = [{"name": "turnIn", "arguments": "{}"}]


@pytest.mark.parametrize("text", POSITIVES[:3])
def test_loop_forces_turn_in_for_each_live_phrasing(monkeypatch, text):
    rounds, belts, forced, executed = _drive(
        monkeypatch, text=text, scripts=[{"calls": _TURN_IN_CALL}, {"deltas": ["The house stirs."]}],
        turn_in_result=_res("morning"))
    assert rounds[0]["tool_choice"] == TURN_IN_FORCE, rounds[0]
    assert "turnIn" in rounds[0]["tools"]
    assert executed == ["turnIn"]
    # success-gated telemetry: an APPLIED turnIn counts
    assert belts.get("bedtime-turn-in") == 1
    assert belts.get("forced-tool-choice:turnIn") == 1
    assert ("turnIn", True) in forced
    # the force is spent: the narration round is NOT forced again
    assert rounds[1]["tool_choice"] is None


def test_held_turn_in_is_not_counted_as_a_belt_fire(monkeypatch):
    held = _res("late-night", held={"next": "bedtime", "minutesUntil": 30})
    rounds, belts, forced, executed = _drive(
        monkeypatch, text="I sleep.", scripts=[{"calls": _TURN_IN_CALL}, {"deltas": ["Not yet."]}],
        turn_in_result=held)
    assert executed == ["turnIn"]
    assert "bedtime-turn-in" not in belts and "forced-tool-choice:turnIn" not in belts
    assert ("turnIn", True) in forced           # the attempt-counted sibling still records that the model called it
    assert rounds[1]["tool_choice"] is None     # and the belt does not re-force


def test_ignored_force_counts_nothing_as_a_belt_fire(monkeypatch):
    rounds, belts, forced, executed = _drive(monkeypatch, text="I sleep.", scripts=[{"deltas": ["Zzz."]}])
    assert rounds[0]["tool_choice"] == TURN_IN_FORCE
    assert executed == []
    assert not any(k in belts for k in ("bedtime-turn-in", "forced-tool-choice:turnIn"))
    assert ("turnIn", False) in forced


def test_model_that_calls_turn_in_itself_gets_no_further_force_or_nudge(monkeypatch):
    # Round 2+ (turnIn already fired this turn): no force, no textual line.
    rounds, belts, forced, executed = _drive(
        monkeypatch, text="I sleep.",
        scripts=[{"calls": _TURN_IN_CALL}, {"deltas": ["Morning."]}, {"deltas": ["more"]}],
        turn_in_result=_res("morning"))
    assert [r["tool_choice"] for r in rounds[1:]] == [None] * (len(rounds) - 1)
    assert all(r["n_system"] == rounds[0]["n_system"] for r in rounds)


@pytest.mark.parametrize("text", ["I can't sleep.", "She sleeps late.", "Do you want to go to bed?", "Nice bed."])
def test_loop_never_forces_on_talk_about_bed(monkeypatch, text):
    rounds, belts, _, executed = _drive(monkeypatch, text=text)
    assert rounds[0]["tool_choice"] is None
    assert executed == [] and not belts


@pytest.mark.parametrize("tod", ["morning", "afternoon", "evening"])
def test_loop_never_forces_where_the_engine_would_hold(monkeypatch, tod):
    rounds, belts, _, _ = _drive(monkeypatch, text="I sleep.", status={**_NIGHT, "timeOfDay": tod})
    assert rounds[0]["tool_choice"] is None and belts == {"bedtime-held-note": 1}  # ORW-421: exactly the held note fires, once


def test_loop_never_forces_with_a_pending_decision(monkeypatch):
    rounds, belts, _, _ = _drive(monkeypatch, text="I sleep.", status={**_NIGHT, "pending": {"kind": "veto-use"}})
    assert rounds[0]["tool_choice"] is None and not belts


def test_loop_kill_switch_off(monkeypatch):
    rounds, _, _, _ = _drive(monkeypatch, text="I sleep.", force_setting=False)
    assert rounds[0]["tool_choice"] is None


@pytest.mark.parametrize("text", POSITIVES[:3])
def test_rejecter_model_has_the_players_turn_in_run_directly_before_narration(monkeypatch, text):
    # ORW-310b: deepseek-flash rejects tool_choice AND ignores the textual twin line (live check 2026-11-12), so the FE runs the player's own turnIn through the normal dispatcher.
    rounds, belts, _, executed = _drive(monkeypatch, text=text, model=DEEPSEEK, turn_in_result=_res("morning"))
    assert executed == ["turnIn"]                      # exactly once, via the dispatcher
    assert rounds[0]["tool_choice"] is None            # never a wire force for a rejecter
    assert rounds[0]["n_system"] == 3                  # the original system prompt + the production note that voices the result + the per-turn block (ORW-555: the datetime and per-turn tail ride after the history)
    assert belts.get("bedtime-turn-in") == 1 and belts.get("bedtime-turn-in-direct") == 1
    assert "forced-tool-fallback-line:turnIn" not in belts


def test_rejecter_held_turn_in_falls_back_to_the_textual_line_and_counts_nothing(monkeypatch):
    held = _res("late-night", held={"next": "bedtime", "minutesUntil": 30})
    rounds, belts, _, executed = _drive(monkeypatch, text="I sleep.", model=DEEPSEEK, turn_in_result=held)
    assert executed == ["turnIn"]                      # the engine decided: held
    assert "bedtime-turn-in" not in belts and "bedtime-turn-in-direct" not in belts
    assert belts.get("forced-tool-fallback-line:turnIn") == 1


# Loop-level (each case drives the whole agent loop, ~3 s): only the cases most likely to be mistaken for a bedtime. The full NEGATIVES list is pinned at the detector level above.
REJECTER_LOOP_NEGATIVES = ["I'm going to bed soon.", "Should I sleep?", "She went to bed.", "I'm not going to sleep.", "Goodnight everyone.", "I can't sleep."]


@pytest.mark.parametrize("text", REJECTER_LOOP_NEGATIVES)
def test_rejecter_never_runs_turn_in_for_talk_about_bed(monkeypatch, text):
    rounds, belts, _, executed = _drive(monkeypatch, text=text, model=DEEPSEEK, turn_in_result=_res("morning"))
    assert executed == [] and not belts


@pytest.mark.parametrize("tod", ["morning", "afternoon", "evening"])
def test_rejecter_never_runs_turn_in_where_the_engine_would_hold(monkeypatch, tod):
    rounds, belts, _, executed = _drive(monkeypatch, text="I sleep.", model=DEEPSEEK, status={**_NIGHT, "timeOfDay": tod}, turn_in_result=_res("morning"))
    assert executed == [] and belts == {"bedtime-held-note": 1}  # review of #2730: the held note must actually fire, once


def test_rejecter_never_runs_turn_in_with_a_pending_decision(monkeypatch):
    _, belts, _, executed = _drive(monkeypatch, text="I sleep.", model=DEEPSEEK, status={**_NIGHT, "pending": {"kind": "veto-use"}}, turn_in_result=_res("morning"))
    assert executed == [] and not belts


# ── part 2: the pre-emission unbacked-morning guard ──────────────────────────────────────────────
MORNING_PHANTOMS = [
    "The next morning comes and the house is quiet.",
    "Morning arrives with a clatter from the kitchen.",
    "It is the next morning.",
    "It's morning, and Marcus wakes you in the morning light.",
]
NOT_MORNING_CLAIMS = [
    "The hallway is dark and the house is asleep.",
    "She says she will see you in the morning.",
    "If morning comes, I'll make a run for the kitchen.",
    "You dream that morning arrives and the house is empty.",
    "Tomorrow morning the HOH comp begins.",
    "The morning light is a thing of the past.",
]


@pytest.mark.parametrize("text", MORNING_PHANTOMS)
def test_unbacked_morning_prefilter_catches_the_assertion(text):
    from routes.chat_helpers import _sentence_has_unbacked_morning_claim
    assert _sentence_has_unbacked_morning_claim(text), text


@pytest.mark.parametrize("text", NOT_MORNING_CLAIMS)
def test_unbacked_morning_prefilter_leaves_prose_alone(text):
    from routes.chat_helpers import _sentence_has_unbacked_morning_claim
    assert not _sentence_has_unbacked_morning_claim(text), text


def _screen(monkeypatch, sentence, tod, clock=None):
    from routes import chat_helpers as ch
    from src import orwell_engine as oe
    stashed: list = []

    async def fake_status(user=None):
        return {"timeOfDay": tod, "clockLabel": clock}

    monkeypatch.setattr(oe, "game_status", fake_status)
    monkeypatch.setattr(ch, "_stash_overclaim_reground", lambda u, d: stashed.append(d))
    ok = asyncio.get_event_loop().run_until_complete(ch.screen_streamed_unbacked_morning("u", sentence))
    return ok, stashed


@pytest.mark.parametrize("tod", ["evening", "night", "late-night"])
def test_screen_holds_a_morning_while_the_engine_clock_reads_night(monkeypatch, tod):
    ok, stashed = _screen(monkeypatch, "The next morning comes and the house wakes.", tod, "2:10am, Day 1")
    assert ok is False
    assert stashed and "turnIn" in stashed[0] and "2:10am, Day 1" in stashed[0]


def test_screen_emits_once_the_engine_really_moved_to_morning(monkeypatch):
    ok, stashed = _screen(monkeypatch, "The next morning comes and the house wakes.", "morning")
    assert ok is True and not stashed


def test_screen_fails_open(monkeypatch):
    from routes import chat_helpers as ch
    from src import orwell_engine as oe

    async def boom(user=None):
        raise RuntimeError("engine down")

    monkeypatch.setattr(oe, "game_status", boom)
    assert asyncio.get_event_loop().run_until_complete(
        ch.screen_streamed_unbacked_morning("u", "The next morning comes.")) is True


def test_pre_emission_guard_drops_only_the_phantom_morning(monkeypatch):
    from src import agent_loop as al
    from src import orwell_engine as oe
    from routes import chat_helpers as ch

    async def fake_status(user=None):
        return {"timeOfDay": "late-night", "clockLabel": "1:00am, Day 1"}

    monkeypatch.setattr(oe, "game_status", fake_status)
    monkeypatch.setattr(ch, "_stash_overclaim_reground", lambda u, d: None)
    text = "You pull the covers up. The next morning comes with a clatter. The hall is quiet."
    out = asyncio.get_event_loop().run_until_complete(al._pre_emission_outcome_guard(text, "u"))
    assert "next morning" not in out
    assert "You pull the covers up." in out and "The hall is quiet." in out


# ── ORW-405: the per-turn context is rebuilt from the post-turnIn board ──────────────────────────
_NIGHT_VOL = "\n- Week: 1\n- Phase: hoh\n- Time of day: night (engine truth)\n- With you: the houseguests in the room\n"
_MORNING_VOL = "\n- Week: 1\n- Phase: hoh\n- Time of day: morning (engine truth)\n- With you: nobody\n"


def _drive_405(monkeypatch, *, fresh_prompt=None):
    from src import agent_loop as al
    from src import orwell_engine as oe
    from routes import chat_helpers as ch
    owner = "orw405"
    ch._LAST_FRAMED_MOMENT_VOLATILE[owner] = _NIGHT_VOL
    sys0 = "GAME CONTEXT:\n- roster" + _NIGHT_VOL + "\nTOOLS. You run the game by calling tools."
    seen = []

    async def fake_mp(moment=None, user=None, timeout=None, brief=None):
        return {"systemPrompt": fresh_prompt if fresh_prompt is not None else "GAME CONTEXT:\n- roster" + _MORNING_VOL}

    monkeypatch.setattr(oe, "get_moment_prompt", fake_mp)
    out = {"output": json.dumps({"status": {"timeOfDay": "morning", "asleep": [{"id": "n1", "name": "Sleeper One"}, {"id": "n2", "name": "Sleeper Two"}]}}), "exit_code": 0}
    msgs = [{"role": "system", "content": sys0}]
    ok = asyncio.get_event_loop().run_until_complete(al._refresh_context_after_turn_in(msgs, owner, out["output"]))
    ch._LAST_FRAMED_MOMENT_VOLATILE.pop(owner, None)
    return ok, msgs, al._volatile_tail_wire(msgs)


def test_post_turn_in_context_has_no_stale_night_and_lists_the_asleep(monkeypatch):
    ok, msgs, wire = _drive_405(monkeypatch)
    blob = "\n".join(str(m["content"]) for m in wire)
    assert ok is True
    assert "Time of day: night" not in blob
    assert "Time of day: morning" in blob
    assert "Still asleep (2): Sleeper One, Sleeper Two" in blob


def test_post_turn_in_context_fails_open_when_the_fresh_prompt_is_unusable(monkeypatch):
    ok, msgs, _ = _drive_405(monkeypatch, fresh_prompt="no volatile block here")
    assert ok is False and "Time of day: night" in msgs[0]["content"]


def test_post_turn_in_context_kill_switch(monkeypatch):
    monkeypatch.setenv("ORWELL_POST_TURNIN_CONTEXT", "0")
    ok, msgs, _ = _drive_405(monkeypatch)
    assert ok is False and "Time of day: night" in msgs[0]["content"]

# ── ORW-395 (1): the belt's chip is its OWN round, above the morning narration ───────────────────
def _sse(chunks):
    out = []
    for c in chunks:
        if c.startswith("data: ") and not c.startswith("data: [DONE]"):
            try:
                out.append(json.loads(c[6:]))
            except ValueError:
                pass
    return out


def test_direct_turn_in_chip_is_its_own_round_before_the_narration(monkeypatch):
    # The renderer draws a round's text bubble first, then that round's tool rail: a chip sharing round 1 with the morning scene rendered BELOW it.
    _drive(monkeypatch, text="I sleep.", model=DEEPSEEK, turn_in_result=_res("morning"),
           scripts=[{"deltas": ["The house stirs."]}])
    evs = _sse(_LAST_CHUNKS)
    kinds = [e.get("type") or ("delta" if "delta" in e else "?") for e in evs]
    start = next(i for i, e in enumerate(evs) if e.get("type") == "tool_start" and e.get("tool") == "turnIn")
    step = next(i for i, e in enumerate(evs) if e.get("type") == "agent_step")
    first_text = next(i for i, e in enumerate(evs) if "delta" in e and e.get("type") is None)
    assert start < step < first_text, kinds                     # chip, then the round closes, then the narration
    assert evs[start]["round"] == 1 and evs[step]["round"] == 2


def test_undecodable_chunk_passthrough_follows_the_first_stream_round():
    """The belt is its own round, so the first narration round can be 2: the JSONDecodeError pass-through must compare against `_first_stream_round`, not a literal 1."""
    import inspect
    from src import agent_loop as al
    src = inspect.getsource(al)
    i = src.index("except json.JSONDecodeError:\n                    if round_num")
    assert "round_num == _first_stream_round" in src[i:i + 120]


# ── ORW-421: the HELD band (morning/afternoon/evening) gets a "too early to sleep" note ────────────────
import re as _re


def _held(text="Goodnight everyone. I'm going to bed.", fired=(), status=None):
    from src.agent_loop import _bedtime_held_note
    st = {**_NIGHT, "timeOfDay": "evening"} if status is None else status
    return _bedtime_held_note(set(fired), player_text=text, status=st)


@pytest.mark.parametrize("tod", ["evening", "afternoon", "morning"])
def test_held_note_in_the_held_band(tod):
    note = _held(status={**_NIGHT, "timeOfDay": tod})
    assert note and f"still the {tod}" in note and "do not call turnIn" in note


@pytest.mark.parametrize("tod", ["night", "late-night", ""])
def test_held_note_never_at_night(tod):
    assert _held(status={**_NIGHT, "timeOfDay": tod}) is None


def test_held_note_stands_down():
    assert _held(status={"timeOfDay": "evening", "started": True, "pending": {"kind": "veto-use"}}) is None
    assert _held(status={"timeOfDay": "evening", "started": False}) is None
    assert _held(fired={"turnIn"}) is None
    assert _held(text="I can't sleep.") is None
    assert _held(text="Goodnight everyone.") is None


def test_held_note_has_no_clock_time():
    note = _held()
    assert not _re.search(r"\d{1,2}\s*:\s*\d{2}|\b\d{1,2}\s*(?:am|pm)\b|\bminutes?\b|\bhours?\b", note, _re.I), note


def test_board_gate_unchanged_for_the_evening():
    from src.agent_loop import _bedtime_board_allows
    assert _bedtime_board_allows({**_NIGHT, "timeOfDay": "evening"}) is False


def test_loop_adds_the_held_note_once_for_an_evening_goodnight(monkeypatch):
    rounds, belts, _, executed = _drive(
        monkeypatch, text="Goodnight everyone. I'm going to bed.", status={**_NIGHT, "timeOfDay": "evening"},
        scripts=[{"deltas": ["Too wired to sleep."], "calls": [{"name": "advanceGame", "arguments": "{}"}]}, {"deltas": ["Still awake."]}])
    assert rounds[0]["tool_choice"] is None and executed == ["advanceGame"]
    assert len(rounds) == 2  # a SECOND model round ran (review of #2730), so "once per turn" is really tested
    assert rounds[0]["n_system"] == 3  # narrator + the ORW-421 note + the per-turn block (ORW-555)
    assert rounds[1]["n_system"] == 3  # still the one note: not added again (+ the ORW-555 per-turn block)
    assert belts == {"bedtime-held-note": 1}


def test_loop_no_held_note_at_night(monkeypatch):
    rounds, belts, _, _ = _drive(monkeypatch, text="I sleep.", scripts=[{"deltas": ["ok"]}])
    assert "bedtime-held-note" not in belts
    assert rounds[0]["n_system"] == 2  # the narrator context is unchanged: no held note was injected (review of #2730); the 2nd is the ORW-555 per-turn block


# ── ORW-437 (reviews of #2683 and #2664): the rejecter-model direct turnIn, driven through the loop, hands the NARRATOR the morning board and the recap ──
def test_direct_turn_in_narrator_gets_the_recap_first_and_the_morning_context(monkeypatch):
    from src import orwell_engine as oe
    from routes import chat_helpers as ch
    owner = "orw437"
    old_vol = "\n- Week: 1 (Day 1)\n- Time of day: night\n- House: everyone is up"
    new_vol = "\n- Week: 1 (Day 2)\n- Time of day: morning\n- House: waking"

    async def fake_mp(moment=None, user=None, timeout=None, brief=None):
        return {"systemPrompt": "GAME CONTEXT:\n- roster" + new_vol}

    monkeypatch.setattr(oe, "get_moment_prompt", fake_mp)
    ch._LAST_FRAMED_MOMENT_VOLATILE[owner] = old_vol
    out = {"output": json.dumps({"started": True, "status": {"timeOfDay": "morning", "asleep": [{"id": "n1", "name": "Sleeper One"}]},
                                  "dailyRecap": {"day": 1, "highlights": [], "surfaced": [], "yourDay": ["a toast"]}}), "exit_code": 0}
    try:
        rounds, belts, _, executed = _drive(monkeypatch, text="I sleep.", model=DEEPSEEK, turn_in_result=out, owner=owner,
                                            system="GAME CONTEXT:\n- roster" + old_vol + "\nTOOLS.", scripts=[{"deltas": ["The house stirs."]}])
    finally:
        ch._LAST_FRAMED_MOMENT_VOLATILE.pop(owner, None)
    assert executed == ["turnIn"]
    first = rounds[0]["msgs"]
    tool_msg = next(m for m in first if m.get("role") == "tool")
    assert tool_msg["content"].startswith('### turnIn\n```\n{"dailyRecap"')  # the recap leads the tool message (#2664)
    blob = "\n".join(str(m.get("content")) for m in first if m.get("role") == "system")
    assert "Time of day: night" not in blob and "Time of day: morning" in blob and "Still asleep (1): Sleeper One" in blob  # (#2683)
    assert belts.get("bedtime-context-rebuilt") == 1


# ── ORW-520: the engine held the bed / never committed a sleep, yet the narrator wrote the night and a morning. ──
UNCOMMITTED_SLEEP_CLAIMS = [
    "Production's voice cuts in: \"Good morning, houseguests.\"",
    "You slept through the whole afternoon.",
    "The light through the blinds has gone gray and then gold.",
]


@pytest.mark.parametrize("text", UNCOMMITTED_SLEEP_CLAIMS)
@pytest.mark.parametrize("tod,clock", [("evening", "9:09pm, Day 1"), ("evening", "6:10pm, Day 2"), ("afternoon", "3:00pm, Day 2")])
def test_screen_holds_a_night_that_never_happened(monkeypatch, text, tod, clock):
    ok, stashed = _screen(monkeypatch, text, tod, clock)
    assert ok is False and stashed and clock in stashed[0]


@pytest.mark.parametrize("text", UNCOMMITTED_SLEEP_CLAIMS)
def test_screen_keeps_them_once_the_engine_moved_to_morning(monkeypatch, text):
    ok, stashed = _screen(monkeypatch, text, "morning", "8:00am, Day 2")
    assert ok is True and not stashed


def test_screen_holds_the_dead_of_night_only_in_the_daytime_bands(monkeypatch):
    s = "It is the dead middle of the night and the house has finally quit."
    ok, stashed = _screen(monkeypatch, s, "evening", "9:09pm, Day 1")
    assert ok is False and stashed
    ok, stashed = _screen(monkeypatch, s, "late-night", "2:10am, Day 1")
    assert ok is True and not stashed


def test_the_pre_emission_guard_drops_only_the_invented_night(monkeypatch):
    from src import agent_loop as al
    from src import orwell_engine as oe
    from routes import chat_helpers as ch

    async def fake_status(user=None):
        return {"timeOfDay": "evening", "clockLabel": "9:09pm, Day 1"}

    monkeypatch.setattr(oe, "game_status", fake_status)
    monkeypatch.setattr(ch, "_stash_overclaim_reground", lambda u, d: None)
    text = "You lie back and close your eyes. You slept through the whole afternoon. The hall is still loud."
    out = asyncio.get_event_loop().run_until_complete(al._pre_emission_outcome_guard(text, "u"))
    assert "slept through" not in out
    assert "You lie back" in out and "The hall is still loud." in out


# ── review of #2870 (Cubic P2s on the ORW-520 screen) ──
@pytest.mark.parametrize("text", [
    "You slept through the night; now it is the afternoon.",   # A: an accurate recollection of a committed night
    "You slept through the whole night last night.",
    "The pale hands then turned golden in the lamplight.",     # B: a colour change is not dawn
    "It wasn't the dead middle of the night, just late.",      # C: negated
    "It is not the dead of night yet.",
])
def test_orw520_screen_does_not_hold_recollection_colour_or_negation(monkeypatch, text):
    ok, stashed = _screen(monkeypatch, text, "evening", "6:15pm, Day 2")
    assert ok is True and not stashed, text


@pytest.mark.parametrize("text", [
    "You slept through the whole afternoon.",
    "The light through the blinds has gone gray and then gold.",
    "The sky went pale, then golden light spilled in.",
    "It is the dead middle of the night.",
])
def test_orw520_real_phrasings_still_held(monkeypatch, text):
    ok, stashed = _screen(monkeypatch, text, "evening", "6:15pm, Day 2")
    assert ok is False and stashed, text
