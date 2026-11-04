"""P5d (P5c finding): the F-6 replay guard only caught a later round that OPENED with the same 6-word prefix. Live (forced secret-veto slice) a round re-told the
whole scene in PARAPHRASE — different opening, same beats — and #829 coalescing glued the two takes into one bubble. A later round whose substantive sentences are
mostly near-duplicates (content-word Jaccard) of sentences already shown this turn is a replay too. Narrow: needs >= 3 substantive sentences and >= 70% matched. Roles only."""
import importlib

importlib.import_module("src.agent_tools")
al = importlib.import_module("src.agent_loop")

SHOWN = """Role A looks up while you get up.

You cross to the little table by the door, and the walk feels longer than the room is. Role B watches you the whole way, arms loose, chin up, that little crinkle at the corners of his eyes that could be nerves or could be a man deciding to be gracious about it.

The paper's in your hand. The pen's heavier than it should be.

Behind you, nobody's breathing loud. Somebody shifts in a chair.

It's just a name on a slip."""

PARAPHRASE = """The walk to the little table by the door is longer than the room is.

The pen is heavier than it should be. Behind you, nobody's breathing loud. Somebody shifts in a chair. Role B watches the whole way, arms loose, chin up, with that crinkle at the corners of his eyes that could be nerves or could be a man deciding to be gracious about it.

It's just a name on a slip."""

CONTINUATION = """The votes are read one at a time, and the count climbs until a name has the majority.

Role C exhales and stares at the ceiling while the host waits for the room to settle. Somebody in the back starts to clap and stops.

"That's the vote," the host says, and the lights shift toward the door."""


def test_a_paraphrased_retelling_of_the_shown_scene_is_a_replay():
    assert al._replays_shown(PARAPHRASE, SHOWN) is True


def test_ordinary_continuation_prose_is_never_a_replay():
    assert al._replays_shown(CONTINUATION, SHOWN) is False


def test_one_echoed_line_in_new_prose_is_not_a_replay():
    mixed = ("The host reads the first ballot aloud and the room goes quiet. A second ballot follows, then a third, "
             "and Role C starts counting on his fingers under the table.\n\nIt's just a name on a slip.")
    assert al._replays_shown(mixed, SHOWN) is False


def test_the_original_prefix_rule_still_works():
    assert al._replays_shown("You cross to the little table by the door and sit down heavily.", SHOWN) is True


def test_short_rounds_and_empty_shown_never_trip():
    assert al._replays_shown("Okay.", SHOWN) is False
    assert al._replays_shown(PARAPHRASE, "") is False
