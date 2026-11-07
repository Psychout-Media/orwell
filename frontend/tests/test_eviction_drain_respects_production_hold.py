"""While production HOLDS the eviction (scheduled for the evening, not yet due) the F14 eviction-drain must not force the ceremony open early: that raised the player's eviction-vote card hours before
its time (a64: card staged at message 197 with 475 in-game minutes left). Once the hold pops the drain works as before. Roles only."""
import importlib
import inspect

import pytest

g = importlib.import_module("src.agent_gates")
al = importlib.import_module("src.agent_loop")

BASE = dict(in_eviction=True, progressed=False, turn_advance_nudges=0, max_advance_nudges=2, production_holding=False)


def test_the_drain_still_fires_when_the_eviction_is_due_and_not_held():
    assert g.want_drain_eviction(**BASE) is True


def test_the_drain_does_not_fire_while_production_holds_the_eviction():
    assert g.want_drain_eviction(**{**BASE, "production_holding": True}) is False


@pytest.mark.parametrize("kw", [{"in_eviction": False}, {"progressed": True}, {"turn_advance_nudges": 2}])
def test_the_other_original_conditions_are_unchanged(kw):
    assert g.want_drain_eviction(**{**BASE, **kw}) is False


def test_the_agent_loop_feeds_the_live_hold_into_the_gate():
    src = inspect.getsource(al)
    assert "_gates.want_drain_eviction(" in src and "production_is_holding(owner)" in src
    assert "_want_drain_eviction = (_in_eviction and (not _progressed)" not in src  # the ungated inline expression is gone
