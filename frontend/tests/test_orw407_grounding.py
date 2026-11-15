"""ORW-407 (grounding): the extraction is a second model, so each entry it returns is compared with the narration it was given.
By default this only MEASURES (every entry is still kept and the weak ones are counted, with no entry text in the record);
`ORWELL_OPEN_LEDGER_GROUNDING=strict` drops the weak ones, `=off` skips the check. Roles only."""
import asyncio

import pytest

from src import orwell_open_ledger as ol

NARR = ("In the kitchen a houseguest leans in over the coffee. \"I will keep your name out of it this week,\" she says, "
        "and then, quieter, that the two by the pool are planning something for Thursday.")
PRESENT = [{"id": "npc:3", "name": "Someone"}]
VERBATIM = {"text": "I will keep your name out of it this week", "speaker": "npc:3", "addressedTo": ["player"], "kind": "promise"}
INVENTED = {"text": "I swear on my mother that the veto is already yours", "speaker": "npc:3", "addressedTo": ["player"], "kind": "promise"}


def run(coro):
    return asyncio.run(coro)


def _capture(monkeypatch, entries, mode=None):
    import json
    from src import log_rings
    if mode is None:
        monkeypatch.delenv("ORWELL_OPEN_LEDGER_GROUNDING", raising=False)
    else:
        monkeypatch.setenv("ORWELL_OPEN_LEDGER_GROUNDING", mode)
    seen = []
    monkeypatch.setattr(log_rings, "record_overseer", lambda *a, **k: seen.append((a, k)))
    sent = []

    async def llm(_m):
        return json.dumps({"entries": entries, "resolutions": []})

    async def write(p):
        sent.append(p)
        return {"accepted": True, "entryId": f"open:{len(sent)}"}

    n = run(ol.capture_open_ledger(NARR, PRESENT, llm, write, owner="u1"))
    return n, sent, seen


def test_the_score_is_one_for_the_words_as_written_and_low_for_words_that_are_not_there():
    assert ol.grounding("I will keep your name out of it this week", NARR) == 1.0
    assert ol.grounding('  "i WILL keep   your name out of it this week."  ', NARR) == 1.0   # case, quotes, spacing, full stop
    assert ol.grounding("the two by the pool are planning something for Thursday", NARR) == 1.0
    half = ol.grounding("she will keep the secret about Thursday forever", NARR)
    assert 0.3 < half < 0.9
    assert ol.grounding(INVENTED["text"], NARR) < ol.GROUNDING_MIN
    assert ol.grounding("", NARR) == 0.0 and ol.grounding("x", "") == 0.0 and ol.grounding("!!", NARR) == 0.0


def test_by_default_a_weak_entry_is_still_kept_and_counted_without_its_text(monkeypatch):
    n, sent, seen = _capture(monkeypatch, [VERBATIM, INVENTED])
    assert n == 2 and [p["text"] for p in sent] == [VERBATIM["text"], INVENTED["text"]]      # report mode changes nothing stored
    assert len(seen) == 1
    (level, kind, diagnosis), kw = seen[0]
    assert level == "observation" and kind == "open-ledger:weak-grounding" and kw["ok"] is True and kw["user"] == "u1"
    assert "1 of 2" in diagnosis and "kept (report mode)" in diagnosis and kw["lever"] is None
    assert INVENTED["text"] not in diagnosis and "mother" not in diagnosis                    # counts only, never the entry's words


def test_a_turn_whose_entries_are_all_in_the_narration_records_nothing(monkeypatch):
    n, sent, seen = _capture(monkeypatch, [VERBATIM])
    assert n == 1 and seen == []


def test_strict_drops_the_weak_entry_and_keeps_the_grounded_one(monkeypatch):
    n, sent, seen = _capture(monkeypatch, [INVENTED, VERBATIM], mode="strict")
    assert n == 1 and [p["text"] for p in sent] == [VERBATIM["text"]]
    (_l, _k, diagnosis), kw = seen[0]
    assert "dropped" in diagnosis and kw["lever"] == "drop"


def test_off_skips_the_check(monkeypatch):
    n, sent, seen = _capture(monkeypatch, [INVENTED], mode="off")
    assert n == 1 and len(sent) == 1 and seen == []


@pytest.mark.parametrize("value,expected", [("", "report"), ("report", "report"), ("STRICT", "strict"), (" off ", "off"), ("nonsense", "report")])
def test_the_mode_defaults_to_report(monkeypatch, value, expected):
    monkeypatch.setenv("ORWELL_OPEN_LEDGER_GROUNDING", value)
    assert ol.grounding_mode() == expected


def test_a_failing_recorder_never_breaks_the_capture(monkeypatch):
    from src import log_rings

    def boom(*a, **k):
        raise RuntimeError("ring down")

    monkeypatch.delenv("ORWELL_OPEN_LEDGER_GROUNDING", raising=False)
    monkeypatch.setattr(log_rings, "record_overseer", boom)
    sent = []

    async def llm(_m):
        import json
        return json.dumps({"entries": [INVENTED]})

    async def write(p):
        sent.append(p)
        return {"accepted": True}

    assert run(ol.capture_open_ledger(NARR, PRESENT, llm, write)) == 1 and len(sent) == 1
