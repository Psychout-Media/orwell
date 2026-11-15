# spec-only: this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
# Design contract — BUILT (PRs #717, #741) and shipped DEFAULT ACTIVE since the owner ruling 2026-07-13; verified by FE tests, NOT wired into cucumber.cjs. (Header corrected 2026-11-12, ORW-286 item 8: it said "drafted failing-first, not yet implemented".)
# Feature 0079 — Runtime loop overseer & diagnostic log (diagnose-and-unstick; wide eyes, small hands).
# HARD rule: roles only (player, NPC, HOH, nominee, admin). No houseguest/player names. "the overseer"
# is the reasoning supervisor of the engine<->LLM loop; its inputs and its log are Vault-free BY
# CONSTRUCTION. Seeded fixtures only; a deterministic stub stands in for the model in these scenarios.

Feature: Runtime loop overseer & diagnostic log

  The engine<->LLM loop is supervised by a reasoning overseer that is summoned ONLY when a cheap,
  sparse symptom-gate trips (never every turn). On wake it reads only Vault-free telemetry, diagnoses
  the root cause, and applies the one matching fix from a small, fixed, mandate-safe toolbox — or
  surfaces and backs off when the fix is outside that toolbox. Every wake is written to a Vault-free
  diagnostic log that is live in the admin panel. Wide eyes, small hands; the deterministic floor
  (integrity checkpoint, sync spine) is never overridden.

  Scenario: A healthy turn does not wake the overseer (sparse trigger — breadth is not frequency)
    Given a started game on an ordinary in-character turn
    And the player's scene was recorded, the beat sequence advanced, and no error occurred
    When the turn completes
    Then no symptom trips the gate
    And the overseer is not summoned
    And no overseer model call is made and no diagnostic log line is written

  Scenario: A symptom wakes the overseer, which diagnoses an under-call and unsticks it
    Given a started game sitting in an advance-phase while play has gone quiet
    And the narration model did not call advanceGame
    When the symptom trips the gate
    Then the overseer is summoned and reads only Vault-free telemetry
    And it diagnoses a model under-call as the root cause
    And it applies the advance lever, triggering the deterministic advance without authoring its content
    And it writes one "action" entry to its diagnostic log

  Scenario: Same symptom, different root cause, different fix (the wide-eyes value)
    Given a started game sitting in an advance-phase
    But the player is legitimately mid-scene rather than stalled
    When the symptom trips the gate and the overseer is summoned
    Then it diagnoses that no advance is warranted
    And it holds, taking no action
    And it writes one "observation" entry recording why it held

  Scenario: A missed social fold is repaired with the constrained record lever
    Given a started game where an engaged player and NPC scene recorded nothing
    When the symptom trips the gate and the overseer is summoned
    Then it diagnoses a skipped recordInteraction
    And it proposes a constrained record so the social play folds its hidden impact
    But the engine still owns the magnitude and no raw relationship number crosses

  Scenario: An out-of-toolbox problem is surfaced, never forced (small hands stay small)
    Given a started game where the overseer cannot unstick the situation with any lever it holds
    When the overseer is summoned and completes its diagnosis
    Then it does not author narration, decide an outcome, or read the Vault
    And it surfaces the problem to the diagnostic log and to God-Mode health and backs off
    And it writes one "escalation" entry rather than reaching for a bigger lever

  Scenario: The overseer never overrides the deterministic floor
    Given a started game whose commit the integrity checkpoint refuses (would degrade or leak)
    When the overseer is summoned for the resulting symptom
    Then it cannot persist, advance past, or override the refused commit
    And the prior persisted save is left intact

  Scenario: The diagnostic log is live in the admin panel and Vault-free
    Given the overseer has acted across several turns of a game whose Vault holds hidden scheming
    When an admin tails the "Overseer (live)" log source
    Then it returns the overseer's reads, diagnoses, levers, and outcomes as a live stream
    And it returns no Vault data and no other user's content
    And the player has no access to the overseer log

  Scenario: Fail-soft — with the overseer unavailable the deterministic floor stands unchanged
    Given two games started from the same seed
    When the same turns are applied to one with the overseer available and one with it unavailable
    Then both reach identical state
    And the game with no overseer still progresses on the existing heuristics and the deterministic floor
