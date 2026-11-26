"""ORW-1038 (audit A3): the front end's `_player_asked_to_move` gate against audit A3's move corpus (tests/fixtures/orw1008/corpus.txt, shared with the engine parser's test). The counts are a ratchet: they may
only go DOWN as the gate is brought into line with the engine's parser. Baseline before ORW-1038 (audit A3): 63 false moves of 426 non-moves, 83 missed of 183 moves. Set ORW1008_LIST=1 to print every misread."""
import os

from src import agent_loop as al

FX = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tests", "fixtures", "orw1008", "corpus.txt")
CEILING_FALSE_MOVES = 46
CEILING_MISSED_MOVES = 55


def _rows():
    for line in open(FX, encoding="utf-8"):
        line = line.rstrip("\n")
        if not line or line.startswith("#"):
            continue
        cls, _here, text, exp = (line.split("|") + [""])[:4]
        if cls == "bedgo":
            continue  # the engine's own-bed seam reads these, not this gate
        yield cls, text, exp not in ("-", "")


def test_the_gate_against_the_a3_corpus_only_improves():
    fp, fn = [], []
    for cls, text, exp in _rows():
        got = al._player_asked_to_move(text, None)
        if got and not exp:
            fp.append((cls, text))
        elif exp and not got:
            fn.append((cls, text))
    if os.environ.get("ORW1008_LIST"):
        print("FALSE", *fp, "MISSED", *fn, sep="\n")
    assert len(fp) <= CEILING_FALSE_MOVES, f"false moves {len(fp)}"
    assert len(fn) <= CEILING_MISSED_MOVES, f"missed moves {len(fn)}"


def test_quoted_speech_ooc_and_takebacks_never_move():
    for text in ['I say "let\'s go to the kitchen" and stay', "((let's go to the kitchen))", "I say 'let's go to the backyard'", "I head to the kitchen; actually never mind", "I go to the kitchen, if Dana's there",
                 "I'll go to the kitchen later", "I go to the kitchen every morning"]:
        assert not al._player_asked_to_move(text, None), text
    for text in ["I smile and go to the kitchen", "I enter the kitchen", "I'm heading to the lounge", "We go to the kitchen"]:
        assert al._player_asked_to_move(text, None), text
