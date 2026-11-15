# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0012 — Conversation & scene system. Interaction model: hybrid (free-text social,
# explicit validated decisions). HARD rule: roles only. Extends 0001/0002 guarantees.

Feature: Conversation & scene system — the player's social game

  The player plays the social game in free-text; the LLM voices NPCs and narrates; NPCs also
  initiate. The engine owns ground truth. Binding decisions are explicit, validated prompts.
  Everything is Vault-free and runs over the MCP boundary.

  Background:
    Given a running game sandbox with a fully populated Producer's Vault

  Scenario: A player-initiated scene is recorded as the player's knowledge
    When the player approaches a houseguest and speaks with them
    Then the scene is recorded as an event whose witness set includes the player
    And it is part of the player's knowledge, not the Vault

  Scenario: NPCs initiate scenes too (bidirectional)
    Given a stretch of game time
    Then some scenes are initiated by houseguests approaching the player
    And which houseguest approaches reflects their agenda and relationships, not chance

  Scenario: A social read is honest and Vault-free
    When the player asks for the energy in the room or a read on a houseguest
    Then an honest, character-appropriate read is returned
    And it contains no Vault sentinel value
    And it may hint at off-screen shifts without naming any off-screen event

  Scenario: An NPC never voices a fact it has no pathway to know
    Given a hidden fact a houseguest neither witnessed nor was told
    When that houseguest speaks with the player
    Then its dialogue never asserts that fact
    And at most it expresses suspicion, never knowledge

  Scenario: Binding decisions are explicit and validated, not parsed from prose
    Given the player holds power at a decision point
    When the player lobbies houseguests in free-text
    Then the binding choice is not changed by that conversation
    And the choice is made only via an explicit prompt over the legal options
    And an illegal choice is rejected with a reason

  Scenario: Scene fidelity is player-directed
    When the player requests a compressed beat or a full scene
    Then the narration is rendered at that fidelity
    And the underlying ground truth is unchanged

  Scenario Outline: No player-facing conversation output contains Vault content
    When the engine produces "<surface>" for the player
    Then it contains no Vault sentinel value

    Examples:
      | surface       |
      | scene         |
      | NPC dialogue  |
      | social read   |

  # ORW-423 (#2736) + ORW-443 (#2769): the same-purpose approach cap. In a played game with the desire clock on, after two approaches of
  # one purpose in a stretch the next one of that purpose waits (two quiet in-game hours, or a different purpose, release it), and the
  # game state tells the narrator for that one message that an approach was held back. A game nobody is playing is unaffected. No rng.

  Scenario: After two same-purpose approaches the next one is held back and the narrator is told
    Given a played game with the desire clock on, stepped message by message until the approach cap holds a houseguest back
    Then the two approaches just before it in that stretch were for the same purpose
    And no houseguest cuts into the conversation on that message
    And the game state tells the narrator an approach was held back

  Scenario: The held-back signal lasts for that one message only
    Given a played game with the desire clock on, stepped message by message until the approach cap holds a houseguest back
    When the player keeps talking until a message on which nothing is held back
    Then the game state no longer carries the held-back signal

  Scenario: Two quiet in-game hours release the cap
    Given a played game with the desire clock on, stepped message by message until the approach cap holds a houseguest back
    When that same message is replayed as though the last approach came two quiet in-game hours earlier
    Then the held houseguest now cuts into the conversation for that purpose
    And the game state carries no held-back signal

  Scenario: A different purpose is not held back by the cap
    Given a played game with the desire clock on, stepped message by message until the approach cap holds a houseguest back
    When that same message is replayed as though the stretch so far had been a different purpose
    Then the held houseguest now cuts into the conversation for that purpose
    And the game state carries no held-back signal

  Scenario: A game nobody is playing is unaffected by the cap
    Given a played game with the desire clock on, stepped message by message until the approach cap holds a houseguest back
    When that same message is replayed in a game nobody is playing
    Then the held houseguest now cuts into the conversation for that purpose
    And the game state carries no held-back signal
    And the stretch is left untouched
