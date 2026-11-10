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
    # frameBatch.js: markdown.js imports it once ORW-157 (#2261) lands; copied when present so this harness works on either side of it
    for name in ("markdown", "markdown.js", "emojiShortcodes.js", "streamingSegmenter.js", "streamingRenderer.js", "frameBatch.js"):
        src = os.path.join(STATIC_JS, name)
        if not os.path.exists(src):
            continue
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


# "speech" is the game's usual reply: `@[Name]` speaker lines, each continued by narration (indented as the same speech)
@pytest.mark.parametrize("kind", ["prose", "speech"])
def test_renders_per_token_stay_flat(measured, kind):
    a, b = measured[f"{kind}2000"], measured[f"{kind}8000"]
    # was ~10,000+ renders for ~500 deltas (20+ per token); now ~1 tail render per token + a few per block
    assert a["calls"] / a["deltas"] < 2.5, a
    assert b["calls"] / b["deltas"] < 2.5, b
    # independent of reply length (quadratic work would make the 8k reply cost far more PER token)
    assert (b["calls"] / b["deltas"]) < (a["calls"] / a["deltas"]) * 1.3, (a, b)


@pytest.mark.parametrize("kind", ["prose", "speech"])
def test_work_is_linear_in_new_text(measured, kind):
    a, b = measured[f"{kind}2000"], measured[f"{kind}8000"]
    ratio = b["chars"] / a["chars"]  # characters handed to the markdown renderer; 4x the text must cost ~4x (quadratic: ~16x)
    assert ratio < 7, f"markdown input grew {ratio:.1f}x for 4x the text (quadratic) - {a} {b}"


def test_streamed_output_matches_one_full_render(measured):
    assert measured["prose2000"]["parity"] and measured["prose8000"]["parity"]
    assert measured["speech2000"]["parity"] and measured["speech8000"]["parity"]
    assert measured["cases"]["mixed"]["parity"], measured["cases"]["mixed"]


def test_fenced_code_streams_without_the_fullrender_fallback(measured):
    f = measured["cases"]["fenced"]
    assert f["degraded"] == 0 and f["hasCode"] and f["hasAfter"], f


def test_loose_list_never_freezes_across_the_blank_line(measured):
    assert measured["looseListCommitted"] == 0
    assert measured["proseCommitted"] == measured["proseSplitAt"]  # ordinary prose freezes (the live tail's first line is still arriving)
    # a cut is judged only once the block AFTER it is complete, so the verdict never depends on how much of that block had arrived
    assert measured["proseCommittedHalf"] == measured["proseSplitAt"]
    assert measured["proseCommittedLater"] == measured["proseSplitLater"]


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
    # ...also for a NEW reply container (the OOC wrap flipped and the old one was removed): no empty mirror frame
    assert "state._replyPainted = false;" in live[live.index("state._replyRenderer = createStreamRenderer("):]
    # Greptile on #2260: the read loops must NOT flush per network chunk (that skipped the frame batching the sender has); each loop
    # flushes ONCE after it ends, on every way out ([DONE], end of stream, a drop), before its settle
    assert chat.count("_liveState._replyCo.now()") == 2
    for fn in ("async function _trySelfResume(", "export async function resumeStream("):
        body = chat[chat.index(fn):]
        body = body[:body.index("\n  }\n")]
        loop = body[body.index("readLoop:"):body.index("} catch (e) {", body.index("readLoop:"))]
        assert "_replyCo.now()" not in loop, fn
        after = body[body.index("} catch (e) {", body.index("readLoop:")):]
        assert after.index("_liveState._replyCo.now()") < min(i for i in (after.find("chatState._resumingStreams.delete"), after.find("cleanup();")) if i != -1), fn


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
    # nothing is frozen past (or just before) an aside, so even a mid-reply ((aside)) streams to exactly the settled render
    assert r["parity"], case


def test_the_scrubs_are_really_on_in_the_harness(measured):
    # otherwise the prefix test above is vacuous: the final render must actually hide the leak text
    assert measured["scrubActive"]["npc"] and measured["scrubActive"]["op"], measured["scrubActive"]


# ---- context markers: speech and asides depend on OTHER paragraphs, so they are never split across frozen chunks (ship gate F5) --------
CONTEXT_CASES = ["continuation", "handOff", "restated", "asideMultiLine"]


@pytest.mark.parametrize("case", CONTEXT_CASES)
def test_live_render_equals_a_full_render_at_every_step(measured, case):
    """A speaker line indents the paragraphs that continue its speech (not the one handing off to the next speaker), and F-6 drops a
    later block that restates an earlier block by the same speaker (Greptile on #2260). Neither can be decided by one frozen piece on
    its own: each piece is rendered in its speech context, a restatement latches the whole-reply render, and asides never freeze. So the
    live DOM must equal a full render of the same text at EVERY step, as the pre-ORW-156 full re-render did."""
    live = measured["speech"][case]["live"]
    assert live["at"] is None, live


@pytest.mark.parametrize("case", CONTEXT_CASES)
def test_a_late_joining_mirror_paints_the_same_dom_as_the_sender(measured, case):
    """Where a reply gets frozen must not depend on how its deltas arrived: a window that joins mid-stream (one update with everything so
    far) paints exactly the DOM of the window that streamed it delta by delta. With an aside judged early (opened, not yet closed) the
    two used to place the producer-aside bubble differently."""
    assert measured["speech"][case]["lateJoin"] == [], measured["speech"][case]["lateJoin"]


def test_the_speech_cases_are_not_vacuous(measured):
    assert measured["speechQuoteCountSettled"] == 1  # the settled render really collapses the restated answer
    assert measured["speechContIndented"]  # ...and really indents a continued speech


@pytest.mark.parametrize("case", ["continuation", "handOff"])
def test_a_speech_keeps_freezing_with_its_context(measured, case):
    # the paragraphs of a speech are frozen too (each piece rendered in its speech context), not held in the live tail
    assert measured["speech"][case]["live"]["frozenMax"] >= 4, measured["speech"][case]


def test_an_aside_stops_even_a_completed_code_fence_from_freezing(measured):
    # the closed-fence branch used to freeze unconditionally, past an open aside; now nothing at or just before the aside freezes
    assert measured["asideFenceCommitted"] == 0 < measured["asideAt"]


def test_two_windows_paint_the_same_dom_at_every_step_on_random_replies(measured):
    """Fixed-seed random game replies (speech, narration, lists, quotes, headings, code fences, scrubbed lines, restatements): a window
    that joins at ANY step paints exactly the DOM of the window that streamed the reply (ship gate F5)."""
    r = measured["random"]
    assert r["cases"] == 30 and r["stepMismatch"] == 0, r["firstBad"]


def test_random_replies_settle_to_the_full_render(measured):
    # the one documented exception is a reply whose last line is a bare `@[Name]` tag (see the harness)
    r = measured["random"]
    assert r["endMismatch"] == 0, r["firstBad"]


def test_the_restatement_watch_makes_exactly_the_f6_collapse_decision(measured):
    """markdown.js keeps F-6's rules in two places (_collapseRestatedReply stays self-contained; createRestatementWatch is its
    incremental twin). On random replies the watch must agree with the real function on the whole text and at every paragraph-aligned
    prefix, and fed in random deltas it must never miss a collapse (an early yes only costs speed)."""
    w = measured["watch"]
    assert w["cases"] == 150 and w["collapsing"] >= 20, w  # non-vacuous: plenty of replies really collapse
    assert w["whole"] == 0 and w["prefix"] == 0 and w["falseNeg"] == 0, w
