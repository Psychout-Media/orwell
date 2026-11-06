"""ORW-205 (structural half) — the PRE-EMISSION headcount guard for the premiere entrances.

Playtest 2026-11-06: during the staged premiere entrances the narrator counted the room itself and got it
wrong — "Ten of the cast in the house now" with 12 inside, "Ten of you in" with 13 inside, "Six in the door,
nine to go" with 11 inside, and "Eight of you fill the living room" while the player had not walked in yet.
#2244 gave the narrator the engine's own count (`premiereIntros.entrance.insideCount` plus a ready-made
`headcount` sentence) and forbade its own counts in the prompt. These gates pin the structural half, so the
rule no longer rests on the prompt alone:

  * a sentence that STATES how many are inside (or how many are still to come) and disagrees with the
    engine's live entrance count is DROPPED before the player sees it, and a next-turn re-ground quoting
    the engine's headcount is stashed;
  * a correct count, the engine's own headcount quoted back, and every non-count use of a number (a
    subgroup, a time, a hedge, a conditional, a past count) stream untouched — the open set is never
    policed (ADR 0005 #1);
  * outside the live entrances/toast stage nothing is checked, and any engine hiccup fails open.

Roles only: the narration fixtures are real playtest sentence SHAPES with every name replaced by a role.
"""

import asyncio
import importlib

import pytest

chat_helpers = importlib.import_module("routes.chat_helpers")
orwell_engine = importlib.import_module("src.orwell_engine")
agent_loop = importlib.import_module("src.agent_loop")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


_USER = "u-orw205-headcount"


@pytest.fixture(autouse=True)
def _clean_state():
    chat_helpers._LAST_BEAT_SIG.pop(_USER, None)
    chat_helpers._DESYNC_REGROUND.pop(_USER, None)
    yield
    chat_helpers._LAST_BEAT_SIG.pop(_USER, None)
    chat_helpers._DESYNC_REGROUND.pop(_USER, None)


def _view(*, inside, total=16, player_inside, stage="entrances", headcount="auto", player_position=9):
    """A `premiereIntros` result shaped like GameSessionAdapter's, with the #2244 entrance fields."""
    if headcount == "auto":
        headcount = f"{inside} of {total} are inside" + (
            " (the player is one of them)" if player_inside
            else " (the player has NOT walked in yet; they are not counted)")
    ent = {"stage": stage, "index": inside, "total": total, "playerPosition": player_position,
           "insideCount": inside, "playerInside": player_inside, "arrivedNames": []}
    if headcount is not None:
        ent["headcount"] = headcount
    return {"complete": True, "metCount": total, "total": total, "remaining": [], "met": [],
            "hotReads": 0, "powerReachable": True, "entrance": ent}


def _fake_intros(monkeypatch, view, calls=None):
    async def fake(user=None):
        if calls is not None:
            calls.append(user)
        return view
    monkeypatch.setattr(orwell_engine, "premiere_intros", fake)


def _ent(**kw):
    """The normalised entrance the pure decision reads (same parse the live guard uses)."""
    return chat_helpers._headcount_entrance(_view(**kw))


# ── the playtest evidence: each wrong count is caught against the engine's count at that moment ─────── #

@pytest.mark.parametrize("sentence,inside,player_inside", [
    # S29: engine had 12 inside (the player one of them); the narrator said ten.
    ("Ten of the cast in the house now.", 12, True),
    # S33: engine had 13 inside; the narrator said ten.
    ("Ten of you in, the room thick with first-night noise — two houseguests now running a two-person "
     "show near the couch.", 13, True),
    # S25: engine had 11 inside; "six in" and "nine to go" are both wrong.
    ("Six in the door, nine to go, and the room's getting loud enough that the clusters are starting to "
     "blur into one big milling crowd.", 11, True),
    # The OOC-aside shape from S41, against a count it disagrees with (15 inside, so one to go, not two).
    ("Fourteen of you are inside; two more still have to walk through that door.", 15, True),
    # A plain wrong remaining count.
    ("Three more to go before the toast.", 14, True),
    # Digits are counts too.
    ("12 of you are inside now.", 10, True),
])
def test_playtest_wrong_counts_are_flagged(sentence, inside, player_inside):
    assert chat_helpers._sentence_has_headcount_claim(sentence)
    bad = chat_helpers._headcount_mismatch(sentence, _ent(inside=inside, player_inside=player_inside))
    assert bad is not None, f"wrong count not caught: {sentence!r} with {inside} inside"


def test_of_you_while_the_player_is_still_outside_is_flagged():
    """Continuity report F, B6: "Eight of you fill the living room" with 8 houseguests inside and the
    player NOT yet in. The number matches the houseguests, but "of you" puts the player in the room, and
    the engine says the player has not walked in — a closed-set claim the engine contradicts."""
    sentence = ("Eight of you fill the living room now — the early arrivals clustered round the couch — and "
                "the energy is starting to hum.")
    assert chat_helpers._headcount_mismatch(sentence, _ent(inside=8, player_inside=False)) is not None
    # Once the player IS inside, the same count of "you" is the engine's count and passes.
    assert chat_helpers._headcount_mismatch(sentence, _ent(inside=8, player_inside=True)) is None


# ── a correct count passes ───────────────────────────────────────────────────────────────────────── #

@pytest.mark.parametrize("sentence,inside,player_inside", [
    ("Fourteen in.", 14, True),
    ("Two to go.", 14, True),
    ("Fourteen in. Two to go.", 14, True),
    ("Twelve of you inside now.", 12, True),
    # The engine's own headcount sentence quoted back verbatim.
    ("12 of 16 are inside (the player is one of them).", 12, True),
    # Counting the OTHERS once the player is inside (the player plus eleven houseguests).
    ("Eleven houseguests in the house now, plus you.", 12, True),
    # The houseguests only, while the player waits outside.
    ("Eight in the house now, and you're still on the other side of the door.", 8, False),
    # Remaining: the player still outside is one of the three to come; "two to go" may count NPCs only.
    ("Three to go.", 13, False),
    ("Two to go before your own entrance.", 13, False),
    ("One more to go.", 15, True),
    # Dialogue: the host greets the houseguests inside while the player is still out (\"you\" = them).
    ("\"Eight of you inside already!\" the host calls from the stairs.", 8, False),
])
def test_correct_counts_pass(sentence, inside, player_inside):
    assert chat_helpers._headcount_mismatch(sentence, _ent(inside=inside, player_inside=player_inside)) is None


# ── not a headcount at all: never touched, whatever the count (ADR 0005 #1) ──────────────────────── #

_NOT_A_HEADCOUNT = [
    # Subgroups (real transcript shapes).
    "Two houseguests have pulled a third in and the three of them are laughing too loud for people who met ten minutes ago.",
    "The whole room is still humming around the two of you.",
    "Four of them are spread out along the fence line.",
    "The hallway's just the two of you.",
    "Six people, one couch, and nobody's actually said anything for the last four minutes.",
    "Two people in and out of the kitchen all night, like a revolving door.",
    "The houseguest by the door waves two in, and the circle widens.",
    "Two of them are in the kitchen arguing about the dishwasher.",
    "The two of you in here, and the small tick of her nail on the bunk frame.",
    # Times and other numbers.
    "It's nine in the morning.",
    "Two hours to go until the toast, and nobody has touched the cheese plate.",
    "Who's the one to go home first? Nobody says it out loud.",
    # Pronoun "one".
    "No one in the house knows yet.",
    # Hedges, conditionals, past counts, future counts.
    "There are about ten of you in by now, give or take.",
    "Once all sixteen of you are inside, the toast begins.",
    "When there are ten of you in, production will call the toast.",
    "Ten of you were inside when she walked in.",
    "There will be sixteen of you inside by midnight.",
    # The cast total, not a headcount of the room.
    "Sixteen strangers deciding who's rooming with who, which is already a decision with consequences.",
    "Sixteen houseguests in total will share this house all summer.",
    "The other fifteen houseguests are somewhere on the other side of that door.",
]


@pytest.mark.parametrize("sentence", _NOT_A_HEADCOUNT)
def test_non_headcount_numbers_are_never_claims(sentence):
    assert not chat_helpers._sentence_has_headcount_claim(sentence), sentence
    # Even against a count every number above would contradict, nothing is flagged.
    assert chat_helpers._headcount_mismatch(sentence, _ent(inside=3, player_inside=True)) is None


# ── stage scoping ────────────────────────────────────────────────────────────────────────────────── #

def test_toast_stage_checks_the_inside_count_but_not_a_remaining_count():
    """At the toast everyone is in (inside == total). "Two more to go" there is about speeches, not
    arrivals, so the remaining family stands down; a wrong inside count is still caught."""
    toast = _ent(inside=16, player_inside=True, stage="toast")
    assert chat_helpers._headcount_mismatch("Two more to go, then the host takes the mic.", toast) is None
    assert chat_helpers._headcount_mismatch("Sixteen of you in the house now, glasses up.", toast) is None
    assert chat_helpers._headcount_mismatch("Fourteen of you in the house now.", toast) is not None


def test_no_entrance_or_a_finished_stage_checks_nothing():
    assert chat_helpers._headcount_entrance(None) is None
    assert chat_helpers._headcount_entrance({"complete": True, "remaining": []}) is None
    assert chat_helpers._headcount_entrance(_view(inside=16, player_inside=True, stage="done")) is None


def test_older_payload_without_the_2244_fields_falls_back_to_index_and_position():
    """An engine from before #2244 has no insideCount/playerInside/headcount: the guard reads `index`
    (the same number) and derives player-inside from `playerPosition`."""
    view = _view(inside=12, player_inside=True, headcount=None, player_position=9)
    for k in ("insideCount", "playerInside"):
        view["entrance"].pop(k)
    ent = chat_helpers._headcount_entrance(view)
    assert ent is not None and ent["inside"] == 12 and ent["player_inside"] is True
    assert chat_helpers._headcount_mismatch("Ten of the cast in the house now.", ent) is not None


# ── the live screen: hold + re-ground, emit, fail-open ───────────────────────────────────────────── #

def test_screen_holds_a_wrong_count_and_stashes_the_engine_headcount(monkeypatch):
    _fake_intros(monkeypatch, _view(inside=12, player_inside=True))
    emit = _run(chat_helpers.screen_streamed_headcount(_USER, "Ten of the cast in the house now."))
    assert emit is False
    directive = chat_helpers._DESYNC_REGROUND.get(_USER) or ""
    assert "HEADCOUNT" in directive
    assert "12 of 16 are inside (the player is one of them)" in directive  # the engine's own sentence


def test_screen_emits_a_correct_count_and_stashes_nothing(monkeypatch):
    _fake_intros(monkeypatch, _view(inside=12, player_inside=True))
    assert _run(chat_helpers.screen_streamed_headcount(_USER, "Twelve of you inside now.")) is True
    assert _USER not in chat_helpers._DESYNC_REGROUND


def test_screen_never_reads_the_engine_for_a_sentence_with_no_headcount(monkeypatch):
    async def boom(user=None):
        raise AssertionError("read the engine for a sentence with no headcount claim (ADR 0005 #1)")
    monkeypatch.setattr(orwell_engine, "premiere_intros", boom)
    assert _run(chat_helpers.screen_streamed_headcount(
        _USER, "The three of them are laughing too loud by the couch.")) is True


def test_screen_outside_the_premiere_emits(monkeypatch):
    async def none(user=None):
        return None  # premiereIntros is null outside the premiere
    monkeypatch.setattr(orwell_engine, "premiere_intros", none)
    assert _run(chat_helpers.screen_streamed_headcount(_USER, "Ten of you in the house now.")) is True
    assert _USER not in chat_helpers._DESYNC_REGROUND


def test_screen_fails_open_when_the_engine_read_fails(monkeypatch):
    async def boom(user=None):
        raise RuntimeError("engine unreachable")
    monkeypatch.setattr(orwell_engine, "premiere_intros", boom)
    assert _run(chat_helpers.screen_streamed_headcount(_USER, "Ten of you in the house now.")) is True
    assert _USER not in chat_helpers._DESYNC_REGROUND


def test_screen_works_single_tenant(monkeypatch):
    """F16 (#1014): owner is None under AUTH_ENABLED=false; the guard still reads the live count and keys
    its re-ground on the canonical game session."""
    monkeypatch.setattr("src.orwell_game_session.get_game_session", lambda user: "gs-205")
    calls = []
    _fake_intros(monkeypatch, _view(inside=12, player_inside=True), calls)
    try:
        assert _run(chat_helpers.screen_streamed_headcount(None, "Ten of the cast in the house now.")) is False
        assert calls == [None]
        assert "HEADCOUNT" in (chat_helpers._DESYNC_REGROUND.get("gs:gs-205") or "")
    finally:
        chat_helpers._DESYNC_REGROUND.pop("gs:gs-205", None)


# ── the stream wiring: `_emit_guarded_scene` drops only the wrong-count sentence ───────────────────── #

_CHUNK = ("The newest arrival laughs it off and starts working the room, handshake by handshake. "
          "Ten of the cast in the house now. "
          "The living room's gone warm and crowded, clusters bleeding into each other.")


def _no_scene_break(monkeypatch):
    async def no_scene_break(user, text):
        return None
    monkeypatch.setattr(chat_helpers, "screen_streamed_scene_break", no_scene_break)


def _scene(text, *, emitted_visible=False, cutaway_emitted=False):
    return _run(agent_loop._emit_guarded_scene(
        text, _USER, scene_broken=False, emitted_visible=emitted_visible, cutaway_emitted=cutaway_emitted))


def test_stream_drops_only_the_wrong_count_sentence(monkeypatch):
    _no_scene_break(monkeypatch)
    _fake_intros(monkeypatch, _view(inside=12, player_inside=True))
    out = _scene(_CHUNK).text
    assert "Ten of the cast" not in out
    assert out.startswith("The newest arrival laughs it off and starts working the room, handshake by handshake.")
    assert out.endswith("The living room's gone warm and crowded, clusters bleeding into each other.")
    assert "HEADCOUNT" in (chat_helpers._DESYNC_REGROUND.get(_USER) or "")


def test_stream_keeps_a_correct_count_byte_identical(monkeypatch):
    _no_scene_break(monkeypatch)
    _fake_intros(monkeypatch, _view(inside=10, player_inside=True))
    assert _scene(_CHUNK).text == _CHUNK
    assert _USER not in chat_helpers._DESYNC_REGROUND


def test_stream_outside_the_premiere_is_byte_identical(monkeypatch):
    _no_scene_break(monkeypatch)

    async def none(user=None):
        return None
    monkeypatch.setattr(orwell_engine, "premiere_intros", none)
    assert _scene(_CHUNK).text == _CHUNK


def test_a_chunk_emptied_by_a_wrong_count_gets_no_cutaway_line(monkeypatch):
    """A wrong count is not a fabricated outcome: when it is the only thing in the turn's first chunk, the
    chunk is simply not shown. The T0-3 "live feeds cut away" line (and its cut-streak escalation) is for
    closed-set outcome claims and must not fire here."""
    _no_scene_break(monkeypatch)
    _fake_intros(monkeypatch, _view(inside=14, player_inside=True))

    async def no_cutaway(user):
        raise AssertionError("a headcount drop must not step the cutaway / cut streak")
    monkeypatch.setattr(chat_helpers, "guard_emptied_cutaway", no_cutaway)
    g = _scene("Ten of you in, and the room is getting loud.")
    assert g.text == ""
    assert g.cutaway_emitted is False
    assert g.scene_broken is False


def test_an_outcome_claim_still_gets_the_cutaway_when_a_count_was_also_dropped(monkeypatch):
    """Ordering: the headcount wall runs first; when the OUTCOME guard is what empties the rest, the T0-3
    cutaway still fires exactly as before."""
    _no_scene_break(monkeypatch)
    _fake_intros(monkeypatch, _view(inside=14, player_inside=True))

    async def outcome_guard_drops_everything(text, owner):
        return ""
    monkeypatch.setattr(agent_loop, "_pre_emission_outcome_guard", outcome_guard_drops_everything)
    g = _scene("Ten of you in. You won HOH!")
    assert g.cutaway_emitted is True
    assert "Ten of you in" not in g.text


def test_the_wall_reads_the_engine_once_per_chunk(monkeypatch):
    calls = []
    _fake_intros(monkeypatch, _view(inside=11, player_inside=True), calls)
    out = _run(agent_loop._headcount_wall_guard("Six in the door. Nine to go. The room hums.", _USER))
    assert out == " The room hums."
    assert len(calls) == 1


def test_the_wall_never_reads_the_engine_without_a_headcount(monkeypatch):
    async def boom(user=None):
        raise AssertionError("read the engine for a chunk with no headcount claim (ADR 0005 #1)")
    monkeypatch.setattr(orwell_engine, "premiere_intros", boom)
    text = "The three of them are laughing too loud by the couch. It's nine in the morning."
    assert _run(agent_loop._headcount_wall_guard(text, _USER)) == text


# A premiere-shaped creative corpus (real playtest shapes, names swapped): numbers everywhere, no headcount
# claim anywhere. Against a live entrance whose count every number would contradict, all of it must
# stream byte-identical and queue no re-ground.
_PREMIERE_PROSE = [
    "Eight faces swing toward you at once, and somebody near the couch actually gasps.",
    "Two houseguests have pulled a third in and the three of them are laughing too loud for people who met "
    "ten minutes ago.",
    "The clusters, the volume, the ten strangers all talking over each other — it is a lot.",
    "Just two people noting each other across the island, nothing said.",
    "Sixteen of you, on the wall, every photo smiling like it has never told a lie.",
    "He gives the two of you a shrug that's more shoulder than meaning.",
]


@pytest.mark.parametrize("prose", _PREMIERE_PROSE)
def test_premiere_creative_prose_streams_untouched(prose, monkeypatch):
    _fake_intros(monkeypatch, _view(inside=3, player_inside=True))
    assert _run(agent_loop._headcount_wall_guard(prose, _USER)) == prose
    assert _USER not in chat_helpers._DESYNC_REGROUND


# ── the OOC aside path: a production aside is held to the same count ────────────────────────────── #

def test_aside_with_a_wrong_count_is_dropped(monkeypatch):
    _fake_intros(monkeypatch, _view(inside=15, player_inside=True))
    aside = "((Fourteen of you are inside; two more still have to walk through that door.))"
    assert _run(agent_loop._screen_aside_text(aside, _USER)) != aside


def test_aside_with_the_engine_count_streams_whole(monkeypatch):
    _fake_intros(monkeypatch, _view(inside=14, player_inside=True))
    aside = "((Fourteen of you are inside; two more still have to walk through that door.))"
    assert _run(agent_loop._screen_aside_text(aside, _USER)) == aside


# ── the persisted text: the dropped sentence never survives into the saved round ───────────────── #

def test_dropped_count_is_mirrored_out_of_the_raw_round_buffer(monkeypatch):
    """F-1: what a round persists must equal what the player was shown. The guarded chunk's mirror ops
    erase the dropped headcount sentence from the raw round buffer too."""
    _fake_intros(monkeypatch, _view(inside=12, player_inside=True))

    async def no_scene_break(user, text):
        return None
    monkeypatch.setattr(chat_helpers, "screen_streamed_scene_break", no_scene_break)
    guarded, held = _run(agent_loop._guard_stream_chunk(
        _CHUNK, _USER, ooc_open="", scene_broken=False, emitted_visible=False, cutaway_emitted=False))
    assert held == ""
    assert "Ten of the cast" not in guarded.text
    raw = "Earlier narration. " + _CHUNK
    mirrored = agent_loop._apply_mirror_ops(raw, guarded.mirror_ops)
    assert "Ten of the cast" not in mirrored
    assert mirrored.startswith("Earlier narration. The newest arrival laughs it off")
