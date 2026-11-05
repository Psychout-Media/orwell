"""Live E-1 (2026-11-04): a turn whose model called `ask_user` left the round loop before the nudge block bound `_want_record` / `_phase`; the post-loop overseer and
faithfulness hooks then raised UnboundLocalError (soft-failed → both gates skipped that turn). Pin: both names are bound at turn init, before the round loop."""
import re
from pathlib import Path

SRC = (Path(__file__).resolve().parent.parent / "src" / "agent_loop.py").read_text()


def test_turn_init_binds_the_post_loop_hook_names():
    init = SRC.index("    _turn_record_nudges = 0\n")
    window = SRC[init:init + 900]
    assert re.search(r"^\s+_want_record = False$", window, re.M)
    assert re.search(r"^\s+_phase = None$", window, re.M)
    # …and strictly before the first in-loop assignment of either name.
    first_assign = min(SRC.index("                _want_record = _gates.want_record("), SRC.index("_phase, _house, _moment = None, [], None"))
    assert init < first_assign


def test_silent_advance_owes_its_announcements_to_the_player():
    """E-1 follow-up: an FE-issued (silent) advance commits beats whose chyron the player must see — incl. their OWN eviction. It must stash them (id-deduped)."""
    i = SRC.index("async def _commit_advance_silently")
    body = SRC[i:i + 14000]
    assert "stash_preresolved_announcements(owner, _adv)" in body
