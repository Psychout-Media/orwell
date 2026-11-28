"""ORW-1177: a dated plan the player states and houseguests accept ("ice breakers tomorrow morning, I'll make the coffee") reaches the open ledger
with its day and part of day and every accepting houseguest, instead of being refused as bad-shape or recorded undated."""
import asyncio

from src import orwell_open_ledger as ol

HG = {f"npc:{i}": n for i, n in enumerate(["Ana", "Jace", "Bo", "Cy", "Di"], start=1)}
PRESENT = [{"id": i, "name": n} for i, n in HG.items()]
SAY = "Its a date. Cheesy camp ice breakers tomorrow morning. I'll make the coffee!"
NARR = ("Ana grins: That's a promise I'm holding you to. Jace nods: Coffee at dawn, then, I'll take that deal. Bo, Cy and Di all say they will be there "
        "for the ice breakers tomorrow morning, and the kitchen fills with laughter.")


def run(coro):
    return asyncio.run(coro)


def _capture(reply, player_message=SAY, present=PRESENT):
    sent = []

    async def llm(_m):
        return reply

    async def write(p):
        sent.append(p)
        return {"accepted": True, "entryId": f"open:{len(sent)}"}

    n = run(ol.capture_open_ledger(NARR, present, llm, write, player_message=player_message))
    return n, sent


ALL5 = '["npc:1","npc:2","npc:3","npc:4","npc:5"]'


def test_five_acceptors_are_parties_not_a_bad_shape_refusal():
    n, sent = _capture('{"entries":[{"text":"Cheesy camp ice breakers tomorrow morning, I\'ll make the coffee","speaker":"player","addressedTo":' + ALL5 + ',"kind":"plan"}]}')
    assert n == 1 and len(sent) == 1
    e = sent[0]
    assert len(e["addressedTo"]) <= ol.ADDRESSED_MAX
    assert set(e["parties"]) == set(HG)


def test_day_and_part_are_read_off_the_players_words_when_the_extraction_leaves_them_out():
    _, sent = _capture('{"entries":[{"text":"Cheesy camp ice breakers tomorrow morning, I\'ll make the coffee","speaker":"player","addressedTo":["npc:1","npc:2"],"kind":"plan"}]}')
    assert sent[0]["due"] == {"day": "tomorrow", "part": "morning"}
    assert sent[0]["addressedTo"] == ["npc:1", "npc:2"]


def test_the_extractions_own_due_is_kept_and_is_validated():
    _, sent = _capture('{"entries":[{"text":"ice breakers at dawn","speaker":"player","addressedTo":["npc:1"],"kind":"plan","due":{"day":"tomorrow","part":"evening"}}]}', player_message="")
    assert sent[0]["due"] == {"day": "tomorrow", "part": "evening"}
    _, sent = _capture('{"entries":[{"text":"ice breakers","speaker":"player","addressedTo":["npc:1"],"kind":"plan","due":{"day":"next year","part":"noon"}}]}', player_message="")
    assert "due" not in sent[0]


def test_negative_control_a_vague_sometime_carries_no_day():
    _, sent = _capture('{"entries":[{"text":"We should do ice breakers sometime, I\'ll make the coffee","speaker":"player","addressedTo":["npc:1"],"kind":"plan"}]}',
                       player_message="We should do ice breakers sometime. I'll make the coffee!")
    assert len(sent) == 1 and "due" not in sent[0]
    assert ol.derive_due("one day, soon, maybe next week") is None


def test_negative_control_a_plan_nobody_accepts_records_nothing():
    n, sent = _capture('{"entries":[]}')
    assert n == 0 and sent == []


def test_a_claim_about_people_is_not_dated_by_a_tomorrow_in_the_message():
    _, sent = _capture('{"entries":[{"text":"Bo is going after you","speaker":"npc:3","addressedTo":["player"],"kind":"claim","claim":{"kind":"going-after","subject":"npc:3"}}]}',
                       player_message="Tomorrow morning we find out")
    assert "due" not in sent[0]


def test_derive_due_forms():
    assert ol.derive_due("tomorrow morning") == {"day": "tomorrow", "part": "morning"}
    assert ol.derive_due("Tomorrow") == {"day": "tomorrow"}
    assert ol.derive_due("see you tonight") == {"day": "today", "part": "night"}
    assert ol.derive_due("this afternoon") == {"day": "today", "part": "afternoon"}


def test_the_engine_wrapper_forwards_due():
    from src import orwell_engine as oe
    seen = {}

    async def fake_call(name, args, user=None):
        seen.update(name=name, args=args)
        return {"accepted": True}

    orig = oe._call
    oe._call = fake_call
    try:
        run(oe.record_open_ledger({"text": "t", "speaker": "player", "addressedTo": ["npc:1"], "kind": "plan", "due": {"day": "tomorrow", "part": "morning"}}))
    finally:
        oe._call = orig
    assert seen["args"]["due"] == {"day": "tomorrow", "part": "morning"}
