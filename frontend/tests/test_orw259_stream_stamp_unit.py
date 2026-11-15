"""ORW-259 (node unit tests on the real chat.js `_stampSpanHtml`): a streaming reply that never settles must not show the real wall clock in its header.
While a game is on screen the live holder is created with the most recent in-world moment (M2-6); with no game bubble yet (casting, chat mode) it keeps
the neutral wall-clock stamp. ORW-44 S4b2 retired the two real-browser tests that held the HTTP chat request open to prove this
(test_orw259_stream_stamp.py::test_unsettled_reply_in_a_game_keeps_the_in_world_moment_not_the_wall_clock and
::test_with_no_game_bubble_the_neutral_wall_clock_stamp_is_unchanged): the game build is WebSocket-only, so the HTTP hold no longer exists. Replacements:
test_in_a_game_the_holder_is_stamped_with_the_most_recent_moment, test_with_no_game_bubble_the_neutral_wall_clock_stamp_is_unchanged. Roles only."""
import json
import os
import re
import shutil
import subprocess

import pytest

JS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js", "chat.js")
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node not available")
MOMENT = "Week 2 · Veto competition · Evening"
WALL = re.compile(r"^\d{1,2}:\d{2}\s?(AM|PM)?$", re.I)

PROGRAM = r"""
const fs = require('fs');
const src = fs.readFileSync(process.argv[1], 'utf8');
function fn(name) {
  const i = src.indexOf('function ' + name + '(');
  let depth = 0, started = false;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
  throw new Error('unterminated ' + name);
}
const moments = JSON.parse(process.argv[2]);
const document = { querySelectorAll: () => moments.map(t => ({ textContent: t })) };
const uiModule = { esc: s => String(s) };
const f = new Function('document', 'uiModule', fn('_stampSpanHtml') + '; return _stampSpanHtml;')(document, uiModule);
process.stdout.write(JSON.stringify(f('06:19 AM')));
"""


def _stamp(moments):
    res = subprocess.run([NODE, "-e", PROGRAM, "--", JS, json.dumps(moments)], capture_output=True, text=True, timeout=60)
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_in_a_game_the_holder_is_stamped_with_the_most_recent_moment():
    html = _stamp(["Week 1 · Nominations · Morning", MOMENT])
    assert 'class="role-timestamp role-timestamp-moment"' in html and f">{MOMENT}<" in html, html
    assert 'data-wall-clock="06:19 AM"' in html            # the exact wall clock is kept only as data, for message_saved to overwrite
    assert not WALL.match(re.sub(r"<[^>]+>", "", html).strip()), html   # never shown


def test_with_no_game_bubble_the_neutral_wall_clock_stamp_is_unchanged():
    html = _stamp([])
    assert html == '<span class="role-timestamp">06:19 AM</span>', html
    assert WALL.match(re.sub(r"<[^>]+>", "", html).strip())


def test_every_holder_creation_site_uses_the_stamp_helper():
    src = open(JS, encoding="utf-8").read()
    assert src.count("_stampSpanHtml(roleTs)") >= 4        # the streaming holder, the retry holder, the bg holder, the agent holder
