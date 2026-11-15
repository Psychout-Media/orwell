"""The window kit's "· refreshing" hint is visible UI text, so it must never render below the --fs-2xs floor (~11px).

At `.7em` of a 13px title it rendered at 9.1px. It only appears when a /state fill is still in flight after 200ms (TRANS-10), so the
responsive matrix's crowding sweep failed intermittently on unrelated PRs whenever a loaded runner made a fill slow at capture time
(`phone-390+settings crowding:page font 9.1px: · refreshing`, ORW-229). The floor makes the check deterministic."""
import re
from pathlib import Path

KIT = Path(__file__).resolve().parents[1] / "static" / "js" / "orwellWindow.js"


def _rule() -> str:
    m = re.search(r"\.ow-title \.ow-load-hint \{([^}]*)\}", KIT.read_text(encoding="utf-8"))
    assert m, "the .ow-load-hint rule is gone from orwellWindow.js"
    return m.group(1)


def test_the_refreshing_hint_never_renders_below_the_font_floor():
    sizes = re.findall(r"font-size:\s*([^;]+);", _rule())
    assert sizes == ["max(.7em, var(--fs-2xs, .6875rem))"], sizes


def test_the_hint_is_still_the_kit_refresh_affordance():
    src = KIT.read_text(encoding="utf-8")
    assert "hint.className = 'ow-load-hint';" in src and "hint.textContent = '· refreshing';" in src
