import importlib.util, pathlib
spec = importlib.util.spec_from_file_location("live_short", pathlib.Path(__file__).parent / "live_short.py")
ls = importlib.util.module_from_spec(spec); spec.loader.exec_module(ls)


def test_eviction_allowance_needs_the_reply_to_play_eviction_steps():
    assert ls.eviction_voiced("The first ballot is read: a vote to evict the nominee. The tally stands at three.")
    assert not ls.eviction_voiced("You chat by the pool about snacks.")   # same phase name, no eviction step in the reply: the clock jump is NOT the ceremony
    assert not ls.eviction_voiced(None)


def test_the_other_ten_of_you_is_a_remainder_not_a_house_total():  # ORW-549: six names called, "the other ten of you" is the other 10 of 16
    assert not ls.headcount_claims("the six names settling, the other ten of you suddenly spectators.")
    assert not ls.headcount_claims("Nine are in the room; the rest of you stay put.")
    assert ls.headcount_claims("There are ten of you left.")   # a true house total still scores
    assert ls.headcount_claims("Ten of you, all friends.")     # unqualified still warns
