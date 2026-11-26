"""ORW-993 (PR 2): every viewport-height cap in the window/sheet/notice kit JS carries its dvh twin.

ORW-163 pinned style.css; the kit injects its own CSS from JS, and three of those caps (the decision card's prompt
scroll region, the notice card, the anchored sheet body) were bare `vh`: taller than the visible area under a mobile URL
bar, so the card's lowest control sat off-screen. Source pin: in these files a `height: ...vh...` declaration must have
the same property with a `dvh` length on the same line or the next one (the vh line stays as the fallback)."""
import re
from pathlib import Path

JS = Path(__file__).resolve().parent.parent / "static" / "js"
FILES = ["orwellWindow.js", "orwellSlots.js", "orwellDecision.js", "orwellRetrospective.js", "orwellHeadshot.js",
         "orwellDossier.js", "orwellCast.js", "orwellHallOfFame.js", "orwellMemoryWall.js", "orwellSheet.js", "orwellNotice.js"]
DECL = re.compile(r"((?:max-|min-)?height):\s*([^;\"}]*?\b\d+vh\b[^;\"}]*)")


def test_every_vh_height_in_the_kit_has_a_dvh_twin():
    bare, seen = [], 0
    for name in FILES:
        lines = (JS / name).read_text(encoding="utf-8").split("\n")
        for i, line in enumerate(lines):
            for m in DECL.finditer(line):
                seen += 1
                window = line[m.end():] + "\n" + (lines[i + 1] if i + 1 < len(lines) else "")
                if not re.search(re.escape(m.group(1)) + r":[^;]*\d+dvh", window):
                    bare.append(f"{name}:{i + 1}: {m.group(0).strip()}")
    assert seen >= 8, f"the pin must actually see the vh declarations (saw {seen})"
    assert not bare, "vh height without a dvh twin (clipped under a mobile URL bar):\n" + "\n".join(bare)
