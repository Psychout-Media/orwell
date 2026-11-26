"""ORW-740b (ORW-706 finding: `soft-fail briefing-conflict:player-room` on most turns of both playtests). Roles only.

Class (c), a false positive of the report-only briefing audit: the engine names a themed room "The Hearth Pit" (capital T), the audit's room pattern matched "the " in lower case only, so the capture kept
the article ("the-hearth-pit") and never equalled the briefing's own themed name ("hearth-pit"). Every journal line that names both sides (281 of 281) is this pair; a real disagreement still reports."""
import pytest

from routes.briefing import build_briefing
from routes.briefing_audit import audit_briefing

NAMES = {"living-room": "The Hearth Pit", "backyard": "The Dry Wash Deck", "hallway": "Bearing Corridor"}


def _board(room):
    return {"whereabouts": {"room": room, "present": [], "roomNames": NAMES}}


def _msgs(line):
    return [{"role": "system", "content": f"    Your room: {line} (you've been here a moment)."}]


@pytest.mark.parametrize("room,line", [("living-room", "The Hearth Pit"), ("living-room", "the Hearth Pit"), ("backyard", "The Dry Wash Deck"), ("hallway", "Bearing Corridor")])
def test_a_themed_room_the_engine_named_is_not_a_conflict(room, line):
    b = build_briefing(_board(room), zero_clocks=False)
    assert [c for c in audit_briefing(_msgs(line), b) if c["fact"] == "player-room"] == []


def test_a_real_disagreement_still_reports_and_names_both_sides():
    b = build_briefing(_board("living-room"), zero_clocks=False)
    hits = [c for c in audit_briefing(_msgs("The Dry Wash Deck"), b) if c["fact"] == "player-room"]
    assert len(hits) == 1 and "dry-wash-deck" in hits[0]["detail"] and "living-room" in hits[0]["detail"]


# ── the pre-display check: a reply that calls the house to a room other than the engine's (count-only; the quiet rewrite stays OFF) ─────────────────────────────────────────────────
from src import predisplay_check as pd  # noqa: E402


def _state(kind, room):
    return {"whereabouts": {"room": room, "roomNames": NAMES, "houseEvent": {"kind": kind, "room": room}}}


def test_calling_the_house_to_another_room_than_the_engines_is_caught_even_in_a_quote():
    st = _state("hoh-competition", "backyard")
    txt = 'The speaker clicks. "Houseguests. It\'s time. Everyone to the living room."'
    assert pd.FACT_EVENT_ROOM in pd.find_conflicts(txt, st, zero_clocks=False)
    det = pd.conflict_details("They come from everywhere, spilling into The Hearth Pit until all sixteen are gathered.", st, zero_clocks=False)
    assert [c.fact for c in det] == [pd.FACT_EVENT_ROOM] and det[0].detail == "The Dry Wash Deck"


@pytest.mark.parametrize("kind,room,txt", [
    ("hoh-competition", "backyard", "Production's voice: everyone out to the Dry Wash Deck, the competition is starting."),
    ("nominations", "living-room", 'Production calls: "Houseguests, everyone to the living room."'),
    ("hoh-competition", "backyard", "Everyone files out of The Hearth Pit and onto the Dry Wash Deck."),  # names the engine's room too: a move, not a mis-call
    ("hoh-competition", "backyard", "Role A cooks in The Hearth Pit while the others talk."),  # not a call
])
def test_the_engines_room_or_no_call_is_never_a_conflict(kind, room, txt):
    assert pd.FACT_EVENT_ROOM not in pd.find_conflicts(txt, _state(kind, room), zero_clocks=False)


def test_no_event_in_session_or_no_names_fails_open():
    txt = "Everyone to the living room."
    assert pd.find_conflicts(txt, {"whereabouts": {"room": "backyard", "roomNames": NAMES}}, zero_clocks=False) == []
    assert pd.find_conflicts(txt, {"whereabouts": {"houseEvent": {"kind": "hoh-competition", "room": "backyard"}}}, zero_clocks=False) == []
    assert pd.find_conflicts(txt, {"whereabouts": "x"}, zero_clocks=False) == []
    assert pd.find_conflicts(txt, None, zero_clocks=False) == []


def test_the_correction_names_the_engines_room_and_the_rewrite_is_on_by_default(monkeypatch):
    c = pd.Conflict(pd.FACT_EVENT_ROOM, "The Dry Wash Deck")
    assert "The Dry Wash Deck" in pd._correction_line(c)
    monkeypatch.delenv("ORWELL_PREDISPLAY_REWRITE", raising=False)
    assert pd.predisplay_rewrite_enabled() is True
