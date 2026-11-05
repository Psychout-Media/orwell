"""A77 - the two log lines that say a closed-set guard fired ("pre-emission guard HELD a phantom closed-set outcome" and "beat-signature desync detected") must say WHICH guard: a short class tag plus the first
120 chars of the (Vault-free) directive, so the live-triage runbook and the post-session analyzer can tell N-1 / N-3 / N-15 / N-16 / A-9 apart. One caplog case per class through the REAL entry points
(screen_streamed_outcome, record_post_turn_desync_check). Roles only."""
import asyncio
import importlib
import logging
import re

import pytest

importlib.import_module("src.agent_tools")
ch = importlib.import_module("routes.chat_helpers")
USER = "a77-user"

N16 = ('"Locked in. Houseguests - take your spots." The yard moves. Sixteen bodies climb onto the platform, sixteen sets of hands find the wall, and the rope line goes taut.')
A9_LEAK = "Contestant Alpha goes out first, laughing it off. The competition went to somebody else entirely."
N1_LEAK = "Rival gets there first and the bell rings."



def _base(**kw):
    b = {"week": 1, "phase": "veto-ceremony", "pending": None, "hoh": "npc:7", "hohName": "Hoh", "noms": ["npc:2", "npc:4"], "nomNames": ["NomOne", "NomTwo"],
         "vetoHolder": "npc:1", "vetoHolderName": "Holder", "vetoUsed": False, "playerIsHoh": False, "playerHasVeto": False, "playerStatus": "active",
         "evicted": 0, "finished": False, "beatSeq": 40, "compSig": None, "vetoFieldIds": [], "vetoFieldNames": [], "playerId": "player", "compNotDue": None,
         "activeNames": ["Hoh", "NomOne", "NomTwo", "Holder", "Rival"]}
    b.update(kw)
    return b


# class -> (text, board signature that makes the detector fire)
CASES = {
    "N-16": (N16, _base(phase="hoh-competition", compNotDue=True), None),
    "N-15": ("You cast your vote and step back out into the hallway.", _base(phase="eviction", pending="eviction-vote"), None),
    "N-3": ("Nothing's been announced - the Head of Household competition hasn't happened yet.", _base(phase="nominations"), None),
    "N-1": (N1_LEAK, _base(), None),
    "A-9": (A9_LEAK, _base(phase="hoh-competition", pending="comp-round", compSig="npc:1,npc:2,npc:3"), None),
}


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


@pytest.fixture(autouse=True)
def _clean():
    for d in (ch._LAST_BEAT_SIG, ch._DESYNC_REGROUND):
        d.pop(USER, None)
    yield
    for d in (ch._LAST_BEAT_SIG, ch._DESYNC_REGROUND):
        d.pop(USER, None)


def _arm(monkeypatch, sig, before=None):
    async def fake(user=None):
        return dict(sig)
    monkeypatch.setattr(ch, "_capture_beat_signature", fake)
    ch._LAST_BEAT_SIG[USER] = dict(before or sig)


@pytest.mark.parametrize("cls", sorted(CASES))
def test_the_pre_emission_guard_line_names_its_class(monkeypatch, caplog, cls):
    text, sig, before = CASES[cls]
    _arm(monkeypatch, sig, before)
    with caplog.at_level(logging.WARNING):
        held = _run(ch.screen_streamed_outcome(USER, text))
    assert held is False, f"{cls}: the sentence guard must HOLD this ({text[:60]!r})"
    line = next(r.getMessage() for r in caplog.records if "pre-emission guard HELD a phantom closed-set outcome" in r.getMessage())
    assert f"class={cls}" in line or re.search(rf"class=[^;)]*{re.escape(cls)}", line), line
    assert "RE-GROUND" in line or len(line) > 140, line


@pytest.mark.parametrize("cls", sorted(CASES))
def test_the_post_turn_line_names_its_class(monkeypatch, caplog, cls):
    text, sig, before = CASES[cls]
    _arm(monkeypatch, sig, before)
    with caplog.at_level(logging.WARNING):
        _run(ch.record_post_turn_desync_check(USER, text, True))
    line = next(r.getMessage() for r in caplog.records if "beat-signature desync detected" in r.getMessage())
    assert re.search(rf"class=[^;)]*{re.escape(cls)}", line), line


def test_each_class_gets_a_distinct_tag_and_a_plain_outcome_claim_falls_back():
    tags = {}
    for cls, (text, sig, before) in CASES.items():
        d = ch._narration_claims_outcome(text, before or sig, sig)
        assert d, cls
        tags[cls] = ch._guard_class_tag(d)
    assert len(set(tags.values())) == len(tags), tags
    for cls, tag in tags.items():
        assert cls in tag, (cls, tag)
    assert ch._guard_class_tag("RE-GROUND ON THE BOARD - an eviction result the engine never committed") == "closed-set"
    assert ch._guard_snippet("x" * 400) == "x" * 120
