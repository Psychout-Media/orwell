# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0015 — Character creation (OOBE): the ONE human-authored profile.
# HARD rule: roles only. The player is a houseguest like any other — never mechanically protected.

Feature: Character creation (OOBE) — authoring the player, the only human-authored profile

  A new save begins with a first-run, out-of-character flow that produces the player: the only
  authored houseguest. It yields the player's static Character and an initial dynamic Soul, then
  seeds the rest of the house around the player as a balanced ensemble. The player authors who
  they are, not how the game will treat them.

  Scenario: OOBE produces exactly one human-authored profile
    When a new save is created through character creation
    Then exactly one houseguest profile originates from human authoring
    And that profile is the player
    And the other fifteen houseguests are generated

  Scenario: The authored player splits into a static Character and an initial Soul
    When the player is authored
    Then the player has a static Character carrying identity, backstory, and core aptitudes
    And the player has an initial Soul carrying an emotional baseline
    And the player's Soul holds no relationship beliefs yet

  Scenario: A missing name is rejected (the name is the one required field); a complete input is internally consistent
    Given a character-creation input with no name
    When the input is submitted
    Then character creation is rejected
    When a complete character-creation input is submitted instead
    Then the resulting player profile is internally consistent

  Scenario: The player cannot author themselves a guaranteed advantage
    Given a character-creation input that attempts to maximize every aptitude
    When the player is authored
    Then the player's core aptitudes fall within the same bounds as the generated houseguests
    And no authored input places an aptitude outside those bounds

  Scenario: The authored player is not mechanically protected
    Given the authored player enters seeded competitions
    Then the player can lose
    And the authored profile grants the player no outcome guarantee

  Scenario: The player's authored private strategy reaches no houseguest at the start
    When the player authors a private strategic lean
    Then that material is part of the player's own knowledge
    And no houseguest's knowledge state holds it at the start of the game

  Scenario: Character creation is out-of-character and witnessed by no one
    When the player is authored
    Then character creation produces no witnessed event
    And nothing from it is narrated to any houseguest

  Scenario: The house is generated around the player as a balanced ensemble
    When the player is authored
    And the house is generated
    Then the cast spans a spread of distinct archetypes and strategy styles
    And the player is not dropped into a clump of near-identical houseguests

  Scenario: Character creation runs once per save with no carryover
    Given a player authored in one save
    And a player authored in another save
    Then the two saves share no houseguest identities
