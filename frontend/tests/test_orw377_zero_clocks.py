"""ORW-377 - zero clocks in the house (Ryne, playtest 2026-11-15). The narrator/houseguests name the PART OF THE DAY, never a clock time; a clock-time SENTENCE is dropped (never the scene); what the
player sees is Day N + the band. PRESENTATION ONLY: the engine keeps its internal clock (pinned engine-side in tests/unit/zeroClocks.test.ts). OFF is byte-identical. Roles only, no model calls."""
import asyncio
import json
import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.usefixtures("non_game_text_routing")

CLOCK_RE = re.compile(r"\b\d{1,2}:\d{2}\b|\b\d{1,2}\s?(?:am|pm)\b", re.IGNORECASE)


@pytest.fixture
def setting(monkeypatch):
    import src.settings as st
    real = st.get_setting
    state = {"v": True}
    monkeypatch.setattr(st, "get_setting", lambda k, d=None: state["v"] if k == "zero_clocks" else real(k, d))
    return state


def _guard(text):
    from src import agent_loop as al
    return asyncio.get_event_loop().run_until_complete(al._pre_emission_outcome_guard(text, "u"))


def test_default_is_on():
    from src.settings import DEFAULT_SETTINGS
    assert DEFAULT_SETTINGS["zero_clocks"] is True


@pytest.mark.parametrize("clocky", [
    "It's 8:15 in the morning.", "Quarter past eight.", "At 3am the house is dark.", "It's 6:15 and nobody is up.", "Half past three, and the kitchen hums.",
    "She checks the time: eight o'clock.", "Three in the morning, and the hallway is silent.", "It's 11 pm.", "Twenty past six by the light.", "It's eight-thirty.",
    "Twelve noon on the dot.", "At midnight sharp the lights go.", "A quarter to eight, someone says.", "It is 9:40 a.m.",
])
def test_clock_time_sentences_are_dropped_but_the_scene_survives(setting, clocky):
    text = f"The kettle clicks off. {clocky} The player stays on the couch."
    out = _guard(text)
    assert "The kettle clicks off." in out and "The player stays on the couch." in out
    assert not CLOCK_RE.search(out) and clocky not in out


@pytest.mark.parametrize("fine", [
    "Three of us are in the kitchen.", "It has been seven days.", "It's Day 4.", "They talk for two hours.", "Noon light falls across the floor.", "The midnight snack is gone.",
    "No one in the morning would dare.", "Round 3 of 5.", "Seven of them nod along.", "A few hours into the night, the house goes quiet.", "Ten of them gather at the table.",
])
def test_non_clock_numbers_and_band_words_survive(setting, fine):
    text = f"{fine} The door opens."
    assert _guard(text) == text


def test_off_is_byte_identical_nothing_dropped(setting):
    setting["v"] = False
    text = "It's 6:15 and quarter past eight and 3am.\n\nShe waits."
    assert _guard(text) == text


def test_detection_is_pure_and_fail_open():
    from src.zero_clocks import sentence_states_zero_clock_time_raw as d
    assert d("It's 6:15.") and not d("") and not d(None) and not d("Nothing here.")


# ---- what the narrator is handed ----
def test_tool_output_the_model_reads_has_the_band_not_the_clock(setting):
    from src.zero_clocks import scrub_tool_output
    raw = json.dumps({"clockLabel": "4:15am, Day 5", "timeOfDay": "late-night", "daySchedule": {"next": "x", "minutesUntil": 45, "due": False}, "nested": [{"clockLabel": "3:05pm, Day 2"}]})
    out = scrub_tool_output(raw)
    assert "early morning, Day 5" in out and "afternoon, Day 2" in out and "minutesUntil" not in out and not CLOCK_RE.search(out)
    setting["v"] = False
    assert scrub_tool_output(raw) == raw


def test_format_tool_result_applies_the_scrub(setting):
    from src.tool_execution import format_tool_result
    res = {"output": json.dumps({"clockLabel": "9:40am, Day 1"}), "exit_code": 0}
    assert "9:40" not in format_tool_result("status", res) and "morning, Day 1" in format_tool_result("status", res)
    setting["v"] = False
    assert "9:40am, Day 1" in format_tool_result("status", res)


def test_format_tool_result_scrubs_stdout_content_and_results_shapes_too(setting):
    """review of #2657: MCP and shell tool results use `stdout` (not `output`); no branch may carry a clock label to the model."""
    from src.tool_execution import format_tool_result
    raw = json.dumps({"clockLabel": "9:40am, Day 1"})
    for res in ({"stdout": raw, "stderr": "", "exit_code": 0}, {"stdout": "", "stderr": "now 9:40am, Day 1", "exit_code": 1},
                {"content": raw, "size": 10}, {"results": "the clock reads 9:40am, Day 1"}):
        out = format_tool_result("status", res)
        assert "9:40" not in out and "morning, Day 1" in out, (res, out)
    setting["v"] = False
    assert "9:40am, Day 1" in format_tool_result("status", {"stdout": raw, "stderr": "", "exit_code": 0})


def test_orw437_format_tool_result_scrubs_the_response_branch_and_the_extra_payload(setting):
    """review of #2751: `response` text and the serialized `extra` payload (clockLabel, minutesUntil) still reached the model."""
    from src.tool_execution import format_tool_result
    raw = json.dumps({"clockLabel": "9:40am, Day 1"})
    for res in ({"response": raw}, {"response": raw, "model": "m"}, {"response": "ok", "daySchedule": {"clockLabel": "9:40am, Day 1", "minutesUntil": 25, "next": "nominations"}}):
        out = format_tool_result("status", res)
        assert "9:40" not in out and "minutesUntil" not in out and "morning, Day 1" in out, (res, out)
    setting["v"] = False
    assert "9:40am, Day 1" in format_tool_result("status", {"response": raw})
    assert "minutesUntil" in format_tool_result("status", {"response": "ok", "daySchedule": {"minutesUntil": 25}})


@pytest.mark.parametrize("label,band", [("4:15am, Day 4", "early morning"), ("1:00am, Day 2", "late night"), ("1:59am, Day 2", "late night"), ("2:00am, Day 2", "early morning"), ("6:30am, Day 2", "early morning"), ("7:59am, Day 2", "early morning"), ("8:00am, Day 2", "morning"), ("3:20pm, Day 3", "afternoon"),
                                        ("9:10pm, Day 3", "night"), ("5:00pm, Day 1", "evening"), ("12:15pm, Day 1", "midday"), ("9:40am, Day 1", "morning")])
def test_band_label_mirrors_the_engine_bands(label, band):
    from src.zero_clocks import band_label
    assert band_label(label) == f"{band}, " + label.split(", ")[1]


def test_turn_in_note_and_reground_quote_the_band(setting):
    from src import agent_loop as al
    out = json.dumps({"status": {"timeOfDay": "morning", "clockLabel": "4:15am, Day 4"}})
    note = al._bedtime_direct_note(out)
    assert "early morning, Day 4" in note and not CLOCK_RE.search(note)
    setting["v"] = False
    assert "4:15am, Day 4" in al._bedtime_direct_note(out)


def test_held_and_warning_steers_carry_no_minutes(setting):
    from routes import chat_helpers as ch
    for steer in (ch.engine_held_note({"next": "nominations", "minutesUntil": 45, "reason": "schedule"}), ch._production_warning_steer("nominations", 20)):
        assert not re.search(r"\d", steer.replace("Day", ""))
    setting["v"] = False
    assert "20 in-game minutes" in ch._production_warning_steer("nominations", 20)
    assert "in about 45 minutes" in ch.engine_held_note({"next": "nominations", "minutesUntil": 45})


def test_get_moment_prompt_requests_zero_clocks_only_when_on(setting, monkeypatch):
    from src import orwell_engine as oe
    seen = []

    async def fake_call(name, args=None, user=None, timeout=None):
        seen.append(dict(args or {}))
        return {}

    monkeypatch.setattr(oe, "_call", fake_call)
    asyncio.get_event_loop().run_until_complete(oe.get_moment_prompt("x"))
    setting["v"] = False
    asyncio.get_event_loop().run_until_complete(oe.get_moment_prompt("x"))
    assert seen[0].get("zeroClocks") is True and "zeroClocks" not in seen[1]


# ---- what the player sees ----
def test_player_visible_labels_are_day_plus_band_no_minutes():
    from routes import chat_helpers as ch
    for tod in ("morning", "afternoon", "evening", "night", "late-night"):
        stamp = ch._format_game_moment({"started": True, "week": 1, "phase": "nominations", "timeOfDay": tod, "clockLabel": "4:15am, Day 5"})
        assert stamp and not CLOCK_RE.search(stamp)
    js = Path(__file__).resolve().parent.parent / "static" / "js"
    panel = (js / "orwellStatusPanel.js").read_text()
    assert "clockLabel" not in panel and "timeOfDay" in panel  # the HUD chip is "Morning, Day 1" from the band + dayNumber
    assert 'return p === "night" ? "tonight" : "this " + p;' in panel and 'return "tomorrow " + p;' in panel  # what's next: "this evening" / "tomorrow afternoon"
    for f in ("orwellChapters.js", "chatRenderer.js"):
        assert "clockLabel" not in (js / f).read_text()


def test_settings_toggle_exists():
    root = Path(__file__).resolve().parent.parent
    assert 'id="set-zeroClocksToggle"' in (root / "static" / "index.html").read_text()
    assert "zero_clocks" in (root / "static" / "js" / "settings.js").read_text()


def test_orw437_a_dotted_time_and_a_semicolon_clause_are_handled_per_sentence(setting):
    """review of #2657: "3 a.m." must not be split into "3 a." + "m." (so it escaped the check); a semicolon compound loses only its clock clause."""
    out = _guard("The kettle clicks off. The hall is dark at 3 a.m. The player stays put.")
    assert "3 a.m" not in out and "The kettle clicks off." in out and "The player stays put." in out
    out = _guard("The kettle clicks off; it is 9 p.m. by the light; the player stays put.")
    assert "p.m" not in out and "by the light" not in out  # the WHOLE sentence goes (the dotted time does not end it): a clause cut left dangling "; and ..." text and the stored-text mirror could not follow it


def _stream(chunk, stored_before):
    """Run a chunk through the REAL `_guard_stream_chunk` + `_apply_mirror_ops`: (shown text, stored text)."""
    from src import agent_loop as al
    g, _ = asyncio.get_event_loop().run_until_complete(al._guard_stream_chunk(chunk, "u", ooc_open="", scene_broken=False, emitted_visible=True, cutaway_emitted=False))
    return g.text, al._apply_mirror_ops(stored_before + chunk, g.mirror_ops)


@pytest.mark.parametrize("chunk,shown,stored_tail", [
    ("The house settles. It was 3 a.m. Then he left with them. ", "The house settles. Then he left with them. ", "The house settles. Then he left with them. "),
    ("She waited in the kitchen; it was 9 p.m. and Sam yawned. Then everyone left. ", " Then everyone left. ", " Then everyone left. "),
    ("The house settles. Then he left with them. ", "The house settles. Then he left with them. ", "The house settles. Then he left with them. "),
])
def test_orw437_shown_and_stored_text_agree_for_dotted_times_compounds_and_plain_sentences(setting, chunk, shown, stored_tail):
    """review of #2754: the stored text used to be corrupted ("settles.m. Then he left with the ") because the mirror re-split "3 a." / "m."."""
    before = "You push the door open. "
    out_shown, stored = _stream(chunk, before)
    assert out_shown == shown
    assert stored == before + stored_tail


@pytest.mark.parametrize("clocky", ["Ten to eight, by the light.", "It is twenty to nine.", "The clock says 9.15am.", "At 4.30pm the doors open."])
def test_orw437_dotted_and_to_form_times_are_dropped(setting, clocky):
    out = _guard(f"The kettle clicks off. {clocky} The player stays put.")
    assert clocky not in out and "The kettle clicks off." in out
    assert out == "The kettle clicks off. The player stays put.", out  # review of #2751: the whole clock sentence goes and nothing else (no leftover fragment, the trailing sentence stays)


@pytest.mark.parametrize("fine", ["It takes five to ten minutes.", "Ten to twelve of them nod.", "Version 2.5pm is not a time."])
def test_orw437_the_new_forms_leave_durations_alone(fine):
    from src.zero_clocks import sentence_states_zero_clock_time_raw as raw  # the detector itself (the loop's other closed-set screens read "five to ten" as a vote tally)
    assert not raw(fine)


@pytest.mark.parametrize("chunk,shown", [
    ("The kettle ticked. At 9 p.m., Sam yawned. Rain tapped the glass. The door clicked shut. ", "The kettle ticked. Rain tapped the glass. The door clicked shut. "),
    ("The kettle ticked. It was 9 p.m; Sam yawned. Rain tapped the glass. The door clicked shut. ", "The kettle ticked. Rain tapped the glass. The door clicked shut. "),
    ("The kettle ticked. Around 3 a.m and later, Sam yawned. Rain tapped the glass. The door clicked shut. ", "The kettle ticked. Rain tapped the glass. The door clicked shut. "),
])
def test_orw437_punctuation_after_a_dotted_time_goes_with_it_and_stored_text_agrees(setting, chunk, shown):
    """review of #2751: ", Sam yawned." was left behind as an orphan part when "At 9 p.m." was dropped, and "3 a.m and" (no closing period) was split inside the time. Three true sentences stay,
    in the shown text AND the stored text (real `_guard_stream_chunk` + `_apply_mirror_ops`)."""
    before = "You push the door open. "
    out_shown, stored = _stream(chunk, before)
    assert out_shown == shown
    assert stored == before + shown


@pytest.mark.parametrize("chunk,shown", [
    ("The kettle ticked. The clock says 9.15am. Rain tapped the glass. The door clicked shut. ", "The kettle ticked. Rain tapped the glass. The door clicked shut. "),
    ("The kettle ticked. At 4.30pm the doors open. Rain tapped the glass. The door clicked shut. ", "The kettle ticked. Rain tapped the glass. The door clicked shut. "),
])
def test_orw437_a_dotted_numeric_time_is_one_sentence_part_and_stored_text_agrees(setting, chunk, shown):
    """review of #2751: the splitter cut "9.15am" at the dot, so dropping the clock part left "The clock says 9." on screen. The whole sentence goes, shown and stored (real `_guard_stream_chunk` + `_apply_mirror_ops`); three true sentences stay."""
    before = "You push the door open. "
    out_shown, stored = _stream(chunk, before)
    assert out_shown == shown
    assert stored == before + shown


def test_orw437_a_vote_tally_is_not_a_clock_reading(setting):
    """review of #2751/#2767: "five to two" matched the to-form ("ten to eight"). Only the TALLY shape is exempt (a number pair that follows "a vote of" / "voted", or precedes "vote"); a real time in a vote-themed sentence is still dropped."""
    from src.zero_clocks import sentence_states_zero_clock_time_raw as raw
    for tally in ("By a vote of five to two, the group picked pizza.", "They voted five to two for pizza.", "A five to two vote picked pizza."):
        assert not raw(tally), tally
    for clock in ("Ten to eight, by the light.", "It was ten to eight when the vote began.", "Voting opens at five to nine.", "She voted at ten to eight.",
                  "The vote is at ten to eight tonight.", "He reached the kitchen at ten to eight."):
        assert raw(clock), clock
    from routes import chat_helpers as ch
    assert not ch.sentence_states_zero_clock_time("By a vote of five to two, the group picked pizza.")
    for clock in ("Voting opens at five to nine.", "She voted at ten to eight.", "The vote is at ten to eight tonight.", "He reached the kitchen at ten to eight."):
        out = _guard(f"The kettle ticked. {clock} Rain tapped the glass.")
        assert out == "The kettle ticked. Rain tapped the glass.", (clock, out)


@pytest.mark.parametrize("stem", ["3 a.m", "9 p.m"])
def test_orw437_a_dotted_time_split_across_chunks_takes_its_terminator_with_it(setting, stem):
    """review of #2767: chunks ending at "3 a.m" with the "." in the next one left "settles.. Then he left." shown AND stored. Real `_guard_stream_chunk` + `_apply_mirror_ops`, chunk by chunk, plus the round's flush."""
    from src import agent_loop as al
    run = asyncio.get_event_loop().run_until_complete
    shown, stored, pending = "", "", ""
    for c in (f"The house settles. It was {stem}", ". Then he left. The door clicks. Rain falls. "):
        g, pending = run(al._guard_stream_chunk(c, "u", ooc_open=pending, scene_broken=False, emitted_visible=True, cutaway_emitted=False))
        shown += g.text
        stored = al._apply_mirror_ops(stored + c, g.mirror_ops)
    assert pending == ""
    assert shown == "The house settles. Then he left. The door clicks. Rain falls. ", shown
    assert stored == shown, (stored, shown)
    # nothing follows the stem: the flush resolves it (the clock sentence is dropped, not lost into the pending buffer)
    g, pending = run(al._guard_stream_chunk(f"The house settles. It was {stem}", "u", ooc_open="", scene_broken=False, emitted_visible=True, cutaway_emitted=False))
    assert g.text.strip() == "The house settles." and pending.endswith(stem)
    g2, pending = run(al._guard_stream_chunk("", "u", ooc_open=pending, scene_broken=False, emitted_visible=True, cutaway_emitted=False, flush=True))
    assert g2.text == "" and pending == ""


def _loop_stream(chunks):
    """ORW-437: feed raw deltas through the loop's OWN steps in the loop's order (`_split_complete_sentences`, `_scrub_game_leak`, `_orphan_continuation_split`, the REAL `_guard_stream_chunk`,
    `_apply_mirror_ops`, `_chunk_ended_in_drop`), then the round's flush. Returns (shown, stored)."""
    from src import agent_loop as al
    run = asyncio.get_event_loop().run_until_complete
    shown = stored = buf = pending = ""
    prev = False

    def step(complete, flush=False):
        nonlocal shown, stored, pending, prev
        clean = al._scrub_game_leak(complete)
        orphan, clean = al._orphan_continuation_split(clean, prev)
        if orphan:
            stored = al._apply_mirror_ops(stored, ((orphan, ""),))
        piece, ops = "", ()
        if clean:
            g, pending = run(al._guard_stream_chunk(clean, "u", ooc_open=pending, scene_broken=False, emitted_visible=True, cutaway_emitted=False, flush=flush))
            piece, ops = g.text, g.mirror_ops
            stored = al._apply_mirror_ops(stored, ops)
        shown += piece
        prev = al._chunk_ended_in_drop(complete, piece)

    for c in chunks:
        stored += c  # the raw round buffer grows by every delta
        buf += c
        complete, buf = al._split_complete_sentences(buf)
        if complete:
            step(complete)
    if buf:
        step(buf, flush=True)
    return shown, stored


@pytest.mark.parametrize("joiner", ["; and Sam yawned. ", ", and Sam yawned. "])
def test_orw437_a_fragment_joined_to_a_dropped_sentence_goes_with_it_shown_and_stored(setting, joiner):
    """The chunk ended at "3 a.m." (the clock sentence is dropped); the next chunk opened with the clause that was joined to it. Real guard + mirror; three true sentences still show."""
    shown, stored = _loop_stream(["The house settles. It was 3 a.m.", joiner + "Rain tapped the glass. The door clicked shut. The kettle ticked. "])
    assert shown == "The house settles. Rain tapped the glass. The door clicked shut. The kettle ticked. ", shown
    assert stored == shown, (stored, shown)


def test_orw437_a_fragment_after_a_kept_sentence_still_shows(setting):
    """No drop, no rule: "; and ..." after a sentence the player saw is ordinary narration."""
    shown, stored = _loop_stream(["The house settles.", "; and Sam yawned. Rain tapped the glass. The door clicked shut. "])
    assert shown == "The house settles.; and Sam yawned. Rain tapped the glass. The door clicked shut. "
    assert stored == shown


def test_orw437_a_time_cut_between_a_dot_and_the_m_is_never_split(setting):
    """The splitter used to end a unit at "3 a." so the clock check never saw "3 a.m."; now the time stays whole, is dropped as a sentence (shown and stored), and three true sentences stay."""
    shown, stored = _loop_stream(["The house settles. It was 3 a.", "m. and the house slept. Sam yawned. Rain tapped the glass. The door clicked shut. "])
    assert "a.m" not in shown and "m." not in shown.replace("Sam yawned", "")
    assert shown == "The house settles. Sam yawned. Rain tapped the glass. The door clicked shut. ", shown
    assert stored == shown, (stored, shown)


def test_orw437_the_splitter_holds_a_buffer_that_ends_mid_time_and_nothing_else():
    from src import agent_loop as al
    assert al._split_complete_sentences("It was 3 a.") == ("", "It was 3 a.")
    assert al._split_complete_sentences("He left. It was 9 p.") == ("He left.", " It was 9 p.")
    assert al._split_complete_sentences("It was 3 a.m. and quiet. Then") == ("It was 3 a.m. and quiet.", " Then")
    assert al._split_complete_sentences("Plan B. Then") == ("Plan B.", " Then")
    assert al._split_complete_sentences("Option a. ") == ("Option a.", " ")
