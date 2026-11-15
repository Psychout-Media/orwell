"""adaptiveGlass.js — PERFORMANCE hardening (#1315) SOURCE-PINS.

The dominant glass/transcript cost was adaptiveGlass's per-scheduled-tick re-walk of EVERY
`.msg-ai` bubble — O(transcript) work (getBoundingClientRect + canvas getImageData + inline
style writes, read↔write interleaved) fired dozens of times per streamed reply. This gate pins
the three structural fixes so they can't silently regress:

  1. SCOPED PASS — a chat DOM mutation marks only the AFFECTED bubbles dirty
     (`_collectAdaptive` → `_markElDirty`), so a streamed reply costs O(changed bubbles).
     A "full" trigger (scroll/resize/theme/backdrop) still re-samples everything (`_allDirty`).
  2. BATCHED READS — the pass reads ALL rects (+ one backdrop sample each) in a READ PHASE,
     THEN flushes all style writes in a WRITE PHASE — no per-element layout thrash. applyTo
     takes a cached rect + a presample so the write phase does zero layout reads.
  3. VIEWPORT CAP — bubbles far outside the viewport are skipped (the wallpaper is fixed →
     they are re-sampled on the scroll that brings them near).

The visual OUTPUT for on-screen bubbles is unchanged (same polarity/scrim/ink math via the
untouched resolveBubbleScrim/apcaContrast helpers). The FE has no DOM runtime in pytest, so
these are source-pinned like the sibling glass gates. Roles only, no names, no engine/network.
"""
import os
import re

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _read(*parts):
    with open(os.path.join(FRONTEND, *parts), encoding="utf-8") as f:
        return f.read()


JS = _read("static", "js", "adaptiveGlass.js")


def _pass_body():
    return JS[JS.index("function pass()"):JS.index("function _dropTagged(")]


def _init_body():
    return JS[JS.index("function init()"):JS.index("if (document.readyState")]


# ── 1. scoped-pass dirty tracking ─────────────────────────────────────────────

def test_scoped_dirty_state_exists():
    assert "_allDirty" in JS and "_dirtyEls" in JS
    assert "function _markAllDirty(" in JS
    assert "function _markElDirty(" in JS
    assert "function _collectAdaptive(" in JS


def test_chat_mutations_are_scoped_not_a_full_rewalk():
    # The #chat-history observer must resolve the AFFECTED adaptive elements (_collectAdaptive)
    # rather than blindly marking everything dirty — that is the streaming O(1) win. It must NOT
    # be the old `new MutationObserver(schedule)` bare form on chat-history.
    init = _init_body()
    chat_seg = init[init.index('getElementById("chat-history")'):]
    assert "_collectAdaptive(" in chat_seg, "the chat observer must collect only affected bubbles"
    assert "addedNodes" in chat_seg, "a freshly added bubble must be collected"
    # it must NOT call _markAllDirty for an ordinary chat mutation (that would defeat the scoping).
    obs_cb = chat_seg[chat_seg.index("new MutationObserver"):chat_seg.index("cmo.observe")]
    assert "_markAllDirty" not in obs_cb, "a chat mutation must stay SCOPED, never mark all dirty"


def test_full_triggers_mark_all_dirty():
    # scroll / resize / theme(body) / media-query all MOVE the backdrop behind the bubbles → a full
    # re-sample. They route through fullSchedule (which calls _markAllDirty), never bare schedule.
    assert "function fullSchedule(" in JS
    assert "_markAllDirty();" in JS
    init = _init_body()
    assert re.search(r'addEventListener\("resize",\s*fullSchedule', init)
    # ORW-158: scroll is still a full trigger (it marks all dirty) but is DEBOUNCED to the burst's end.
    assert re.search(r'addEventListener\("scroll",\s*scrollSchedule', init)
    assert "function scrollSchedule(" in JS and "_markAllDirty();" in JS[JS.index("function scrollSchedule("):JS.index("function init(")]
    # the body (theme/backdrop) observer is a full trigger too.
    assert "new MutationObserver(fullSchedule)" in init


def test_scoped_pass_consumes_dirty_set_and_filters_disconnected():
    body = _pass_body()
    # the pass consumes _allDirty up front, then either walks everything (full) or the dirty set.
    assert "var full = _allDirty;" in body
    assert "_allDirty = false;" in body
    assert "_dirtyEls = null;" in body
    # scoped candidates are filtered to still-connected, still-adaptive elements.
    assert "isConnected" in body and "matches(ADAPTIVE_SEL)" in body


def test_mark_all_dirty_drops_the_pending_scoped_set():
    # STALE-SET LEAK guard (CodeRabbit, PR #1332): _markAllDirty must ALSO reset _dirtyEls.
    # Without it, elements marked dirty BEFORE a full trigger linger in the set: the full pass
    # consumes _allDirty (covering them), and the NEXT scoped mutation then re-samples the stale
    # leftovers on top of its own target — a silent partial re-walk. Pin the reset inside
    # _markAllDirty, and the _allDirty short-circuit inside _markElDirty (no accumulation while
    # a full pass is pending).
    mark_all = JS[JS.index("function _markAllDirty("):JS.index("function _markElDirty(")]
    assert "_allDirty = true;" in mark_all
    assert "_dirtyEls = null;" in mark_all, \
        "_markAllDirty must drop the pending scoped set (stale-set leak)"
    mark_el = JS[JS.index("function _markElDirty("):JS.index("function _collectAdaptive(")]
    first_stmt_region = mark_el[:mark_el.index("new Set()")]
    assert re.search(r"if \(_allDirty \|\| !el\) return;", first_stmt_region), \
        "_markElDirty must short-circuit while a full pass is pending"
    # belt-and-braces: the full branch of pass() clears the set too (invariant holds however
    # _allDirty was raised).
    body = _pass_body()
    full_branch = body[body.index("if (full) {"):body.index("} else {")]
    assert "_dirtyEls = null;" in full_branch, \
        "the full pass must clear _dirtyEls (no scoped leftovers)"


# ── 2. batched reads-then-writes ──────────────────────────────────────────────

def test_read_phase_precedes_write_phase():
    body = _pass_body()
    assert "READ PHASE" in body and "WRITE PHASE" in body
    # ALL getBoundingClientRect reads happen before ANY applyTo style write.
    read_idx = body.index("getBoundingClientRect")
    write_idx = body.index("applyTo(work[")
    assert read_idx < write_idx, "rects must be read (batched) BEFORE the write phase runs applyTo"


def test_write_phase_does_no_layout_reads():
    # The write loop must not re-read layout (getBoundingClientRect / offsetParent) — that would
    # reintroduce the read↔write thrash the batching removes.
    body = _pass_body()
    write_loop = body[body.index("WRITE PHASE"):]
    assert ".getBoundingClientRect(" not in write_loop, "write phase must not read layout"
    assert "offsetParent" not in write_loop, "write phase must not read offsetParent (forces layout)"


def test_applyto_takes_cached_rect_and_presample():
    # applyTo is called with the batched rect + the one-shot backdrop sample; the layout read and
    # the canvas sampling happen ONCE in the read phase, not again per write.
    assert "function applyTo(el, cachedRect, presampled)" in JS
    assert "var r = cachedRect || el.getBoundingClientRect();" in JS
    # L / bubble bg / hero bg all honour the presample instead of re-sampling.
    assert "presampled ? presampled.L" in JS
    assert "presampled ? presampled.rgb" in JS


def test_single_combined_backdrop_sampler():
    # _sampleBackdrop computes BOTH luminance and average colour in ONE grid loop, halving the
    # getImageData work vs the old backdropLuminance + backdropAvgColor double pass.
    assert "function _sampleBackdrop(" in JS
    samp = JS[JS.index("function _sampleBackdrop("):JS.index("// #744 — for a received bubble")]
    # exactly one getImageData call inside the sampler's grid loop (one pass, not two).
    assert samp.count("getImageData") == 1, "the combined sampler must read the grid once"
    assert "L:" in samp and "rgb:" in samp, "it returns both L and rgb from the single pass"
    # the pass's read phase uses it.
    assert "_sampleBackdrop(" in _pass_body()


# ── 3. viewport-proximity cap ─────────────────────────────────────────────────

def test_offviewport_bubbles_are_skipped():
    body = _pass_body()
    # a one-viewport look-ahead margin, and the cull test on the batched rect.
    assert "margin = vh" in body
    assert re.search(r"r\.bottom < -margin \|\| r\.top > vh \+ margin", body), \
        "bubbles far outside the viewport (±1 screen) must be culled"
    # the hero is never culled (welcome screen, always in view).
    assert "hero" in body and "!hero" in body


# ── cross-cutting: the visual math + standdown are untouched ───────────────────

def test_bubble_and_hero_math_helpers_are_intact():
    # the perf refactor must not touch the polarity/scrim/ink resolvers (identical visual output).
    for fn in ("resolveBubbleScrim", "_escalateScrim", "_hardenToFloor",
               "resolveHeroInk", "resolveMutedInk", "apcaContrast", "compositeOver"):
        assert "function " + fn in JS, fn
    # the muted-token floor still runs on a FULL pass (it reads the whole-viewport backdrop).
    assert "_floorMutedToken();" in _pass_body()
    # the frosted standdown selector stays the pinned form.
    assert 'var ADAPTIVE_SEL = BUBBLE_ADAPTIVE + ", " + HERO_ADAPTIVE;' in JS


def test_still_debounced_and_fail_soft():
    assert "DEBOUNCE_MS" in JS
    assert JS.count("catch (_)") >= 10  # pervasive fail-soft preserved


def test_scroll_burst_runs_one_pass_not_one_per_120ms():
    """ORW-158: execute the real scrollSchedule against fake timers. 100 scroll events 30ms apart (3s of auto-scroll) used to be ~25 passes; now a handful (max-wait bound), and one trailing pass after idle."""
    import json, shutil, subprocess
    node = shutil.which("node")
    if not node:
        import pytest
        pytest.skip("node unavailable")
    start = JS.index("  var SCROLL_IDLE_MS")
    end = JS.index("  function init()")
    snippet = JS[start:end]
    harness = """
let now = 0, timers = [], passes = 0, marks = 0, id = 0;
const Date_ = { now: () => now };
function setTimeout_(fn, ms) { const t = { id: ++id, at: now + ms, fn }; timers.push(t); return t.id; }
function clearTimeout_(i) { timers = timers.filter(t => t.id !== i); }
function _markAllDirty() { marks++; }
function schedule() { passes++; }
const run = new Function('Date', 'setTimeout', 'clearTimeout', '_markAllDirty', 'schedule', %s + '; return scrollSchedule;');
const scrollSchedule = run(Date_, setTimeout_, clearTimeout_, _markAllDirty, schedule);
function advance(to) { while (true) { timers.sort((a, b) => a.at - b.at); const t = timers[0]; if (!t || t.at > to) break; timers.shift(); now = t.at; t.fn(); } now = to; }
for (let i = 0; i < 100; i++) { scrollSchedule(); advance(now + 30); }
const during = passes;
advance(now + 2000);
console.log(JSON.stringify({ during, total: passes, marks }));
""" % json.dumps(snippet)
    out = subprocess.run([node, "-e", harness], capture_output=True, text=True, timeout=30)
    assert out.returncode == 0, out.stderr
    r = json.loads(out.stdout.strip())
    assert r["marks"] == 100, "every scroll still marks all dirty (correctness: a later pass re-samples everything)"
    assert r["during"] <= 3, f"3s of continuous scroll must not run a pass per 120ms: {r}"
    assert r["total"] == r["during"] + 1, f"exactly one trailing pass after the burst goes idle: {r}"
