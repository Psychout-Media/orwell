# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Build priority #1 (Vault isolation, incl. God Mode). Resolved stack: TypeScript / Node —
# run via Cucumber.js + Vitest + fast-check + dependency-cruiser (see 0001-...md §8).
# HARD rule: roles only, never houseguest or player names. Fixtures are generated,
# never sample-save content. "Sentinel" = a unique marker injected into each Vault
# datum by the test fixture, not derivable from any public/visible state.

Feature: Vault Wall — secret state never reaches the player or the admin

  The Producer's Vault holds genuinely off-screen / hidden content: hidden attributes,
  NPC confessionals, hidden threads, off-screen NPC-to-NPC events the player did not
  witness, and any twists held in reserve. No Vault content — nor any inference uniquely
  derived from it — may reach the player through ANY player-facing surface, and the
  administrator (God Mode) is walled from the Vault as well. Enforcement is structural:
  outward-facing surfaces are incapable of reading the Vault, so the narrator cannot leak
  what it never receives.

  Background:
    Given a running game sandbox
    And a fully populated Producer's Vault
    And every Vault datum carries a unique sentinel value not derivable from visible state

  # --- Content guarantee: no sentinel (hence no Vault content) on any outward surface ---

  Scenario Outline: No Vault content appears on a player-facing surface
    When the engine produces player-facing output of type "<surface>"
    Then the output contains none of the Vault sentinel values
    And it contains no hidden attribute, confessional, hidden thread, or unwitnessed off-screen event

    Examples:
      | surface                |
      | scene narration        |
      | NPC dialogue           |
      | system message         |
      | player-visible log     |
      | end-of-session summary |

  Scenario: God Mode does not expose the Vault, even to the admin
    Given an administrator interacting in God Mode
    When the administrator inspects any game state
    Then no Vault sentinel value is returned
    And only non-Vault state is returned

  Scenario: NPC confessionals never surface to the player
    Given an NPC confessional recorded with a witness set that excludes the player
    When any player-facing surface is produced
    Then the confessional text does not appear
    And its sentinel value does not appear

  Scenario: An off-screen NPC-to-NPC event stays hidden until surfaced
    Given an off-screen NPC-to-NPC event whose witness set excludes the player
    When any player-facing log or journal projection is produced
    Then that event does not appear
    And it remains hidden until an in-game pathway surfaces it

  Scenario: A twist held in reserve is not disclosed before it occurs
    Given a twist held in the Vault that has not yet occurred in-game
    When the engine produces any player-facing or admin-facing output
    Then the twist is neither referenced, confirmed, nor denied
    And its sentinel value does not appear

  # --- Summaries and direct interrogation ---

  Scenario: An end-of-session summary reveals nothing about the Vault
    When the engine emits an end-of-session summary
    Then it confirms only that updated save(s) exist
    And it does not describe what changed, enumerate Vault sections, or include any sentinel value

  Scenario: Direct player questions cannot extract Vault content
    Given the player directly asks whether a specific hidden fact is true
    When the engine responds
    Then the response contains no Vault sentinel value
    And it neither confirms nor denies the existence of specific Vault content

  Scenario: Competition results are delivered as outcomes, not stat disclosures
    When a competition result is delivered to the player
    Then the result is stated as an outcome
    And no houseguest stat score, rating, or relative ranking is revealed

  # --- Structural guarantee: outward surfaces CANNOT read the Vault ---

  Scenario: The narration context is assembled without any Vault data
    Given the engine assembles the context handed to the narrative layer for a player-facing moment
    Then that context contains no Vault sentinel value
    # Nothing can be "uniquely derived" from Vault content the narrator never receives.

  # PAT-2 positive control: the live-game sweep used by the Vault-leak scenarios can actually FAIL.
  # (Whole-season proof: tests/property/liveSentinel.property.test.ts.)
  Scenario: The live-game sweep detects a planted leak
    Given a live game with Vault sentinels planted in its hidden state
    When a sentinel is deliberately leaked onto the live game's player surface
    Then the live-game sweep detects the leak

  Scenario Outline: Outward-facing channels have no capability to read the Vault
    Given the tools available in the "<channel>" channel
    Then none of them can read from the VaultStore
    And no "<channel>"-facing adapter depends on the VaultStore port

    Examples:
      | channel        |
      | player         |
      | admin/God Mode |

  # --- Guard against over-blocking: the boundary is provenance, not blanket censorship ---

  Scenario: A fact legitimately surfaced to the player is not blocked
    Given a hidden fact that has been surfaced to the player through an in-game pathway
    And that fact now lives in the player's knowledge state
    When a player-facing surface renders it
    Then it may appear
    And it is sourced from the player's knowledge state, not from the Vault
