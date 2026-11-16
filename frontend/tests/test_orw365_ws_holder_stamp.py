"""ORW-365 (node unit tests on the real chatWsSplice.js): the WebSocket observer/mirror live holder (`_wsEnsureRound`, a run-started boundary
that mounts a holder before message_saved) was created with the REAL wall clock ("Production 12:47 AM") in a played game; the persisted row was
fine (metadata.game_moment). ORW-259 seeded only chat.js's holders. In a game the holder must be seeded with the last in-world moment; a
non-game chat keeps its wall-clock time. Roles only."""
import json
import os
import re
import shutil
import subprocess

import pytest

JS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js", "chatWsSplice.js")
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node not available")
MOMENT = "Week 1 · Nominations · Evening"
WALL = re.compile(r"^\d{1,2}:\d{2}\s?(AM|PM)?$", re.I)

PROGRAM = r"""
const fs = require('fs');
const src = fs.readFileSync(process.argv[1], 'utf8');
const moments = JSON.parse(process.argv[2]);
let html = '';
const holder = { className: '', dataset: {}, set innerHTML(v) { html = v; }, isConnected: true };
const document = {
  querySelectorAll: (sel) => (sel === '#chat-history .role-timestamp-moment' ? moments.map(t => ({ textContent: t })) : [{ textContent: 'WRONG SCOPE' }]),
  getElementById: () => ({ appendChild() {} }),
  createElement: () => holder,
};
function block(start) {
  let depth = 0, started = false;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; } else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(start, j + 1); }
  }
}
const s0 = src.indexOf('function _wsStampSpanHtml');
const stamp = s0 >= 0 ? block(s0) : '';
let body = block(src.indexOf('export function _wsEnsureRound')).replace('export function', 'function');
body = body.slice(0, body.indexOf('box.appendChild(holder);')) + 'return html; }';
const f = new Function('document', 'uiModule', 'sessionModule', 'chatState', '_senderLabel', '_shortModel', '_wsRound',
  stamp + ';' + body + '; return _wsEnsureRound;')(document, { esc: s => String(s) }, {}, { _resumingStreams: new Set() }, () => 'PR', () => '', null);
process.stdout.write(JSON.stringify(f()));
"""


def _html(moments):
    res = subprocess.run([NODE, "-e", PROGRAM, "--", JS, json.dumps(moments)], capture_output=True, text=True, timeout=60)
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def _ts_text(html):
    m = re.search(r'<span class="role-timestamp[^"]*"[^>]*>([^<]*)</span>', html)
    assert m, html
    return m.group(1)


def test_in_a_game_the_mirror_holder_shows_the_last_in_world_moment_not_the_wall_clock():
    html = _html(["Week 1 · Nominations · Morning", MOMENT])
    assert _ts_text(html) == MOMENT, html
    assert "role-timestamp-moment" in html
    # ORW-481 (review 4576639860): the wall clock is kept on data-wall-clock, never replaced by the moment text
    assert WALL.match(re.search(r'data-wall-clock="([^"]*)"', html).group(1).strip()), html


def test_a_non_game_chat_mirror_holder_keeps_the_wall_clock_time():
    html = _html([])
    assert WALL.match(_ts_text(html).strip()), html
    assert "role-timestamp-moment" not in html


MSG_PROGRAM = r"""
const fs = require('fs');
const src = fs.readFileSync(process.argv[1], 'utf8');
const seeded = process.argv[2] === 'seeded';
const start = src.indexOf("if (d.type === 'message_saved') {");
let depth = 0, started = false, end = -1;
for (let j = src.indexOf('{', start); j < src.length; j++) {
  if (src[j] === '{') { depth++; started = true; } else if (src[j] === '}') { depth--; if (started && depth === 0) { end = j + 1; break; } }
}
const blockSrc = src.slice(start, end);
const classes = new Set(seeded ? ['role-timestamp', 'role-timestamp-moment'] : ['role-timestamp']);
const ts = { dataset: {}, textContent: seeded ? 'Week 1 \u00b7 Evening' : '12:47 AM', title: '',
  classList: { contains: c => classes.has(c), add: c => classes.add(c) } };
const holder = { dataset: {}, querySelector: () => ts };
const _wsRound = { holder };
const document = { body: { hasAttribute: () => false } };
const d = { type: 'message_saved', id: 7, moment: 'Week 2 \u00b7 Nominations' };
new Function('d', '_wsRound', 'document', blockSrc)(d, _wsRound, document);
process.stdout.write(JSON.stringify({ wall: ts.dataset.wallClock === undefined ? null : ts.dataset.wallClock, text: ts.textContent }));
"""


def _saved(mode):
    res = subprocess.run([NODE, "-e", MSG_PROGRAM, "--", JS, mode], capture_output=True, text=True, timeout=60)
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


def test_message_saved_never_stores_the_moment_text_as_the_wall_clock():
    out = _saved("seeded")
    assert out["text"] == "Week 2 \u00b7 Nominations"
    assert out["wall"] is None, out  # a moment-seeded holder with no server ts must not keep the moment text as its wall clock


def test_message_saved_keeps_a_neutral_stamp_wall_clock():
    out = _saved("neutral")
    assert out["wall"] == "12:47 AM" and out["text"] == "Week 2 \u00b7 Nominations", out
