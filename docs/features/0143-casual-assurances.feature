# spec-only: BUILT (retrospective, 2026-11-11) but NOT wired into cucumber.cjs; behavior is gated by unit tests (see the design note). Feature 0143 - Casual Assurances. Roles only.

Feature: Casual Assurances

  Retrospective scenarios describing the shipped behavior.

  Scenario: A promise made in a scene is recorded
    Given the assurances flag is on and a scene in which a houseguest tells another "you're safe with me"
    When the scene is recorded with that assurance
    Then an open assurance exists from the promiser to the assured

  Scenario: A kept safe assurance keeps the assured off the block
    Given the HOH holds a kept "safe" assurance toward a houseguest and two other legal choices remain
    When nominations are decided
    Then the assured houseguest is not nominated

  Scenario: A broken assurance costs the assurer the assured's trust
    Given the HOH holds an open "safe" assurance toward a houseguest
    When the HOH nominates that houseguest
    Then the assurance resolves broken once
    And the assured remembers it and trusts the HOH less
    And no number is shown to the player

  Scenario: A sealed ballot never names the voter
    Given a houseguest holds an open "vote" assurance toward a nominee
    When the houseguest votes that nominee out on a secret ballot
    Then the assurance resolves broken in the engine
    And nothing the assured or a witness holds names the voter
    And the memory and trust cost is shared equally across every possible voter

  Scenario: The HOH tie-break stays attributed
    Given an eviction vote is tied and the HOH breaks it against an assured nominee
    When the break is recorded
    Then the HOH is named as the breaker, because that act is public

  Scenario: Open assurances lapse
    Given an open assurance older than the horizon
    When the week advances
    Then it is marked lapsed and no longer binds
