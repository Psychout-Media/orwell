Feature: 0078 — Motivated off-screen society & intentional movement
  Houseguests must be in the same room to have any off-screen scene — co-presence is the gate, so
  "who's in a room together" matters. But co-presence is EARNED, not arbitrary: NPCs move with intent,
  like the player, toward what their motivation wants (a bond to build, a target to work, a quiet room
  to scheme). And being in a room together does not mean talking game: the nature follows motivation —
  a friendly conversation (affinity only, no scheming) or a strategic one — and relationships build
  either way.

  # Role-only (testing rule): the-player, an ally, a rival, a target, a schemer, an outsider.

  Background:
    Given a started season with the off-screen society running between turns

  Rule: Co-presence is required for any off-screen interaction

    Scenario: No scene happens between houseguests in different rooms
      Given two houseguests in different rooms
      When the house lives between the player's turns
      Then no off-screen scene fires between them

  Rule: Co-presence is earned by intentional movement, not by random drift

    Scenario: A houseguest moves toward the person their motivation points at
      Given a houseguest with a motive to bond with an ally
      And another houseguest with a motive to work a rival
      When the house lives between the player's turns
      Then each trends toward their target's vicinity more than a motiveless houseguest
      And the pairs that end up co-present reflect agenda, not luck

    Scenario: Shuffling who has a motive changes who ends up together
      Given a fixed seed
      When the same season is run with different houseguest agendas
      Then the co-presence pattern shifts to follow the agendas

  Rule: Co-presence is not game talk — motivation sets the nature

    Scenario: A warm pair has a friendly conversation that builds the bond only
      Given two co-present houseguests with a warm, low-threat relationship
      When they have an off-screen scene
      Then the scene is friendly, not strategic
      And it raises their affinity
      And it folds no strategic weight and triggers no vote-affecting change

    Scenario: A threatened pair has a strategic conversation
      Given two co-present houseguests where one reads the other as a threat
      When they have an off-screen scene
      Then the scene is a game conversation
      And it folds the strategic weights that feed votes

    Scenario: Every co-present scene deepens the relationship layer
      When any off-screen scene resolves
      Then it records, folds its impact, and persists
      And nothing is left inert

  Rule: Asleep houseguests drop out of play (the night bound holds)

    # A turned-in houseguest is OUT OF PLAY (ADR 0006: the bound is the emptying house, not a
    # frozen coordinate) — gone from the society floor and the player-visible house, and never
    # paired into an off-screen scene.
    Scenario: A turned-in houseguest drops out of the society
      Given the night has thinned the awake set
      Then a houseguest who has gone to bed is absent from the awake house and appears in no off-screen scene

  Rule: The anti-sycophancy floor is enforced for the new movement model

    # The authoritative active-vs-passive band — an active player reaches the jury and wins at
    # least as often as a passive one — is measured across many seeds in the heavy calibration
    # sims (npm run test:heavy:jury + test:heavy:gradient), which run in CI on every engine
    # change. Like 0073's structural wall proof, this scenario verifies that gate is WIRED for
    # the intentional-movement model: it plays one real season through the live harness and
    # confirms the floor's teeth are in force.
    Scenario: The calibration floor runs on the intentional-movement model
      Given the seeded calibration harness that plays passive seasons to a verdict
      When one passive season is played to completion on the current model
      Then it yields a well-formed outcome the band gate can score
      And the floor demands every crowned passive season be earned on the public comp record

  Rule: Headcounts include the player

  # ORW-376 (Ryne, 2026-11-15: houseguests "typically refer to the number of NPCs in a room, not including the player").
  Scenario: The engine's headcounts include the player
    Given a season that has reached its nominations
    Then the player's room count is the houseguests with them plus the player
    And the house count is everyone still in the game, the player included

  Scenario: On eviction night the voter count is the real one, not a fixed number
    Given a season that has reached an eviction vote after an eviction
    Then the voter count is the house minus the HOH and the two nominees
