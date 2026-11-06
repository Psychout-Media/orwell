"""ORW-156 - streaming render cost: the per-token work is O(new text), not O(reply so far).

Root cause (audit report A, 4.1): `cutIsRenderSafe` compared `render(a) + render(b)` with `render(a + b)`, but the renderer joins
blocks with a blank-line separator, so the strict equality was false for ordinary prose -> `committedLen` stayed 0 -> every delta
re-rendered the WHOLE reply (and re-ran 3 renders per candidate boundary): ~10,000 markdown renders for a 2,000-char reply.

Fix: (1) the cut check ignores inter-block whitespace and each boundary is proven ONCE (memoised in the renderer); (2) chat.js coalesces
the plain-delta render to one per animation frame; every non-delta event flushes it first.

Behavioural legs drive the REAL streamingRenderer.js / streamingSegmenter.js / markdown.js in Node with a fake DOM and COUNT markdown renders.
"""
import json
import os
import re
import shutil
import subprocess

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_JS = os.path.join(FRONTEND, "static", "js")
HARNESS = os.path.join(FRONTEND, "tests", "js", "orw156_stream_render_harness.mjs")
_NODE = shutil.which("node")


def _read(*parts):
    with open(os.path.join(FRONTEND, *parts), encoding="utf-8") as f:
        return f.read()


@pytest.fixture(scope="module")
def measured(tmp_path_factory):
    if not _NODE:
        pytest.skip("node not available")
    d = tmp_path_factory.mktemp("orw156")
    for name in ("markdown", "markdown.js", "emojiShortcodes.js", "streamingSegmenter.js", "streamingRenderer.js"):
        src = os.path.join(STATIC_JS, name)
        if os.path.isdir(src):
            shutil.copytree(src, d / name)
        else:
            shutil.copy(src, d / name)
    md = (d / "markdown.js").read_text(encoding="utf-8")
    md = md.replace("import uiModule from './ui.js';", "const uiModule = { esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;') };")
    (d / "markdown.js").write_text(md, encoding="utf-8")
    (d / "package.json").write_text('{"type":"module"}', encoding="utf-8")
    p = subprocess.run([_NODE, HARNESS, str(d)], capture_output=True, text=True, timeout=120)
    assert p.returncode == 0, p.stderr[-2000:]
    return json.loads(p.stdout.strip().splitlines()[-1])


def test_renders_per_token_stay_flat(measured):
    a, b = measured["prose2000"], measured["prose8000"]
    # was ~10,000+ renders for ~500 deltas (20+ per token); now ~1 tail render per token + a few per block
    assert a["calls"] / a["deltas"] < 2.5, a
    assert b["calls"] / b["deltas"] < 2.5, b
    # independent of reply length (quadratic work would make the 8k reply cost far more PER token)
    assert (b["calls"] / b["deltas"]) < (a["calls"] / a["deltas"]) * 1.3, (a, b)


def test_work_is_linear_in_new_text(measured):
    a, b = measured["prose2000"], measured["prose8000"]
    ratio = b["chars"] / a["chars"]  # characters handed to the markdown renderer; 4x the text must cost ~4x (quadratic: ~16x)
    assert ratio < 7, f"markdown input grew {ratio:.1f}x for 4x the text (quadratic) - {a} {b}"


def test_streamed_output_matches_one_full_render(measured):
    assert measured["prose2000"]["parity"] and measured["prose8000"]["parity"]
    assert measured["cases"]["mixed"]["parity"], measured["cases"]["mixed"]


def test_fenced_code_streams_without_the_fullrender_fallback(measured):
    f = measured["cases"]["fenced"]
    assert f["degraded"] == 0 and f["hasCode"] and f["hasAfter"], f


def test_loose_list_never_freezes_across_the_blank_line(measured):
    assert measured["looseListCommitted"] == 0
    assert measured["proseCommitted"] == measured["proseSplitAt"]  # ordinary prose freezes (the live tail's first line is still arriving)
    assert measured["proseCommittedLater"] == measured["proseSplitLater"]  # ...and one block further once that line is complete


# ---- source pins: chat.js keeps its conventions around the coalescing ----------------------------------------------------------------
def test_chat_js_coalesces_only_the_plain_delta_render():
    chat = _read("static", "js", "chat.js")
    assert "function _makeFrameCoalescer(run)" in chat
    co = chat[chat.index("function _makeFrameCoalescer(run)"):]
    co = co[:co.index("\n  }\n")]
    assert "requestAnimationFrame(fire)" in co and "setTimeout(fire, 100)" in co  # rAF + a 100 ms backstop: replies appear in a hidden/backgrounded window
    assert "const _renderStreamSoon = () =>" in chat and "document.hidden" in chat
    # exactly one sender call site: the "Normal streaming" branch; the thinking/tool/agent/settle paths stay synchronous
    assert chat.count("_renderStreamSoon();") == 1
    branch = chat[chat.index("// Normal streaming\n"):]
    assert branch[:400].count("_renderStreamSoon();") == 1
    # a non-delta event flushes the pending frame render before doing anything else; the sync render supersedes it
    assert "if (!json.delta) _flushStreamSoon();" in chat
    assert re.search(r"_renderStream = \(\) => \{\n\s+_streamCo\.cancel\(\);", chat)
    # the settle `finally` never paints a late frame, and keeps the F5 pin (test_f5_empty_assistant_bubble) on `} finally {\n clearResponseTimeout();`
    assert "_streamCo.cancel();   // ORW-156: never paint a frame after the turn settled" in chat
    assert "    } finally {\n      clearResponseTimeout();" in chat
    # each round's segment paints its first text synchronously again
    assert "_streamRenderedOnce = false;   // ORW-156: the next round's segment" in chat


def test_sender_and_mirror_share_one_coalescer():
    chat = _read("static", "js", "chat.js")
    live = chat[chat.index("  function _renderLiveStream(contentDiv, replyText"):]
    live = live[:live.index("\n  }\n")]
    assert "_makeFrameCoalescer(" in live and "state._replyCo.soon()" in live  # the mirror/observer paints through the same helper
    assert "!state._replyPainted" in live  # ...with a synchronous first paint
    # every observer settle flushes the coalesced paint before the canonical rebuild
    assert chat.count("_liveState._replyCo.now()") == 4


def test_reasoning_still_never_reaches_the_body():
    chat = _read("static", "js", "chat.js")
    body = chat[chat.index("// Direct render helper for streaming text"):]
    body = body[:body.index("const _commitRoundSegment")]
    assert "stripToolBlocks(roundReplyText)" in body  # reply-only buffer (F8 channel split)
    code = "\n".join(ln for ln in body.splitlines() if not ln.strip().startswith("//"))
    assert "roundReasoningText" not in code


@pytest.mark.parametrize("case", ["asideSpanningBlocks", "npcIdLine", "operatorAsideMiddle", "operatorAsideStandalone"])
def test_a_frozen_block_never_shows_text_the_final_render_hides(measured, case):
    """With the real game-build scrubs on (scrubReasoningPreamble, scrubMachineryAsides, redactRawIds, the ((aside)) wrap), freezing finished
    blocks must never paint something the settled render would hide: every frozen prefix is a prefix of the final render."""
    r = measured["scrub"][case]
    assert r["bad"] == [], r
    if case != "asideSpanningBlocks":  # a mid-reply ((aside)) is settled by chat.js re-rendering the finished message from source; mid-stream only "never un-show" matters
        assert r["parity"], case


def test_the_scrubs_are_really_on_in_the_harness(measured):
    # otherwise the prefix test above is vacuous: the final render must actually hide the leak text
    assert measured["scrubActive"]["npc"] and measured["scrubActive"]["op"], measured["scrubActive"]
