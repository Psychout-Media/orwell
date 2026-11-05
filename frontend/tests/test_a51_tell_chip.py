"""A51: the roster header chip - closed engine tell word -> one plain label, only for entries the caller passes (in-room), flag-off byte-identical."""
import json, os, subprocess, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JS = open(os.path.join(ROOT, "static", "js", "orwellPresence.js"), encoding="utf-8").read()


def _helper():
    a = JS.index("function _joinWithTells(")
    return JS[a:JS.index("// Flatten every visible person", a)].strip()


def _run(people):
    harness = _helper() + "\nconsole.log(JSON.stringify(_joinWithTells(" + json.dumps(people) + ", p => p.name)));\n"
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(harness); path = f.name
    try:
        out = subprocess.run(["node", path], capture_output=True, text=True, timeout=20)
    finally:
        os.unlink(path)
    assert out.returncode == 0, out.stderr
    return json.loads(out.stdout.strip().splitlines()[-1])


def test_label_for_known_word_and_plain_without():
    assert _run([{"name": "A", "tell": "snapping"}, {"name": "B"}]) == "A (on edge), B"


def test_flag_off_is_byte_identical_to_plain_join():
    ppl = [{"id": "1", "name": "A"}, {"id": "2", "name": "B"}]
    assert _run(ppl) == "A, B"


def test_unknown_or_hostile_word_never_renders():
    assert _run([{"name": "A", "tell": "constructor"}, {"name": "B", "tell": "<img>"}, {"name": "C", "tell": 3}]) == "A, B, C"


def test_chip_applied_only_to_in_room_present_list():
    assert "_joinWithTells(present" in JS or "joinWithTells(present)" in JS
    # nearby/tracked rows use the plain join, never the chip
    assert "joinWithTells(n.present" not in JS and "joinWithTells(w.nearby" not in JS


def test_guard_off_mutant_goes_red():
    mutated = JS.replace("n && lab ? n + \" (\" + lab + \")\" : n", "n")
    assert mutated != JS
    a = mutated.index("function _joinWithTells(")
    h = mutated[a:mutated.index("// Flatten every visible person", a)]
    out = subprocess.run(["node", "-e", h + "\nconsole.log(_joinWithTells([{name:'A',tell:'snapping'}], p=>p.name))"], capture_output=True, text=True)
    assert out.stdout.strip() == "A"  # the chip is gone: the real tests above would fail on this
