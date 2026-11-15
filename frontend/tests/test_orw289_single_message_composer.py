"""ORW-289: the page must carry exactly ONE element with id="message". ui.js autoResize measured the textarea with `cloneNode(false)`, which copies the id
(and disabled/autofocus/aria-label), appending a hidden duplicate composer next to the real one: Playwright "resolved to 2 elements", and getElementById vs
querySelector could disagree about which box was the composer. Runs the real autoResize under node with a minimal DOM stub."""
import json
import os
import shutil
import subprocess

import pytest

JS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js", "ui.js")
NODE = shutil.which("node")
pytestmark = pytest.mark.skipif(NODE is None, reason="node not available")

PROGRAM = r"""
const fs = require('fs');
const src = fs.readFileSync(process.argv[1], 'utf8');
const i = src.indexOf('export function autoResize(');
let depth = 0, started = false, end = -1;
for (let j = src.indexOf('{', i); j < src.length; j++) {
  if (src[j] === '{') { depth++; started = true; } else if (src[j] === '}') { depth--; if (started && depth === 0) { end = j + 1; break; } }
}
const body = src.slice(i, end).replace('export function', 'function');
class El {
  constructor(attrs) { this.attrs = Object.assign({}, attrs); this.style = {}; this.scrollHeight = 20; this.offsetWidth = 100; this.value = ''; this.parentNode = null; }
  cloneNode() { return new El(this.attrs); }
  removeAttribute(a) { delete this.attrs[a]; }
  setAttribute(a, v) { this.attrs[a] = v; }
  appendChild(c) { (this.children = this.children || []).push(c); c.parentNode = this; }
}
const parent = new El({});
const ta = new El({ id: 'message', name: 'm', autofocus: '', required: '', disabled: '', 'aria-label': 'Message input', 'data-default-placeholder': 'x' });
ta.parentNode = parent;
const fn = new Function('getComputedStyle', 'isNarrow', body + '; return autoResize;')(() => ({ lineHeight: '20', cssText: '' }), () => false);
fn(ta); fn(ta);   // the second call must reuse the clone, not append another
process.stdout.write(JSON.stringify({ clones: (parent.children || []).length, attrs: (parent.children || [{ attrs: {} }])[0].attrs }));
"""


def test_the_measuring_clone_carries_no_composer_identity():
    res = subprocess.run([NODE, "-e", PROGRAM, "--", JS], capture_output=True, text=True, timeout=60)
    assert res.returncode == 0, res.stderr
    out = json.loads(res.stdout)
    assert out["clones"] == 1, out                         # one hidden measuring clone, reused
    a = out["attrs"]
    for gone in ("id", "name", "autofocus", "required", "disabled", "aria-label", "data-default-placeholder"):
        assert gone not in a, (gone, a)
    assert a.get("aria-hidden") == "true" and a.get("tabindex") == "-1", a
