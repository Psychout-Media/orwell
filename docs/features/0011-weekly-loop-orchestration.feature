# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0011 — Weekly loop orchestration (the gameplay spine). Pure domain core.
# HARD rule: roles only. Binds 0005 (legality), 0006 (outcomes), 0008 (cadence), decision 0002.

Feature: Weekly loop orchestration — the playable week and season

  A week (one HOH reign) runs HOH competition -> nominations -> veto competition -> veto
  ceremony -> eviction vote -> live eviction, then repeats; the season runs down to Final 2
  and a jury vote decides the winner. The loop is pure, seed-deterministic state.

  Scenario: A seeded season runs from premiere to a single winner
    Given a new game of sixteen houseguests with a fixed seed
    When the season is played to completion
    Then it ends at a Final 2 followed by a jury vote
    And exactly one houseguest is declared the winner
    And replaying with the same seed yields the identical season

  Scenario: Each week follows the canonical phase order
    Given a week begins with an HOH competition
    Then it proceeds nominations, veto competition, veto ceremony, eviction vote, live eviction

  Scenario: The loop enforces the per-week legality rules
    Given an HOH, two nominees, and a veto holder for the week
    When the veto is used and the HOH names a replacement
    Then the replacement is not the veto winner
    And at eviction everyone except the HOH and the two nominees votes
    And the HOH votes only to break a tie

  Scenario: The jury is the last nine evictees
    When the season reaches Final 2
    Then the jury is composed of the last nine evicted houseguests
    And the earlier evictees are pre-jury

  Scenario: The endgame produces a winner by jury vote, with a last-juror tie-break
    Given a Final 2 and a jury
    When the jury votes
    Then the finalist with the most votes wins
    And a tied jury vote is broken by the last-evicted juror

  # BDD AMEND (Ryne): an NPC HOH decides from ITS OWN perspective and always tries to benefit itself —
  # never random, never the player's wishes. This scenario drives the live logic (`nominationStrategy`,
  # `voteChoice`) on a quiet house (no deals or campaigns) and proves the outcome is a function of the NPC's
  # own reads by swapping them across 20 seeds. Later features keep their own tests (0044 tactics and the
  # HOH-referendum term, 0043/0107 blocs, 0039 deals, 0085 campaigns, 0086 drives).
  Scenario: An NPC's nominations and votes come from its own read of the house and serve its own interests
    Given an NPC holds power at a decision point
    When it nominates and votes across many seeded runs
    Then its nominations follow its own reads of the house, not chance
    And a bloc-mate is not named while an alternative exists
    And its eviction vote goes to the nominee it reads as the bigger threat

  Scenario: A player decision point is surfaced and validated
    Given the player holds power at a decision point
    Then the loop surfaces the pending decision and its legal options
    And it rejects any choice that violates an eligibility rule
