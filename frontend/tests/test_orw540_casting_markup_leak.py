"""ORW-540: a casting reply showed `{"content":[{"type":"text","text":"..."}]</parameter> </invoke> </DSML calls>` (full-width bars) and persisted it. The leak scrub did not know stray call closers, a DSML closing tag, or a result-content envelope. Roles only."""
import pytest

FW = "｜｜"
LIVE = ('{"content":[{"type":"text","text":"Casting status: ready to finalize. Cast photo is optional."}]'
        f'</parameter> </invoke> </{FW}DSML{FW} calls>')


def _scrub(s):
    from src.agent_loop import _scrub_game_leak
    return _scrub_game_leak(s)


def test_exact_live_string_scrubs_to_its_text():
    out = _scrub(LIVE)
    assert out == "Casting status: ready to finalize. Cast photo is optional.", out


def test_ascii_bars_and_stray_closers():
    out = _scrub("The HOH nods.</parameter> </invoke> </||DSML|| tool_calls>")
    assert out.strip() == "The HOH nods."


def test_streamed_in_pieces():
    first = _scrub('{"content":[{"type":"text","text":"Casting status: ready.')
    last = _scrub(' Photo is optional."}]</parameter> </invoke>')
    assert (first + last).strip() == "Casting status: ready. Photo is optional."


def test_persist_path_is_clean():
    from src.agent_loop import _persisted_round_text
    from src.tool_parsing import strip_tool_blocks
    out = _persisted_round_text(strip_tool_blocks(LIVE).strip(), scene_broken=False, scrub_active=True, round_emitted="")
    assert "parameter" not in out and "DSML" not in out and "{" not in out and "Cast photo is optional" in out


@pytest.mark.parametrize("s", [
    "I invoke the right of the HOH to speak first.",
    'She writes {"content": "ok"} on the whiteboard and grins.',
    "The parameter of the challenge is simple. Nobody may invoke the veto early.",
    'He says "wait" and the room, a code-like list [1, 2], goes quiet.',
    "Use the closing </b> tag? No, the HOH just smiles.",
])
def test_negative_controls_untouched(s):
    assert _scrub(s) == s


def test_client_render_scrub_is_wired_in_the_game_branch():
    """Source pin: the client scrub exists, is exported, and runs in processWithThinking's game-build branch (the reload of an already-stored leak)."""
    import pathlib
    js = (pathlib.Path(__file__).resolve().parents[1] / "static/js/markdown.js").read_text()
    assert "export function scrubToolMarkupTail" in js
    assert "reply = (scrubToolMarkupTail(reply) || '').trim();" in js
    assert "DSML" in js.split("export function scrubToolMarkupTail")[1][:700]
