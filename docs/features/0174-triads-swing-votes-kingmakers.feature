# Feature 0174 - triads, swing votes, kingmakers (Theme 3 slice 13; Theme 3 Slice Plan, owner B). BUILT behind ORWELL_TRIADS (default ON).
# Design note: 0174-triads-swing-votes-kingmakers.md. Rests on the owner's 2026-11-16 Theme 3 ruling, Q1 (engine decides, narrator voices) and the belief-centred
# decisions ruling (2026-11-03: votes come from what each NPC believes). A swing houseguest KNOWS they decide it, as a read the engine holds; the player never
# sees a vote count, a price or a swing marker. Vault Wall: the swing read and its price are Vault content until the post-season retrospective. Roles only.

Feature: Balanced triads pull friends together, and a deciding vote is courted

  Scenario: The enemy of my enemy grows warmer
    Given a triads season where two houseguests share an enemy
    Then triads: they grow warmer toward each other, across seeds

  Scenario: Two friends of one person drift toward each other
    Given a triads season where a houseguest is close to two others who barely know each other
    Then triads: the two others grow closer over time

  Scenario: An unbalanced triad strains the center's bond to one side
    Given a triads season where a houseguest is close to two others who are enemies of each other
    Then triads: the bond to the one they like less strains while the closer one holds

  Scenario: A kingmaker is courted and the price rises with the rivals
    Given a triads season where one houseguest's vote decides an eviction
    Then triads: both camps pitch them, and the price is higher with a rival bidder than without

  Scenario: A swing houseguest knows it
    Given a triads season where one houseguest's vote decides an eviction
    Then triads: that houseguest holds the read that they decide it, and their read of each pitcher moved

  Scenario: The player is courted as a swing vote and their ballot is never touched
    Given a triads season where the player's own vote could decide an eviction
    Then triads: the camps pitch the player and one stands as an offer they may decline, and no ballot is set for them

  Scenario: The player's own conduct and standing move the triads
    Given a triads season where two houseguests both hold the player as an enemy, and two others hold the player as a friend
    Then triads: the first two grow warmer toward each other and so do the others

  Scenario: The deciding ballot is recorded as the kingmaker and only the retrospective unseals it
    Given a triads season where a close eviction was courted and decided
    Then triads: the deciding ballot is the kingmaker, history only, and it unseals in the retrospective

  Scenario: Nothing about swings or triads reaches the player as a number
    Given a triads season where a swing houseguest is courted by both sides
    Then triads: no player or admin view shows a courted flag, a price, a swing marker or a triad
    And triads: the player may overhear a pitch only when it is made to them

  Scenario: The same seed gives the same swings, and the flag off changes nothing
    Given a triads season played twice from the same seed
    Then triads: both runs hold the same drift, pitches and kingmaker in the same order
    And triads: with the flag off nothing moves and nothing is kept

  Scenario: Triad drift and swing history survive a save and a load whole
    Given a triads season where a swing vote was courted and cast
    When triads: the season is saved and loaded into a fresh session
    Then triads: the loaded session holds the swing history and the drifted bonds the saved one held
