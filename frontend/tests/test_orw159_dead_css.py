"""ORW-159: static/style.css blocks first paint at ~1 MB; the provably-dead rules were removed.

Pins (static, no browser):
 1. the dead-selector scanner (scripts/orw159_dead_css.py) finds no NEW provably dead rules above a small
    allowance (a rule is dead only when every selector in it needs a class/id/attribute name that appears
    nowhere in the game-build sources -- conservative: any token, prefix/suffix concat, camelCase dataset);
 2. a sample of the removed selector families does not return;
 3. a size ceiling on style.css (a ratchet: lower it as more is pruned, never raise it casually).

If (1) fails: you added CSS for a class nothing emits (delete it, or emit the class), or you removed the last
emitter of a class -- run `python3 scripts/orw159_dead_css.py --list` and prune with `--apply`.
"""
import importlib.util
import os

HERE = os.path.dirname(os.path.abspath(__file__))
FRONTEND = os.path.dirname(HERE)
_spec = importlib.util.spec_from_file_location("orw159_dead_css", os.path.join(FRONTEND, "scripts", "orw159_dead_css.py"))
dc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dc)

CSS = open(dc.CSS_PATH, encoding="utf-8").read()

# before: 1,056,894 bytes. After the ORW-159 prune: see SIZE_CEILING (small headroom for organic growth).
SIZE_CEILING = 982_000
DEAD_ALLOWANCE = 5

# A representative sample of removed families (class names with no emitter anywhere in the game sources).
REMOVED_CLASSES = [
    "sidebar-sep", "icon-rail-divider", "unfiled-drop-zone", "swipe-delete-action",
    "rag-upload-zone", "rag-file-delete", "msg-overflow-item", "continue-separator", "toast-checkmark",
    "btn-spinner", "loading-indicator", "code-runner-close",
]


def test_size_ceiling():
    assert len(CSS.encode("utf-8")) <= SIZE_CEILING, "style.css grew past the ORW-159 ceiling"


def test_no_new_provably_dead_rules():
    corpus = dc.Corpus(dc.corpus_tokens())
    dead = dc.find_dead(CSS, corpus)
    kf = dc.dead_keyframes(CSS, corpus, dead)
    found = [(p[:80], pr) for _, _, p, pr in dead + kf]
    assert len(found) <= DEAD_ALLOWANCE, f"{len(found)} provably dead CSS rules/keyframes: {found[:10]}"


def test_removed_families_stay_removed():
    import re
    for c in REMOVED_CLASSES:
        assert not re.search(r"\." + re.escape(c) + r"(?![\w-])", CSS), f".{c} (dead, ORW-159) is back in style.css"


def test_scanner_is_conservative():
    corpus = dc.Corpus({"foo-", "-bar", "live", "fooBar"})
    assert dc.selector_dead(".live", corpus) is None
    assert dc.selector_dead(".foo-anything", corpus) is None      # prefix concatenation
    assert dc.selector_dead(".x-bar", corpus) is None             # suffix concatenation
    assert dc.selector_dead("[data-foo-bar]", corpus) is None       # dataset camelCase
    assert dc.selector_dead(".live:not(.gone)", corpus) is None   # :not() args never prove deadness
    assert dc.selector_dead(".live .gone", corpus) == ".gone"
    assert dc.rule_dead(".live, .gone", corpus) is None           # one live selector keeps the rule
    assert dc.rule_dead(".gone, #nope", corpus) is not None


def test_sw_cache_bumped_and_style_in_shell():
    sw = open(os.path.join(FRONTEND, "static", "sw.js"), encoding="utf-8").read()
    assert "'/static/style.css'" in sw
    import re
    m = re.search(r"CACHE_NAME = 'orwell-v(\d+)'", sw)
    assert m and int(m.group(1)) >= 334, "sw.js CACHE_NAME must be bumped when style.css changes (ORW-159)"
