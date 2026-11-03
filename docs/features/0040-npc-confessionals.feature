# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0040 — NPC Diary Room confessionals: Vault-only NPC interiority, grounded in the engine's truth,
# walled from BOTH the player and admin/God Mode. HARD rule: roles only (NPC, HOH, nominee, juror).
# Add to cucumber.cjs when green.

Feature: NPC Diary Room confessionals

  At dramatic beats the houseguests confess privately: a Vault-only read of their game grounded in the
  engine's relationship truth — their target, who they trust, their grudges. These confessionals deepen
  the soul and keep each NPC's later voice consistent, but they reach no one — not the player, not the
  admin. The engine supplies the read; the narrator never invents it.

  Scenario: Houseguests confess at dramatic beats
    Given a started game that reaches a nomination ceremony
    When the beat resolves
    Then the directly-involved houseguests each record a private confessional

  Scenario: A confessional reflects the NPC's real engine-grounded read
    Given a houseguest whose hidden relationship reads mark a clear top threat
    When that houseguest confesses
    Then the confessional names that threat as their target
    And it reflects who they actually trust and distrust
    And it is not an invented stance improvised by the narrator

  Scenario: Confessionals never reach the player
    Given a started game in which houseguests have confessed
    When any player surface is read
    Then no confessional content appears
    And no confessional witnesses the player

  Scenario: Confessionals never reach admin or God Mode either
    Given a started game in which houseguests have confessed
    When the admin / God-Mode surface is read
    Then no confessional content appears
    And no Vault sentinel value appears

  # @standalone-module (the recall half): live confessionals are written to the soul index (recordConfessionalToSoul, GameSessionAdapter),
  # but SoulProvider.recall/soulOf have no production caller, so nothing reads them back. The live game grounds a later confessional via
  # confessionalFor over the current relationship edges + recent events, proven by "A confessional reflects the NPC's real engine-grounded
  # read" and the seed-determinism scenario, both of which run the live game. The soul-recall half is proven by tests/unit/confessionalsLive.test.ts
  # ("confessionals deepen the soul"); the live grounding by tests/unit/npcConfessionals.test.ts.
  @standalone-module
  Scenario: Confessionals deepen the soul and ground later voice
    Given a houseguest who has confessed across several beats
    Then their soul accumulates those confessionals without losing earlier ones
    And a later recall can surface a specific past confessional to keep their voice consistent

  Scenario: Confessionals are seed-deterministic
    Given two confessing games started from the same seed
    When the same beats are reached in each
    Then the same houseguests confess the same grounded reads
