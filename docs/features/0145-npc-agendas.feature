# ORW-253 slice 1 - NPC agendas: lasting goals (theme 1, NPC minds; design approved by Ryne 2026-11-12).
# Status: BUILT and BDD-wired (ORW-312): the pure core (src/engine/agenda.ts, tests/unit/agenda.test.ts) is carried on the live season; steps drive a real played season (features/step_definitions/npc_agendas.steps.ts). Roles only.

Feature: Every houseguest holds a lasting agenda of their own

  Background:
    Given a season has started with a full cast

  Scenario: Every houseguest starts with a season aim that comes from their character
    Then every houseguest other than the player holds one main season aim
    And a competitor's aim is to win competitions and a schemer's aim is to run the house
    And every goal names the real reason it exists

  Scenario: Different characters want different things
    Then the cast holds at least four different season aims

  Scenario: A secret worth protecting is a real goal
    Given a houseguest carries a secret or a hidden tie from before the show
    Then keeping that secret is one of their season goals
    And a houseguest with no secret holds no such goal

  Scenario: A strong threat read becomes a target, tied to that read
    Given a houseguest sees another houseguest as a big threat
    Then one of their goals this week is to get that houseguest out
    And the goal's reason points at that threat read
    And the goal counts as done only when that houseguest is evicted

  Scenario: The HOH is never this week's target
    Given the houseguest a holder fears most is the HOH
    Then the holder does not aim to evict the HOH this week

  Scenario: Being nominated puts staying safe first
    When a houseguest is nominated
    Then staying safe becomes their strongest goal this week, tied to the nomination

  Scenario: A mood swing does not change who someone is after
    Given a houseguest is after a target
    When their mood swings but nothing else changes
    Then they are still after the same target

  Scenario: Stubborn houseguests hold on, flexible ones switch
    Given two houseguests are each after three targets
    When a slightly bigger threat appears
    Then the stubborn one keeps their targets and the flexible one switches, and the dropped goal is kept as replaced

  Scenario: A goal is achieved and remembered
    Given a houseguest is after a target
    When that target is evicted
    Then the goal is marked achieved and kept in the houseguest's history

  Scenario: An unmet goal fails at week's end and the grudge carries over
    Given a houseguest was after a target who survived the week
    When the week closes
    Then that goal is marked failed
    And next week they are after the same target, a little harder, with the carry-over as a reason

  Scenario: A deep betrayal becomes revenge
    When a houseguest is badly betrayed by another
    Then getting revenge on the betrayer becomes a season-long goal, tied to the memory of the betrayal

  Scenario: An exposed secret fails the goal of keeping it
    Given a houseguest is keeping a secret
    When the secret is exposed
    Then that goal is marked failed

  Scenario: An evicted houseguest's goals end with them and are kept
    When a houseguest is evicted
    Then they hold no active goals and every goal they held is in their history

  Scenario: Nothing is ever lost
    When a season is played week after week and saved and reloaded
    Then every houseguest's goal history only grows and reloads identical

  Scenario: Overnight, an unprogressed goal fades, faster for a flexible houseguest
    When a houseguest sleeps without having made progress on a goal
    Then their commitment to it fades, more for a flexible houseguest than a stubborn one
    And a goal they give up on is kept in their history as dropped
    But keeping a secret is never given up

  Scenario: Long cons are only for strategic types
    Then only masterminds, villains, analysts or strategic players ever start a long con, and not every one of them does
    And a long con succeeds only if the mark leaves after the jury starts

  Scenario: The agenda is secret and deterministic
    Then the same season gives the same agendas
    And no agenda reaches the player, the narrator or the admin view

  # ORW-314 (slice 2 wiring): goals drive the decisions at full strength and the narrator voices only the stated reason.
  Scenario: A revenge goal moves the nomination off the top threat read
    Then an HOH holding a revenge goal on a houseguest who is not their top threat nominates that houseguest, and does not once the goal is zeroed

  Scenario: A long con keeps the mark off the block before the jury and nominates them after it starts
    Then a long-con holder leaves the mark off the block before the jury and nominates them once the jury has started

  Scenario: The narrator voices the stated reason and nothing behind it
    Then the nominations prompt carries the decider's stated reason and never the goal, the terms or the candor
