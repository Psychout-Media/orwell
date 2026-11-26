"""ORW-956: one table of rules builds the cast prompt and its checks; a failing field is re-asked once, not dropped.

Pure source and stub checks: no model call, no network. Names are invented."""
import ast
import asyncio
import inspect
import json
import re
import textwrap

from src import orwell_cast_authoring as A
from src import orwell_cast_gate as gate
from src import orwell_cast_realism as RL
from src import orwell_cast_rules as R


def _run(c):
    return asyncio.new_event_loop().run_until_complete(c)


CARD = {"id": "npc:1", "name": "Dana Test", "genderPresentation": "woman", "age": 30, "vocation": "nurse",
        "hometown": "Tulsa, Oklahoma", "identityConcept": "A night-shift nurse who keeps the ward calm."}
OK_CAM = "Arms folded, gaze off to one side, a dry half smile."
BAD_CAM = "She says hello to the group, then laughs."  # banned words: says, then, the group
GOOD_WARDROBE = ["a white blouse", "dark jeans"]


def _user_message():
    npc = {**CARD, "physicalCharacteristics": {"hair": "brown"}}
    taken = {"phrases": {"marks": ["a mole"]}, "openings": {"closing read": "no"}}
    return A.build_authoring_messages(npc, taken=taken)[1]["content"]


# ── 1. the prompt is built from the table ─────────────────────────────────────────────────────────────────────────
def _prompt_text(where):
    return {"sheet": A.PHOTO_SHEET_RULES, "system": A._SYSTEM, "user": _user_message()}[where]


def test_every_rule_sentence_is_in_the_prompt_that_carries_it():
    extras = {**A._RULE_EXAMPLES, "name": "Dana"}
    for rule in R.RULES:
        text = R.render(R.SENTENCES[rule.sentence], extras).strip()
        assert text.replace("Dana", "Dana Test") in _prompt_text(rule.where) or text in _prompt_text(rule.where), rule.code


def test_the_sheet_sentences_reach_every_writer_of_the_sheet():
    for rule in R.RULES:
        if rule.where == "sheet":
            text = R.render(R.SENTENCES[rule.sentence], A._RULE_EXAMPLES).strip()
            assert text in A.PHOTO_SHEET_SYSTEM, rule.code  # the photo-sheet writer
            assert text in A._SYSTEM, rule.code  # the first draft
            assert text in A.compact_rewrite_messages(CARD, "x")[0]["content"], rule.code  # the one-field rewrites


def test_no_sentence_is_in_the_table_without_a_rule_to_check_it():
    used = {r.sentence for r in R.RULES}
    assert set(R.SENTENCES) == used
    for r in R.RULES:
        assert r.sentence in R.SENTENCES and r.where in ("sheet", "system", "user")
    assert not re.search(r"\[\[", A._SYSTEM + A.PHOTO_SHEET_RULES + _user_message())  # no marker left unfilled


def test_render_refuses_an_unknown_rule_so_a_typo_cannot_ship_a_hole():
    for bad in ("[[rule:no-such-rule]]", "[[eg:no-such-example]]", "[[name]]"):
        try:
            R.render(bad)
        except KeyError:
            continue
        raise AssertionError(bad)


# ── 2. every check has a rule, every rule has a check ────────────────────────────────────────────────────────────
def _fn_ast(module, dotted):
    obj = module
    for part in dotted.split("."):
        obj = getattr(obj, part)
    return ast.parse(textwrap.dedent(inspect.getsource(obj)))


_CODE_SHAPE = re.compile(r"^[a-z][a-zA-Z]*(?:-[a-zA-Z]+)*$")


def _emitted(tree):
    """The reason codes a function puts out: `.append("code")`, `out["field"] = "code"`, list literals of codes."""
    found = set()
    for n in ast.walk(tree):
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "append":
            for a in n.args:
                if isinstance(a, ast.Constant) and isinstance(a.value, str):
                    found.add(a.value)
        elif isinstance(n, ast.Assign) and isinstance(n.value, ast.Constant) and isinstance(n.value.value, str) \
                and any(isinstance(t, ast.Subscript) for t in n.targets):
            found.add(n.value.value)
        elif isinstance(n, ast.List):
            found.update(e.value for e in n.elts if isinstance(e, ast.Constant) and isinstance(e.value, str))
    return {c for c in found if _CODE_SHAPE.match(c) and "-" in c or c in {"family", "upscale", "climate", "missing"}}


def _all_strings(tree):
    return {n.value for n in ast.walk(tree) if isinstance(n, ast.Constant) and isinstance(n.value, str)}


_CHECKS = (
    (A, "look_problems"), (A, "story_problems"), (A, "story_name_codes"), (A, "card_consistency"),
    (A, "parse_dropped"), (gate, "card_codes"), (gate, "background_codes"), (RL, "look_fits_life"),
)
# codes the checks build with a computed name: "identity-" + the story-name code, "look-missing-" + a field
_COMPUTED = ({"identity-name", "identity-cast-name"} | {"look-missing-" + f for f in A._REQUIRED_LOOK_FIELDS})


def test_every_code_a_check_emits_has_a_rule_with_a_sentence():
    emitted = set(_COMPUTED)
    for mod, name in _CHECKS:
        emitted |= _emitted(_fn_ast(mod, name))
    emitted |= _emitted(_fn_ast(A, "write_photo_sheet"))  # the default problems of a sheet reply with no usable field
    missing = sorted(c for c in emitted if c not in R.BY_CODE)
    assert not missing, f"checks emit codes with no rule (so no sentence in the prompt): {missing}"


def test_every_rule_names_a_check_that_really_emits_its_code():
    for rule in R.RULES:
        mod_name, _, fn = rule.check.partition(".")
        mod = {"orwell_cast_authoring": A, "orwell_cast_gate": gate, "orwell_cast_realism": RL}[mod_name]
        strings = _all_strings(_fn_ast(mod, fn))
        assert rule.code in strings or rule.code in _COMPUTED, f"{rule.code}: {rule.check} never emits it"


def test_the_gate_blocking_tier_is_the_one_it_was_before_the_table():
    assert gate.BLOCKING == frozenset({
        "story-no-biography", "identity-missing", "story-name", "story-cast-name", "identity-name", "identity-cast-name",
        "story-pronoun", "identity-pronoun", "story-age", "identity-age", "bio-dup-text"})
    assert gate.is_blocking("story-name") and not gate.is_blocking("bio-format")


# ── 3. one number each: the prompt and the check read the same threshold ─────────────────────────────────────────
def test_thresholds_are_the_table_numbers_and_the_prompt_prints_them():
    assert gate.BIO_ASK_CHARS is R.BIO_ASK_CHARS and gate.BIO_OVERSIZE_CHARS == 720
    assert A._ONCAMERA_MAX == R.ONCAMERA_MAX_CHARS == 240 and A._PHOTOHAIR_MAX == R.PHOTOHAIR_MAX_CHARS == 90
    assert A._SPOT_MAX == R.SPOT_MAX == 3 and A._IDENTITY_MIN_CHARS == R.IDENTITY_MIN_CHARS == 20
    for number in ("under %d characters" % R.BIO_ASK_CHARS, "at most 240 characters", "at most 90 characters",
                   "under 60 characters", "at least 20 and under 250 characters", "an array of 2-3 pieces"):
        assert number in A._SYSTEM, number


def test_each_limit_the_prompt_states_is_the_limit_the_check_enforces():
    pc = {"wardrobe": ["a white blouse", "dark jeans"], "photoHair": "neat low bun", "onCamera": OK_CAM, "lookSignature": "silver hoop earrings"}
    assert A.look_problems({"physicalCharacteristics": pc}, CARD) == []
    assert "oncamera-scene" not in A.look_problems({"physicalCharacteristics": {**pc, "onCamera": "A" * 240}}, CARD)
    assert "oncamera-scene" in A.look_problems({"physicalCharacteristics": {**pc, "onCamera": "A" * 241}}, CARD)
    assert "photohair-messy" in A.look_problems({"physicalCharacteristics": {**pc, "photoHair": "n" * 91}}, CARD)
    assert "photohair-messy" not in A.look_problems({"physicalCharacteristics": {**pc, "photoHair": "n" * 90}}, CARD)
    assert "signature-shape" in A.look_problems({"physicalCharacteristics": {**pc, "lookSignature": "s" * 91}}, CARD)
    assert "wardrobe-shape" in A.look_problems({"physicalCharacteristics": {**pc, "wardrobe": ["a white blouse", "d" * 61]}}, CARD)
    assert "wardrobe-shape" in A.look_problems({"physicalCharacteristics": {**pc, "wardrobe": ["a white blouse"]}}, CARD)


def test_every_word_a_check_bans_is_a_word_the_prompt_lists():
    # before ORW-956 the photoHair check also rejected flyaways, fly-away, fly away and frayed while the prompt named only some
    for word in R.PHOTOHAIR_BANNED_WORDS:
        assert word in A.PHOTO_SHEET_RULES and A.photohair_is_messy(f"neat {word} look"), word
    for word in R.ONCAMERA_BANNED_WORDS:
        assert word in A.PHOTO_SHEET_RULES, word


def test_checks_that_had_no_sentence_before_now_state_one():
    for text in (R.SENTENCES["label-leak"], R.SENTENCES["bio-no-stop"], R.SENTENCES["identity-story"], R.SENTENCES["no-copy"],
                 R.SENTENCES["style-family"]):
        assert text.strip() in A._SYSTEM
    # the photo-sheet writer used to lack the two-things-in-one and uniform/badge rule that its own check applies
    assert R.SENTENCES["wardrobe-pieces"].strip() in A.PHOTO_SHEET_SYSTEM
    # and the check that sentence states fires on a biography that runs off without a full stop
    assert "bio-no-stop" in gate.card_codes({"biography": "Dana grew up in Tulsa and nursed for ten years, first on a ward and then"}, CARD)


# ── 4. repair, not drop ───────────────────────────────────────────────────────────────────────────────────────────
class Writer:
    """A stub model: returns the queued replies in order and records every message list it was sent."""

    def __init__(self, replies):
        self.replies, self.sent = list(replies), []

    async def __call__(self, messages):
        self.sent.append(messages)
        return json.dumps(self.replies.pop(0))


BAD = {"wardrobe": GOOD_WARDROBE, "photoHair": "neat low bun", "onCamera": BAD_CAM}


def test_a_sheet_whose_oncamera_line_fails_twice_keeps_a_line_the_repair_wrote():
    w = Writer([BAD, BAD, {"onCamera": OK_CAM}])
    fields, codes = _run(A.write_photo_sheet(CARD, {}, w))
    assert fields.get("onCamera") == OK_CAM and codes == [] and len(w.sent) == 3
    ask = w.sent[2][1]["content"]
    assert R.sentence("oncamera-scene", A._RULE_EXAMPLES)[:120] in ask and "oncamera-scene" in ask  # the failing rule's own sentence
    assert fields["wardrobe"] == GOOD_WARDROBE and fields["photoHair"] == "neat low bun"  # the rest of the sheet stands


def test_a_repair_that_also_fails_drops_the_field_as_before_and_costs_one_call():
    w = Writer([BAD, BAD, {"onCamera": BAD_CAM}])
    fields, codes = _run(A.write_photo_sheet(CARD, {}, w))
    assert "onCamera" not in fields and fields["wardrobe"] == GOOD_WARDROBE and "oncamera-scene" in codes
    assert len(w.sent) == 3  # worst case: the old 2 calls plus ONE repair, however many fields fail


def test_one_repair_call_covers_every_failing_field_of_a_sheet():
    bad = {"wardrobe": GOOD_WARDROBE, "photoHair": "messy bun, usually frizzy", "onCamera": BAD_CAM}
    w = Writer([bad, bad, {"photoHair": "neat low bun", "onCamera": OK_CAM}])
    fields, codes = _run(A.write_photo_sheet(CARD, {}, w))
    assert fields["photoHair"] == "neat low bun" and fields["onCamera"] == OK_CAM and codes == [] and len(w.sent) == 3


def test_a_repair_that_brings_a_new_problem_is_not_kept():
    w = Writer([BAD, BAD, {"onCamera": "Her arms folded, near him."}])  # the pronoun check refuses "him" for a woman
    fields, codes = _run(A.write_photo_sheet(CARD, {}, w))
    assert "onCamera" not in fields and len(w.sent) == 3


def test_a_failing_repair_call_leaves_the_fallback_to_run():
    class Boom(Writer):
        async def __call__(self, messages):
            self.sent.append(messages)
            if len(self.sent) == 3:
                raise RuntimeError("provider down")
            return json.dumps(BAD)
    w = Boom([])
    fields, codes = _run(A.write_photo_sheet(CARD, {}, w))
    assert "onCamera" not in fields and fields["wardrobe"] == GOOD_WARDROBE and len(w.sent) == 3


def test_a_clean_sheet_costs_no_repair_call():
    w = Writer([{"wardrobe": GOOD_WARDROBE, "photoHair": "neat low bun", "onCamera": OK_CAM}])
    fields, codes = _run(A.write_photo_sheet(CARD, {}, w))
    assert codes == [] and len(w.sent) == 1


def test_a_first_draft_field_a_fallback_would_delete_is_found_and_the_mend_that_keeps_it_is_not():
    prof = {"physicalCharacteristics": {"onCamera": BAD_CAM, "photoHair": "neat low bun", "wardrobe": GOOD_WARDROBE}}
    probs = A.look_problems(prof, CARD)
    assert "oncamera-scene" in probs
    # repair_oncamera cuts the banned clauses; when a clean part survives the line is kept and there is nothing to repair
    kept = {"physicalCharacteristics": {"onCamera": "Arms folded, gaze off to one side. She says hello."}}
    assert A.fields_a_fallback_changes(kept, CARD, A.look_problems(kept, CARD)) == []
    gone = {"physicalCharacteristics": {"onCamera": "She says hello, then laughs with everyone."}}
    assert A.fields_a_fallback_changes(gone, CARD, A.look_problems(gone, CARD)) == ["onCamera"]


def test_a_biography_or_identity_the_parse_floor_dropped_is_re_asked_once():
    reply = json.dumps({"identityConcept": "short", "biography": "Too short."})
    assert A.parse_authored_profile(reply, "npc:1") is None  # both fields fall below the floor: the parse deletes them
    assert A.parse_dropped(reply, CARD) == {"biography": "bio-floor", "identityConcept": "identity-length"}
    prof = {"physicalCharacteristics": {"wardrobe": GOOD_WARDROBE}}
    bio = "Dana Test grew up in Tulsa and has nursed for ten years. She works the night shift and keeps a quiet ward."
    w = Writer([{"biography": bio, "identityConcept": "A night nurse who keeps the ward calm by being unhurried."}])
    out = _run(A.repair_failing_fields(prof, {**CARD, "identityConcept": ""}, [], w,
                                       dropped={"biography": "bio-floor", "identityConcept": "identity-length"}))
    assert out["fixed"] == ["biography", "identityConcept"] and prof["biography"] == bio and len(w.sent) == 1
    sent = w.sent[0][1]["content"]
    assert R.sentence("bio-floor", {**A._RULE_EXAMPLES, "name": "Dana"})[:60] in sent
    # a field already present is never asked again
    prof2 = {"biography": bio}
    w2 = Writer([])
    assert _run(A.repair_failing_fields(prof2, CARD, [], w2, dropped={"biography": "bio-floor"})) == {"asked": [], "fixed": []} and not w2.sent
