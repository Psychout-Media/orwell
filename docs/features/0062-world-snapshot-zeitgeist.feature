Feature: 0062 — Move-in zeitgeist snapshot (a frozen, shared world the whole cast moved in with)
  At season creation the cast collectively receives ONE snapshot of the real-world zeitgeist as of
  move-in (seeded from a real web search with a ~7-day lag), persisted byte-stable and FROZEN. It is
  recalled all season, colors BOTH the player's scenes AND off-screen NPC life, grows stale as the
  weeks pass (the played "out of the loop" texture), and is FLAVOR ONLY — it never perturbs a single
  game outcome (a third state category: public, shared, real-world context — never Vault, never game
  truth). Fail-soft with no provider. Roles only — no names.

  # §3 / §10 — seeded, persisted, frozen byte-stable
  Scenario: the world snapshot is captured once at season creation and frozen
    Given a season started with seed "0062-1" and a world snapshot captured at move-in
    Then the world snapshot carries a frozen move-in date
    And the world snapshot survives snapshot and restore byte-identical
    And the world snapshot never regenerates while the season runs

  # §6 / §10 — the headline guard: FLAVOR ONLY, never game truth
  Scenario: the world snapshot never perturbs any game outcome
    Given a season started with seed "0062-2" with a world snapshot present
    And the same season started with seed "0062-2" with no world snapshot
    When both seasons are advanced through a competition, a nomination, and an eviction vote
    Then the competition results are byte-identical between the two seasons
    And the eviction votes are byte-identical between the two seasons
    And the relationship and soul folds are byte-identical between the two seasons

  # §5 — reach channel one: the player's moment prompt
  Scenario: the snapshot colors a player moment prompt
    Given a season started with seed "0062-3" with a world snapshot present
    When a player moment prompt is built
    Then the moment prompt carries the world the cast moved in with
    And the moment prompt states the world is frozen as of the move-in date

  # §5 — reach channel two: off-screen NPC-to-NPC life (the C32-beyond delta)
  Scenario: the snapshot colors an off-screen society and gossip prompt
    Given a season started with seed "0062-4" with a world snapshot present
    When an off-screen society prompt is built for an NPC-to-NPC scene
    Then the off-screen prompt carries the world the cast moved in with

  # §4 — per-NPC interest filtering (shared baseline, individual color)
  Scenario: two houseguests draw on different slices of the same shared snapshot
    Given a season started with seed "0062-5" with a world snapshot present
    And two active houseguests with different personas
    Then each houseguest is handed a different slice emphasis of the same world snapshot
    And the world snapshot itself remains one byte-stable artifact

  # §7 — the played freeze-drift: increasingly out of the loop
  Scenario: the prompt carries the freeze and the elapsed time so the cast grows dated
    Given a season started with seed "0062-6" with a world snapshot present
    When the season has run several weeks since move-in
    Then the moment prompt carries the elapsed in-house duration
    And the moment prompt instructs that anything after the move-in date is unknowable to the house

  # §8 / §9 — fail-soft: no provider, never break
  Scenario: with no search provider the game runs unchanged
    Given a season started with seed "0062-7" and no search provider configured
    Then the world snapshot is seeded from framed knowledge
    And an absent world snapshot round-trips as absent
    And the season advances unchanged with no world snapshot present
