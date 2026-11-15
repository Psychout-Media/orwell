"""ORW-431 D: the photo check fails twice -> keep the photo with fewer problem codes, record the rest, let the upgrader
retry later (bounded). Stub check and stub image writer only: no network, no spend."""
import asyncio
import importlib

P = importlib.import_module("src.orwell_portraits")
C = importlib.import_module("src.orwell_portrait_check")
PROMPT = ("Official cast portrait. Waist-up portrait of a 40-year-old woman with long auburn hair and glasses. "
          "Wearing a grey sweater. Setting: the house kitchen. The only person in the frame.")


def _run(c):
    return asyncio.new_event_loop().run_until_complete(c)


def _stubs(monkeypatch, verdicts):
    calls = {"gen": 0}
    q = list(verdicts)

    async def fake_check(png, facts, user):
        return {"ok": not q[0], "problems": q.pop(0)}

    async def fake_gen(prompt, user, reference_png=None):
        calls["gen"] += 1
        return b"second"
    monkeypatch.setattr(C, "check_portrait", fake_check)
    monkeypatch.setattr(P, "_generate_one", fake_gen)
    return calls


def test_check_that_fails_twice_keeps_the_photo_with_fewer_codes(monkeypatch):
    calls = _stubs(monkeypatch, [["wrong-age", "wrong-clothes"], ["wrong-age"]])
    png, meta = _run(P._portrait_check_pass(b"first", PROMPT, "u", None))
    assert png == b"second" and meta["ok"] is False and meta["problems"] == ["wrong-age"] and calls["gen"] == 1
    calls = _stubs(monkeypatch, [["wrong-age"], ["wrong-age", "wrong-clothes"]])
    png, meta = _run(P._portrait_check_pass(b"first", PROMPT, "u", None))
    assert png == b"first" and meta["problems"] == ["wrong-age"] and meta["ok"] is False


def test_failed_photo_is_a_bounded_upgrader_candidate():
    ok = {"check": {"ok": True, "problems": []}}
    one = {"check": {"ok": False, "problems": ["wrong-age"]}}
    spent = {"check": {"ok": False, "problems": ["wrong-age"]}, "checkRetries": P.PHOTO_CHECK_RETRY_BOUND}
    assert P.check_retry_ids({"a": ok, "b": one, "c": spent, "d": {**one, "source": "upload"}}) == ["b"]


def test_an_upgrader_retry_makes_no_in_pass_reshoot(monkeypatch):
    calls = _stubs(monkeypatch, [["wrong-age"]])
    png, meta = _run(P._portrait_check_pass(b"new", PROMPT, "u", None, retry_of={"check": {"ok": False, "problems": ["wrong-age"]}}))
    assert calls["gen"] == 0 and meta["ok"] is False and meta["reshot"] is False


def test_the_check_is_given_every_stated_visible_feature():
    f = C.facts_from_prompt(PROMPT + " A nose stud and a short beard.")
    assert set(f["features"]) == {"glasses", "nose stud or ring", "beard", "auburn hair", "long auburn hair"}  # ORW-437: the whole list, exactly
    assert "missing-feature" in C.KNOWN_CODES and "glasses" in C.facts_block(f)
