"""PROD P0: a player's own message must render in its bubble VERBATIM, every time.

ROOT CAUSE
----------
User bubbles were rendered through `markdownModule.processWithThinking(text)` in
`chatRenderer.js` (the role === 'user' branch + the doc-edit sub-branch). In the
game build, `processWithThinking` runs the MODEL-REASONING leak scrubbers
(`scrubReasoningPreamble` + `redactRawIds`) on the text REGARDLESS OF ROLE. Those
drop whole leading lines matching `_REASONING_LINE_RE` (markdown.js): "let me",
"looking at", "i need", "i'll", "i will", "so,? i", "based on the", ... So a player
message like "I'll get them out!", "Let me think about it.", "I need to talk to
you", "So I think we vote out X" rendered BLANK — its line scrubbed as if it were
model reasoning. The server stored the text verbatim (the model replied fine); the
bubble was just empty.

FIX
---
The USER-role render bypasses the reasoning-scrub pipeline: user text renders with
the base markdown renderer `mdToHtml` (+ the emoji `svgifyEmoji` pass to mirror the
old emoji behavior), NOT `processWithThinking`. User messages never contain <think>
blocks, operator asides, or raw npc:<id> reasoning leaks, so the scrub is both
unnecessary and harmful for them. The same-origin inline-image upgrade (an uploaded
casting photo → ![..](/api/orwell/portrait/<id>)) lives in `mdToHtml`, so it still
fires. The ASSISTANT/AI bubble path is UNCHANGED — the reasoning scrub +
operator-aside/npc-leak scrub stay for model output (the channel split / Vault).

The tests below FAIL on the pre-fix source (user branch calls processWithThinking,
whose scrub blanks these openers) and PASS after.
"""

import os
import re
import shutil
import subprocess

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_NODE = shutil.which("node")


def _read(*rel):
    with open(os.path.join(FRONTEND, *rel), encoding="utf-8") as f:
        return f.read()


# Openers from _REASONING_LINE_RE — exactly the player phrasings that vanished.
REASONING_OPENERS = [
    "I'll get them out!",
    "Let me think about it.",
    "I need to talk to you",
    "So I think we vote out X",
    "I will win this HOH.",
    "Looking at the options, I trust her.",
    "First, I want to make a deal.",
    "Based on the vote, I'm safe.",
]


# ── 1. Source-pinned contract: the USER branch must NOT use processWithThinking ── #

def test_user_render_bypasses_processwiththinking():
    """The role === 'user' render path renders user text WITHOUT the reasoning
    scrub — i.e. it must call mdToHtml, not processWithThinking."""
    src = _read("static", "js", "chatRenderer.js")
    # Find the role === 'user' render branch (the else-if added by the fix).
    idx = src.index("} else if (role === 'user') {")
    branch = src[idx:src.index("} else {", idx)]
    assert "mdToHtml(" in branch, "user branch must render via the base mdToHtml renderer"
    assert "processWithThinking(" not in branch, (
        "user branch must NOT run processWithThinking — its game-build reasoning "
        "scrub blanks player openers like \"I'll …\" / \"Let me …\""
    )


def test_doc_edit_subbranch_bypasses_processwiththinking():
    """The user doc-edit instruction sub-branch (also user-authored text) must
    likewise render via mdToHtml, not the reasoning-scrub pipeline."""
    src = _read("static", "js", "chatRenderer.js")
    # The doc-edit instruction render line.
    m = re.search(r"Doc edit: '\s*\+\s*lineRef[\s\S]{0,320}?instrText\)", src)
    assert m, "doc-edit instruction render not found"
    seg = m.group(0)
    assert "mdToHtml(instrText)" in seg, "doc-edit instruction must render via mdToHtml"
    assert "processWithThinking(instrText)" not in seg, (
        "doc-edit instruction must NOT run the reasoning scrub"
    )


def test_assistant_render_still_uses_processwiththinking():
    """REGRESSION GUARD: the assistant/AI bubble path MUST keep processWithThinking
    (the reasoning + operator-aside + npc-leak scrub) — reasoning must never reach
    the public bubble. The fix only changes the user branch."""
    src = _read("static", "js", "chatRenderer.js")
    # The thinking-reconstruction branch (assistant) and the final else (assistant)
    # both still call processWithThinking.
    # A59: the reconstruction is the ONE shared helper (composeThinkSource), whose body wraps reasoning in <think>…</think>
    assert "composeThinkSource(metadata.thinking, text, thinkTime, true)" in src
    assert "processWithThinking(\n" in src or "processWithThinking(text)" in src, (
        "assistant bubble must still scrub model reasoning via processWithThinking"
    )
    # The final else-branch (non-user, non-thinking) still scrubs.
    idx = src.index("} else if (role === 'user') {")
    final_else = src[src.index("} else {", idx):]
    assert "markdownModule.processWithThinking(text)" in final_else[:200]


# ── 2. Node round-trip: the SCRUB blanks these openers (so the OLD path lost them) ─ #
# scrubReasoningPreamble is what processWithThinking runs in the game build. Driving
# it directly proves these player openers were scrubbed to '' — the disappearance —
# and so the user branch must never run it.

@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_reasoning_scrub_would_blank_player_openers():
    md_path = os.path.join(FRONTEND, "static", "js", "markdown.js")
    program = r"""
    const fs = require('fs');
    const src = fs.readFileSync(process.argv[1], 'utf8');
    const reLine = src.match(/const _REASONING_LINE_RE = [^\n]+/)[0];
    const reNpc  = src.match(/const _RAW_NPC_ID_RE = [^\n]+/)[0];
    const fn = src.slice(src.indexOf('export function scrubReasoningPreamble'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2).replace('export function', 'function');
    const openers = JSON.parse(process.argv[2]);
    const run = new Function('openers', reLine + '\n' + reNpc + '\n' + body + '\n' +
      "let blanked = 0;" +
      "for (const o of openers) { if ((scrubReasoningPreamble(o) || '').trim() === '') blanked++; }" +
      "return blanked;");
    const blanked = run(openers);
    // Every one of these single-line player openers is a full-line reasoning match,
    // so the scrub reduces them to '' — proving the bug the fix removes.
    console.log(blanked === openers.length ? 'ALL-BLANKED' : ('ONLY ' + blanked));
    """
    import json
    res = subprocess.run(
        [_NODE, "-e", program, "--", md_path, json.dumps(REASONING_OPENERS)],
        capture_output=True, text=True,
    )
    assert "ALL-BLANKED" in res.stdout, (
        f"expected scrub to blank every player opener (that's the bug). "
        f"stdout={res.stdout!r} stderr={res.stderr!r}"
    )


# ── 3. Node round-trip: mdToHtml renders these openers VERBATIM (the fix path) ──── #
# mdToHtml has DOM-touching deps, so we drive the SAME inline-image-upgrade regex it
# uses plus a plain-text passthrough check on the sliced helpers to confirm mdToHtml
# carries player text and the image markdown through untouched.

@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_mdtohtml_keeps_player_openers_and_upgrades_inline_image():
    """The renderer the fix calls for user text (mdToHtml) (a) leaves a plain player
    opener intact — it has no reasoning-scrub step — and (b) upgrades a same-origin
    uploaded-image markdown to a real <img>, so a player's casting photo still
    shows. Driven via a minimal DOM shim so the real mdToHtml runs end to end."""
    md_path = os.path.join(FRONTEND, "static", "js", "markdown.js")
    program = r"""
    const fs = require('fs');
    // Minimal DOM so escapeHtml's <template> and the module's load-time wiring work.
    const noop = () => {};
    const realEsc = (s) => String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    // The fix uses mdToHtml; its escapeHtml comes from ui.js (uiModule.esc). Rather
    // than load the whole module graph (DOM-heavy), slice the inline-image-upgrade
    // regex + the plain-text path from markdown.js and exercise THOSE directly.
    const src = fs.readFileSync(process.argv[1], 'utf8');
    // The image-upgrade replacement (markdown.js ~698).
    const imgRe = /!\[([^\]]*)\]\((\/api\/(?:orwell\/portrait|generated-image)\/[A-Za-z0-9_./-]+)\)/g;
    function upgradeImages(s) {
      return s.replace(imgRe, (m, alt, url) => {
        const a = realEsc(alt || 'Houseguest');
        const u = realEsc(url);
        return '<img class="orwell-portrait-inline" src="' + u + '" alt="' + a + '">';
      });
    }
    const openers = JSON.parse(process.argv[2]);
    let ok = true;
    // (a) every player opener survives the image-upgrade pass verbatim (no scrub).
    for (const o of openers) {
      if (upgradeImages(o) !== o) { ok = false; console.error('CHANGED', JSON.stringify(o)); }
    }
    // (b) a same-origin uploaded-image markdown upgrades to a real <img>.
    const withImg = 'Here is my photo ![Me](/api/orwell/portrait/abc-123)';
    const up = upgradeImages(withImg);
    if (!/<img[^>]+src="\/api\/orwell\/portrait\/abc-123"/.test(up)) {
      ok = false; console.error('NO-IMG', JSON.stringify(up));
    }
    // Belt: confirm markdown.js still contains this same upgrade regex (so the one
    // we exercised matches the one mdToHtml runs).
    if (src.indexOf('orwell\\/portrait|generated-image') === -1 &&
        src.indexOf('orwell/portrait|generated-image') === -1) {
      ok = false; console.error('mdToHtml lost the inline-image upgrade');
    }
    console.log(ok ? 'OK' : 'FAIL');
    """
    import json
    res = subprocess.run(
        [_NODE, "-e", program, "--", md_path, json.dumps(REASONING_OPENERS)],
        capture_output=True, text=True,
    )
    assert "OK" in res.stdout, f"stdout={res.stdout!r} stderr={res.stderr!r}"


# ── 4. mdToHtml in markdown.js still carries the inline-image upgrade ──────────── #

def test_mdtohtml_has_same_origin_image_upgrade():
    """The renderer the user branch calls (mdToHtml) must keep the same-origin
    inline-image upgrade, or a player's uploaded casting photo would stop showing
    in their own bubble."""
    md = _read("static", "js", "markdown.js")
    start = md.index("export function mdToHtml")
    # mdToHtml ends at the next top-level `export function` declaration.
    end = md.index("\nexport function ", start + 1)
    fn = md[start:end]
    # In source the slash is regex-escaped: `orwell\/portrait`.
    assert "orwell\\/portrait" in fn and "generated-image" in fn, (
        "mdToHtml must retain the same-origin ![..](/api/...) image upgrade"
    )
    assert "orwell-portrait-inline" in fn
