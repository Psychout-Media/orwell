"""M3-2 · Speaker-attributed dialogue (the microformat) — render-contract gate.

The narrator may attribute a spoken line to a houseguest with a SANCTIONED, line-leading
speaker tag ``@[Full Name]``; the game-build renderer (markdown.js) turns it into that
person's face chip (an OrwellMonogram) in the bubble gutter beside the line. This is an
INVERSION of the existing raw-id scrub: a well-formed tag becomes a chip, while a bare /
malformed ``npc:<id>`` still scrubs exactly as before (the L6b/#1047 gates own that half).

The render contract, proven by driving the PURE markdown.js helpers through Node (no DOM):
  · tagged    — a line-leading ``@[Name]`` becomes one chip + a flex speaker line, dialogue kept.
  · untagged  — ordinary prose is byte-identical (no chip, no change).
  · malformed — an unclosed ``@[Name`` fails OPEN (swallowed until it completes; never a
                chip, never raw markup); a bare ``npc:3`` is NEVER promoted to a chip.
  · split-chunk — a tag arriving across stream deltas shows nothing until the closing ``]``.
Plus source-level asserts that the wiring is in place (extract before the id-scrubs, restore
after mdToHtml, the mdToHtml fail-open degrade, exports), and that the game-build scrub still
redacts raw ids (the existing gate stays green — asserted structurally here, exercised by the
L6b/#1047 suites).

#1638 — the sanctioned tag is OPTIONAL, and in real play the narrator reliably skips it,
writing its own house style instead: a line-leading BOLD houseguest name
(``**Full Name** does something.`` / ``**Full Name:** "quote"``). `extractSpeakerTags` gained a
SECOND, narrower pass (`_SPEAKER_BOLD_LINE_RE` + `_isKnownRosterName`) that recognizes that
pattern too — but ONLY when the bold text is an EXACT (case/whitespace-insensitive) live-roster
name, never fuzzy/partial/non-roster — and routes it into the SAME `.ow-speaker-line` chip
machinery. Unlike the sanctioned tag (which IS machinery and is fully consumed), this is pure
STYLING: it only ever INSERTS a placeholder ahead of the bold run, never touches the
`**Name**`/`**Name:**` markdown itself (ADR 0005 — never normalize/rewrite creative prose). The
render-contract battery below is extended with a roster-stubbed Node harness
(`_run_natural_battery`) to cover: a natural-style line gets a chip with its prose preserved
verbatim; non-roster bold is untouched; a sanctioned-tagged line is never ALSO matched by the
bold pass (no double chip); a mid-sentence bold mention (not line-leading) is untouched; and
the fallback fails closed (no chip) with no roster resolver wired at all (headless / cold
cache), exactly like every other malformed-input case in this suite.
"""

import json
import os
import re
import shutil
import subprocess

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_NODE = shutil.which("node")
MD = os.path.join(FRONTEND, "static", "js", "markdown.js")


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


# ── source-level wiring (no Node needed) ───────────────────────────────────────────── #

def test_helpers_defined_and_exported():
    md = _read("static", "js", "markdown.js")
    assert "export function extractSpeakerTags(" in md
    assert "export function restoreSpeakerChips(" in md
    export_block = md[md.index("const markdownModule = {"):]
    export_block = export_block[:export_block.index("};")]
    assert "extractSpeakerTags," in export_block
    assert "restoreSpeakerChips," in export_block


def test_extract_runs_before_the_id_scrubs_and_restore_after_mdtohtml():
    md = _read("static", "js", "markdown.js")
    pwt = md[md.index("export function processWithThinking"):]
    gated = pwt[pwt.index("if (gameBuildSuppressesThinking())"):]
    gated = gated[:gated.index("let html = ''")]
    # extraction happens, and BEFORE scrubReasoningPreamble / redactRawIds (which key on npc:<id>)
    assert "extractSpeakerTags(" in gated
    assert gated.index("extractSpeakerTags(") < gated.index("scrubReasoningPreamble(")
    assert gated.index("extractSpeakerTags(") < gated.index("redactRawIds(")
    # restoration happens on the rendered reply HTML (wrapping mdToHtml)
    assert "restoreSpeakerChips(mdToHtml(reply)" in gated


def test_mdtohtml_has_the_fail_open_degrade():
    md = _read("static", "js", "markdown.js")
    # a leftover name-only tag collapses to the bare name; the id-bearing form sheds its `@`
    assert r"s.replace(/@\[([^\]\n]{1,80})\](?!\()/g, '$1')" in md
    assert r"s.replace(/@(\[[^\]\n]{1,80}\]\(npc:\d+\))/g, '$1')" in md


def test_raw_id_scrub_is_untouched_by_this_feature():
    # The inversion is ADDITIVE — the existing raw-id redaction must still exist verbatim so a
    # bare/malformed npc:<id> keeps scrubbing (the L6b/#1047 suites exercise the behavior).
    md = _read("static", "js", "markdown.js")
    assert "const _RAW_NPC_ID_GLOBAL_RE = /\\bnpc:\\d+\\b" in md
    assert "export function redactRawIds(" in md


# ── Node round-trip of the pure helpers (the render contract) ───────────────────────── #

def _run_battery(cases):
    """Drive the pure markdown.js speaker-chip helpers in Node over a battery of fixtures.
    Grabs the constants + helper functions straight out of markdown.js (no DOM, no imports),
    plus the two mdToHtml fail-open degrade regexes lifted from source, and returns their
    JSON-encoded results for assertion."""
    program = r"""
    const fs = require('fs');
    const src = fs.readFileSync(process.argv[1], 'utf8');
    function grab(marker, end) {
      const i = src.indexOf(marker); const j = src.indexOf(end, i);
      return src.slice(i, j + end.length);
    }
    function grabFn(marker) {
      let fn = src.slice(src.indexOf(marker));
      fn = fn.slice(0, fn.indexOf('\n}\n') + 2).replace('export function', 'function');
      return fn;
    }
    // A minimal escapeHtml (markdown.js aliases uiModule.esc); headless there is no window /
    // document, so the monogram kit is absent and the chip falls back to an initials tile.
    const escapeHtml = "function escapeHtml(s){return String(s==null?'':s)"
      + ".replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')"
      + ".replace(/\"/g,'&quot;').replace(/'/g,'&#39;');}";
    // The two mdToHtml fail-open degrade regexes, lifted from source so the test can't drift.
    const degrade = [...src.matchAll(/s\.replace\((\/@[^\n]*?\/g), '\$1'\)/g)].map(m => m[1]);
    const body = [
      escapeHtml,
      grab('const _SPEAKER_TAG_RE = ', ';'),
      grab('const _SPEAKER_TRAILING_PARTIAL_RE = ', ';'),
      grab('const _SPEAKER_BOLD_LINE_RE = ', ';'),
      grabFn('function _speakerInitials'),
      grabFn('function _resolveSpeakerSeed'),
      grabFn('function _isKnownRosterName'),
      grabFn('function ensureSpeakerCss'),
      grabFn('function _speakerChipHtml'),
      grab('const _SPEAKER_SCAN_VOID_TAGS = ', ';'),
      grabFn('function _scanTopLevelBlocks'),
      grabFn('function _extendSpeakerContinuations'),
      grab('const _CODE_FENCE_RE = ', ';'),
      grabFn('function _codeLineIndices'),
      grabFn('function _lineIndexAtOffset'),
      grabFn('export function extractSpeakerTags'),
      grabFn('export function restoreSpeakerChips'),
      'const _DEGRADE = [' + degrade.join(',') + '];',
      'function degradeTags(s){ for (const re of _DEGRADE) s = s.replace(re, "$1"); return s; }',
    ].join('\n');
    const api = (new Function(body + '\nreturn {extractSpeakerTags, restoreSpeakerChips, degradeTags, DEGRADE_N:_DEGRADE.length};'))();
    const cases = JSON.parse(process.argv[2]);
    const out = {};
    for (const [name, input] of Object.entries(cases)) {
      const ex = api.extractSpeakerTags(input);
      // Simulate the paragraph mdToHtml would emit for a line-leading placeholder, then restore.
      const wrapped = ex.text.split('\n').filter(Boolean)
        .map(l => '<p>' + l + '</p>').join('');
      const restored = api.restoreSpeakerChips(wrapped, ex.chips);
      const restoredTwice = api.restoreSpeakerChips(restored, ex.chips);
      out[name] = { text: ex.text, chips: ex.chips, restored, restoredTwice,
                    degraded: api.degradeTags(input), degradeN: api.DEGRADE_N };
    }
    process.stdout.write(JSON.stringify(out));
    """
    res = subprocess.run([_NODE, "-e", program, "--", MD, json.dumps(cases)],
                         capture_output=True, text=True, timeout=60)
    assert res.returncode == 0, f"node failed: {res.stderr}"
    return json.loads(res.stdout)


def _run_html_battery(cases):
    """Drive restoreSpeakerChips directly over hand-built {html, chips} fixtures (bypassing the
    per-line paragraph simulation in `_run_battery`) — needed for fixtures that inject a
    non-<p> top-level block (a list/blockquote) between paragraphs, which `_run_battery`'s
    one-<p>-per-line wrap can't produce. Also returns a second, independent call so callers can
    assert idempotency (running the transform twice on its own output ⇒ same DOM)."""
    program = r"""
    const fs = require('fs');
    const src = fs.readFileSync(process.argv[1], 'utf8');
    function grab(marker, end) {
      const i = src.indexOf(marker); const j = src.indexOf(end, i);
      return src.slice(i, j + end.length);
    }
    function grabFn(marker) {
      let fn = src.slice(src.indexOf(marker));
      fn = fn.slice(0, fn.indexOf('\n}\n') + 2).replace('export function', 'function');
      return fn;
    }
    const escapeHtml = "function escapeHtml(s){return String(s==null?'':s)"
      + ".replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')"
      + ".replace(/\"/g,'&quot;').replace(/'/g,'&#39;');}";
    const body = [
      escapeHtml,
      grabFn('function _speakerInitials'),
      grabFn('function _resolveSpeakerSeed'),
      grabFn('function ensureSpeakerCss'),
      grabFn('function _speakerChipHtml'),
      grab('const _SPEAKER_SCAN_VOID_TAGS = ', ';'),
      grabFn('function _scanTopLevelBlocks'),
      grabFn('function _extendSpeakerContinuations'),
      grabFn('export function restoreSpeakerChips'),
    ].join('\n');
    const api = (new Function(body + '\nreturn {restoreSpeakerChips};'))();
    const cases = JSON.parse(process.argv[2]);
    const out = {};
    for (const [name, c] of Object.entries(cases)) {
      const restored = api.restoreSpeakerChips(c.html, c.chips);
      const restoredTwice = api.restoreSpeakerChips(restored, c.chips);
      out[name] = { restored, restoredTwice };
    }
    process.stdout.write(JSON.stringify(out));
    """
    res = subprocess.run([_NODE, "-e", program, "--", MD, json.dumps(cases)],
                         capture_output=True, text=True, timeout=60)
    assert res.returncode == 0, f"node failed: {res.stderr}"
    return json.loads(res.stdout)


def _run_natural_battery(cases, roster):
    """Like `_run_battery`, but ALSO stubs `window.orwellResolveHouseguestId` (the same global
    hook the real orwellMonogram.js cast-roster cache installs — see markdown.js's
    `_resolveSpeakerSeed`/`_isKnownRosterName`) so the #1638 natural-style bold-name fallback
    (`_SPEAKER_BOLD_LINE_RE`) can actually fire. `roster` is the list of exact houseguest names
    the stub treats as live-roster names — a case/whitespace-insensitive lookup, mirroring the
    real `cardFor`'s `.trim().toLowerCase()` match; any other name resolves to null, exactly
    like a name that is not a real houseguest (or no roster loaded at all)."""
    program = r"""
    const fs = require('fs');
    const src = fs.readFileSync(process.argv[1], 'utf8');
    function grab(marker, end) {
      const i = src.indexOf(marker); const j = src.indexOf(end, i);
      return src.slice(i, j + end.length);
    }
    function grabFn(marker) {
      let fn = src.slice(src.indexOf(marker));
      fn = fn.slice(0, fn.indexOf('\n}\n') + 2).replace('export function', 'function');
      return fn;
    }
    const escapeHtml = "function escapeHtml(s){return String(s==null?'':s)"
      + ".replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')"
      + ".replace(/\"/g,'&quot;').replace(/'/g,'&#39;');}";
    const roster = JSON.parse(process.argv[3]);
    const rosterLower = {};
    for (const nm of roster) rosterLower[String(nm).trim().toLowerCase()] = true;
    // A minimal stand-in for the real orwellMonogram.js roster resolver: exact
    // (case/whitespace-folded) lookup only — never substring/fuzzy.
    const windowStub = 'var window = { orwellResolveHouseguestId: function (name) {'
      + ' var k = String(name || "").trim().toLowerCase();'
      + ' return (' + JSON.stringify(rosterLower) + ')[k] ? ("npc:" + k.replace(/[^a-z0-9]+/g, "-")) : null;'
      + ' } };';
    const body = [
      windowStub,
      escapeHtml,
      grab('const _SPEAKER_TAG_RE = ', ';'),
      grab('const _SPEAKER_TRAILING_PARTIAL_RE = ', ';'),
      grab('const _SPEAKER_BOLD_LINE_RE = ', ';'),
      grabFn('function _speakerInitials'),
      grabFn('function _resolveSpeakerSeed'),
      grabFn('function _isKnownRosterName'),
      grabFn('function ensureSpeakerCss'),
      grabFn('function _speakerChipHtml'),
      grab('const _SPEAKER_SCAN_VOID_TAGS = ', ';'),
      grabFn('function _scanTopLevelBlocks'),
      grabFn('function _extendSpeakerContinuations'),
      grab('const _CODE_FENCE_RE = ', ';'),
      grabFn('function _codeLineIndices'),
      grabFn('function _lineIndexAtOffset'),
      grabFn('export function extractSpeakerTags'),
      grabFn('export function restoreSpeakerChips'),
    ].join('\n');
    const api = (new Function(body + '\nreturn {extractSpeakerTags, restoreSpeakerChips};'))();
    const cases = JSON.parse(process.argv[2]);
    const out = {};
    for (const [name, input] of Object.entries(cases)) {
      const ex = api.extractSpeakerTags(input);
      const wrapped = ex.text.split('\n').filter(Boolean)
        .map(l => '<p>' + l + '</p>').join('');
      const restored = api.restoreSpeakerChips(wrapped, ex.chips);
      const restoredTwice = api.restoreSpeakerChips(restored, ex.chips);
      out[name] = { text: ex.text, chips: ex.chips, restored, restoredTwice };
    }
    process.stdout.write(JSON.stringify(out));
    """
    res = subprocess.run(
        [_NODE, "-e", program, "--", MD, json.dumps(cases), json.dumps(roster)],
        capture_output=True, text=True, timeout=60)
    assert res.returncode == 0, f"node failed: {res.stderr}"
    return json.loads(res.stdout)


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_render_contract_tagged_untagged_malformed_split():
    r = _run_battery({
        # TAGGED — one line-leading sanctioned tag → one chip + a flex speaker line
        "tagged": '@[Faith Willis] "I trust no one this week," she says.',
        # UNTAGGED — ordinary prose is byte-identical, no chip
        "untagged": "The living room hums with the tension of the first eviction.",
        # MALFORMED (unclosed) — swallowed, fail open, no chip, no raw markup
        "unclosed": "@[Faith Wil",
        # MALFORMED (mid-line) — not line-leading, so NOT promoted to a chip
        "midline": "You catch @[Faith Willis] watching you from the couch.",
        # RAW ID — a bare engine id must NEVER become a chip (it scrubs elsewhere)
        "rawid": "npc:3 slips into the kitchen.",
        # ID-BEARING sanctioned form (tolerated) — chip carries the real id for hue-match
        "idform": '@[Deja Monroe](npc:8) "We ride together," she whispers.',
    })

    # tagged: exactly one chip, keyed by the public name only (Vault-free), dialogue preserved,
    # rendered as a flex speaker line with a chip in the gutter.
    t = r["tagged"]
    assert len(t["chips"]) == 1
    assert t["chips"][0]["name"] == "Faith Willis"
    assert t["chips"][0]["id"] is None  # name-only form carries no id
    assert "___OWSPK_0___" in t["text"]
    assert "npc:" not in t["restored"]  # no machinery id leaks into the rendered chip
    assert 'class="ow-speaker-line"' in t["restored"]
    assert 'class="ow-speaker-chip"' in t["restored"]
    assert 'data-hg-name="Faith Willis"' in t["restored"]
    assert "I trust no one this week" in t["restored"]

    # untagged: no chip, text unchanged, render carries no speaker markup
    u = r["untagged"]
    assert u["chips"] == []
    assert u["text"] == "The living room hums with the tension of the first eviction."
    assert "ow-speaker-chip" not in u["restored"]

    # unclosed: the partial tag is swallowed (fail open) — no chip, no literal "@[" left
    uc = r["unclosed"]
    assert uc["chips"] == []
    assert "@[" not in uc["restored"]
    assert "ow-speaker-chip" not in uc["restored"]

    # mid-line: not line-leading → NOT a chip; the fail-open degrade collapses it to the name
    m = r["midline"]
    assert m["chips"] == []
    assert "ow-speaker-chip" not in m["restored"]
    assert m["degraded"] == "You catch Faith Willis watching you from the couch."
    assert "@[" not in m["degraded"]

    # raw id: never a chip (the raw-id scrub, not this feature, handles it)
    ri = r["rawid"]
    assert ri["chips"] == []
    assert "ow-speaker-chip" not in ri["restored"]

    # id-bearing form: chip carries the real engine id (exact cross-surface hue match)
    idf = r["idform"]
    assert len(idf["chips"]) == 1
    assert idf["chips"][0]["name"] == "Deja Monroe"
    assert idf["chips"][0]["id"] == "npc:8"
    assert 'data-hg-id="npc:8"' in idf["restored"]
    assert "We ride together" in idf["restored"]

    # both mdToHtml degrade regexes were found in source (fail-open is wired)
    assert t["degradeN"] == 2


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_render_contract_split_chunk_streaming():
    # A tag split across stream deltas: the buffer is re-rendered on each delta. Until the
    # closing `]` arrives, the partial shows NOTHING (fail open) — never a flash of raw markup —
    # then the completed tag promotes to a chip on the next render.
    r = _run_battery({
        "chunk1": "The camera finds her. @[Fai",             # mid-stream: tag incomplete
        "chunk2": '@[Faith Willis] "Hey," she says softly.',  # completed on the next delta
    })
    c1 = r["chunk1"]
    assert c1["chips"] == []
    assert "@[" not in c1["restored"]
    assert "ow-speaker-chip" not in c1["restored"]
    # the prose BEFORE the partial tag survives
    assert "The camera finds her." in c1["restored"]

    c2 = r["chunk2"]
    assert len(c2["chips"]) == 1
    assert c2["chips"][0]["name"] == "Faith Willis"
    assert 'class="ow-speaker-chip"' in c2["restored"]
    assert "Hey" in c2["restored"]


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_multiple_speaker_lines_each_get_their_own_chip():
    r = _run_battery({
        "two": "@[Faith Willis] I'm not going anywhere.\n@[Deja Monroe] We'll see about that.",
    })
    two = r["two"]
    assert len(two["chips"]) == 2
    assert [c["name"] for c in two["chips"]] == ["Faith Willis", "Deja Monroe"]
    # two distinct speaker lines, two chips
    assert two["restored"].count('class="ow-speaker-line"') == 2
    assert two["restored"].count('class="ow-speaker-chip"') == 2
    assert 'data-hg-name="Faith Willis"' in two["restored"]
    assert 'data-hg-name="Deja Monroe"' in two["restored"]


# ── OWN-8b — a DETACHED attribution anchors to its speech (no floating discs) ────────────── #
#
# The narrator sometimes emits the tag ALONE on its own line — a blank line between the tag and
# the quote, or the tag trailing the quote. mdToHtml then wrapped the lone placeholder as its own
# empty paragraph and the face chip rendered as a disc floating BETWEEN prose blocks (owner
# screenshot: one disc between two paragraphs, one dangling after the last line). The fix lives
# in extractSpeakerTags: a tag-only line joins FORWARD onto the speech it introduces; a trailing
# tag-only line anchors BACKWARD, leading the paragraph it attributes. Same-line tags untouched.

@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_detached_leading_attribution_anchors_forward_to_the_speech():
    r = _run_battery({
        "detached": '@[Maya Velez]\n\n"The house has eyes," she says, not looking up.',
    })
    d = r["detached"]
    assert len(d["chips"]) == 1
    # the placeholder and the speech share ONE line/paragraph — never a chip-only paragraph
    assert "___OWSPK_0___ \"The house has eyes,\"" in d["text"]
    restored = d["restored"]
    assert restored.count('class="ow-speaker-line"') == 1
    assert "The house has eyes" in restored
    # no empty speaker paragraph: the speaker line must carry the dialogue, not just the chip
    assert not re.search(r'<p class="ow-speaker-line">(?:(?!</p>).)*</span></p>', restored), \
        "chip floats alone in an empty paragraph"


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_trailing_attribution_anchors_backward_to_the_quote():
    r = _run_battery({
        "trailing": '"I know what you did last week."\n\n@[Marcus Chen]',
    })
    t = r["trailing"]
    assert len(t["chips"]) == 1
    # the placeholder relocates to LEAD the quote it attributes (chip in the speech's gutter)
    assert t["text"].startswith('___OWSPK_0___ "I know what you did last week."')
    restored = t["restored"]
    assert restored.count('class="ow-speaker-line"') == 1
    assert "I know what you did last week" in restored


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_same_line_tags_are_untouched_by_the_anchor_joins():
    # the sanctioned form (tag + same-line dialogue) must stay byte-identical through the joins
    r = _run_battery({
        "sameline": '@[Faith Willis] "Nothing changes for me."\n\nShe shrugs.',
    })
    s = r["sameline"]
    assert s["text"].startswith('___OWSPK_0___ "Nothing changes for me."')
    assert "\nShe shrugs." in s["text"]  # the separate narration paragraph is NOT swallowed


# ── #1323 — multi-paragraph speech indent (only the FIRST line was gutter-aligned) ───────── #
#
# Root cause: the narrator tags only the FIRST line of a speech (by design — momentPrompts.ts's
# SPEAKER TAGS rule is "ONE tag per line" as a per-line constraint, not "re-tag every line").
# restoreSpeakerChips used to wrap ONLY the one <p> starting with the placeholder in
# `.ow-speaker-line` (flex: chip + text); every continuation <p> rendered flush-left, breaking
# the "this person is talking" illusion. The fix extends the SAME left padding
# (`calc(1.7em + .5rem)`, the chip width + gutter gap) to the run of untagged sibling <p>s via a
# new `.ow-speaker-cont` class, stopping at the next speaker tag / a non-<p> block / end of
# message — see `_extendSpeakerContinuations` in markdown.js for the exact rule + rationale.

@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_multi_paragraph_speech_all_paragraphs_share_the_aligned_indent():
    r = _run_battery({
        "speech": (
            '@[Faith Willis] "I trust no one this week," she says.\n\n'
            'She leans back against the counter, arms crossed.\n\n'
            '"Everyone\'s playing an angle. I just play mine."'
        ),
    })
    s = r["speech"]
    assert len(s["chips"]) == 1
    restored = s["restored"]
    # exactly one gutter chip (only the opening line is tagged) …
    assert restored.count('class="ow-speaker-chip"') == 1
    assert restored.count('class="ow-speaker-line"') == 1
    # … but BOTH continuation paragraphs now carry the SAME alignment treatment as the tagged
    # line, so the whole speech reads as one person talking.
    assert restored.count('class="ow-speaker-cont"') == 2
    assert 'class="ow-speaker-cont">She leans back against the counter, arms crossed.</p>' in restored
    assert 'class="ow-speaker-cont">"Everyone\'s playing an angle. I just play mine."</p>' in restored


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_single_paragraph_speech_is_unchanged_by_the_continuation_pass():
    r = _run_battery({"one": '@[Faith Willis] "Hello there."'})
    restored = r["one"]["restored"]
    assert restored.count('class="ow-speaker-line"') == 1
    assert "ow-speaker-cont" not in restored


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_multi_speaker_interleaved_narration_each_run_scoped_no_indent_on_handoff():
    # A plain paragraph that hands directly off into the NEXT speaker's tag reads as narration
    # BETWEEN speeches, not a continuation of the speaker before it — excluded from the run
    # (design choice, documented in _extendSpeakerContinuations).
    r = _run_battery({
        "scene": (
            '@[Faith Willis] "I do not trust him."\n\n'
            'Across the room, Marcus rolls his eyes.\n\n'
            '@[Marcus Chen] "She is being paranoid."'
        ),
    })
    restored = r["scene"]["restored"]
    assert len(r["scene"]["chips"]) == 2
    # two speaker lines, no continuation anywhere (the middle paragraph is the hand-off)
    assert restored.count('class="ow-speaker-line"') == 2
    assert "ow-speaker-cont" not in restored
    # the hand-off narration renders as a bare, unindented paragraph
    assert '<p>Across the room, Marcus rolls his eyes.</p>' in restored


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_multi_speaker_each_with_its_own_multi_paragraph_run():
    # Two different speakers, each with a real multi-paragraph speech of their own — each run
    # must stay scoped to its own speaker and not bleed into the other's.
    r = _run_battery({
        "two_runs": (
            '@[Faith Willis] Opening line one.\n'
            'Faith continues here.\n\n'
            '@[Marcus Chen] Opening line two.\n'
            'Marcus continues here.\n'
            'And once more.'
        ),
    })
    restored = r["two_runs"]["restored"]
    assert restored.count('class="ow-speaker-line"') == 2
    # Faith gets exactly one continuation paragraph (stops because Marcus's tag follows)…
    # …Marcus gets two (nothing follows, so both trail to end of message).
    assert restored.count('class="ow-speaker-cont"') == 2
    faith_idx = restored.index('Faith Willis')
    marcus_idx = restored.index('Marcus Chen')
    assert faith_idx < marcus_idx
    # "Faith continues here." must NOT carry the continuation class (it's the hand-off
    # paragraph immediately preceding Marcus's tag).
    assert '<p>Faith continues here.</p>' in restored
    assert 'class="ow-speaker-cont">Marcus continues here.</p>' in restored
    assert 'class="ow-speaker-cont">And once more.</p>' in restored


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_non_paragraph_block_breaks_the_continuation_run_and_degrades_gracefully():
    # A list right after the tagged line: the indent treatment does not reach into it, and
    # anything AFTER the list is also NOT swept up as a continuation of the speaker before it
    # (the run is over — a non-<p> block ends it, per design).
    ex_html = (
        '<p>___OWSPK_0___ Listen up, everyone.</p>'
        '<ul><li>one</li><li>two</li></ul>'
        '<p>Some narration after the list.</p>'
    )
    r = _run_html_battery({
        "listcase": {"html": ex_html, "chips": [{"id": None, "name": "Faith Willis"}]},
    })
    restored = r["listcase"]["restored"]
    assert 'class="ow-speaker-line"' in restored
    assert '<ul><li>one</li><li>two</li></ul>' in restored  # list itself untouched
    assert '<p>Some narration after the list.</p>' in restored  # trailing text unindented
    assert "ow-speaker-cont" not in restored


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_blockquote_inside_a_speech_does_not_absorb_its_inner_paragraphs():
    # A blockquote's OWN inner <p>s must stay opaque to the top-level scan (never mistaken for
    # top-level speech-continuation siblings), and the blockquote itself breaks the run.
    ex_html = (
        '<p>___OWSPK_0___ Check this out.</p>'
        '<blockquote><p>a quoted excerpt</p><p>second quoted line</p></blockquote>'
        '<p>after the quote</p>'
    )
    r = _run_html_battery({
        "bqcase": {"html": ex_html, "chips": [{"id": None, "name": "Faith Willis"}]},
    })
    restored = r["bqcase"]["restored"]
    assert 'class="ow-speaker-line"' in restored
    assert '<blockquote><p>a quoted excerpt</p><p>second quoted line</p></blockquote>' in restored
    assert '<p>after the quote</p>' in restored
    assert "ow-speaker-cont" not in restored


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_restore_speaker_chips_is_idempotent():
    # Running the transform twice (the second pass over its own output) must be a no-op — no
    # more OWSPK placeholders to find, and no already-classed <p> gets re-classified or
    # double-wrapped.
    cases = {
        "multi": (
            '@[Faith Willis] "I trust no one this week," she says.\n\n'
            'She leans back against the counter, arms crossed.\n\n'
            '"Everyone\'s playing an angle. I just play mine."'
        ),
        "interleaved": (
            '@[Faith Willis] "I do not trust him."\n\n'
            'Across the room, Marcus rolls his eyes.\n\n'
            '@[Marcus Chen] "She is being paranoid."'
        ),
        "single": '@[Faith Willis] "Hello there."',
    }
    r = _run_battery(cases)
    for name, res in r.items():
        assert res["restored"] == res["restoredTwice"], f"not idempotent: {name}"

    # Also idempotent when the SAME already-processed HTML (containing a list/blockquote) is
    # re-run through restoreSpeakerChips directly.
    html_cases = {
        "listcase": {
            "html": (
                '<p>___OWSPK_0___ Listen up, everyone.</p>'
                '<ul><li>one</li><li>two</li></ul>'
                '<p>Some narration after the list.</p>'
            ),
            "chips": [{"id": None, "name": "Faith Willis"}],
        },
    }
    hr = _run_html_battery(html_cases)
    for name, res in hr.items():
        assert res["restored"] == res["restoredTwice"], f"not idempotent: {name}"


# ── #1638 — natural-style bold-name fallback (the narrator writes ITS OWN house style,
# no sanctioned @[Name] tag) ──────────────────────────────────────────────────────── #
#
# The sanctioned tag is OPTIONAL, and real play showed the narrator reliably skips it,
# writing a line-leading BOLD name instead: `**Full Name** does something.` /
# `**Full Name:** "quote"`. `_SPEAKER_BOLD_LINE_RE` + `_isKnownRosterName` recognize that
# pattern too, but ONLY for an EXACT (never fuzzy/partial) live-roster name, and — unlike the
# sanctioned tag, which IS machinery and gets fully consumed — this only ever INSERTS a
# placeholder ahead of the bold run. The `**Name**`/`**Name:**` markdown is never touched, so
# this is pure styling, never a rewrite of the model's prose (ADR 0005).

def test_source_level_natural_bold_fallback_is_wired():
    md = _read("static", "js", "markdown.js")
    assert "const _SPEAKER_BOLD_LINE_RE = " in md
    assert "function _isKnownRosterName(" in md
    # the fallback runs INSIDE extractSpeakerTags (so both processWithThinking call sites — live
    # stream and settled history — get it automatically; see the ADR-0015 parity test below),
    # not as a second standalone pass a caller could omit.
    exsrc = md[md.index("export function extractSpeakerTags"):]
    exsrc = exsrc[:exsrc.index("\nexport function restoreSpeakerChips")]
    assert "_SPEAKER_BOLD_LINE_RE" in exsrc
    assert "_isKnownRosterName(" in exsrc
    # the roster check is the SAME resolver the sanctioned-tag id-lookup already uses —
    # reusing the live roster cache, not a second/parallel source of truth.
    assert "window.orwellResolveHouseguestId" in md


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_natural_style_bold_roster_name_renders_a_speaker_row():
    r = _run_natural_battery(
        {
            "natural": '**Stephanie Briggs** leans against the counter. '
                       '*"I trust no one this week," she says.*',
        },
        roster=["Stephanie Briggs", "Marcus Chen"],
    )
    n = r["natural"]
    assert len(n["chips"]) == 1
    assert n["chips"][0]["name"] == "Stephanie Briggs"
    assert n["chips"][0]["id"] is None  # name-only, resolved to a real id later at render time
    assert 'class="ow-speaker-line"' in n["restored"]
    assert 'class="ow-speaker-chip"' in n["restored"]
    assert 'data-hg-name="Stephanie Briggs"' in n["restored"]
    # STYLING ONLY: the model's own bold markdown + every word of its prose survive verbatim —
    # this is never a rewrite (ADR 0005). No text is dropped, no space silently eaten.
    assert '**Stephanie Briggs** leans against the counter.' in n["restored"]
    assert 'I trust no one this week' in n["restored"]


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_fenced_code_block_bold_roster_name_is_never_chip_ified():
    """CodeRabbit fix: a roster name bolded INSIDE a fenced code block (e.g. an example format
    the narrator is quoting) must never fire the bold-name fallback — chip-ifying it would
    corrupt the eventual <pre><code> render. The bold line outside the fence must still chip."""
    r = _run_natural_battery(
        {
            "fenced": (
                "**Stephanie Briggs** leans in.\n"
                "```\n"
                "**Stephanie Briggs** is the format example.\n"
                "```\n"
            ),
        },
        roster=["Stephanie Briggs"],
    )
    n = r["fenced"]
    assert len(n["chips"]) == 1
    assert n["chips"][0]["name"] == "Stephanie Briggs"
    # the line OUTSIDE the fence got the placeholder...
    assert "___OWSPK_0___ **Stephanie Briggs** leans in." in n["text"]
    # ...but the line INSIDE the fence stays completely untouched, verbatim.
    assert "**Stephanie Briggs** is the format example." in n["text"]
    assert n["text"].count("___OWSPK_") == 1


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_tilde_fenced_code_block_bold_roster_name_is_never_chip_ified():
    r = _run_natural_battery(
        {
            "tilde": (
                "~~~\n"
                "**Stephanie Briggs** is the format example.\n"
                "~~~\n"
            ),
        },
        roster=["Stephanie Briggs"],
    )
    n = r["tilde"]
    assert n["chips"] == []
    assert "**Stephanie Briggs** is the format example." in n["text"]
    assert "___OWSPK_" not in n["text"]


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_backtick_fence_containing_a_tilde_marker_does_not_close_early():
    """CodeRabbit follow-up: fence tracking must be DELIMITER-AWARE, not "any ``` or ~~~ line
    toggles". A ``` fence quoting a ~~~ marker (e.g. the narrator explaining BOTH fence styles in
    one example) must stay open across that tilde line — the naive toggle-on-either-marker
    reading closed early here, resuming speaker extraction while still genuinely inside the
    backtick-fenced block."""
    r = _run_natural_battery(
        {
            "mixed_fence": (
                "```\n"
                "some prose about fences\n"
                "~~~\n"
                "**Stephanie Briggs** is still inside the backtick fence.\n"
                "```\n"
                "**Stephanie Briggs** speaks for real, outside every fence.\n"
            ),
        },
        roster=["Stephanie Briggs"],
    )
    n = r["mixed_fence"]
    # Only the line genuinely OUTSIDE every fence gets a chip.
    assert len(n["chips"]) == 1
    assert n["chips"][0]["name"] == "Stephanie Briggs"
    assert n["text"].count("___OWSPK_") == 1
    assert "**Stephanie Briggs** is still inside the backtick fence." in n["text"], (
        "the tilde marker inside the ``` fence must NOT close it — the enclosed bold line stays "
        "completely untouched, verbatim"
    )
    assert "___OWSPK_0___ **Stephanie Briggs** speaks for real, outside every fence." in n["text"]


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_four_backtick_fence_containing_a_triple_backtick_marker_does_not_close_early():
    """CodeRabbit follow-up: a fence only closes on the SAME character with a run length >= the
    OPENING run's length (CommonMark). A ```` (4-backtick) fence quoting a plain ``` (3-backtick)
    example — e.g. narration explaining how to write a fenced block — must stay open across that
    shorter marker."""
    r = _run_natural_battery(
        {
            "nested_backtick": (
                "````\n"
                "```\n"
                "**Stephanie Briggs** is still inside the outer fence.\n"
                "```\n"
                "````\n"
                "**Stephanie Briggs** speaks for real, outside every fence.\n"
            ),
        },
        roster=["Stephanie Briggs"],
    )
    n = r["nested_backtick"]
    assert len(n["chips"]) == 1
    assert n["chips"][0]["name"] == "Stephanie Briggs"
    assert n["text"].count("___OWSPK_") == 1
    assert "**Stephanie Briggs** is still inside the outer fence." in n["text"], (
        "the inner ``` (3-backtick) marker must NOT close the outer ```` (4-backtick) fence — the "
        "enclosed bold line stays completely untouched, verbatim"
    )
    assert "___OWSPK_0___ **Stephanie Briggs** speaks for real, outside every fence." in n["text"]


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_indented_code_block_bold_roster_name_is_never_chip_ified():
    """A 4-space-indented code line (the other Markdown code-block convention) gets the same
    protection as a fenced block."""
    r = _run_natural_battery(
        {
            "indented": "    **Stephanie Briggs** is the format example.\n",
        },
        roster=["Stephanie Briggs"],
    )
    n = r["indented"]
    assert n["chips"] == []
    assert "**Stephanie Briggs** is the format example." in n["text"]
    assert "___OWSPK_" not in n["text"]


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_tab_indented_code_block_bold_roster_name_is_never_chip_ified():
    r = _run_natural_battery(
        {
            "tabbed": "\t**Stephanie Briggs** is the format example.\n",
        },
        roster=["Stephanie Briggs"],
    )
    n = r["tabbed"]
    assert n["chips"] == []
    assert "___OWSPK_" not in n["text"]


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_sanctioned_tag_inside_fenced_code_block_is_never_chip_ified():
    """The same protection extends to the sanctioned @[Name] tag pass, not just the bold-name
    fallback — belt-and-suspenders, since either regex scans the same raw markdown."""
    r = _run_battery(
        {
            "fenced_tag": (
                "```\n"
                "@[Faith Willis] example line\n"
                "```\n"
            ),
        }
    )
    n = r["fenced_tag"]
    assert n["chips"] == []
    assert "@[Faith Willis] example line" in n["text"]
    assert "___OWSPK_" not in n["text"]


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_matching_fence_with_trailing_text_does_not_close_the_block():
    """Per CommonMark a CLOSING fence takes no info string — a line like ```js inside an open
    ``` block is a quoted example, not a close. The old delimiter-aware check closed on any
    same-char equal-or-longer run, so extraction resumed while still inside the code block and
    a bold roster name in the quoted example got chip-ified."""
    r = _run_natural_battery(
        {
            "fence_with_info": (
                "```\n"
                "```js\n"
                "**Stephanie Briggs** inside the still-open block\n"
                "```\n"
            ),
        },
        roster=["Stephanie Briggs"],
    )
    n = r["fence_with_info"]
    assert n["chips"] == []
    assert "___OWSPK_" not in n["text"]
    assert "**Stephanie Briggs** inside the still-open block" in n["text"]


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_normal_prose_detection_still_works_alongside_a_code_block():
    """Regression guard for the fix itself: excluding code regions must not degrade detection in
    ordinary prose lines that happen to share a message with a code block."""
    r = _run_natural_battery(
        {
            "mixed": (
                "**Stephanie Briggs** paces the room.\n"
                "```\n"
                "some_code()\n"
                "```\n"
                "**Stephanie Briggs** speaks again.\n"
            ),
        },
        roster=["Stephanie Briggs"],
    )
    n = r["mixed"]
    assert len(n["chips"]) == 2
    assert n["text"].count("___OWSPK_") == 2


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_natural_style_bold_name_with_colon_either_side_of_the_stars():
    r = _run_natural_battery(
        {
            "colon_inside": '**Stephanie Briggs:** "I trust no one this week."',
            "colon_outside": '**Stephanie Briggs**: "I trust no one this week."',
        },
        roster=["Stephanie Briggs"],
    )
    for name, res in r.items():
        assert len(res["chips"]) == 1, name
        assert res["chips"][0]["name"] == "Stephanie Briggs", name
        assert 'class="ow-speaker-line"' in res["restored"], name
        assert '"I trust no one this week."' in res["restored"], name


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_non_roster_bold_is_completely_untouched():
    # A plain **bold** that is NOT an exact roster name must render exactly as it always has —
    # never fuzzy-matched, never promoted to a chip.
    r = _run_natural_battery(
        {"note": "**Important Note** this should not change."},
        roster=["Stephanie Briggs"],
    )
    n = r["note"]
    assert n["chips"] == []
    assert n["text"] == "**Important Note** this should not change."
    assert "ow-speaker-chip" not in n["restored"]
    assert n["restored"] == "<p>**Important Note** this should not change.</p>"


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_mid_sentence_bold_roster_name_is_not_line_leading_so_untouched():
    # constraint (b): the bold name must be LINE-LEADING — a mid-sentence bold mention of a
    # real houseguest's name is prose, not an attribution, and must not become a chip.
    r = _run_natural_battery(
        {"midline": "You catch **Stephanie Briggs** watching you from the couch."},
        roster=["Stephanie Briggs"],
    )
    m = r["midline"]
    assert m["chips"] == []
    assert "ow-speaker-chip" not in m["restored"]
    assert "**Stephanie Briggs**" in m["restored"]


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_sanctioned_tagged_line_is_never_also_matched_by_the_bold_pass():
    # constraint (c): idempotent with the @[...] path — a line already carrying a sanctioned
    # tag consumes into a placeholder that no longer starts with `**`, so the SAME line can
    # never double-fire through the natural-style pass too (never two chips for one line).
    r = _run_natural_battery(
        {"both": "@[Stephanie Briggs] **Stephanie Briggs** grins at the room."},
        roster=["Stephanie Briggs"],
    )
    b = r["both"]
    assert len(b["chips"]) == 1
    assert b["restored"].count('class="ow-speaker-chip"') == 1
    assert b["restored"].count('class="ow-speaker-line"') == 1
    # the bold text itself (untouched — it wasn't consumed by the sanctioned-tag match) still
    # renders as ordinary prose alongside the one chip.
    assert "**Stephanie Briggs** grins at the room." in b["restored"]


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_natural_style_fallback_fails_closed_with_no_roster_resolver_at_all():
    # No `window.orwellResolveHouseguestId` at all (headless / cold cache / before the roster
    # loads) — exactly the environment every OTHER malformed-input case in this suite runs
    # under (`_run_battery`, no window stub). The natural-style line must degrade to plain,
    # untouched prose, never a broken half-render.
    r = _run_battery({
        "natural_no_roster": '**Stephanie Briggs** leans against the counter.',
    })
    n = r["natural_no_roster"]
    assert n["chips"] == []
    assert n["text"] == "**Stephanie Briggs** leans against the counter."
    assert "ow-speaker-chip" not in n["restored"]


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_natural_style_roster_match_is_exact_not_fuzzy():
    # A partial/substring match of a roster name must NOT fire — constraint (a): exact match
    # only, never fuzzy, never partial.
    r = _run_natural_battery(
        {
            "partial": "**Stephanie** leans against the counter.",
            "extra_word": "**Stephanie Briggs Jr** leans against the counter.",
        },
        roster=["Stephanie Briggs"],
    )
    for name, res in r.items():
        assert res["chips"] == [], name
        assert "ow-speaker-chip" not in res["restored"], name


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_multiple_natural_speaker_lines_each_get_their_own_chip():
    r = _run_natural_battery(
        {
            "two": "**Stephanie Briggs** I am not going anywhere.\n"
                   "**Marcus Chen** We will see about that.",
        },
        roster=["Stephanie Briggs", "Marcus Chen"],
    )
    two = r["two"]
    assert len(two["chips"]) == 2
    assert [c["name"] for c in two["chips"]] == ["Stephanie Briggs", "Marcus Chen"]
    assert two["restored"].count('class="ow-speaker-line"') == 2
    assert two["restored"].count('class="ow-speaker-chip"') == 2
    assert 'data-hg-name="Stephanie Briggs"' in two["restored"]
    assert 'data-hg-name="Marcus Chen"' in two["restored"]


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_natural_style_restore_is_idempotent():
    r = _run_natural_battery(
        {"natural": '**Stephanie Briggs** leans against the counter.'},
        roster=["Stephanie Briggs"],
    )
    n = r["natural"]
    assert n["restored"] == n["restoredTwice"]


# ── (d) live stream vs settled/history render parity (ADR 0015) ─────────────────────────── #
#
# extractSpeakerTags (which owns BOTH the sanctioned-tag pass and the #1638 natural-style
# fallback) runs INSIDE processWithThinking — the ONE render seam both the live stream
# renderer (chat.js) and the settled/history renderer (chatRenderer.js) call. There is no
# second, path-specific implementation either file could drift from.

def test_live_and_history_render_paths_share_the_one_processwiththinking_seam():
    chat = _read("static", "js", "chat.js")
    chat_renderer = _read("static", "js", "chatRenderer.js")
    assert "markdownModule.processWithThinking(" in chat, \
        "the live stream renderer must render via processWithThinking"
    assert "markdownModule.processWithThinking(" in chat_renderer, \
        "the settled/history renderer must render via processWithThinking"
    # neither path may re-implement (or bypass into) the speaker-chip transform directly —
    # it must stay owned by markdown.js's extractSpeakerTags/restoreSpeakerChips alone, so a
    # natural-style line renders identically wherever it's painted.
    for src, label in ((chat, "chat.js"), (chat_renderer, "chatRenderer.js")):
        assert "_SPEAKER_BOLD_LINE_RE" not in src, f"{label} must not duplicate the speaker regex"
        assert "extractSpeakerTags(" not in src, f"{label} must not bypass processWithThinking"
        assert "restoreSpeakerChips(" not in src, f"{label} must not bypass processWithThinking"


# ── ORW-140 / ORW-141 (11-06 live playtest) ───────────────────────────────────────────── #
# ORW-140: the consumed @[Name] tag left subject-less sentences ("stands near the memory wall…");
# owner ruling (Kevin, 11-06): complete sentences in all cases, so the name is rendered as visible
# text after the chip. ORW-141: the speaker line was a flex row, so every inline element of the
# paragraph became its own column ("as / se / ssi / ng").

@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_orw140_consumed_tag_keeps_the_name_as_visible_text():
    r = _run_natural_battery({
        "narration": "@[Natalia Reed] stands near the memory wall, arms crossed.",
        "dash": "@[Paige Patterson] — barks a laugh over the top of your line.",
        "colon": '@[Faith Willis]: "I trust no one this week."',
        "idform": '@[Deja Monroe](npc:8) "We ride together," she whispers.',
        "tag_then_bold": "@[Stephanie Briggs] **Stephanie Briggs** grins at the room.",
        "tag_then_plain": "@[Riley Cho] Riley Cho waves from the couch.",
        "bold_only": "**Stephanie Briggs** leans against the counter.",
        "escaped": "@[A<b>x] says hi.",
    }, roster=["Stephanie Briggs"])

    n = r["narration"]
    assert n["chips"][0]["showName"] is True
    assert '<strong class="ow-speaker-name">Natalia Reed</strong> stands near the memory wall' in n["restored"]
    assert n["restored"].count('class="ow-speaker-chip"') == 1
    assert n["restoredTwice"] == n["restored"]  # idempotent: no second name on a re-render

    assert '<strong class="ow-speaker-name">Paige Patterson</strong> — barks a laugh' in r["dash"]["restored"]
    assert '<strong class="ow-speaker-name">Faith Willis</strong>: "I trust no one this week."' in r["colon"]["restored"]

    idf = r["idform"]
    assert 'data-hg-id="npc:8"' in idf["restored"]
    assert '<strong class="ow-speaker-name">Deja Monroe</strong> "We ride together,"' in idf["restored"]
    assert "npc:8)" not in idf["restored"]  # the id form never leaks as text

    # the narrator already wrote the name right after the tag: never a second copy
    for key in ("tag_then_bold", "tag_then_plain"):
        assert r[key]["chips"][0]["showName"] is False, key
        assert "ow-speaker-name" not in r[key]["restored"], key
    assert "**Stephanie Briggs** grins at the room." in r["tag_then_bold"]["restored"]

    # the #1638 bold-name pass keeps its own **Name** in the prose, so it never adds a label
    b = r["bold_only"]
    assert len(b["chips"]) == 1
    assert "ow-speaker-name" not in b["restored"]
    assert "**Stephanie Briggs** leans against the counter." in b["restored"]

    # the name is HTML-escaped in the visible label (and the chip attributes)
    e = r["escaped"]["restored"]
    assert "A&lt;b&gt;x</strong>" in e
    assert "<b>" not in e


def test_orw141_speaker_line_is_not_a_flex_row():
    md = _read("static", "js", "markdown.js")
    css_fn = md[md.index("function ensureSpeakerCss"):]
    css_fn = css_fn[:css_fn.index("\n}\n")]
    line_rule = re.search(r"\.ow-speaker-line\{([^}]*)\}", css_fn)
    assert line_rule, "the .ow-speaker-line rule must exist"
    rule = line_rule.group(1)
    # a flex speaker line turns every inline element (<em>, <strong>, a link) into a column
    assert "display:flex" not in rule and "display:inline-flex" not in rule
    assert "padding-left:calc(1.7em + .5rem)" in rule  # same gutter as .ow-speaker-cont
    chip_rule = re.search(r"\.ow-speaker-line>\.ow-speaker-chip\{([^}]*)\}", css_fn)
    assert chip_rule and "position:absolute" in chip_rule.group(1)
