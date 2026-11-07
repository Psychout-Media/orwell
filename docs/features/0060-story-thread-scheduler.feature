Feature: 0060 — Story-thread trigger/resolution scheduler (0058 Phase 2)
  The seeded, sealed story threads (0058 §5) finally PLAY OUT. A small, seeded, bounded scheduler
  rides the EXISTING off-screen tick and walks each thread's lifecycle — dormant → active (reusing
  the 0023 fold) → surfaced (reusing 0038 gossip + 0002 pathway surfacing) → resolved, or → expired
  (recorded, never deleted). It authors nothing; it only decides WHEN each transition fires. Restraint
  is structural: a hard season cap (~3–4) on surfaced threads, NPC↔NPC surfacing far more common than
  surfacing to the player, and what reaches the player is a belief with confidence — never a fact on a
  projection, never a premise, never a number. Roles only — no names.
  #
  # BUILT and wired into cucumber.cjs (AMEND 3a #6: this header used to say SPEC ONLY / not yet wired).

  # §10(a) — the lifecycle actually runs end to end over a seeded season
  Scenario: over a seeded multi-week sim a measurable share of threads activate and then resolve or expire
    Given a deep-profile season with seeded story threads at seed "0060-1"
    And the story-thread scheduler riding the off-screen tick
    When the season is simulated to completion
    Then a measurable share of the seeded threads reached the active status
    And a measurable share of the seeded threads reached a terminal status
    And every thread that activated folded a hidden weight into the relationship layer

  # §3 — structured triggers gate activation against live, Vault-free season position
  Scenario: a dormant thread activates only once its structured trigger condition is met
    Given a deep-profile season with seeded story threads at seed "0060-2"
    And a dormant thread whose trigger condition is not yet met by the house position
    When an off-screen tick runs
    Then that thread is still dormant
    When the house position comes to meet that thread's trigger condition
    And further off-screen ticks run
    Then that thread becomes active and folds its hidden weight

  # §4.2 / §7 — surfacing is a pathway BELIEF (gossip-drifted), never a premise on a projection
  # Re-selected 2026-11-07 (ORW-116: the clock now runs from the premiere entry and the night is the player's, which moved this fixed seed's path so the rare to-player surfacing no longer landed on 0060-3; 0060-1, -2, -4 and -5 all land - a seed pick, not a weakened assertion).
  Scenario: a surfaced thread reaches the player only as an anchored belief, never as a fact or a premise
    Given a deep-profile season with seeded story threads at seed "0060-1"
    When the season is simulated until a thread surfaces toward the player
    Then the player holds a belief about it with a source and a confidence
    And the thread's verbatim premise never appears on any player surface
    And no relationship number ever crosses to the player

  # §5 — restraint: NPC↔NPC surfacing dominates, surfacing to the player is rarer
  Scenario: most thread drama stays off-screen and the player catches only some
    Given a deep-profile season with seeded story threads at seed "0060-4"
    When the season is simulated to completion
    Then more threads surfaced between houseguests than surfaced to the player
    And some seeded threads never surfaced to anyone

  # §5(1) — the hard season surfacing cap holds (the L40 restraint guard)
  Scenario: the count of threads that ever surface never exceeds the season cap
    Given a deep-profile season with seeded story threads at seed "0060-5"
    When the season is simulated to completion
    Then the number of threads that ever reached the surfaced status is within the season surfacing cap
    And surplus ripe threads still activated and resolved without surfacing

  # §4.4 / §7 — non-degradation: an un-triggered thread expires, recorded, never deleted
  Scenario: a thread whose window passes expires and is retained, never deleted
    Given a deep-profile season with seeded story threads at seed "0060-6"
    When a thread's source is evicted before its trigger condition is ever met
    Then that thread reaches the expired status
    And that thread is still retained in the Vault at full fidelity

  # §10(c) — the §8 no-leak sentinel holds even AFTER a thread has surfaced
  Scenario: no thread premise or trigger reaches any outward surface even after surfacing
    Given a deep-profile season with seeded story threads at seed "0060-7"
    When a sentinel is planted in every thread premise, prose trigger, and structured trigger condition
    And the season is simulated until threads surface
    Then the planted sentinel never appears on any player surface
    And the planted sentinel never appears on the admin surface
    And the planted sentinel never appears in any houseguest's voicing projection
    And the planted sentinel never appears in the moment prompt

  # §10(d) — the lifecycle persists across an engine restart
  Scenario: a thread driven to active survives snapshot and restore still active
    Given a deep-profile season with seeded story threads at seed "0060-8"
    When the scheduler has driven a thread to the active status
    And the season is snapshotted and restored
    Then that thread is restored still active
    And the sealed hidden threads survive snapshot and restore at their statuses

  # §10(b) — per-seed divergence (the replayability claim)
  Scenario: two seasons with the same player but different seeds diverge in which threads play out
    Given a deep-profile season with seeded story threads at seed "0060-9a"
    And a second deep-profile season with the same player at seed "0060-9b"
    When both seasons are simulated to completion
    Then the two seasons differ in which threads activated, surfaced, and resolved

  # §4.5 — determinism: same seed + trigger sequence ⇒ identical thread drama
  Scenario: the scheduler is deterministic and never perturbs the main house stream
    Given two deep-profile seasons started identically at seed "0060-10"
    When both are simulated through the identical trigger sequence
    Then both produce the identical sequence of thread transitions
    And both casts' static stats and names remain byte-identical
