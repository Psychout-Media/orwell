"""F-3 (A-11 playtest, #1781): narration seated the player in a veto field the engine EXCLUDED them from, narrated a
houseguest going out in round 3 who in fact WON the veto, and the engine's competition was never resolved that turn.
The A-9 screen only armed on a player approach pending; the veto draw that excludes the player raises none. Roles only."""
import importlib

ch = importlib.import_module("routes.chat_helpers")

FIELD = ["npc:1", "npc:2", "npc:3", "npc:4", "npc:5", "npc:6"]
NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"]
# the captured shape (names replaced by roles)
LEAK = (
    "The first sequence flashes and the six of you are off — punching, checking, punching again. "
    "Contestant Alpha goes out on the third round, missing by a single digit.\n\n"
    "Contestant Bravo is fast — relentless, actually — but the ninth round catches him and he is out."
)


def _sig(**kw):
    base = {"week": 1, "phase": "veto-competition", "pending": None, "hoh": "npc:7", "hohName": "Hoh", "noms": [],
            "vetoHolder": None, "playerIsHoh": False, "playerHasVeto": False, "playerStatus": "active", "evicted": 0,
            "finished": False, "beatSeq": 40, "compSig": None, "vetoFieldIds": FIELD, "vetoFieldNames": NAMES,
            "playerId": "player"}
    base.update(kw)
    return base


def test_the_signature_carries_the_real_veto_field_and_the_player_id():
    status = {"phase": "veto-competition", "veto": {"holder": None, "used": False,
              "players": [{"id": i, "name": n} for i, n in zip(FIELD, NAMES)]}}
    sig = ch._beat_signature(status, {"player": {"id": "player", "status": "active"}})
    assert sig["vetoFieldIds"] == sorted(FIELD) and sig["playerId"] == "player" and "Alpha" in sig["vetoFieldNames"]


def test_seating_the_player_in_a_field_that_excludes_them_is_flagged_with_the_real_field():
    label = ch._player_seated_in_excluded_field(LEAK, _sig())
    assert label and "NOT in it" in label and "Alpha" in label
    directive = ch._narration_claims_outcome(LEAK, _sig(), _sig())
    assert directive and "RE-GROUND" in directive


def test_the_player_actually_in_the_field_is_never_flagged():
    sig = _sig(vetoFieldIds=FIELD + ["player"])
    assert ch._player_seated_in_excluded_field(LEAK, sig) is None


def test_round_eliminations_are_a_phantom_even_with_no_player_approach_pending():
    # The elimination prose alone (no 'six of you') — pending None: the A-9 screen now arms on an unsettled
    # competition whatever the pending, because the veto draw can exclude the player entirely.
    only_elim = "Contestant Alpha goes out on the third round, missing by a single digit."
    assert ch._unsettled_competition_result(only_elim, _sig(), _sig())


def test_a_competition_that_moved_this_turn_stands_down():
    after = _sig(vetoHolder="npc:4", phase="veto-ceremony")
    assert ch._unsettled_competition_result(LEAK, after, _sig()) is None
    assert ch._player_seated_in_excluded_field(LEAK, after) is None


def test_atmosphere_hypotheticals_and_unknowns_are_untouched():
    calm = "The yard is quiet. Whoever wins the veto will matter. You wonder who the six will be."
    assert ch._unsettled_competition_result(calm, _sig(), _sig()) is None
    assert ch._player_seated_in_excluded_field(calm, _sig()) is None
    assert ch._player_seated_in_excluded_field(LEAK, _sig(vetoFieldIds=[])) is None      # no field read ⇒ stand down
    assert ch._player_seated_in_excluded_field(LEAK, _sig(playerId=None)) is None
    assert ch._player_seated_in_excluded_field(LEAK, _sig(phase="nominations")) is None


def test_the_closed_set_gate_lets_the_membership_claim_reach_the_board_check():
    assert ch._sentence_has_closed_set_claim("The six of you are off, punching and checking.") is True


def test_ordinary_player_movement_and_idiom_in_a_veto_phase_is_never_flagged():
    for calm in ("You step into the kitchen and grab a glass.", "You're in the kitchen with Bravo.",
                 "You reach for the fridge. You play it cool.", "You race to the bathroom."):
        assert ch._player_seated_in_excluded_field(calm, _sig()) is None, calm


def test_a_past_week_phrase_exempts_only_its_own_clause():
    text = "Last week you played the comp, but the six of you are off now."
    assert ch._player_seated_in_excluded_field(text, _sig())


def test_membership_and_elimination_in_one_turn_merge_into_one_reground():
    directive = ch._narration_claims_outcome(LEAK, _sig(), _sig())
    assert "NOT in it" in directive and "COMPETITION RESULT" in directive
