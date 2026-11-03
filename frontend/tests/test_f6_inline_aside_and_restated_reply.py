"""F-6 / N-9 (playtest blockers) - a doubled reply and `((...))` markers leaking into the visible bubble.

Evidence (run-20261103-0520 persisted-transcript lines ~131-143, fe.log 05:29:54-05:29:58): the model voiced Dawn's answer (round 1), then the
anti-stale RELEASE VALVE forced a second in-turn round that RE-ANSWERED the same question (and opened with an out-of-character
`((Careful - the Diary Room is sealed...))` aside). The rounds stack into ONE bubble (#829) and join with no separator, so the player saw two
different versions of the same NPC answer, with a literal `((...))` glued to the end of the first and stray `))` markers.

The renderer already segments a LEADING or WHOLE-message `((...))` aside (#970 / NARR-9). It did not handle an aside in the MIDDLE or at the END of a
reply, nor a restated reply. Two pure helpers in markdown.js (the single render engine both the live stream and the reload path funnel through):

  _extractInlineOocAsides(reply) -> { prose, asides }   every balanced ((...)) block not already handled above is pulled OUT of the
                                                         in-character prose (no literal markers), and leftover stray (( / )) tokens are dropped;
  _collapseRestatedReply(text)   -> text                 a later `@[Name] ...` block that restates an earlier block by the SAME speaker (a shared
                                                         verbatim run of 8+ words) is dropped; genuinely new paragraphs are kept.

Pure Node round-trips (no DOM) + source pins that both run in the game-build branch.
"""
import json
import os
import shutil
import subprocess

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(_NODE is None, reason="node not available")


def _md():
    with open(os.path.join(FRONTEND, "static", "js", "markdown.js"), encoding="utf-8") as f:
        return f.read()


def _run(fn_name, cases=None, consts=()):
    program = r"""
    const fs = require('fs');
    const src = fs.readFileSync(process.argv[1], 'utf8');
    const names = JSON.parse(process.argv[3]);
    const fnName = process.argv[2];
    const grabLine = (marker) => { const i = src.indexOf(marker); if (i < 0) throw new Error('missing ' + marker); return src.slice(i, src.indexOf('\n', i)); };
    const pre = names.map(grabLine).join('\n');
    const i = src.indexOf('function ' + fnName);
    if (i < 0) throw new Error('missing function ' + fnName);
    let fn = src.slice(i);
    fn = fn.slice(0, fn.indexOf('\n}\n') + 2);
    const cases = JSON.parse(process.argv[4]);
    const run = new Function('cases', pre + '\n' + fn + '\nreturn cases.map(c => ' + fnName + '(c));');
    process.stdout.write(JSON.stringify(run(cases)));
    """
    res = subprocess.run([_NODE, "-e", program, "--", os.path.join(FRONTEND, "static", "js", "markdown.js"), fn_name, json.dumps(list(consts)), json.dumps(cases)],
                         capture_output=True, text=True)
    assert res.returncode == 0, f"node failed: {res.stderr}"
    return json.loads(res.stdout)


# -- source pins -----------------------------------------------------------------------------------

def test_helpers_exist_and_run_in_the_game_build_branch():
    md = _md()
    assert "function _extractInlineOocAsides(" in md
    assert "function _collapseRestatedReply(" in md
    pwt = md[md.index("export function processWithThinking"):]
    gated = pwt[pwt.index("if (gameBuildSuppressesThinking())"):]
    gated = gated[:gated.index("let html = ''")]
    assert "_collapseRestatedReply(" in gated, "restated replies are collapsed in the game-build render"
    assert "_extractInlineOocAsides(" in gated, "inline asides are pulled out in the game-build render"


# -- inline aside extraction -----------------------------------------------------------------------

def test_trailing_aside_glued_to_a_quote_is_pulled_out_with_no_markers():
    out = _run("_extractInlineOocAsides", consts=("const _OOC_INLINE_RE =",), cases=[
        '@[Dawn] - "So which is it?"((Careful - the Diary Room is sealed. Dawn cannot have heard it.))',
    ])[0]
    assert out["asides"] == ["Careful - the Diary Room is sealed. Dawn cannot have heard it."]
    assert out["prose"] == '@[Dawn] - "So which is it?"'
    assert "((" not in out["prose"] and "))" not in out["prose"]


def test_mid_reply_aside_and_multiple_asides():
    out = _run("_extractInlineOocAsides", consts=("const _OOC_INLINE_RE =",), cases=[
        "She nods slowly. ((No HOH yet - the comp has not run.)) The room goes quiet.\n\n((Locked in.)) Nobody moves.",
    ])[0]
    assert out["asides"] == ["No HOH yet - the comp has not run.", "Locked in."]
    assert "((" not in out["prose"] and "))" not in out["prose"]
    assert "She nods slowly." in out["prose"] and "The room goes quiet." in out["prose"] and "Nobody moves." in out["prose"]


def test_stray_unbalanced_markers_are_dropped_not_rendered():
    out = _run("_extractInlineOocAsides", consts=("const _OOC_INLINE_RE =",), cases=["He laughs. )) Then he leaves ((", "A plain line."])
    assert "))" not in out[0]["prose"] and "((" not in out[0]["prose"]
    assert out[0]["asides"] == []
    assert out[1] == {"prose": "A plain line.", "asides": []}, "ordinary prose is byte-identical"


def test_no_aside_means_no_change():
    text = '@[Dawn] - "Nothing here but the story."\n\nShe lifts her glass.'
    out = _run("_extractInlineOocAsides", consts=("const _OOC_INLINE_RE =",), cases=[text])[0]
    assert out == {"prose": text, "asides": []}


# -- restated-reply collapse -----------------------------------------------------------------------

V1 = ('@[Dawn Whitaker] - She goes very still. "The diary room." She says the words slowly, like she is tasting them. '
      '"Marcus. That room has a lock on it and a voice behind the door that is not any of us. Whatever Luna said in there, I did not hear it."')
V2 = ('@[Dawn Whitaker] - She goes very still, and then her eyebrows climb. "The diary room." She says the words slowly, like she is tasting them '
      'for a joke. "Marcus. That room has a lock on it and a voice behind the door that is not any of us. If I told you I heard what Luna said, walk away."')


def test_a_restated_block_by_the_same_speaker_is_dropped_new_paragraphs_survive():
    new_beat = "@[Dawn Whitaker] - She sets her glass down on the side table, unhurried."
    out = _run("_collapseRestatedReply", [V1 + "\n\n" + V2 + "\n\n" + new_beat])[0]
    assert V1 in out
    assert "eyebrows climb" not in out, "the second rendition of the same answer is dropped"
    assert new_beat in out, "a genuinely new paragraph after the restatement is kept"


def test_distinct_blocks_and_other_speakers_are_never_collapsed():
    a = '@[Dawn Whitaker] - "I trust nobody in this house, and I am not about to start tonight, Marcus."'
    b = '@[Dawn Whitaker] - "Ask me again after the comp and I might tell you who I actually mean."'
    c = '@[Luna] - "I trust nobody in this house, and I am not about to start tonight, Marcus."'  # same words, DIFFERENT speaker
    text = a + "\n\n" + b + "\n\n" + c
    assert _run("_collapseRestatedReply", [text])[0] == text


def test_text_without_speaker_blocks_is_untouched():
    text = "The water hits the wall in sheets.\n\nThe water hits the wall in sheets and the wall tilts."
    assert _run("_collapseRestatedReply", [text])[0] == text


def test_a_restated_block_takes_its_untagged_continuation_paragraphs_with_it():
    cont = "She leans back against the counter and folds her arms across her chest."
    new_beat = "@[Dawn Whitaker] - She sets her glass down on the side table, unhurried."
    out = _run("_collapseRestatedReply", [V1 + "\n\n" + V2 + "\n\n" + cont + "\n\n" + new_beat])[0]
    assert "eyebrows climb" not in out and cont not in out, "the doubled block's continuation goes with it"
    assert new_beat in out


def test_one_shared_phrase_does_not_drop_a_paragraph_with_new_content():
    a = '@[Dawn Whitaker] - "I trust nobody in this house, and I am not about to start tonight, Marcus, not one single person."'
    b = ('@[Dawn Whitaker] - "Listen to me. I trust nobody in this house, and I am not about to start tonight, Marcus. Besides, the nominations '
         'are tomorrow and I have an entirely different plan for the veto that I have told no one about yet at all."')
    text = a + "\n\n" + b
    assert _run("_collapseRestatedReply", [text])[0] == text


def test_closing_parens_in_ordinary_prose_survive_without_an_opener():
    out = _run("_extractInlineOocAsides", consts=("const _OOC_INLINE_RE =",), cases=["He nods (quietly (very)) and leaves.", "He laughs. )) Then ((leaves"])
    assert out[0] == {"prose": "He nods (quietly (very)) and leaves.", "asides": []}
    assert out[1] == {"prose": "He laughs. Then leaves", "asides": []}
