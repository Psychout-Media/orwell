"""ORW-1068: the scene-guard paths append to the bounded re-ground queue; none replaces it, and a drop is counted."""
import importlib

ch = importlib.import_module("routes.chat_helpers")


def setup_function(_f):
    ch._DESYNC_REGROUND.clear()


def test_enqueue_keeps_an_earlier_correction_and_one_directive_is_one_segment():
    ch._reground_enqueue("k", "KNOWLEDGE WALL: do not say who nominated whom.")
    ch._reground_enqueue("k", "BOARD: Dale is not evicted.\n\nStill on the block.")
    segs = ch._reground_segments("k")
    assert len(segs) == 2 and "KNOWLEDGE WALL" in segs[0]
    ch._reground_remove("k", "BOARD: Dale is not evicted.\n\nStill on the block.")  # removable despite the blank line
    assert len(ch._reground_segments("k")) == 1


def test_overflow_is_counted():
    before = ch.reground_dropped_count()
    for i in range(ch._REGROUND_QUEUE_CAP + 2):
        ch._reground_enqueue("k", f"correction {i}")
    assert ch.reground_dropped_count() == before + 2
    assert len(ch._reground_segments("k")) == ch._REGROUND_QUEUE_CAP


def test_no_guard_path_assigns_the_queue_directly():
    import inspect
    src = inspect.getsource(ch)
    import re
    direct = [m.group(0) for m in re.finditer(r"^\s*_DESYNC_REGROUND\[[^\]]+\]\s*=\s*(?!_REGROUND_SEP)[^\n]*", src, re.M)]
    assert all("_REGROUND_SEP.join" in d for d in direct), direct
