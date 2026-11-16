# spec-only: Theme 3 draft scenarios, not built and not wired into the BDD gate; they wait for the owner's approval of the Theme 3 plan (the vault "Theme 3 Slice Plan").
# Feature 0174 - triads, swing votes, kingmakers (Theme 3 slice 13; Theme 3 Slice Plan, owner B). SCENARIOS DRAFTED, NOT BUILT.
# Design note: 0174-triads-swing-votes-kingmakers.md. Rests on the owner's 2026-11-16 Theme 3 ruling, Q1 (engine decides, narrator voices) and the belief-centred
# decisions ruling (2026-11-03: votes come from what each NPC believes). A swing houseguest KNOWS they decide it, as a read the engine holds; the player never
# sees a vote count, a price or a swing marker. Vault Wall: the swing read and its price are Vault content until the post-season retrospective. Roles only.

Feature: Balanced triads pull friends together, and a deciding vote is courted

  Scenario: The enemy of my enemy grows warmer
    Given a triads season where two houseguests share an enemy
    Then they grow warmer toward each other, across seeds

  Scenario: Two friends of one person drift toward each other
    Given a triads season where a houseguest is close to two others who barely know each other
    Then the two others grow closer over time

  Scenario: A balanced triad is stable and an unbalanced one strains
    Given a triads season where two friends each hold the same third person as an enemy and as a friend
    Then the bond among the three strains until one side gives way

  Scenario: A kingmaker is courted
    Given a triads season where one houseguest's vote decides an eviction
    Then both sides pitch them, and their price rises

  Scenario: A swing houseguest knows it
    Given a triads season where one houseguest's vote decides an eviction
    Then that houseguest holds the read that they decide it, and weighs their answer accordingly

  Scenario: Nothing about swings or triads reaches the player as a number
    Given a triads season where a swing houseguest is courted by both sides
    Then no player or admin view shows a vote count, a price, a swing marker or a triad label
    And the player may overhear the pitches only as they would in the house

  Scenario: The same seed gives the same swings, and the mix stays balanced
    Given a triads season played twice from the same seed
    Then both runs hold the same swing reads and pitches in the same order
    And the nominee mix, the jury reach and the gradient are no worse than before

  Scenario: Triad drift and swing history survive a save and a load whole
    Given a triads season where a swing vote was courted and cast
    When the season is saved and loaded into a fresh session
    Then the loaded session holds the swing history and the drifted bonds the saved one held
