"""ORW-1020: the invented-houseguest guard (NARR-3) must never fire on this season's room names, and must still fire on a truly invented person.

Classes from the dev/prod journals (paraphrased, no player text):
  A. themed two-word room staged with a scene verb ("<Room> crackles", "<Room> hums")  - 23 of 24 dev hits
  B. a themed room named right after a motion verb or in a speaker-less quoted line
  C. a transition word before a roster first name ("Meanwhile <First>")                  - the prod hit
True positives: a person staged in a room's sentence, a speaker tag, a copula introduction.
"""
import os
import sys

import pytest

_FRONTEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _FRONTEND not in sys.path:
    sys.path.insert(0, _FRONTEND)

import routes.chat_helpers as ch  # noqa: E402

ROOM_NAMES = {
    "kitchen": "the Hearth Pit",
    "living-room": "the Long Porch",
    "hallway": "the Flue Passage",
    "backyard": "the Soot Garden",
    "bedroom-a": "the Strider Bunk",
    "bedroom-b": "the Calliope Corridor",
    "hoh-room": "the Caldera Hearth",
    "diary-room": "the Confessional Crater",
    "storage-room": "the Dry Wash",
    "landing": "the Bearing Corridor",
}
FULL = {"marcus webb", "ana flores", "miguel ortiz"}
FIRST = {"marcus", "ana", "miguel"}
VOCAB = ch._room_vocab(ROOM_NAMES)


def _hit(sentence, vocab=VOCAB):
    return ch._sentence_names_invented(sentence, FIRST, FULL, vocab)


@pytest.mark.parametrize("sentence", [
    "Hearth Pit leans toward the grate as the others gather.",
    "Long Porch stands open and the boards settle.",
    "Flue Passage waits, and the draft pulls at the door.",
    "Soot Garden says nothing, quiet under the lamps.",
    "Strider Bunk smells of cedar and sleeps three.",
    "Calliope Corridor lingers and then goes still.",
    "Caldera Hearth glows while the ash settles.",
    "Confessional Crater stands open: \"Say it plainly.\"",
    "Dry Wash sits empty and nobody lingers.",
    "Bearing Corridor stands toward the stairs.",
    "You walk Hearth Pit and sit by the grate.",
    "Meanwhile Miguel waits by the door.",
    "Big Brother calls everyone to the living room.",
])
def test_rooms_and_known_names_never_fire(sentence):
    assert _hit(sentence) is None, sentence


def test_without_theme_plain_room_labels_still_pass():
    v = ch._room_vocab(None)
    assert ch._sentence_names_invented("Storage Room hums.", FIRST, FULL, v) is None


@pytest.mark.parametrize("sentence,who", [
    ("Harrison Cole leans against the Hearth Pit and grins.", "Harrison Cole"),
    ("Suddenly Zed Quill says nothing near the Long Porch.", "Zed Quill"),
    ("Harrison Cole: \"Nice kitchen.\"", "Harrison Cole"),
    ("@[Hearth Pit] — \"I know what you did.\"", "Hearth Pit"),  # a speaker tag is a person, whatever its words
])
def test_invented_person_still_fires(sentence, who):
    assert _hit(sentence) == who


def test_copula_introduction_still_fires():
    assert _hit("Zephyr is a new houseguest in the Long Porch.") == "Zephyr"


def test_no_vocab_keeps_old_behaviour():
    assert ch._sentence_names_invented("Hearth Pit leans in.", FIRST, FULL) == "Hearth Pit"


@pytest.mark.parametrize("sentence", [
    "Hearth Pit leans toward the grate as the others gather.",
    "Long Porch stands open and the boards settle.",
    "Soot Garden says nothing, quiet under the lamps.",
])
def test_the_staged_room_sentences_do_fire_without_the_room_set(sentence):
    # proves the table above exercises the guard: the same lines flag when no room vocabulary is given
    assert ch._sentence_names_invented(sentence, FIRST, FULL) is not None
