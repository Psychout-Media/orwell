"""ORW-511: the short-list guard fails on a planted short list and a planted example line / closed menu, in TypeScript, Python and front-end JS,
and the real tree is green against ci/short_list_allowlist.json. Pure (no server, no /tmp run folder)."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ci"))
import check_short_lists as G  # noqa: E402
import short_list_scan as S  # noqa: E402

LONG = ", ".join(f'"item number {i}"' for i in range(45))


def run(srcs, entries=()):
    return G.check(S.scan_sources(srcs), list(entries))[0]


def test_planted_short_ts_list_fails():
    ts = 'const FOODS = ["soup", "bread", "stew", "salad"];\nexport function f(rng: R) { return rng.pick(FOODS); }\n'
    bad = run({"ts": {"src/engine/planted.ts": ts}})
    assert len(bad) == 1 and "src/engine/planted.ts" in bad[0] and "FOODS" in bad[0]


def test_planted_short_ts_modulo_and_inline_fail():
    ts = 'const A = ["x1","x2","x3"];\nexport const g = (h: number) => A[h % A.length];\nexport const k = (r: R) => r.pick(["a1", "b2", "c3"]);\n'
    assert len(run({"ts": {"src/engine/planted.ts": ts}})) == 2


def test_planted_short_py_list_fails():
    py = 'import random\nGREETINGS = ["hi there", "hello", "welcome back"]\ndef f():\n    return random.choice(GREETINGS)\n'
    bad = run({"py": {"frontend/src/planted.py": py}})
    assert len(bad) == 1 and "GREETINGS" in bad[0]


def test_planted_py_modulo_and_inline_fail():
    py = 'NAMES = ("a1", "b2", "c3")\ndef f(h):\n    return NAMES[h % len(NAMES)]\ndef g(r):\n    return r.choice(["x1", "y2", "z3"])\n'
    assert len(run({"py": {"frontend/src/planted.py": py}})) == 2


def test_a_long_list_and_an_undealt_list_pass():
    ts = f"const BIG = [{LONG}];\nexport const f = (r: R) => r.pick(BIG);\nconst SHORT_BUT_UNDEALT = [\"a1\", \"b2\", \"c3\"];\n"
    py = "FIELDS = ('a1', 'b2', 'c3')\ndef f(row):\n    return [row[k] for k in FIELDS]\n"
    assert run({"ts": {"src/engine/p.ts": ts}, "py": {"frontend/src/p.py": py}}) == []


def test_planted_example_line_fails_in_each_language():
    ts = 'export const P = "Write the line in the houseguest\'s voice (e.g. a dry remark about the weather).";\n'
    py = 'PROMPT = "Give a hometown, for example Waco or Chula Vista, in the card."\n'
    js = 'const hint = "Say it plainly, such as: I hear you and I disagree.";\n'
    for lang, path, src in (("ts", "src/engine/p.ts", ts), ("py", "frontend/src/p.py", py), ("js", "frontend/static/js/p.js", js)):
        bad = run({lang: {path: src}})
        assert len(bad) == 1 and "example line" in bad[0], (lang, bad)


def test_planted_closed_menu_fails_in_each_language():
    ts = 'export const P = "Pick one of \\"calm\\", \\"tense\\", \\"giddy\\", \\"cold\\" for the mood of the scene.";\n'
    py = "PROMPT = 'Choose from \"calm\", \"tense\", \"giddy\" for the mood of the scene, then write it.'\n"
    js = 'const m = "mood: \\"calm\\" | \\"tense\\" | \\"giddy\\" is what you may write here";\n'
    for lang, path, src in (("ts", "src/engine/p.ts", ts), ("py", "frontend/src/p.py", py), ("js", "frontend/static/js/p.js", js)):
        bad = run({lang: {path: src}})
        assert len(bad) == 1 and "closed menu" in bad[0], (lang, bad)


def test_comments_and_docstrings_are_not_prompt_text():
    ts = '// e.g. a comment, for example\n/* such as this */\nexport const x = 1;\n'
    py = '"""Docstring, e.g. this, for example that."""\n# e.g. comment\ndef f():\n    """such as this"""\n    return 1\n'
    assert run({"ts": {"src/engine/p.ts": ts}, "py": {"frontend/src/p.py": py}}) == []


def test_allowlist_entry_passes_but_a_new_one_in_the_same_file_fails():
    py = 'A = "Say it, e.g. like this one, to them."\n'
    ent = [{"path": "frontend/src/p.py", "kind": "example", "name": "text", "max": 1, "owner": "ORW-510", "reason": "owned by the live text card, removed there"}]
    assert run({"py": {"frontend/src/p.py": py}}, ent) == []
    two = py + 'B = "Or say it, for example, like so for them."\n'
    bad = run({"py": {"frontend/src/p.py": two}}, ent)
    assert len(bad) == 1 and "ceiling" in bad[0]


def test_allowlist_entry_without_owner_or_reason_fails():
    ent = [{"path": "x.py", "kind": "list", "name": "L", "max": 1, "owner": "", "reason": "short"}]
    assert any("needs an owner" in b for b in run({}, ent))


def test_real_tree_is_green_and_every_entry_has_an_owner_and_reason():
    entries = G.load_allowlist()
    assert entries and all(e["owner"] and len(e["reason"]) >= G.MIN_REASON for e in entries)
    assert {e["owner"] for e in entries} <= {"ORW-508", "ORW-509", "ORW-510", "ORW-480", "ORW-511"}
    r = subprocess.run([sys.executable, str(ROOT / "ci" / "check_short_lists.py")], capture_output=True, text=True)
    assert r.returncode == 0, r.stdout + r.stderr
