"""A79 - closed-set claim regex alternatives that no test depended on. A mutation sweep (pop one top-level `|` alternative per run) left 783 narration-guard tests green for each of the alternatives below.
For each: ONE phrase only that alternative matches (so deleting it must change the answer), a near-miss that the full pattern must NOT match, and the dependency check itself, run in-suite: the pattern
rebuilt WITHOUT the alternative must no longer match the phrase. Roles only. Indices are 0-based over the top-level `|` of the compiled pattern."""
import importlib
import re

import pytest

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")


def _top_level_alternatives(src: str) -> "list[str]":
    parts, depth, cur, i, in_cls = [], 0, [], 0, False
    while i < len(src):
        c = src[i]
        if c == "\\":
            cur.append(src[i:i + 2]); i += 2; continue
        if in_cls:
            in_cls = c != "]"
        elif c == "[":
            in_cls = True
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        elif c == "|" and depth == 0:
            parts.append("".join(cur)); cur = []; i += 1; continue
        cur.append(c); i += 1
    parts.append("".join(cur))
    return parts


def _without(rx: "re.Pattern", idx: int) -> "re.Pattern":
    alts = _top_level_alternatives(rx.pattern)
    return re.compile("|".join(a for i, a in enumerate(alts) if i != idx), rx.flags)


# (regex name, alternative index, label, the phrase only that alternative matches, a near-miss the pattern must NOT match)
CASES = [
    ("_CLAIM_COMP_RESULT_RE", 1, "wins/won ... the comp", "The first contestant clinches the competition.", "She takes the competition seriously."),
    ("_CLAIM_COMP_RESULT_RE", 4, "last one standing", "She is the last one standing.", "the last one in the kitchen turns off the light"),
    ("_CLAIM_COMP_RESULT_RE", 6, "slides the first/second key", "She slides the first key into the box.", "She slides the plate across the table."),
    ("_CLAIM_COMP_RESULT_RE", 7, "keys in your pocket/hand", "A key in your hand, warm from the sun.", "The keys are in the bowl by the door."),
    ("_CLAIM_COMP_RESULT_RE", 8, "two keys", "He holds up two keys.", "He has two kids and a dog."),
    ("_CLAIM_COMP_RESULT_RE", 10, "the comp is over/decided/won", "The competition is over.", "The competition is tomorrow afternoon."),
    ("_CLAIM_COMP_RESULT_RE", 11, "you're out of the game/eliminated", "You're out of the game.", "You're out of your mind."),
    ("_CLAIM_COMP_RESULT_RE", 12, "you are out of the game/eliminated", "You are eliminated.", "You are out of coffee."),
    ("_CLAIM_COMP_RESULT_RE", 14, "the yard erupts", "The yard erupts.", "The yard is quiet tonight."),
    ("_CLAIM_VETO_USE_RE", 3, "didn't use the veto", "She didn't use the veto.", "She didn't use the stairs."),
    ("_CLAIM_VETO_USE_RE", 5, "pulled off the block with the veto", "He was pulled off the block with the veto.", "He pulled the cart off the road."),
    ("_CLAIM_VETO_USE_RE", 6, "saved with the veto", "She is saved with the veto.", "She is saved a seat by the window."),
    ("_CLAIM_PLAYER_IN_FIELD_RE", 2, "you take your place / line up / compete", "You take your place at the line.", "You take your coat from the hook."),
    ("_CLAIM_PLAYER_IN_FIELD_RE", 3, "your pedestal / lane / chip", "Your pedestal wobbles.", "Your sandwich wobbles on the plate."),
    ("_MET_EVERYONE_RE", 1, "met all/every one of the houseguests", "You met every one of the houseguests.", "You met three houseguests in the kitchen."),
    ("_MET_EVERYONE_RE", 2, "you have met the whole/entire/full house|cast|roster", "You've now met the entire roster.", "You've met the neighbors."),
]


@pytest.mark.parametrize("name,idx,label,phrase,near_miss", CASES, ids=[f"{c[0]}#{c[1]}" for c in CASES])
def test_the_alternative_matches_its_phrase_not_its_near_miss_and_is_load_bearing(name, idx, label, phrase, near_miss):
    rx = getattr(ch, name)
    assert len(_top_level_alternatives(rx.pattern)) > idx, f"{name} no longer has an alternative #{idx} ({label}): update the case"
    assert rx.search(phrase), f"{name}#{idx} ({label}) must match {phrase!r}"
    assert not rx.search(near_miss), f"{name}#{idx} ({label}) must NOT match the near-miss {near_miss!r}"
    assert not _without(rx, idx).search(phrase), f"{name}#{idx} ({label}): another alternative also matches {phrase!r}; the case is not isolating this one (pick a phrase only it matches)"


def test_the_splitter_is_not_vacuous():
    assert len(_top_level_alternatives(ch._CLAIM_COMP_RESULT_RE.pattern)) == 15
    assert len(_top_level_alternatives(ch._CLAIM_VETO_USE_RE.pattern)) == 7
