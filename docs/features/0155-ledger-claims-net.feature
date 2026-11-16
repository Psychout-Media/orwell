# Feature 0155 - the open ledger as the safety net (theme 2, slice 6; ORW-330).
# Design note: 0155-ledger-claims-net.md. Plan: the vault note "Theme 2 Slice Plan", slice 6. Builds on 0149 (claims), 0150, 0153.
# A claim the NARRATOR writes on its own (an NPC tells someone something the engine never decided) is caught by the open ledger
# (ORW-407) and handed to the engine: it becomes a claim with its speaker and listeners (origin "narrated"), the engine gives it a
# truth from its own records, and every listener holds it as a belief. So there is one record of "what was said", not two.
# Ryne's question 6 (the narrator's promises) is the seam; this slice covers claims about houseguests, not promises. Roles only.

Feature: The open ledger catches claims the narrator writes

  Scenario: A claim the narrator wrote becomes something the engine tracks
    Given a played season with the open ledger on
    When the narration has a houseguest tell the player and another houseguest that a third houseguest is targeting them
    Then the engine records the claim with its speaker and its listeners, as narrated
    And the houseguest who heard it holds it as a belief, sourced to the speaker
    And the player, who heard it too, is handed no belief
    And a houseguest who only overheard it holds it as said about the one it was told to, never about themself

  Scenario: The engine settles what it can check
    Given a played season with the open ledger on
    When the narration has a houseguest claim that another houseguest voted to evict a third
    Then the engine marks the claim true or false from its own record of the ballots
    And a false claim the speaker does not believe is recorded as a lie, a true one as passing on
    And no player or admin view shows that verdict

  Scenario: A ledger entry with no claim the engine understands changes nothing
    Given a played season with the open ledger on
    When the narration records a promise with no claim attached
    Then no claim is recorded and no belief changes

  Scenario: The narrator voicing a claim the engine already told does not record it twice
    Given a played season with the open ledger on
    When a houseguest's claim to the player was decided by the engine, and the narration then voices it
    Then the claim is recorded once, with the engine's truth

  # ORW-558 (2026-11-16 live sweep): "they've been talking about you" names no one it is about. It is about the person it was told to.
  Scenario: A rumor told without naming whom it is about is about the one it was told to
    Given a played season with the open ledger on
    When the narration has a houseguest tell another houseguest, in front of the player, that a third has been talking about them, without naming them
    Then the houseguest it was told to holds it as said about themself, sourced to the speaker
    And the player can ask who told them that, and the speaker is the one who said it
