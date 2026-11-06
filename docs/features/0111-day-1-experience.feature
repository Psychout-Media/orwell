Feature: 0111 — The Day-1 experience (the first session is the first move of the social game)
  Day 1's job is to make the player believe the whole season's depth before they've seen it
  and get them into the conversation fast. Five pillars: casting probes the self (not a
  declared kill-list); the producer plants one Vault-free curiosity needle that the hidden
  game exists; house entry is fast and asymmetric with the first power arriving quickly; one
  early social beat demonstrably folds a real read (teaching action→consequence diegetically);
  and the Diary Room is an enterable room on Day 1. The Vault Wall holds for player AND admin:
  the needle reveals no specific hidden fact, no number ever crosses from the consequence fold,
  and the Diary Room has no pathway to any NPC. Composes #905/#906/#907/#908/#909 under #875.

  # Role-only (testing rule): the-player, a houseguest, a near-stranger, the-HOH, a hot-read,
  # a straggler, the admin. No names. Fixtures are generated; no sample-save content.

  Background:
    Given a fresh player completing the casting interview into a new season

  Rule: Casting probes the self, it does not demand a declared strategy (#905)

    Scenario: The interview elicits self-belief and tells, not a kill-list
      When the player completes the casting interview
      Then the interview probes the player's self-belief and tells
      And finalizing casting does not require a declared target list
      And the recorded intake captures character, not a committed strategy

  Rule: The producer plants exactly one Vault-free curiosity needle (#909)

    Scenario: A truthful "the house has a hidden game" beat that reveals no secret
      When the producer frames the season during casting
      Then exactly one curiosity needle signals that a hidden game exists
      And the needle is sourced only from public or seeded framing

  Rule: The champagne circle meets the whole house at the toast; the first power arrives quickly (#906)

    Scenario: The whole house is met at the champagne toast, then the first power is ready
      Given the producers convene the champagne circle at the premiere
      Then every houseguest is met at the champagne toast, with no manual roll-call
      And no houseguest is left invisible
      And the first power is reachable the moment the toast is done
      And the first power competition is a real seeded competition that is never gifted

  Rule: With premiere entrances ON (A9, ORWELL_PREMIERE_ENTRANCES) the house arrives ONE AT A TIME, then toasts; with it OFF the champagne circle above is unchanged

    Scenario: Each houseguest enters exactly once, in a seeded order, at a recorded player position
      Given the premiere entrances are enabled for a seeded season
      Then the entrance order contains every houseguest exactly once
      And the player's position in the order is recorded
      And the same seed reproduces the same order

    Scenario: The player's position varies by seed
      Given premiere entrances for several different seeds
      Then the player does not occupy the same position in every season

    Scenario: Entrances are released one houseguest per step and everyone is met by the end of the toast
      Given the premiere entrances are enabled for a seeded season
      When the entrances and the toast are played through
      Then every houseguest entered exactly once and each entrance is a recorded event
      And every houseguest has met the player and every other houseguest by witnessing
      And the host and every houseguest gave a recorded toast speech, except the player's own chat-authored slot
      And nothing hidden appears in any entrance or toast output

    Scenario: Nobody is gated on a roll-call and the first power waits for the Day-1 morning
      Given the premiere entrances are enabled for a seeded season
      When the entrances and the toast are played through
      Then the meet-everyone gate is never raised
      And the first power does not start until the toast is done

    Scenario: With premiere entrances OFF the season is byte-identical to today
      Given the premiere entrances are disabled for a seeded season
      Then no premiere entrance state exists and the champagne circle opens as before

  Rule: One early social beat demonstrably folds a real read (#908)

    Scenario: A Day-1 choice changes how a houseguest later treats the player
      Given a Day-1 social beat between the player and a houseguest
      When the player makes a consequential choice in that beat
      Then the beat is recorded and folds a hidden first read
      And the fold is guaranteed on the live game even when the model records nothing on a premiere turn
      And the change is recalled later only as observable behavior, never as a number

    Scenario: With no Day-1 beat, the folds are byte-identical to the baseline
      Given a Day-1 with no consequential social beat taken
      Then the relationship folds are byte-identical to the baseline first day

  Rule: The Diary Room is an enterable room on Day 1 (#907)

    Scenario: The player can confess on Day 1 with no leak to the house
      When the player enters the Diary Room on Day 1 through the live diaryRoom tool
      Then the Diary Room is available as a room before week-one nominations
      And the confessional is the player's own knowledge
      And nothing said in the Diary Room reaches any houseguest's behavior
      And the Diary Room entry witnesses only the player

  Rule: The Vault Wall holds for player AND admin

    Scenario: Neither the player nor the admin sees Day-1 hidden state
      Given the player has finished a Day-1 with a curiosity needle and a consequential beat
      When the Day-1 player-facing and admin-facing projections are assembled
      Then the curiosity needle exposes no specific hidden fact on either surface
      And no number from the consequence fold appears on either surface
      And the Diary Room exposes no pathway from the player's confession to any NPC

  Rule: With the in-game clock on, Day 1 has a social morning before the first HOH (P4b)

    Scenario: No phase advance moves the clock - the premiere night is the player's, and the first HOH waits for Day 2's afternoon
      Given a new Day-1 premiere with the in-game clock on
      Then the toast seats and pins the whole house
      When the toast closes
      And the player socializes into the first night
      Then the premiere exit moves no time and rolls no night
      And the first HOH has not fired and is not yet due
      When the player turns in for the premiere night
      Then it is Day 2 and the first HOH is not due in the morning
      When the player spends the morning block in social scenes
      Then the first HOH is now due in the afternoon
      And the first HOH fires only once it is due, and the day-break never repeats

  Rule: Day-1 is deterministic and calibration-neutral

    Scenario: With the reframes inactive, the season is byte-identical
      Given a full season is played with the Day-1 reframes inactive
      Then the seeded competition and eviction outcomes are byte-identical to the baseline season
