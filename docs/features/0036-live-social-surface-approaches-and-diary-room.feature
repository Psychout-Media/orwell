# spec-only: gated by tests/unit/liveSocialSurface.test.ts; this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
# Executable spec — IMPLEMENTED; shipped UNIT-GATED (tests/unit/liveSocialSurface.test.ts,
# tests/unit/diaryRoom.test.ts) — never added to cucumber.cjs (recorded deviation, audit E87a;
# the original "add to cucumber.cjs when green" instruction was not followed).
# Feature 0036 — Live social surface: expose 0012's NPC-initiated approaches and 0013's Diary Room as
# Vault-free live player tools. Engine-side (TS gate).
# HARD rule: roles only (player, NPC). The Diary Room wall is the crux — no NPC ever learns DR content.

Feature: Live social surface (NPC approaches & the Diary Room)

  In the live game, scenes start from either side and the player has their Diary Room. NPCs approach the
  player by their own motivation (bidirectional, not only player-initiated), and the player can record an
  out-of-character Diary-Room entry that no houseguest ever learns. Both are Vault-free.

  Scenario: NPCs approach the player on their own initiative
    Given a started game in which a houseguest is motivated to talk to the player
    When the player checks who wants to approach them
    Then that houseguest is listed with a coarse public-safe motive
    And no hidden motive or relationship number is shown

  Scenario: Either side can open a scene
    Given a started game
    Then the player can initiate a scene with a houseguest
    And a houseguest can initiate a scene with the player
    And neither side initiates every scene

  Scenario: The player can use the Diary Room in the live game
    Given a started game
    When the player records a Diary-Room entry
    Then it is stored as the player's own out-of-character knowledge
    And it is recorded with no in-game pathway to any houseguest

  Scenario: No houseguest ever learns Diary-Room content
    Given the player has recorded a Diary-Room entry
    When each houseguest's knowledge is derived
    Then none of them knows the Diary-Room content
    And the houseguests act only on the player's public speech, never the Diary Room

  Scenario: The live social tools leak no hidden state
    Given a started game whose Vault holds hidden attributes and off-screen scheming
    When the player checks approaches and records a Diary-Room entry
    Then neither tool's output contains any hidden attribute or off-screen event
    And neither carries a Vault sentinel value
