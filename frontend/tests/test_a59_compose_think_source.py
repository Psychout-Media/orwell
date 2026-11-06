"""A59 (R2 slice): ONE helper builds the <think>-wrapped source; the three render paths call it and its output equals the three old hand-built strings."""
import os, subprocess, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = os.path.join(ROOT, "static", "js")


def _src(name):
    return open(os.path.join(JS, name), encoding="utf-8").read()


def _helper():
    s = _src("markdown.js")
    a = s.index("export function composeThinkSource(")
    b = s.index("\n}\n", a) + 3
    return s[a:b].replace("export function", "function")


def _run(expr):
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(_helper() + "\nconsole.log(JSON.stringify(" + expr + "));\n"); path = f.name
    try:
        out = subprocess.run(["node", path], capture_output=True, text=True, timeout=20)
    finally:
        os.unlink(path)
    assert out.returncode == 0, out.stderr
    import json
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_equals_the_old_live_and_mirror_form():
    assert _run("composeThinkSource('why', 'hi')") == "<think>why</think>\n\nhi"
    assert _run("composeThinkSource('  ', 'hi')") == "hi"      # blank reasoning: reply only (old: reasoning.trim() ? ... : reply)
    assert _run("composeThinkSource('', 'hi')") == "hi"
    assert _run("composeThinkSource(null, 'hi')") == "hi"


def test_equals_the_old_reload_form():
    assert _run("composeThinkSource('why', 'hi', 12, true)") == '<think time="12">why</think>\n\nhi'
    assert _run("composeThinkSource('why', 'hi', null, true)") == "<think>why</think>\n\nhi"
    assert _run("composeThinkSource(' ', 'hi', null, true)") == "<think> </think>\n\nhi"  # reload kept a whitespace-only block


def test_the_three_paths_call_the_one_helper_and_no_hand_built_think_remains():
    chat, rend = _src("chat.js"), _src("chatRenderer.js")
    assert chat.count("markdownModule.composeThinkSource(") == 2 and "markdownModule.composeThinkSource(" in rend
    assert "'<think>' + roundReasoningText" not in chat and "'<think>' + reasoningText" not in chat
    assert "'<think' + (thinkTime" not in rend


def test_separator_mutant_goes_red():
    """Mutant: drop the blank line after </think>. The equivalence pins above must see it."""
    good = _helper()
    bad = good.replace("'</think>\\n\\n'", "'</think>'")
    assert bad != good
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(bad + "\nconsole.log(JSON.stringify(composeThinkSource('why', 'hi')));\n"); path = f.name
    try:
        out = subprocess.run(["node", path], capture_output=True, text=True, timeout=20).stdout.strip()
    finally:
        os.unlink(path)
    assert out != '"<think>why</think>\\n\\nhi"'
