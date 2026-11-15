# Feature 0066 — In-game time of day & the nightly sleep economy (ADR 0006), the 24-HOUR model (#1125).
# Roles only (no houseguest names). A day is 24 hours from the 8am forced wake: morning(8–12) ·
# afternoon(12–16) · evening(16–20) · night(20–24) · late-night(24–32, the 8h block to the next 8am).
# Sleep is symmetric (8h need; all force-woken at 8am); the player owns their bedtime. The Phase-2
# extensions (per-conversation clock advance · NPC next-day social fatigue · the compounding multi-night
# meter) each sit behind their OWN opt-in flag, default OFF, byte-identical to the calibration spine when
# off. Exercised end-to-end through the live adapter + the opt-in flags.

Feature: In-game time of day and the nightly sleep economy
  As the simulation
  I want a finite 24-hour day where managing sleep against late-night scheming is real
  So that the house feels finite and staying up late before a competition has a cost

  Background:
    Given the in-game clock is enabled

  # --- The 24-hour clock & the five periods -------------------------------------------------------

  Scenario: The day runs forward by play through the five periods, not a wall clock
    Given a live season
    When the house plays through the day
    Then the time of day advances through morning, afternoon, evening, night, and late-night
    And the time of day is surfaced as a public, Vault-free read

  Scenario: A new day begins only at the 8am forced wake; the clock never silently wraps
    Given a live season
    Then the day spans the 8am wake to the next 8am
    And the late-night block runs from midnight to the morning wake

  # --- Symmetric sleep, wake, and the graded debt -------------------------------------------------

  Scenario Outline: Bedtime against the 8am wake decides the sleep debt
    Given a houseguest who goes to bed at <bedtime>
    Then their sleep debt is <debt> hours
    And their own rest cue reads <cue>

    Examples:
      | bedtime      | debt | cue              |
      | 10pm         | 0    | rested           |
      | midnight     | 0    | rested           |
      | 2am          | 2    | tired            |
      | the 8am wake | 8    | running on empty |

  Scenario: An early-to-bed houseguest wakes in the pre-dawn window for free
    Given a houseguest who goes to bed before midnight
    Then they sleep their full need and wake before the 8am forced wake
    And they carry no sleep debt
    And they gain bonus awake time in the pre-dawn window

  Scenario: The awake set shrinks toward midnight then grows toward the morning wake
    Given it is late at night
    Then the awake set is a strict subset of the house — some have turned in
    And the bidirectional ramp holds — pre-dawn risers wake while post-midnight owls stay asleep
    And the two late-night windows are distinct — costly owls versus free early risers

  Scenario: Staying up late costs competition performance — graded, symmetric, never protective
    Given two equally skilled houseguests
    And one of them stayed up past midnight and the other was rested
    When they compete many times
    Then the rested houseguest wins a clear majority
    And a tired favorite can still lose a competition they would otherwise win
    And the sleep penalty is applied to every competitor by the same math
    And the player is never special-cased

  Scenario: The player chooses their own bedtime; the house never sends them to bed
    Given the player is up late
    When the player turns in
    Then the house rolls to the next morning
    And an early night leaves the player rested for tomorrow
    And the player is never auto-slept

  Scenario: The Vault Wall holds — only the player's own tiredness is visible
    Then the player sees their own qualitative rest cue, never a number
    And no houseguest's sleep, bedtime, or rest deficit is ever exposed

  Scenario: Dormant by default keeps the calibration spine byte-identical
    Given the in-game clock is disabled
    When the house plays through the day
    Then no time of day or rest cue is surfaced
    # Calibration neutrality of the clock-off spine is gated by tests/unit/nightGateNeutral.test.ts (master clock OFF,
    # flag ON vs OFF, outcome hashes compared); the former line compared a clock-off run to another clock-off run.

  # --- The weekly 5-cycle cadence + period placement ----------------------------------------------

  Scenario: The week is one HOH reign in strict order with no default rest days
    Then the week runs HOH, nominations, veto competition, veto ceremony, eviction in strict order
    And every day of the week carries a meaningful beat
    And the HOH crowns in the morning, maximizing the post-HOH playable window
    And the veto competition runs in the afternoon
    And the eviction runs in the evening
    And the next HOH begins the morning after the eviction, not eviction night

  # --- Event durations + seeded start-within-period + spillover -----------------------------------

  Scenario: Timed beats have durations, seeded starts within their period, and may spill over
    Then a competition runs about three hours, a ceremony about one, an eviction about two
    And a beat starts at a seeded time within its period, not pinned to the edge
    And a long beat may spill into the next period
    And competitions vary in length by type

  # --- An engaged scene is never cut by the clock (the kind-billed conversation-duration helpers were deleted, ORW-68; the clock bills per message) ---

  Scenario: An engaged conversation is never cut short by the clock
    Given the per-conversation clock advance is enabled
    Then an engaged scene is never cut short by the clock

  # --- Phase-2 extensions — each behind its OWN opt-in flag, byte-identical when off ---------------

  Scenario: Per-conversation clock advance — the day's finite time is felt turn-by-turn
    Given the per-conversation clock advance is enabled
    And a live season
    When the player lingers and plays within a beat
    Then the time of day presses forward as the player plays
    But lingering never wraps the night past the player's own bedtime choice

  Scenario: NPC next-day social fatigue — a tired houseguest sways the house less
    Given NPC next-day social fatigue is enabled
    Then a rested houseguest moves another's read at full strength
    And a tired houseguest moves it less, but never to nothing

  Scenario: A compounding multi-night fatigue meter wears a night owl down over a week
    Given the compounding multi-night fatigue meter is enabled
    Then consecutive late nights stack a deeper deficit than a single one
    And a rested night recovers part of the accumulated fatigue
    And the meter stays bounded and is never shown to the player

  # The Phase-2 "byte-identical to the calibration spine when off" claims (per-conversation clock, NPC social fatigue, the
  # multi-night fatigue meter) are gated by a real flag ON-vs-OFF outcome-hash compare in:
  #   tests/unit/perConversationClockNeutral.test.ts · tests/unit/socialFatigueNeutral.test.ts · tests/unit/multiNightFatigueNeutral.test.ts
