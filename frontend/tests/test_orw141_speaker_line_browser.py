"""ORW-141 (playtest 11-06), real browser: a speaker line must lay out as flowing text. As a flex row, every
inline element became its own column and short italic words stacked one letter-group per line
("as / se / ssi / ng", "h / o / s / t"). Rendered with the REAL injected CSS (markdown.js ensureSpeakerCss,
executed under Node) in Chromium. Lives in its own module so conftest routes only this file to the serial
browser lane.
"""
import json
import os
import shutil
import subprocess

import pytest

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_NODE = shutil.which("node")


def _speaker_css():
    """Run markdown.js's ensureSpeakerCss under Node with a stub document and return the CSS it injects."""
    program = r"""
    const fs = require('fs');
    const src = fs.readFileSync(process.argv[1], 'utf8');
    let fn = src.slice(src.indexOf('function ensureSpeakerCss'));
    fn = fn.slice(0, fn.indexOf('\n}\n') + 2);
    let css = '';
    const document = { head: { appendChild(s) { css = s.textContent; } },
                       documentElement: null, getElementById() { return null; },
                       createElement() { return {}; } };
    (new Function('document', fn + '\nensureSpeakerCss();'))(document);
    process.stdout.write(JSON.stringify(css));
    """
    res = subprocess.run([_NODE, "-e", program, "--", os.path.join(FRONTEND, "static", "js", "markdown.js")],
                         capture_output=True, text=True, timeout=60)
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


@pytest.mark.skipif(_NODE is None, reason="node not available")
def test_orw141_inline_emphasis_in_a_speaker_line_stays_inline_in_a_real_browser():
    sync_api = pytest.importorskip("playwright.sync_api")
    css = _speaker_css()
    html = (
        "<style>" + css + "</style>"
        "<div style='width:560px;font:16px/1.5 sans-serif'>"
        "<p class='ow-speaker-line'><span class='ow-speaker-chip'></span>"
        "<strong class='ow-speaker-name'>Paige Patterson</strong> — \"Nobody in this house is on "
        "vacation, folks. I know what a vacation looks like. I <em>host</em> 'em.\" She wrinkles her "
        "nose. \"So — <em>we can't have you leaving unhappy</em>. What's your name?\" "
        "<a href='#'>a link</a> and <strong>bold</strong> stay in the flow too.</p></div>"
    )
    with sync_api.sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page()
            page.set_content(html)
            m = page.evaluate("""() => {
                const p = document.querySelector('p.ow-speaker-line');
                const line = parseFloat(getComputedStyle(p).lineHeight);
                const host = p.querySelector('em');
                const r = host.getBoundingClientRect();
                const chip = p.querySelector('.ow-speaker-chip').getBoundingClientRect();
                return { display: getComputedStyle(p).display, line, hostH: r.height, hostW: r.width,
                         pLeft: p.getBoundingClientRect().left, chipLeft: chip.left };
            }""")
        finally:
            browser.close()
    assert m["display"] != "flex"
    # "host" renders on ONE line at its natural width (the bug stacked it letter-group by line)
    assert m["hostH"] < 1.6 * m["line"], m
    assert m["hostW"] > 20, m
    # the chip still sits in the gutter at the paragraph's left edge
    assert abs(m["chipLeft"] - m["pLeft"]) < 2, m
