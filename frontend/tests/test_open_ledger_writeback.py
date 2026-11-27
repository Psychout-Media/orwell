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
        {"text": "npc to npc", "speaker": "npc:3", "addressedTo": [], "kind": "k"},  # ORW-1065: the bad id (self) is dropped, the entry kept
        {"text": "c", "speaker": "player", "addressedTo": ["npc:3"], "kind": "claim"},
    ]  # capped at 3, kind is whatever the model said
    assert ol.clean_entries(None, {"npc:3"}) == [] and ol.clean_entries({"entries": "no"}, {"npc:3"}) == []


def test_writes_exactly_four_fields():
    sent = []

    async def llm(_m):
        return 'hmm {"entries":[{"text":"she will never put the player on the block","speaker":"npc:3","addressedTo":["player"],"kind":"promise"}]}'

    async def write(p):
        sent.append(p)
        return {"accepted": True, "entryId": "open:1"}

    assert run(ol.capture_open_ledger(NARR, PRESENT, llm, write)) == 1
    assert sent == [{"text": "she will never put the player on the block", "speaker": "npc:3", "addressedTo": ["player"], "kind": "promise"}]
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
    # ORW-1065: the unknown party id is dropped, not the whole entry; one remaining party is no group
    assert [e["text"] for e in out] == ["If one of us wins the rest are safe", "I will throw the next puzzle", "bad party"]
    assert "parties" not in out[2]
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

    assert run(ol.capture_open_ledger(NARR, TWO, llm, write, None, [{"id": "open:1", "text": "t"}], broken)) == 1  # review of #2721: the accepted entry still counts when a resolve fails


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


def test_the_loop_feeds_the_canon_and_ledger_hooks_the_player_visible_narration():
    """review of #2721: the room-canon and open-ledger hooks must read `_turn_narration_visible` (post-guard, `<think>`-stripped),
    never the raw per-round `_turn_narration` that keeps reasoning and sentences the visibility guards dropped."""
    import os
    import re
    src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src", "agent_loop.py"), encoding="utf-8").read()
    calls = re.findall(r"await (_ol|_rc)\.after_turn\(([^,]+),", src)
    assert {c[0] for c in calls} == {"_ol", "_rc"}
    assert all(arg.strip() == "_turn_narration_visible" for _who, arg in calls), calls


def test_orw437_open_ledger_here_is_a_pure_read_so_it_does_not_invalidate_the_cache():
    """review of #2721: a read counted as a mutation sends a spurious game-updated ping and drops the read cache every turn."""
    from src import engine_read_cache
    assert "openLedgerHere" in engine_read_cache.PURE_READS


def test_orw437_same_words_from_two_speakers_are_two_entries_and_one_failing_write_keeps_the_rest():
    """review of #2721: the dedupe key is (speaker, text); one write raising does not discard the others or the count."""
    present = [{"id": "npc:3", "name": "A"}, {"id": "npc:4", "name": "B"}]
    reply = ('{"entries":[{"text":"I will keep you safe","speaker":"npc:3","addressedTo":["player"],"kind":"oath"},'
             '{"text":"I will keep you safe","speaker":"npc:4","addressedTo":["player"],"kind":"oath"},'
             '{"text":"I will keep you safe","speaker":"npc:3","addressedTo":["player"],"kind":"dup"}],"resolutions":[]}')
    sent = []

    async def llm(messages):
        return reply

    async def write(entry):
        sent.append(entry["speaker"])
        if entry["speaker"] == "npc:3":
            raise RuntimeError("engine hiccup")
        return {"accepted": True}

    assert run(ol.capture_open_ledger(NARR, present, llm, write)) == 1
    assert sent == ["npc:3", "npc:4"]


def test_entry_with_no_houseguest_is_dropped():
    # ORW-437 (review of #2692): player to player, or a player entry with no addressee, involves nobody in the house
    raw = {"entries": [
        {"text": "a", "speaker": "player", "addressedTo": [], "kind": "k"},
        {"text": "b", "speaker": "player", "addressedTo": ["player"], "kind": "k"},
        {"text": "c", "speaker": "npc:3", "addressedTo": [], "kind": "k"},
    ]}
    assert [e["text"] for e in ol.clean_entries(raw, {"npc:3"})] == ["c"]


# ---------------- review fixes: loud refusal when full, fence, deals, engine flag ----------------

def _entries_llm(n):
    texts = ["alpha one", "beta two", "gamma three"][:n]

    async def llm(_m):
        items = ",".join('{"text":"%s","speaker":"npc:3","addressedTo":["player"],"kind":"k"}' % t for t in texts)
        return '{"entries":[%s]}' % items
    return llm


def test_full_refusal_is_recorded_loudly_once_per_turn(monkeypatch):
    from src import log_rings
    seen = []
    monkeypatch.setattr(log_rings, "record_soft_failure", lambda cls, exc, **kw: seen.append((cls, kw)))

    async def full(_p):
        return {"accepted": False, "reason": "full"}

    assert run(ol.capture_open_ledger(NARR, PRESENT, _entries_llm(3), full, owner="u1")) == 0
    assert [c for c, _ in seen] == ["open-ledger:full"]  # three refusals, ONE record
    assert seen[0][1].get("user") == "u1"
    assert not seen[0][1].get("corrected"), "nothing corrected the refusal: the admin disposition must read 'uncorrected'"


def test_other_refusals_and_acceptances_do_not_record_full(monkeypatch):
    from src import log_rings
    seen = []
    monkeypatch.setattr(log_rings, "record_soft_failure", lambda cls, exc, **kw: seen.append(cls))

    async def other(_p):
        return {"accepted": False, "reason": "not-present"}

    async def ok(_p):
        return {"accepted": True}

    run(ol.capture_open_ledger(NARR, PRESENT, _entries_llm(2), other))
    run(ol.capture_open_ledger(NARR, PRESENT, _entries_llm(2), ok))
    # ORW-1065: a refusal other than "full" is no longer silent: one soft failure per reason, never the "full" one
    assert seen == ["open-ledger:refused-not-present"]
    assert ol.discard_counts().get("refused-not-present", 0) >= 2


def test_prompt_is_behind_the_untrusted_fence_and_takes_spoken_deals_as_kind_deal():
    from src.agent_loop import _EXTRACTION_UNTRUSTED_FENCE
    prompts = []

    async def llm(m):
        prompts.append(m[0]["content"])
        return '{"entries":[]}'

    async def write(_p):
        return {"accepted": True}

    run(ol.capture_open_ledger(NARR, PRESENT, llm, write))
    assert prompts[0].startswith(_EXTRACTION_UNTRUSTED_FENCE)
    # ORW-456 (Kevin: formal deals are also in the ledger, linked): a spoken deal is extracted with kind "deal"; it is no longer left out.
    assert 'kind "deal"' in prompts[0] and "leave it out" not in prompts[0]


def test_after_turn_stands_down_when_the_engine_has_the_ledger_off(monkeypatch):
    from src import orwell_engine as oe
    from src import orwell_show_brief as sb
    monkeypatch.setattr(sb, "show_brief_enabled", lambda: True)
    called = []

    async def boom(*a, **k):
        called.append(1)
        return None

    monkeypatch.setattr(oe, "whereabouts", boom)

    async def none(*a, **k):
        return []

    monkeypatch.setattr(oe, "open_ledger_here", none)
    monkeypatch.setitem(oe._ENGINE_FLAGS, "openLedger", False)
    assert run(ol.after_turn(NARR, "u", "http://x", "m", {})) == 0
    assert called == []  # no extraction, not even the presence read
    monkeypatch.setitem(oe._ENGINE_FLAGS, "openLedger", True)
    run(ol.after_turn(NARR, "u", "http://x", "m", {}))
    assert called == [1]  # flag on: it carries on
    monkeypatch.delitem(oe._ENGINE_FLAGS, "openLedger")
    run(ol.after_turn(NARR, "u", "http://x", "m", {}))
    assert called == [1, 1]  # flag unknown: fail open


def test_a_spoken_deal_is_kept_with_kind_deal_not_dropped():
    """ORW-456: a formal deal between the player and one houseguest, voiced in the scene, goes to the engine as kind "deal"."""
    raw = {"entries": [{"text": "We go to the end together", "speaker": "player", "addressedTo": ["npc:1"], "kind": "Deal"}]}
    out = ol.clean_entries(raw, {"npc:1"})
    assert out == [{"text": "We go to the end together", "speaker": "player", "addressedTo": ["npc:1"], "kind": "Deal"}]


def test_orw1065_discards_and_overflow_are_counted_and_one_bad_id_keeps_the_entry():
    before = ol.discard_counts()
    raw = {"entries": [
        {"text": "I will keep you safe", "speaker": "npc:3", "addressedTo": ["player", "Dale"], "kind": "oath"},
        {"text": "who", "speaker": "npc:9", "addressedTo": ["player"], "kind": "k"},
        {"text": "a", "speaker": "player", "addressedTo": ["npc:3"], "kind": "k"},
        {"text": "b", "speaker": "player", "addressedTo": ["npc:3"], "kind": "k"},
        {"text": "c", "speaker": "player", "addressedTo": ["npc:3"], "kind": "k"},
    ]}
    out = ol.clean_entries(raw, {"npc:3"})
    assert out[0]["addressedTo"] == ["player"]  # the unknown id went, the entry and the good id stayed
    after = ol.discard_counts()

    def d(k):
        return after.get(k, 0) - before.get(k, 0)
    assert d("addressee-id-dropped") == 1 and d("entry-speaker-not-present") == 1 and d("entries-over-cap") >= 1


def test_orw1065_a_long_entry_keeps_its_first_sentence_when_that_fits_and_is_dropped_when_none_does():
    before = ol.discard_counts()
    long_tail = "I will keep you safe this week. " + "And then there is a long story about why, " * 8
    raw = {"entries": [
        {"text": long_tail, "speaker": "npc:3", "addressedTo": ["player"], "kind": "oath"},
        {"text": "y" * 250, "speaker": "npc:3", "addressedTo": ["player"], "kind": "ramble"},
    ]}
    out = ol.clean_entries(raw, {"npc:3"})
    assert [e["text"] for e in out] == ["I will keep you safe this week."]  # whole words, never cut mid-sentence
    after = ol.discard_counts()
    assert after.get("entry-long-first-sentence-kept", 0) - before.get("entry-long-first-sentence-kept", 0) == 1
    assert after.get("entry-empty-long-or-duplicate", 0) - before.get("entry-empty-long-or-duplicate", 0) == 1


def test_orw1065_due_and_open_items_the_caps_leave_out_are_counted():
    import asyncio
    before = ol.discard_counts()
    items = [{"id": f"o{i}", "text": f"promise {i}"} for i in range(8)] + [{"id": f"d{i}", "text": f"due {i}", "due": "the vote happened"} for i in range(5)]

    async def llm(_msgs):
        return '{"entries": [], "resolutions": []}'

    async def write(_e):
        return {"ok": True}
    asyncio.run(ol.capture_open_ledger("n" * 200, [{"id": "npc:1", "name": "A Houseguest"}], llm, write, open_items=items, resolve=write))
    after = ol.discard_counts()
    assert after.get("due-over-cap", 0) - before.get("due-over-cap", 0) == 2
    assert after.get("open-over-cap", 0) - before.get("open-over-cap", 0) == 3
