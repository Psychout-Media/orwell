"""ORW-163: a bare `height|max-height: 100vh` (or `calc(100vh - ..)`) is taller than the visible area under the iPhone URL bar. Every such declaration in style.css must be IMMEDIATELY followed by its `dvh`
twin (same property, same !important) - the vh line stays as the fallback for browsers without dvh. Source pin; a new bare vh height fails here."""
import re
from pathlib import Path

CSS = (Path(__file__).resolve().parent.parent / "static" / "style.css").read_text(encoding="utf-8").split("\n")
DECL = re.compile(r"^\s*((?:max-)?height):\s*(calc\(100vh[^;]*\)|100vh)(\s*!important)?\s*;")


def test_every_100vh_height_has_a_dvh_twin_right_after():
    bare = []
    n = 0
    for i, line in enumerate(CSS):
        m = DECL.match(line)
        if not m:
            continue
        n += 1
        want = re.compile(r"^\s*" + re.escape(m.group(1)) + r":\s*" + re.escape(m.group(2).replace("vh", "dvh")) + re.escape(m.group(3) or "") + r"\s*;")
        nxt = CSS[i + 1] if i + 1 < len(CSS) else ""
        if not want.match(nxt):
            bare.append(f"style.css:{i + 1}: {line.strip()}")
    assert n >= 10, f"the pin must actually see the vh declarations (saw {n})"
    assert not bare, "100vh height without a dvh twin (clipped under the iOS URL bar):\n" + "\n".join(bare)
