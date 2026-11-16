import importlib.util, pathlib
spec = importlib.util.spec_from_file_location("live_short", pathlib.Path(__file__).parent / "live_short.py")
ls = importlib.util.module_from_spec(spec); spec.loader.exec_module(ls)


def test_eviction_allowance_needs_the_reply_to_play_eviction_steps():
    assert ls.eviction_voiced("The first ballot is read: a vote to evict the nominee. The tally stands at three.")
    assert not ls.eviction_voiced("You chat by the pool about snacks.")   # same phase name, no eviction step in the reply: the clock jump is NOT the ceremony
    assert not ls.eviction_voiced(None)
