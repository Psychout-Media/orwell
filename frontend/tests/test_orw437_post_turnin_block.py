"""ORW-437 (review of #2722): an incomplete post-turnIn briefing falls back per field to the turnIn status."""
import json
from types import SimpleNamespace

from src.agent_loop import _post_turn_in_asleep_block

OUT = json.dumps({"status": {"timeOfDay": "morning", "asleep": [{"name": "Sam"}]}})


def test_empty_part_of_day_falls_back_to_the_turn_in_status():
    b = SimpleNamespace(part_of_day="", asleep=[])
    blk = _post_turn_in_asleep_block(OUT, b, "")
    assert "it is now morning" in blk


def test_a_briefing_with_both_facts_is_used_as_is():
    b = SimpleNamespace(part_of_day="afternoon", asleep=["Kim"])
    blk = _post_turn_in_asleep_block(OUT, b, "")
    assert "afternoon" in blk and "Kim" in blk and "Sam" not in blk


def test_no_briefing_uses_the_status_for_both():
    blk = _post_turn_in_asleep_block(OUT, None, "")
    assert "morning" in blk and "Sam" in blk
