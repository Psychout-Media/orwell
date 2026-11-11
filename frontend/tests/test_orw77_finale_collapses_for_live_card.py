"""ORW-77 (#1418) SOURCE-PIN: on the narrow tier a live decision card collapses the floating finale panel to its header (finalists stay one tap away; nothing covers the card)."""
import os
import re

SRC = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "js", "orwellFinale.js"), encoding="utf-8").read()


def _narrow_block():
    i = SRC.index("@media (max-width: 768px)")
    return SRC[i:SRC.index("</style>", i)]


def test_a_live_card_collapses_the_floating_finale_body_on_the_narrow_tier():
    blk = _narrow_block()
    m = re.search(r"body:has\(#orwell-decision-card\)\s+#orwell-finale:not\(\.ow-docked\)\s+\.ow-body\s*\{\s*display:\s*none\s*!important", blk)
    assert m, "no collapse rule inside the narrow media block"


def test_it_hides_only_the_body_never_the_whole_panel_and_never_a_docked_one():
    blk = _narrow_block()
    assert "#orwell-finale:not(.ow-docked) { display: none" not in blk, "the panel must keep its header (the finalists/votes the player needs)"
    assert ":not(.ow-docked)" in blk
