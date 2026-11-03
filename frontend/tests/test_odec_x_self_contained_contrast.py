"""a11y: the decision card's dismiss x carries its OWN backing, so its contrast never depends on the host surface.

The A-15 a11y matrix flagged `contrast:orwell-decision-card:button.odec-x` at 1.48:1 (dark ink #16191f on a dark
rgb(33,58,72) surface) on the exit-interview and evicted cards: the x INHERITED the card ink, which is pinned dark
for the light kit glass. Source-pinned: the x sets an explicit dark ink AND a light backing disc, and never goes
back to `color: inherit`. Roles only.
"""
import os
import re

FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _rule():
    with open(os.path.join(FRONTEND, "static", "js", "orwellDecision.js"), encoding="utf-8") as f:
        src = f.read()
    m = re.search(r"\.odec \.odec-x \{([^}]*)\}", src)
    assert m, ".odec .odec-x rule missing"
    return m.group(1)


def test_x_has_explicit_ink_and_its_own_light_backing():
    rule = _rule()
    assert re.search(r"(?<![-\w])color:\s*#16191f", rule), "the x must pin its own dark glyph ink"
    assert "radial-gradient" in rule and "rgba(255,255,255" in rule, "the x must carry its own light backing disc"


def test_x_never_inherits_the_card_ink_again():
    assert not re.search(r"(?<![-\w])color:\s*inherit", _rule()), "an inherited ink is what went dark-on-dark"
    assert not re.search(r"background:\s*none", _rule()), "no backing = surface-dependent contrast"
