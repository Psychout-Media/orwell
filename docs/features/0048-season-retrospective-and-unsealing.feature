# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0048 — Season retrospective & the Vault unsealing. The Wall is ABSOLUTE during play; this is its
# one sanctioned, structurally-gated exception — post-season only. HARD rule: roles only (player, winner,
# evictee). Add to cucumber.cjs when green.

Feature: Season retrospective & the Vault unsealing

  While a season is live the Vault is sealed and no hidden state ever leaks. Once the season is over — a
  winner crowned — the player may open the Vault to see the real story they never could: the off-screen
  scheming, the confessionals, any twist that never fired, plus an arc recap built from the event record.
  Unsealing is impossible while a season is live, enforced in code, for that finished season only.

  Scenario: The Vault stays sealed while the season is live
    Given a live season whose Vault holds off-screen scheming and confessionals
    When the player requests the unsealed story before the season is over
    Then nothing hidden is returned
    And no Vault sentinel value appears on any surface

  Scenario: The Vault unseals only after a winner is crowned (legacy (flag off) twist path)
    Given a finished season with a crowned winner
    When the player triggers the season retrospective
    Then the unsealed hidden story is returned — off-screen scheming, confessionals, and any unfired twist

  Scenario: Unsealing is scoped to that finished season only
    Given one finished season and one live season for different users
    When each user triggers the retrospective
    Then only the finished season returns its hidden story
    And the live season returns nothing, and no other user's content appears

  Scenario: The recap is built from the event record, not narrator memory
    Given a finished season
    When the season recap is assembled
    Then its highlights come from the recorded events — HOH reigns, nominations, vetoes, evictions, deals
    And every highlight it lists is a recorded, non-hidden event in the stores

  Scenario: A finished season starts a new one cleanly
    Given a finished season
    When the player starts a new season
    Then the snapshot taken of the prior season before the reset still reads as finished, with its winner
    And a fresh game begins with one active game for that user
