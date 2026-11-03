# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0047 — Eviction night live: stage the weekly eviction through the 0034 seam like the finale.
# HARD rule: roles only (HOH, nominee, evictee, voter, juror). Add to cucumber.cjs when green.

Feature: Eviction night live

  The weekly eviction plays out live: the votes are revealed in a seeded order — batched into a handful
  of reveal rounds (live-verify 2026-06-27, mirroring the staged-comp pacing, so a big eviction is not a
  ~14-advance slog) — with a revealed-only tally, the evicted houseguest gets a goodbye, and goodbye
  messages from the house shape how that evictee later votes as a juror. The engine decides the reveal
  order and the outcome; no pre-reveal tally ever crosses the wall.

  Scenario: Votes are revealed in batched rounds in a deterministic order
    Given a started game at an eviction with a decided vote
    When the eviction is advanced through the seam
    Then the eviction votes are revealed monotonically in a few batched rounds
    And the reveal order is the same for the same seed
    And the running tally shows only the votes revealed so far

  Scenario: The evictee is not knowable before the last vote
    Given an eviction mid-reveal
    When the eviction surface is read mid-reveal
    Then it shows no pre-reveal tally and no unread vote
    And it does not name the evictee until the final vote lands
    And no Vault sentinel value appears on the eviction surface

  # Amended 2026-06-10 (E12 + T2): eviction votes are SECRET BALLOTS, as on the real show — the
  # staged reveal reads anonymized ballots ("a vote to evict …"), never the voter; rogue votes,
  # scapegoating, and vote paranoia become possible again. The attribution is recorded
  # engine-only and unseals exclusively in the post-season retrospective (0048). T2 also
  # replaced the self-referential tally assertions with electorate-derived bounds.
  Scenario: Vote secrecy — ballots are anonymous until the season ends
    Given a started game at an eviction with a decided vote
    When the eviction is advanced through the seam
    Then every revealed ballot is anonymized
    And the post-season retrospective unseals the season's ballots

  Scenario: The evicted houseguest gets a goodbye beat
    Given an eviction whose result has landed
    When the staging continues
    Then an evictee goodbye beat occurs
    And goodbye messages from the house are recorded

  # Amended 2026-11-03 (BDD audit AMEND 0047): the Then used to call juryLean/goodbyeMannerFor directly after an
  # empty When. It now plays two same-seed LIVE games from one snapshot taken at the player's goodbye pending - a real
  # warm goodbye and a real cold one, each through submitDecision - and reads the evictee's hidden lean toward the player
  # from the live state. The lean is engine-only: nothing visible to the player changes beyond the tone they picked.
  Scenario: A warm goodbye and a cold goodbye move the jury differently
    Given the same live evictee about to hear the player's goodbye
    When the player sends a warm goodbye in one game and a cold one in a same-seed game
    Then the evictee's hidden lean toward the player is measurably more favorable after the warm one
    And nothing the player can see tells the two games apart beyond the tone they chose

  Scenario: The staging runs through the decision seam and survives a restart
    Given an eviction staged through the advance seam
    When the engine restarts mid-reveal
    Then the eviction resumes from where it left off

  # Amended 2026-06-10 (E34): the engine never authors the PLAYER's goodbye message. A surviving
  # player records their own — a real pending decision through the 0034 seam (the tone is the
  # player's choice; the prose is the model's to voice) — folded into the evictee's manner
  # exactly as NPC tones are. Jury management's signature lever belongs to the player.
  Scenario: The player's goodbye message is their own decision
    Given a live eviction night with the player surviving
    When the goodbye stage reaches the player
    Then the loop pauses for the player's goodbye message
    And no player goodbye beat exists before the decision is resolved
    And the player's chosen tone folds into the evictee's manner toward the player

  # Amended 2026-11-03 (BDD audit AMEND 0047): the player-goodbye scenario above now runs on the LIVE adapter (a real seeded
  # game parked at the engine's own goodbye-message pending), not a hand-built 7-person pure liveSeason. The front-end route
  # chain that keeps advancing after the goodbye is proven in Python (frontend/tests/test_0130_post_goodbye_advance.py); this
  # scenario proves the engine side on real pendings: after the goodbye the night owes the exit interview and then the
  # result - bounded, never stalling at the interview, with no further player gate (an NPC evictee's interview is a beat, not
  # a player decision; the player's OWN interview as the evictee is 0130).
  Scenario: After the player's goodbye the night ends at the result and never stalls at the interview
    Given a live eviction night with the player surviving
    When the goodbye stage reaches the player
    And the player records a respectful goodbye
    Then the night runs on through the exit interview to the result in a few steps
    And no further decision is asked of the player on the way
    And the evictee is out and the house rolls on to its next phase

  # Added 2026-11-03 (BDD audit AMEND 0047, Vault-flavored; #1963 / #1976 / #1987). Eviction votes are SECRET BALLOTS, so a
  # deal broken by one must not be attributable by any hidden fold an NPC acts on: the betrayal shock is shared across
  # everyone who voted to evict the wronged party, and no jury demerit names the breaker. A break done in the open (a
  # nomination) and a break against the player keep the full, attributed fold. Each scenario plays a real seeded game to the
  # real ballot / ceremony and compares the same night with and without the deal, from one engine snapshot.
  Scenario: A deal broken by a secret ballot does not single out the breaker
    Given a live eviction night where an NPC deal partner votes with the house to evict the wronged party
    When the partner breaks the deal through the secret ballot
    Then the wronged houseguest's hidden read of every voter who voted to evict them takes a share of the shock
    And the breaker is not an outlier among those voters
    And no jury demerit names the breaker

  Scenario: A deal broken in the open still lands on the breaker alone
    Given a live nomination night where an NPC head of household holds a deal with a houseguest they are about to nominate
    When the head of household nominates their deal partner
    Then a public break lands on the breaker alone with a jury demerit

  Scenario: A deal broken against the player keeps the full fold
    Given a live eviction night where the player is on the block and a deal partner votes against them
    When the partner breaks the deal through the secret ballot
    Then a break against the player lands on the breaker alone
