# Feature 0175 - the bond record (Theme 3 Core 1, ORW-552; Ryne approved the Theme 3 plan 2026-11-17).
# Design note: 0175-the-bond-record.md. Read API: src/engine/bonds.ts (posted on ORW-552); record and folds: src/engine/bondRecord.ts.
# One directed, lopsided bond per pair, beyond today's trust and affinity: felt warmth, debts, a grudge, strain and its repair, shared history, a commitment
# and a kind, and each houseguest's private pecking order. The engine folds it from what happened (scenes, deals kept and broken, a veto save), never from
# narration. Engine-only: never a number, a label or a roster to the player. Nothing decides from it yet (later slices do), so it moves no outcome.
# Flag ORWELL_BOND_RECORD (default ON; =0 = the edge-only bond read). Roles only.

Feature: The bond record

  Scenario: Shared warm scenes make a friendship, and a final two makes a commitment
    Given a played season with the bond record on
    When two houseguests share several warm scenes and make a final two
    Then each holds the other as a friend, with a final-two commitment
    And the bond between them is stronger than before

  Scenario: A clash leaves a grudge and strain; the nights repair the strain, and the grudge is remembered
    Given a played season with the bond record on
    When two houseguests clash twice
    Then each holds a grudge and strain toward the other
    When several nights pass with no new clash
    Then the strain has eased more than the grudge, and the worst of the grudge is still remembered

  Scenario: A broken deal is lopsided, and the wronged side feels it only once they learn of it
    Given a played season with the bond record on
    When one houseguest quietly breaks a deal with another
    Then the one wronged holds no grudge yet, because they do not know
    When the breaker then nominates them
    Then the one wronged holds a grudge toward the breaker
    And the breaker holds no grudge, only strain

  Scenario: A veto save leaves a debt
    Given a played season with the bond record on
    When the veto holder saves a nominee
    Then the saved houseguest owes the veto holder

  Scenario: The record survives a save and a restore, and nothing reaches the player or admin
    Given a played season with the bond record on
    When two houseguests share several warm scenes and make a final two
    Then the bond record survives a save and a restore unchanged
    And no player or admin view carries the bond record

  Scenario: Each houseguest keeps a private pecking order
    Given a played season with the bond record on
    When two houseguests share several warm scenes and make a final two
    Then each houseguest's private pecking order follows how close they are, the closest first, and ranks only their top few
