# Executable spec - BUILT (retrospective, 2026-11-11); BDD-gated in cucumber.cjs (ORW-385). Feature 0143 - Casual Assurances. Roles only.
# Steps: features/step_definitions/casual_assurances.steps.ts. Recording goes through McpServer.callTool; the nomination,
# ballot and week-roll scenarios play a REAL seeded game through the live adapter and compare one engine snapshot played twice
# (a control without the assurance, a branch with it).

Feature: Casual Assurances

  Retrospective scenarios describing the shipped behavior.

  Scenario: A promise made in a scene is recorded
    Given the assurances flag is on and a scene in which the player tells a houseguest "you're safe with me"
    When the scene is recorded with that assurance
    Then an open assurance exists from the promiser to the assured

  Scenario: A kept safe assurance keeps the assured off the block
    Given an NPC HOH who has given a "safe" assurance to a houseguest and means to keep it, about to nominate them
    When nominations are decided
    Then the assured houseguest is not nominated

  Scenario: A broken assurance costs the assurer the assured's trust
    Given an NPC HOH who has given an open "safe" assurance to a houseguest and will not keep it, about to nominate them
    When the HOH nominates that houseguest
    Then the assurance resolves broken once
    And the assured remembers it and trusts the HOH less
    And no assurance or number is shown to the player

  Scenario: A sealed ballot never names the voter
    Given a houseguest holds an open "vote" assurance toward a nominee they are about to vote out, with a witness who heard it
    When the houseguest votes that nominee out on a secret ballot
    Then the assurance resolves broken in the engine
    And nothing the assured or a witness holds names the voter
    And the memory and trust cost is shared equally across every possible voter

  Scenario: The HOH tie-break stays attributed
    Given an eviction vote is tied and the HOH, who holds an open "safe" assurance toward a nominee, is about to break it against them
    When the break is recorded
    Then the HOH is named as the breaker, because that act is public

  Scenario: Open assurances lapse
    Given an open assurance older than the horizon and a fresh one
    When the week advances
    Then the old one is marked lapsed and no longer binds, and the fresh one stays open
