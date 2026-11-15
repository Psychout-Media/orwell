# spec-only: this .feature is a design contract, NOT wired into the BDD gate (absent from cucumber.cjs paths; no step definitions). Its behavior is verified elsewhere — see the per-feature status index in docs/features/README.md. (TEST-3, #628)
# Feature 0129 — The jury house. Expands 0046 (juror seat) + pairs with its ceremonies-as-broadcast model.
# HARD rule: roles only (player, juror, evictee, finalist, frontrunner). SLICES 1-4 BUILT (slice 4 is an ASSUMED default, pending Ryne) (roster, jurors voiced from their own knowledge, askJuror, the finale juror-vote card;
# unit-tested, see 0129.md §9); NOT BUILT: jurors approaching the player, rolling updates as new evictees arrive, and
# broadcast of ceremony outcomes since eviction, jury gossip and the roundtable. Spec authored 2026-07-13 during the 0046 PO review.

Feature: The jury house (living with the evicted)

  Once the player is a juror they are not alone watching a broadcast — the other evicted houseguests are in
  the jury house with them. The player can hear the season from each juror's point of view, ask them
  questions, and get a rolling update on the house as new evictees arrive, carrying that read into their
  finale vote. A juror only ever knows what they witnessed before their own eviction, the public broadcast,
  and what other jurors told them — never the live house's hidden scheming.

  # BUILT (slice 1, juryHouseView roster)
  # STATUS: BUILT (slice 1, roster projection; tests/unit/juryHouse*.test.ts)
  Scenario: The jury is a room the player can talk to
    Given the player has been evicted into the jury
    When the player is in the jury house
    Then the other jurors are present
    And the player can talk to any juror, and jurors also approach the player

  # BUILT (slice 2, juryHouseVoice0129.test.ts)
  # STATUS: BUILT (slice 2, jurors voiced from their own knowledge; tests/unit/juryHouseVoice0129.test.ts)
  Scenario: Each juror tells the season from their own perspective
    Given two jurors who were evicted at different points
    When each recounts the season
    Then each account is bounded to what that juror actually witnessed and the public broadcast
    And their reads reflect their own soul and the manner of their eviction
    And two jurors may hold contradictory beliefs about the same event

  # BUILT (slice 3, askJuror; juryHouseVoice0129.test.ts)
  # STATUS: BUILT (slice 3, the askJuror lever; tests/unit/juryHouseVoice0129.test.ts, incl. 'a telling moves NO relationship edge' - ORW-112)
  Scenario: The player can ask a juror questions and get grounded answers
    Given the player is in the jury house with a juror
    When the player asks that juror what they think of the frontrunner
    Then the answer is voiced in that juror's voice from that juror's own knowledge and opinion
    And it never draws on another juror's private knowledge or any hidden house state

  # BUILT (0001 canary in juryHouseVoice0129.test.ts)
  # STATUS: BUILT (slices 2-3, the juror's own knowledge scope + the 0001 canary; tests/unit/juryHouseVoice0129.test.ts)
  Scenario: A juror never knows the live house's hidden scheming
    Given the house schemes off-screen and records confessionals after a juror's eviction
    When that juror's shareable knowledge is derived
    Then it contains only the public ceremony outcomes broadcast since their eviction
    And it contains no off-screen scheme and no confessional
    And no Vault sentinel value appears anywhere in the jury-house projection

  # UNBUILT (rolling updates not built)
  # STATUS: NOT BUILT (rolling updates as new evictees arrive; see 0129.md section 9)
  Scenario: The jury-house picture updates as new evictees arrive
    Given the player is a juror and another houseguest is then evicted
    When the new evictee joins the jury house
    Then the jury-house picture updates with the new arrival's fresh read and the shared broadcast

  # BUILT (slice 4, jurorVoteCard0129.test.ts; assumed default pending Ryne)
  # STATUS: BUILT, ASSUMED default pending Ryne (slice 4, the informed juror-vote card; tests/unit/jurorVoteCard0129.test.ts)
  Scenario: The deliberation informs the player's finale vote
    Given the player has spent the jury phase talking with the other jurors
    When the finale arrives
    Then the player carries that read into the finale juror vote
    And the finale vote mechanic is unchanged from feature 0037

  # BUILT (askJuror folds nothing: no relationship edge moves, juryHouseVoice0129.test.ts)
  # STATUS: PARTLY VERIFIED (askJuror folds no edge and the jury has no pathway back to the live house; no dedicated scenario test)
  Scenario: The jury house never leaks back into the still-playing house
    Given the player talks with the jurors about the finalists
    When an active houseguest still in the game acts
    Then nothing the player or jurors said in the jury house reaches that active houseguest

  # BUILT (read-only view, draws no rng)
  # STATUS: NOT SEPARATELY VERIFIED here (see tests/unit/juryHouseAdapter.test.ts for the 0100 jury-house layer; 0129 slices 1-4 add no rng)
  Scenario: The player's jury-house experience touches no seeded outcome by default
    Given the jury-house experience with no optional roundtable vote-nudging enabled
    When a seeded season is played to its finale
    Then the eviction order, the finalists, and the jury result are byte-identical to the pre-feature model
