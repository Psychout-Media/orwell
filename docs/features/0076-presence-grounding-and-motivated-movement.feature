# spec-only: this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
# Design contract: 0076 is Built, and its gates are unit + front-end tests, not Gherkin. The behavior below is verified by:
#   engine:    tests/unit/presence.test.ts (present company holds the scene; no teleports; seeded base-occupancy draw-count unchanged),
#              tests/unit/locationGrounding0009.test.ts (the closed-set location/roster grounding the narrator is fed);
#   front end: frontend/tests/test_0076_presence_desync.py (the desync guard: teleport / from-nowhere staging caught, prose untouched),
#              frontend/tests/test_0076_presence_movement.py (exits and arrivals narrated as beats),
#              frontend/tests/test_a2_presence_wall.py (narration may only stage houseguests the engine places in the room).
# The sibling presence behavior that IS Gherkin-gated lives in 0049 (witnessing, overhearing) and 0077 (floor plan, sightline).
Feature: 0076 — Presence grounding & motivated movement
  The narrator stops inventing the room. Who is present and who exists are closed-set facts the
  engine owns and feeds every turn; the model voices the scene but never authors the roster or the
  floor plan. Houseguests keep full agency to leave the player's scene — but only for a reason,
  to an adjacent room, recorded and voiced as an exit, never a silent teleport. A closed-set-only
  desync guard catches a spatial or roster contradiction before the player sees it, and never
  touches the prose.

  # Role-only (testing rule): the-player, a houseguest, an ally, a present-houseguest, an evictee.

  Background:
    Given a started season with the player in a room with two present houseguests

  Rule: The room is fed, never invented (closed-set fact)

    Scenario: The scene names only the houseguests the engine places there
      When the narrator sets the player's scene
      Then every houseguest narrated as present is one the engine's whereabouts places in the room
      And no living houseguest from another room is narrated as present
      And no houseguest outside the cast roster is narrated into the room

    Scenario: A houseguest the engine has elsewhere is not voiced as present
      Given a houseguest the engine places in a non-adjacent room
      When the narrator sets the player's scene
      Then that houseguest is not narrated as present in the player's room

    Scenario: The regression — the Bedroom-A teleport is caught before emission
      Given the player has moved into one bedroom
      And the proposed narration places a houseguest from the other, non-adjacent bedroom in the room
      And the proposed narration introduces a houseguest who is in no room
      When the presence guard runs before the player sees the scene
      Then both the teleport and the from-nowhere arrival are caught
      And the scene is re-grounded to the engine's real occupancy

  Rule: Houseguests leave with agency — motivated, voiced, recorded (never a freeze, never churn)

    Scenario: Present company stays through a continuous scene with no motive to leave
      Given a continuous conversation across several player turns
      And no precipitating reason for anyone to leave
      Then the present houseguests remain in the room across those turns
      And no houseguest silently disappears or reappears

    Scenario: A houseguest leaves for a reason, and it is shown
      Given a present houseguest who has a reason to leave
      When the scene continues
      Then that houseguest departs to an adjacent room
      And their move is recorded and persisted
      And their exit is narrated as a beat, not a silent disappearance

    Scenario: A houseguest can leave on a turn the player did not initiate movement
      Given a present houseguest whose motive to leave fires
      When the player takes a turn that does not move the player
      Then the houseguest may still leave the room on their own agency

    Scenario: No teleports across the season
      When a full season is played
      Then every houseguest movement is to an adjacent room or a stay
      And the occupancy invariants never report a teleport

  Rule: The guard touches facts, never flavor (the storytelling is not compromised)

    Scenario: The guard is inert on pure narrative texture
      Given narration that invents only mood, glances, and the texture of the room
      When the presence guard runs
      Then it makes no change to the prose
      And the expressive-non-collapse invariant stays satisfied

  Rule: Grounding holds all season, not only at the premiere

    Scenario Outline: The scene is grounded at every stage
      Given the game is at <stage>
      When the narrator sets the player's scene
      Then the present houseguests match the engine's occupancy

      Examples:
        | stage          |
        | the premiere   |
        | mid-season     |
        | a final-N week |

  Rule: Movement retuning never perturbs the seeded calibration

    Scenario: The calibration-neutral base occupancy is byte-identical after the retune
      When the presence tick runs with the retuned, lull-gated movement
      Then the shared-stream base occupancy draw-count is unchanged
      And the seeded jury-reach calibration stays within its band
