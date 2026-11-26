"""ORW-952: the cast-writing prompt states what the checks enforce; a refused clothes rewrite says why."""
import json

from src import orwell_cast_authoring as A
from src import orwell_cast_believability as B
from src import orwell_cast_gate as gate
from test_orw563_believable_look import Fake, _cast, _run_pass


def test_the_first_draft_prompt_names_the_biography_length_the_gate_uses():
    assert "under %d characters" % gate.BIO_ASK_CHARS in A._SYSTEM
    assert "under %d characters" % gate.BIO_ASK_CHARS in gate.rewrite_message(["bio-format"])
    assert gate.BIO_OVERSIZE_CHARS == gate.BIO_ASK_CHARS * 3 // 2


def test_the_prompt_carries_the_pronoun_rule():
    assert "use no pronoun other than this person's own" in A.PHOTO_SHEET_RULES
    assert "do not refer to anyone else" in A.PHOTO_SHEET_RULES
    assert A.PHOTO_SHEET_RULES in A._SYSTEM


def test_a_text_the_rule_allows_passes_and_one_it_forbids_fails():
    allowed = "Arms folded, gaze off to one side, a dry half smile."
    assert not A.pronoun_mismatch(allowed, "man") and not A.pronoun_mismatch(allowed, "woman")
    assert not A.pronoun_mismatch("He looks past the lens, his hands in his pockets.", "man")
    for text in ("Their arms are folded.", "She watches him closely."):
        assert A.pronoun_mismatch(text, "man")
    assert A.pronoun_mismatch("They look past the lens.", "woman")
    assert A.pronoun_mismatch("Her hands in her pockets, near him.", "man")


def test_a_refused_clothes_rewrite_names_the_failing_code(monkeypatch):
    seen = []
    monkeypatch.setattr(B, "_soft_failure", lambda kind, msg, user=None: seen.append((kind, msg)))
    cards = _cast()
    fake = Fake(json.dumps({"flagged": [{"id": "npc:1", "reason": "x", "pick": ""}]}), rewrite_ok=False)
    assert _run_pass(cards, fake, {}) == 0
    assert seen and seen[0][0] == "rewrite" and "wardrobe-count" in seen[0][1]
