"""The cast photo states the card's gender presentation outright, and the photo check verifies it (never for a nonbinary card, never by stereotype).
httpx fully faked: no network, no spend."""

import asyncio
import importlib
import json
import types

import pytest

B = importlib.import_module("src.orwell_photo_brief")
C = importlib.import_module("src.orwell_portrait_check")
P = importlib.import_module("src.orwell_portraits")
ledger = importlib.import_module("src.orwell_token_ledger")

FLOOR = ("An opener. The subject is a 30-year-old {noun}. An ordinary person, not a model: a 30-year-old x from y; their grooming, hands, build and clothes fit that life. "
         "Face: round. Hair: dark. Wearing a grey tee, never a uniform. Setting: the house kitchen. Light: window. The moment: a grin. "
         "Framing, the same for the whole series: a half-length portrait. The only person in the frame; no text or logos.")


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.mark.parametrize("gender,needle", [("man", "a man, masculine presentation"), ("woman", "a woman, feminine presentation"), ("nonbinary", "nonbinary, a soft androgynous look")])
def test_the_prompt_states_the_cards_presentation_once_after_the_subject(gender, needle):
    card = {"id": "npc:1", "genderPresentation": gender}
    out = B.final_prompt(FLOOR.format(noun="person"), None, None, card)
    assert needle in out and out.count("Presentation, as the card states it:") == 1
    assert out.index("The subject is") < out.index("Presentation, as the card states it:") < out.index("An ordinary person")
    assert B.final_prompt(out, None, None, card) == out  # idempotent


def test_a_nonbinary_card_is_never_pushed_to_a_binary_reading():
    s = B.presentation_sentence({"genderPresentation": "nonbinary"})
    assert "not made to read as a man or as a woman" in s and "He " not in s and "She " not in s


def test_no_presentation_on_the_card_adds_nothing_and_never_guesses_from_a_name():
    assert B.presentation_sentence({"name": "Beth Harrow"}) == ""
    assert B.presentation_sentence(None) == "" and B.presentation_sentence({"genderPresentation": "unsure"}) == ""
    base = FLOOR.format(noun="person")
    assert B.final_prompt(base, None, None, {"name": "Beth Harrow"}) == B.floor_with_anchors(base, None, {"name": "Beth Harrow"})


def test_a_composed_brief_prompt_carries_it_too():
    card = {"id": "npc:1", "genderPresentation": "woman", "name": "Dre Boone"}
    brief = {"where": "the porch of a faded house", "timeLight": "dusk, clear and still", "doing": "leans on the rail", "wear": "a grey tee, dark jeans",
             "inFrame": ["a watering can", "a folded blanket"], "signature": "a brass key on a cord", "expressionBody": "a calm look"}
    out = B.final_prompt(FLOOR.format(noun="woman"), brief, {"body": "three-quarter"}, card)
    assert "Presentation, as the card states it: a woman" in out


def test_the_check_lists_wrong_gender_and_words_it():
    assert "wrong-gender" in C.KNOWN_CODES and "wrong-gender" in C._CHECKLIST and "wrong-gender" in C._checklist_for({"candid": True})
    assert "reads as the gender presentation the card states" in C.problems_in_words(["wrong-gender"])
    # the rule judges the whole person, never one stereotyped trait
    assert "never evidence on their own" in C._CHECKLIST
    assert "alone never make this wrong" in C.facts_block({"gender": "man"})
    assert "never report wrong-presentation or wrong-gender" in C.facts_block({"gender": "nonbinary"})


def _reply(problems):
    return types.SimpleNamespace(status_code=200, json=lambda: {"choices": [{"message": {"content": json.dumps({"problems": problems})}}],
                                                              "usage": {"prompt_tokens": 9, "completion_tokens": 3, "cost": 0.001}})


@pytest.fixture
def check_env(monkeypatch, tmp_path):
    monkeypatch.setattr(ledger, "LEDGER_PATH", tmp_path / "ledger.json")
    monkeypatch.setattr(P, "image_gen_disabled", lambda: False)
    monkeypatch.setattr(C, "check_enabled", lambda user: True)
    monkeypatch.setattr(C, "_image_data_url", lambda png: "data:image/png;base64,AAAA")
    monkeypatch.setattr(C, "_resolve_deepseek", lambda m, o: ("https://api.deepseek.com/chat/completions", {}))
    st = types.SimpleNamespace(replies=[])

    class Client:
        def __init__(self, *a, **k): pass
        async def __aenter__(self): return self
        async def __aexit__(self, *a): return False
        async def post(self, url, json=None, headers=None): return st.replies.pop(0)

    import httpx
    monkeypatch.setattr(httpx, "AsyncClient", Client)
    return st


@pytest.mark.parametrize("gender", ["man", "woman"])
def test_wrong_gender_is_a_verdict_for_a_binary_card(check_env, gender):
    check_env.replies = [_reply(["wrong-gender"])]
    assert _run(C.check_portrait(b"PNG", {"gender": gender}, "u")) == {"ok": False, "problems": ["wrong-gender"]}


def test_wrong_gender_is_dropped_for_a_nonbinary_or_unstated_card(check_env):
    for facts in ({"gender": "nonbinary"}, {}):
        check_env.replies = [_reply(["wrong-gender", "messy-hair"])]
        assert _run(C.check_portrait(b"PNG", facts, "u"))["problems"] == ["messy-hair"]


def test_the_stated_gender_is_read_from_the_prompt_the_brief_wrote():
    out = B.final_prompt(FLOOR.format(noun="woman"), None, None, {"genderPresentation": "woman"})
    assert C.facts_from_prompt(out)["gender"] == "woman"
    assert "Stated gender presentation: woman" in C.facts_block(C.facts_from_prompt(out))


def test_a_wrong_gender_fails_the_pass_and_reshoots_with_the_fix_line(check_env, monkeypatch):
    check_env.replies = [_reply(["wrong-gender"]), _reply([])]
    shots = []

    async def fake(prompt, user, reference_png=None, keep_identity=True):
        shots.append(prompt)
        return b"PNG2"
    monkeypatch.setattr(P, "_generate_one", fake)
    prompt = B.final_prompt(FLOOR.format(noun="man"), None, None, {"genderPresentation": "man"})
    png, meta = _run(P._portrait_check_pass(b"PNG1", prompt, "u", None))
    assert png == b"PNG2" and meta["ok"] is True and meta["reshot"] is True and meta["first"] == ["wrong-gender"]
    assert "Fix in this version: a person who reads as the gender presentation the card states" in shots[0]


def test_an_empty_answer_is_recorded_unverified_never_as_a_pass(check_env, monkeypatch, tmp_path):
    check_env.replies = [types.SimpleNamespace(status_code=200, json=lambda: {"choices": [{"finish_reason": "stop", "message": {"content": ""}}]})]
    png, meta = _run(P._portrait_check_pass(b"PNG1", "The subject is a 30-year-old man.", "u", None))
    assert png == b"PNG1" and meta == {"unverified": True}
    monkeypatch.setattr(P, "PORTRAITS_DIR", tmp_path / "portraits")
    P._write_portrait("u", "npc:1", png, "Zorvan", check=meta)
    entry = P.load_manifest("u")[P._safe_id("npc:1")]
    assert entry["checkUnverified"] is True and "check" not in entry   # visible in the record, never a pass


def test_a_disabled_check_is_not_unverified(check_env, monkeypatch):
    monkeypatch.setattr(C, "check_enabled", lambda user: False)
    png, meta = _run(P._portrait_check_pass(b"PNG1", "The subject is a 30-year-old man.", "u", None))
    assert png == b"PNG1" and meta is None
