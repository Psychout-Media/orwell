"""ORW-407 slice 1: the FE half of the open-ledger write-back. The extraction is injectable (no live model). Pins: exactly
{text, speaker, addressedTo, kind} is sent, ids outside the present list / entries not involving the player / over-long
text are dropped before the engine sees them, `kind` stays free text, failures are silent, and the engine wrapper
dispatches the registered tool name."""
import asyncio

from src import orwell_open_ledger as ol

NARR = "In the kitchen, a houseguest leans in and says she will never put the player on the block, then laughs it off over coffee."
PRESENT = [{"id": "npc:3", "name": "Someone"}]


def run(coro):
    return asyncio.run(coro)


def test_clean_entries_bounds_and_free_kind():
    raw = {"entries": [
        {"text": ' "I will keep you safe" ', "speaker": "npc:3", "addressedTo": ["player"], "kind": "  an oath of loyalty  "},
        {"text": "i will keep you safe", "speaker": "npc:3", "addressedTo": ["player"], "kind": "dup"},
        {"text": "x" * 241, "speaker": "npc:3", "addressedTo": ["player"], "kind": "long"},
        {"text": "who is that", "speaker": "npc:9", "addressedTo": ["player"], "kind": "unknown id"},
        {"text": "npc to npc", "speaker": "npc:3", "addressedTo": ["npc:3"], "kind": "k"},
        {"text": "c", "speaker": "player", "addressedTo": ["npc:3"], "kind": ""},
        {"text": "d", "speaker": "player", "addressedTo": ["npc:3"], "kind": "k"},
        {"text": "e", "speaker": "player", "addressedTo": ["npc:3"], "kind": "k"},
        {"text": "f", "speaker": "player", "addressedTo": ["npc:3"], "kind": "k"},
    ]}
    out = ol.clean_entries(raw, {"npc:3"})
    assert out == [
        {"text": "I will keep you safe", "speaker": "npc:3", "addressedTo": ["player"], "kind": "an oath of loyalty"},
        {"text": "c", "speaker": "player", "addressedTo": ["npc:3"], "kind": "claim"},
        {"text": "d", "speaker": "player", "addressedTo": ["npc:3"], "kind": "k"},
    ]  # capped at 3, kind is whatever the model said
    assert ol.clean_entries(None, {"npc:3"}) == [] and ol.clean_entries({"entries": "no"}, {"npc:3"}) == []


def test_writes_exactly_four_fields():
    sent = []

    async def llm(_m):
        return 'hmm {"entries":[{"text":"I will never vote you out","speaker":"npc:3","addressedTo":["player"],"kind":"promise"}]}'

    async def write(p):
        sent.append(p)
        return {"accepted": True, "entryId": "open:1"}

    assert run(ol.capture_open_ledger(NARR, PRESENT, llm, write)) == 1
    assert sent == [{"text": "I will never vote you out", "speaker": "npc:3", "addressedTo": ["player"], "kind": "promise"}]
    assert set(sent[0]) == {"text", "speaker", "addressedTo", "kind"}


def test_skips_short_narration_empty_room_and_empty_extraction():
    calls = []

    async def llm(_m):
        calls.append(1)
        return '{"entries":[]}'

    async def write(_p):
        raise AssertionError("must not write")

    assert run(ol.capture_open_ledger("short", PRESENT, llm, write)) == 0 and not calls
    assert run(ol.capture_open_ledger(NARR, [], llm, write)) == 0 and not calls
    assert run(ol.capture_open_ledger(NARR, PRESENT, llm, write)) == 0 and calls


def test_failures_are_silent_and_refusals_not_counted():
    async def boom(_m):
        raise RuntimeError("model down")

    async def never(_p):
        raise AssertionError("must not write")

    assert run(ol.capture_open_ledger(NARR, PRESENT, boom, never)) == 0

    async def llm(_m):
        return '{"entries":[{"text":"a","speaker":"player","addressedTo":["npc:3"],"kind":"k"}]}'

    async def refuse(_p):
        return {"accepted": False, "reason": "not-present"}

    assert run(ol.capture_open_ledger(NARR, PRESENT, llm, refuse)) == 0

    async def broken(_p):
        raise RuntimeError("engine down")

    assert run(ol.capture_open_ledger(NARR, PRESENT, llm, broken)) == 0


def test_engine_wrapper_dispatches_the_registered_tool(monkeypatch):
    from src import orwell_engine as oe
    seen = {}

    async def fake_call(tool, args, user=None):
        seen.update(tool=tool, args=args, user=user)
        return {"accepted": True}

    monkeypatch.setattr(oe, "_call", fake_call)
    entry = {"text": "t", "speaker": "player", "addressedTo": ["npc:3"], "kind": "k", "junk": 1}
    assert run(oe.record_open_ledger(entry, user="u")) == {"accepted": True}
    assert seen == {"tool": "recordOpenLedger", "args": {"text": "t", "speaker": "player", "addressedTo": ["npc:3"], "kind": "k"}, "user": "u"}


# ---------------- slice 2: groups, claims about others, plans, resolution ----------------

TWO = [{"id": "npc:3", "name": "Someone"}, {"id": "npc:4", "name": "Another"}]
AWAY = [{"id": "npc:7", "name": "Far Away"}]


def test_group_pact_keeps_all_parties_and_a_plan_needs_no_addressee():
    raw = {"entries": [
        {"text": "If one of us wins the rest are safe", "speaker": "npc:3", "addressedTo": [], "kind": "group pact", "parties": ["npc:3", "npc:4", "player"]},
        {"text": "I will throw the next puzzle", "speaker": "npc:4", "addressedTo": [], "kind": "stated plan"},
        {"text": "bad party", "speaker": "npc:3", "addressedTo": [], "kind": "k", "parties": ["npc:3", "npc:99"]},
        {"text": "lone party", "speaker": "npc:3", "addressedTo": ["player"], "kind": "k", "parties": ["npc:3"]},
    ]}
    out = ol.clean_entries(raw, {"npc:3", "npc:4"})
    assert out[0] == {"text": "If one of us wins the rest are safe", "speaker": "npc:3", "addressedTo": [], "kind": "group pact",
                      "parties": ["npc:3", "npc:4", "player"]}
    assert out[1] == {"text": "I will throw the next puzzle", "speaker": "npc:4", "addressedTo": [], "kind": "stated plan"}
    assert [e["text"] for e in out] == ["If one of us wins the rest are safe", "I will throw the next puzzle", "lone party"]
    assert "parties" not in out[2]  # one party is just the speaker


def test_about_maps_a_known_name_or_id_and_keeps_other_free_text():
    known = {"npc:3": "Someone", "npc:7": "Far Away"}
    raw = {"entries": [
        {"text": "a", "speaker": "npc:3", "addressedTo": [], "kind": "claim", "about": "far away"},
        {"text": "b", "speaker": "npc:3", "addressedTo": [], "kind": "claim", "about": "npc:7"},
        {"text": "c", "speaker": "npc:3", "addressedTo": [], "kind": "claim", "about": "the next competition"},
        {"text": "d", "speaker": "npc:3", "addressedTo": [], "kind": "claim", "about": "x" * 200},
        {"text": "e", "speaker": "npc:3", "addressedTo": [], "kind": "claim", "about": 5},
    ]}
    out = ol.clean_entries(raw, {"npc:3"}, known)
    assert [e["about"] for e in out] == ["npc:7", "npc:7", "the next competition"]  # capped at 3; 4th is cut, 5th would be dropped


def test_clean_resolutions_only_for_offered_open_entries():
    raw = {"resolutions": [
        {"entryId": "open:1", "status": "broken", "note": "  she  nominated   the player "},
        {"entryId": "open:9", "status": "kept", "note": "not offered"},
        {"entryId": "open:2", "status": "angry", "note": "bad status"},
        {"entryId": "open:1", "status": "kept", "note": "repeat"},
        {"entryId": "open:2", "status": "withdrawn", "note": "n" * 300},
        {"entryId": "open:3", "status": "kept", "note": "over the cap"},
    ]}
    out = ol.clean_resolutions(raw, {"open:1", "open:2", "open:3"})
    assert out == [{"entryId": "open:1", "status": "broken", "note": "she nominated the player"},
                   {"entryId": "open:2", "status": "withdrawn", "note": "n" * 160}]
    assert ol.clean_resolutions(None, {"open:1"}) == []


def test_capture_writes_group_and_resolution_and_shows_the_model_the_open_list():
    sent, resolved, prompts = [], [], []

    async def llm(m):
        prompts.append(m[1]["content"])
        return ('{"entries":[{"text":"We all look after each other","speaker":"npc:3","addressedTo":[],"kind":"alliance talk",'
                '"parties":["npc:3","npc:4"],"about":"Far Away"}],'
                '"resolutions":[{"entryId":"open:1","status":"kept","note":"she stood by it"}]}')

    async def write(p):
        sent.append(p)
        return {"accepted": True}

    async def resolve(p):
        resolved.append(p)
        return {"accepted": True}

    n = run(ol.capture_open_ledger(NARR, TWO, llm, write, AWAY, [{"id": "open:1", "text": "I will not nominate you"}], resolve))
    assert n == 2
    assert sent == [{"text": "We all look after each other", "speaker": "npc:3", "addressedTo": [], "kind": "alliance talk",
                     "parties": ["npc:3", "npc:4"], "about": "npc:7"}]
    assert resolved == [{"entryId": "open:1", "status": "kept", "note": "she stood by it"}]
    assert "ELSEWHERE" in prompts[0] and "npc:7" in prompts[0] and "open:1" in prompts[0]


def test_resolution_failure_does_not_lose_the_entries_and_no_open_list_means_no_resolve():
    async def llm(_m):
        return '{"entries":[{"text":"a","speaker":"npc:3","addressedTo":["player"],"kind":"k"}],"resolutions":[{"entryId":"open:1","status":"kept","note":"x"}]}'

    async def write(_p):
        return {"accepted": True}

    async def resolve(_p):
        raise AssertionError("no open list was given")

    assert run(ol.capture_open_ledger(NARR, TWO, llm, write, None, None, resolve)) == 1

    async def broken(_p):
        raise RuntimeError("engine down")

    assert run(ol.capture_open_ledger(NARR, TWO, llm, write, None, [{"id": "open:1", "text": "t"}], broken)) == 0


def test_engine_wrappers_dispatch_the_slice2_tools(monkeypatch):
    from src import orwell_engine as oe
    seen = []

    async def fake_call(tool, args, user=None):
        seen.append((tool, args))
        return [{"id": "open:1"}] if tool == "openLedgerHere" else {"accepted": True}

    monkeypatch.setattr(oe, "_call", fake_call)
    entry = {"text": "t", "speaker": "npc:3", "addressedTo": [], "kind": "k", "parties": ["npc:3", "npc:4"], "about": "npc:7", "junk": 1}
    run(oe.record_open_ledger(entry, user="u"))
    run(oe.resolve_open_ledger({"entryId": "open:1", "status": "broken", "note": "n", "junk": 1}, user="u"))
    assert run(oe.open_ledger_here(user="u")) == [{"id": "open:1"}]
    assert seen[0] == ("recordOpenLedger", {"text": "t", "speaker": "npc:3", "addressedTo": [], "kind": "k", "parties": ["npc:3", "npc:4"], "about": "npc:7"})
    assert seen[1] == ("resolveOpenLedger", {"entryId": "open:1", "status": "broken", "note": "n"})
    assert seen[2] == ("openLedgerHere", {})
