# spec-only: 0208 (ORW-662 is Done) umbrella spec; its scenarios run as the slices: superseded by 0208-returning-houseguests.feature, 0208-your-reputation-walks-in.feature, 0208-the-hall-of-fame.feature
# Feature 0208 - seasons that remember (Ryne approved all three slices 2026-11-18). Design: 0208-seasons-that-remember.md. Roles only.

Feature: Seasons that remember

  Scenario: The player chooses to start new or return
    Given a player who has finished a season
    When they start a new season as a new houseguest
    Then no reputation and no returning houseguest follow them in
    When they instead return
    Then their reputation walks in with them, and a returner may be cast

  # B1: wired in 0208-returning-houseguests.feature (ORW-663)

  # B2 (executable now: 0208-your-reputation-walks-in.feature, 2026-11-18; this scenario stays as the design statement)
  Scenario: Last season's play shapes day-one reads, for those who know of it
    Given the player returns after breaking many deals last season
    Then houseguests who know of it start warier of the player than they would of a newcomer
    And houseguests who never heard of it read the player fresh

  # B3
  Scenario: Finished seasons are kept
    Given the player has finished two seasons
    Then both appear in the hall of fame with their result and a highlight
    And nothing in it was not already unsealed to the player at that season's end
