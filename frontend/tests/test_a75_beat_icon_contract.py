"""A75 - every engine `Beat` kind has an outcome-chip icon in `_BEAT_ICON` (orwellToolBeats.js), or is in an explicit, commented 'never shown as a chip' allowlist. Before this, four kinds
(comp-elimination, battle-back, self-eviction, final-hoh-part) and day-break fell back to a bare bullet. The Beat union is parsed from src/engine/liveSeason.ts so a new engine beat kind fails here until it
gets an icon or a reason. Roles only."""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
LIVE = open(os.path.join(ROOT, "src", "engine", "liveSeason.ts"), encoding="utf-8").read()
BEATS_JS = open(os.path.join(ROOT, "frontend", "static", "js", "orwellToolBeats.js"), encoding="utf-8").read()

# Beat kinds that are NEVER rendered as an outcome chip, with the reason (a new entry needs one).
NEVER_A_CHIP = {
    "complete": "the terminal structural state of the season (s.beat === 'complete'); it is never a BeatEvent, the crowned-winner line covers the end",
}


def _beat_kinds():
    a = LIVE.index("export type Beat =")
    tail = re.sub(r"//[^\n]*", "", LIVE[a:a + 6000])  # strip comments FIRST: a ';' inside a comment must not end the union early
    body = tail[:tail.index(";")]
    return set(re.findall(r'"([a-z][a-z-]*)"', body))


def _icon_keys():
    a = BEATS_JS.index("const _BEAT_ICON = {")
    body = BEATS_JS[a:BEATS_JS.index("};", a)]
    return set(re.findall(r"'([a-z][a-z-]*)'\s*:", body))


def test_the_beat_union_was_parsed():
    kinds = _beat_kinds()
    assert {"hoh-competition", "comp-elimination", "day-break", "complete"} <= kinds and len(kinds) >= 20, kinds


def test_every_beat_kind_has_an_icon_or_a_documented_reason():
    missing = sorted(_beat_kinds() - _icon_keys() - set(NEVER_A_CHIP))
    assert not missing, f"engine beat kinds with no outcome-chip icon (they fall back to a bare bullet): {missing}"


def test_the_allowlist_is_real_and_not_stale():
    kinds, icons = _beat_kinds(), _icon_keys()
    for k, why in NEVER_A_CHIP.items():
        assert k in kinds and why.strip(), k
        assert k not in icons, f"{k} is allow-listed as never-a-chip but has an icon: remove it from NEVER_A_CHIP"


def test_no_icon_for_a_kind_the_engine_no_longer_has():
    stale = sorted(_icon_keys() - _beat_kinds())
    assert not stale, f"_BEAT_ICON has keys that are not engine Beat kinds: {stale}"
