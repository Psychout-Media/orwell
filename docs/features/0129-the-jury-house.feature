# Feature 0129 — The jury house. Expands 0046 (juror seat) + pairs with its ceremonies-as-broadcast model.
# HARD rule: roles only (player, juror, finalist, active houseguest). SLICES 1-4 BUILT and wired into the BDD gate (cucumber.cjs;
# steps in features/step_definitions/jury_house.steps.ts): the roster projection, jurors voiced from their own knowledge, the
# askJuror lever, the informed juror-vote card (slice 4 is an ASSUMED default, pending Ryne). NOT BUILT (scenarios tagged
# @pending, skipped): jurors approaching the player, rolling updates as new evictees arrive, the broadcast of ceremony outcomes
# into a juror's view, jury gossip, and the roundtable. Spec authored 2026-07-13 during the 0046 PO review; wired ORW-385.

Feature: The jury house (living with the evicted)

  Once the player is a juror they are not alone watching a broadcast — the other evicted houseguests are in
  the jury house with them. The player can hear the season from each juror's point of view, ask them
  questions, and carry what they were told into their finale vote. A juror only ever knows what they
  witnessed before their own eviction and what they were told — never the live house's hidden scheming.

  # STATUS: BUILT (slice 1, the roster projection; tests/unit/juryHouse0129.test.ts)
  Scenario: The jury is a room the player can talk to
    Given the player has been evicted into the jury
    When the player is in the jury house
    Then the other jurors are present
    And the player can ask any juror a question

  # Unbuilt: jurors approaching the player on their own (0129.md section 9).
  @pending
  Scenario: Jurors approach the player
    Given the player has been evicted into the jury
    When a juror has fresh news or a pick to lobby for
    Then that juror approaches the player unprompted

  # STATUS: BUILT (slice 2, jurors voiced from their own knowledge; tests/unit/juryHouseVoice0129.test.ts)
  Scenario: Each juror tells the season from their own perspective
    Given two jurors who were evicted at different points
    And each juror holds a different belief about the same event
    When each recounts the season
    Then each account is bounded to what that juror actually witnessed or was told
    And their bearing toward the player reflects the manner of their eviction
    And the two jurors hold contradictory beliefs about the same event

  # STATUS: BUILT (slice 3, the askJuror lever; tests/unit/juryHouseVoice0129.test.ts)
  Scenario: The player can ask a juror questions and get grounded answers
    Given the player is in the jury house with a juror who regards them warmly
    When the player asks that juror a question
    Then the answer is something that juror holds, told to the player through that juror
    And it never draws on another juror's private knowledge or any hidden house state

  # STATUS: BUILT (slices 2-3, the juror's own knowledge scope + the 0001 canary; tests/unit/juryHouseVoice0129.test.ts)
  Scenario: A juror never knows the live house's hidden scheming
    Given the house schemes off-screen and records confessionals after a juror's eviction
    When that juror's shareable knowledge is derived
    Then it contains no off-screen scene and no confessional recorded after their eviction
    And no Vault sentinel value appears anywhere in the jury-house projection
    And no sealed ballot attribution appears in the juror's voice or in what they tell the player

  # Unbuilt: rolling updates as new evictees arrive, and the ceremony broadcast reaching a juror's view (0129.md section 9).
  @pending
  Scenario: The jury-house picture updates as new evictees arrive
    Given the player is a juror and another houseguest is then evicted
    When the new evictee joins the jury house
    Then the jury-house picture updates with the new arrival's fresh read and the shared broadcast

  # STATUS: BUILT, ASSUMED default pending Ryne (slice 4, the informed juror-vote card; tests/unit/jurorVoteCard0129.test.ts)
  Scenario: The deliberation informs the player's finale vote
    Given the player has spent the jury phase talking with the other jurors
    When the finale arrives
    Then the player carries what a juror told them into the finale juror vote
    And the finale vote mechanic is unchanged from feature 0037

  # STATUS: BUILT (askJuror folds nothing and has no pathway back to the live house)
  Scenario: The jury house never leaks back into the still-playing house
    Given the player talks with the jurors about the finalists
    When an active houseguest still in the game acts
    Then nothing the player or jurors said in the jury house reaches that active houseguest

  # STATUS: BUILT (the projection and askJuror draw no seeded rng; no roundtable is built)
  Scenario: The player's jury-house experience touches no seeded outcome by default
    Given the jury-house experience with no optional roundtable vote-nudging enabled
    When a seeded season is played to its finale with and without the player using the jury house
    Then the eviction order, the finalists, and the jury result are byte-identical
