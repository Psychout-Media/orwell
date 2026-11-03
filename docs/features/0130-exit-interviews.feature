# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted spec-only 2026-07-13,
# built 2026-07-13.) Feature 0130 — Exit interviews: expands 0047. Every staged eviction ends with the
# producers' exit interview — the evictee's posture leaving (NPC: derived from manner; player: their own
# pending decision), recorded for the 0048 retrospective. Inert to the seeded spine. HARD rule: roles only
# (evictee, producer, player, juror).

Feature: Exit interviews (the producer's eviction-night sit-down)

  Every staged eviction ends with the evictee interviewed by the producers: they react to how they went out
  and tell their side. For an NPC the posture is grounded in the manner of their eviction; for the player it
  is their own say. Each interview is recorded and resurfaces in the season-end retrospective. Nothing hidden
  crosses the wall, and the beat never moves a seeded outcome.

  Scenario: An NPC's exit posture is grounded in the manner, not invented
    Given an evictee who was betrayed on the way out
    And an evictee who was cleanly, respectfully evicted
    When each gives their exit interview
    Then the betrayed evictee leaves bitter
    And the respectfully evicted one leaves gracious

  Scenario: Every staged eviction is interviewed and resurfaces in the retrospective
    Given a seeded season played to completion
    When the season-end retrospective is read
    Then every staged eviction has a recorded exit interview
    And each is a first-person account with a legal posture

  Scenario: The player's exit interview is their own decision
    Given a seeded season in which the player is evicted through the staged path
    When the exit interview reaches the player
    Then the loop pauses for the player's own answer
    And nothing is recorded for the player until they answer
    And the player's chosen posture and words are recorded

  Scenario: An illegal exit posture is refused
    Given the player at their exit interview
    When they submit a posture that is not offered
    Then the decision is refused

  Scenario: The exit interview leaks nothing hidden
    Given a seeded season played to completion
    When the exit-interview stages and the retrospective reel are read
    Then no hidden stat, score, or sealed state appears anywhere in them

  # Renamed 2026-11-03 (BDD audit AMEND 0130): this scenario proves the seeded spine is DETERMINISTIC and PINNED, not that the
  # beat is inert. The inertness claim - the exit-interview beat draws no rng, is clock-free, and replays the pre-0130 eviction
  # order byte-for-byte under ORWELL_FLAGS_OFF=1 - rests on tests/unit/exitInterview.test.ts ("is an INERT beat",
  # "byte-identical spine"). The seed-108 order pinned below is RE-ANCHORED on every owner-approved balance change.
  Scenario: The seeded eviction order is deterministic and pinned
    Given the same seed played to completion twice
    Then the eviction order is identical both times
    And it matches the approved seeded trajectory anchor

  # Added 2026-11-03 (BDD audit AMEND 0130): a restart while the player sits at their exit interview resumes at the same
  # interview and the night still completes (0030). Real seeded game, real pending, the registry snapshot/restore door.
  Scenario: A restart mid-interview keeps the same exit interview waiting
    Given the player evicted and facing their exit interview
    When the engine restarts at the exit interview
    Then the same exit interview is waiting with the same options
    And answering it completes the night
