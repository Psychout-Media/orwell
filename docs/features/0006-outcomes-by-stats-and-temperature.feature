# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Build priority #6 — Outcomes by stats + temperature. Distribution-style over many seeds.
# HARD rule: roles only. Assert PROPERTIES, not specific numbers (temperature math is open).

Feature: Outcomes by stats and temperature — earned results, never story convenience

  Competition outcomes are weighted by the relevant stat versus the competition type, a
  per-moment temperature roll across all involved variables, and an emotional modifier sourced
  from the houseguest's soul (no Luck stat). Results are
  reproducible under a fixed seed. Temperature governs variance but never overrides hard
  rules or archetype-grounded weighting, and the engine never protects the player.

  Scenario: A moment rolls temperature across its involved variables, reproducibly
    Given a gameplay moment with multiple involved variables
    When the moment is resolved with a fixed seed
    Then a temperature roll is applied across those variables
    And resolving again with the same seed yields the identical outcome

  Scenario: Hard rules are never overridden by temperature
    Given any temperature roll
    Then eligibility rules and the Vault Wall still hold

  Scenario: Outcomes follow archetype and temperature, not narrative need
    Given an endurance competition and a houseguest whose profile does not support endurance
    When outcomes are computed across many seeded runs
    Then that houseguest's win rate reflects stats and temperature, not story convenience

  Scenario: The engine never protects the player
    Given the player competes in a competition type their stats do not favor
    When outcomes are computed across many seeded runs
    Then the player's win rate reflects their stats like any other houseguest

  Scenario: Stats usually win — upsets are real but uncommon
    Given a clear favorite by stats in a competition
    When outcomes are computed across many seeded runs
    Then the favorite wins the clear majority of runs
    And the favorite still loses a real minority of runs
    # Earned outcomes with marginal drama: variance from temperature + the soul emotional modifier (no Luck stat).

  Scenario: Player competition intent is honored and immutable
    Given the player declares an intent of compete, throw, or play safe before a competition
    When the outcome is computed
    Then the declared intent affects the computation
    And the intent cannot be changed after the result is given

  Scenario Outline: The temperature roll stays within configured bounds
    Given the game is simulated with seed "<seed>"
    Then every temperature roll falls within the configured bounds

    Examples:
      | seed |
      | 1    |
      | 2    |
      | 3    |

  # ── PO EXPANSION (2026-06-28, PO-REVIEW-LEDGER) — BUILT ─────────────────────────────
  # Both PO rulings shipped. These are property-style behaviors gated by the calibration/unit
  # suite (not Gherkin, which asserts properties not numbers) — the gate files are named below.
  #
  #  (1) UPSETS A TAD MORE COMMON — BUILT. temperature weight 0.36 → 0.40 in
  #      `temperatureConstants.ts` lowers a clear favorite from ~64% to ~59% average across field
  #      sizes, so raw comp stats are less dominant now that emotions (0041) + sleep (0066) add
  #      depth. A DELIBERATE calibration retune (not byte-identical) — the juryReach EARNED-WINS
  #      guard was re-verified green (playing the game still converts). Gate:
  #      `tests/unit/stagedCompetition.test.ts` (the ~50–70% favorite-win band).
  #
  #      Scenario: A clear favorite wins a majority, but upsets are common
  #        Given a clear favorite by stats in a competition
  #        When outcomes are computed across many seeded runs
  #        Then the favorite wins more often than not
  #        And the favorite loses often enough that upsets are a regular occurrence
  #
  #  (2) EVERY NPC CARRIES A COMPETITION INTENT — BUILT (default-ON `ORWELL_COMP_INTENT`;
  #      byte-identical when off). A nominee fights; a lay-low houseguest with a strongly-trusted
  #      ally in the field throws to hand them the power; a cautious houseguest a rival reads as a
  #      real threat plays safe; otherwise competes. The intent reaches the same seeded roll the
  #      player's does. Gate: `tests/unit/npcCompIntent.test.ts`.
  #
  #      NOTE (single-roll model kept — Path B declined): intent is declared ONCE, up front. The
  #      earlier idea of an NPC (or the player) CHANGING intent mid-comp per round was dropped —
  #      the comp is one calibrated roll, so a mid-comp change can't affect the result (see the
  #      "intent asked once" amendment). Per-round re-resolution would be a separate rebuild.
  #
  #      Scenario: Every competitor carries an intent, not just the player
  #        Given a competition with the player and NPCs competing
  #        Then each competing NPC holds an intent of compete, throw, or play safe
  #        And each NPC's intent affects their outcome computation like the player's
  # ────────────────────────────────────────────────────────────────────────────────────
