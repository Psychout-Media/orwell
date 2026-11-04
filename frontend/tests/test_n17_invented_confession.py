"""N-17 (Ryne card 19): a houseguest's first-person CONFESSION of a hidden personal fact must come from an engine disclosure decision; an invented one is replaced by an in-voice deflection.
Conservative: >= 2 cue families, or one strong cue + a personal-fact noun. Roles only."""
import asyncio
import importlib

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")
oe = importlib.import_module("src.orwell_engine")

CAUGHT = [
    'KV— "I\'ve never told anyone this. Before the show I did eighteen months in prison for fraud."',
    'TB— "Okay. My secret is I\'m on my fourth bankruptcy and the whole sweet-guy thing is a cover."',
    'LP— "I have to confess something. Nobody here knows that I was arrested in college."',
    'MS— "The truth is I lied about my kids. I don\'t have any, and I never told a soul."',
]
PASSES = [
    'AB— "Honestly, I\'m tired. Long night, too much champagne."',
    'ED— "The truth is I love pizza more than anything in this house."',
    'RK— "I\'ve never told anyone I can\'t whistle, and I\'m weirdly proud of it."',
    'DS— "My secret is the eggs. Low heat and patience."',
    'OW— "I have to confess I ate the last of your cereal."',
    "The kitchen is quiet; somebody laughs at the far end of the table.",
    'JC— "Nobody here knows that I can juggle."',
]


def _run(c):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(c)
    finally:
        loop.close()
        asyncio.set_event_loop(asyncio.new_event_loop())


def _setup(user="n17"):
    ch._GAME_WAS_ACTIVE.add(user)
    oe.clear_disclosure_turn(user)
    return user


def test_real_confessions_are_caught_and_replaced():
    u = _setup()
    for line in CAUGHT:
        out, ops = ch.screen_invented_confession(u, "Before.\n" + line + "\nAfter.")
        assert ops and ops[0][0] == line, line
        assert line not in out and "Before." in out and "After." in out
        assert out.split("\n")[1] in ch._CONFESSION_DEFLECTIONS, "replaced by an in-voice deflection, never a hole"


def test_ordinary_chatter_and_benign_openers_pass():
    u = _setup()
    for line in PASSES:
        out, ops = ch.screen_invented_confession(u, line)
        assert ops == [] and out == line, line


def test_an_engine_backed_disclosure_passes():
    u = _setup()
    assert ch.screen_invented_confession(u, CAUGHT[0])[1], "no lever this turn -> caught"
    async def fake(name, args=None, user=None, timeout=None):
        return {"ok": True}
    # the disclosure levers mark the turn BEFORE the call (set in _call); simulate via the same bookkeeping
    oe._DISCLOSURE_TURN[oe._disclosure_key(u)] = True
    out, ops = ch.screen_invented_confession(u, CAUGHT[0])
    assert ops == [] and out == CAUGHT[0], "confide/tradeSecret/... ran this turn -> the engine backed the disclosure"
    oe.clear_disclosure_turn(u)
    assert ch.screen_invented_confession(u, CAUGHT[0])[1], "a new turn clears the exemption"


def test_disclosure_tools_mark_the_turn_and_other_tools_do_not():
    assert {"confide", "tradeSecret", "exposeSecret", "askJuror", "surfaceInformationTo"} <= set(oe._DISCLOSURE_TOOLS)
    assert "advanceGame" not in oe._DISCLOSURE_TOOLS and "recordInteraction" not in oe._DISCLOSURE_TOOLS


def test_not_a_started_game_never_judges():
    ch._GAME_WAS_ACTIVE.discard("casting-user")
    out, ops = ch.screen_invented_confession("casting-user", CAUGHT[0])
    assert ops == [] and out == CAUGHT[0]


def test_agent_loop_wiring_replaces_and_mirrors():
    al = importlib.import_module("src.agent_loop")
    u = _setup("n17-loop")
    text, ops = _run(al._confession_guard(CAUGHT[0] + "\nShe looks away.", u))
    assert ops and text.split("\n")[0] in ch._CONFESSION_DEFLECTIONS
    raw = "intro\n" + CAUGHT[0] + "\nShe looks away."
    mirrored = al._mirror_confession_replace(raw, ops)
    assert CAUGHT[0] not in mirrored and "She looks away." in mirrored and "intro" in mirrored


def test_wiring_is_present_at_both_emit_sites():
    import pathlib
    src = pathlib.Path(__file__).resolve().parents[1].joinpath("src", "agent_loop.py").read_text()
    assert src.count("_cf_text, _cf_ops = await _confession_guard(") == 2, "stream site + final site"
    assert src.count("_mirror_wall_drop(round_response, _cf_text, _guarded_text)") == 2, "the wall-drop mirror pairs from the post-confession text"
