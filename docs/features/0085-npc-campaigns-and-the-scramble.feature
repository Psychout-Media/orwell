Feature: 0085 — NPC campaigns & the scramble
  Houseguests run strategy over time, not in one-tick impulses: a campaign is a persistent, hidden
  agenda with a goal and a target, executed across many beats — lobbying, planting doubt, cutting
  deals, repositioning — and adapting as the board changes, until it resolves at a ceremony. A
  campaign tilts the SEEDED outcome (the engine tallies it; narration only voices it), and the player
  learns one exists only through a real pathway — never by reading the house's mind. The pre-eviction
  scramble is the week's campaigns colliding, where the secret true count can diverge from what people
  say to your face.

  # Role-only (testing rule): the-player, a-schemer, the-target, an-ally, a-bloc, the-electorate.

  Background:
    Given a started season with a live off-screen society

  Rule: A campaign is strategy executed over time, not a one-tick reaction

    Scenario: A campaign persists and advances across many ticks
      Given a schemer forms a campaign to evict the target this week
      When the society runs several more campaign ticks
      Then the campaign advances by a concrete move on each tick
      And the campaign is still active and closer to its goal until the week resolves

    Scenario: A multi-week campaign survives a save and a week boundary
      Given a schemer forms a season-long campaign against the target
      When the game is snapshotted and restored after a week has passed
      Then the campaign is still active with its accumulated history intact

  Rule: A campaign adapts when the board changes

    Scenario: The target escaping veto re-aims the campaign
      Given a campaign to evict the target this week
      When the target wins the veto and removes themselves from the block
      Then the campaign re-targets or escalates rather than disappearing

    Scenario: A campaign pivots to self-protection when its owner is endangered
      Given a schemer running a campaign against the target
      When the schemer themselves is nominated
      Then the campaign pivots toward protecting its owner

  Rule: A campaign tilts the seeded outcome — the engine decides, not the narration

    Scenario: A sustained eviction campaign raises the target's odds of going home
      Given many seeded seasons with and without a sustained campaign to evict the target
      Then the target is evicted more often when the campaign runs
      But the same seed always produces the same outcome
      And the seeded competition and jury calibration is unchanged

    Scenario: A campaign is not destiny
      Given a sustained campaign to evict the target
      Then the target can still survive the vote on some seeds

    Scenario: How hard a campaign tilts depends on who is talking and who is listening
      Given the same campaign run by a highly persuasive houseguest and by a low-persuasion one
      Then the persuasive houseguest's campaign tilts the outcome more
      And a gullible listener is swayed more than a stubborn, independent one
      But neither persuasiveness nor gullibility changes the seeded determinism

  Rule: A campaign is hidden — the player learns of it only through a pathway

    Scenario: No surface reveals a campaign
      When every player-facing and admin-facing surface is read
      Then none of them returns any campaign's existence, target, plan, or progress

    Scenario: The player feels a campaign through real pathways, not mind-reading
      Given a campaign against the player is underway
      When houseguests lobby, gossip, and meet about it
      Then the player can learn that a campaign exists only through what they witness, are told, or overhear
      And the player never receives the sealed content of the schemers' private scenes

  Rule: Perspective is symmetric — houseguests are no more omniscient than the player

    Scenario: A bystander houseguest does not know a campaign they were never told of
      Given two houseguests run a campaign against the target
      And a third houseguest has no pathway to it
      Then the third houseguest's voicing carries no trace of that campaign
      And the third houseguest never acts on a campaign they do not know exists

    Scenario: A houseguest acts on their own belief, not an omniscient ledger
      Given two houseguests in different blocs hold different reads of the house
      When each chooses their next strategic move
      Then each acts on what they themselves have learned, not the full set of campaigns

    Scenario: Belief in a campaign spreads only by pathway and drifts as it travels
      Given one houseguest learns of a campaign by being lobbied
      When that belief diffuses to others as gossip
      Then it reaches them only through that pathway
      And it may arrive partial, late, or distorted, never as shared certain truth

  Rule: The scramble — campaigns colliding at the vote

    Scenario: The secret count can diverge from what is said to the player's face
      Given several campaigns working the same electorate before an eviction
      Then the hidden true vote count may differ from the houseguests' stated intentions
      And the staged eviction reveal is anonymized
      And per-voter attribution unseals only in the post-season retrospective

  Rule: The player can run their own campaign — as player knowledge, never mind control

    Scenario: A player campaign is the player's knowledge and moves no NPC by itself
      Given the player declares a campaign to evict the target
      Then the player's campaign is the player's own knowledge with no pathway to any NPC
      And no NPC acts on the campaign except in response to the player's actual recorded moves

    Scenario: The player's actual recorded pitches earn a real campaign that tilts the vote like an NPC's
      Given the player pitches a houseguest against the target across several real, witnessed scenes
      Then the player's own campaign accrues progress exactly as an NPC's campaign would
      And the pitched houseguest's vote is tilted toward the target, bounded to the same ceiling an NPC's campaign uses
      And a houseguest the player never pitched is unmoved

  Rule: Vote counting adapts, and lobbying pitches are real events (B37 / B38, flag-gated, default off)

    Scenario: An overconfident NPC is blindsided
      Given a close eviction count and an overconfident campaigner
      When the campaigner reads the count
      Then the campaigner believes it is decided and stops campaigning
      And the true count was still in doubt

    Scenario: A pitch to the new Head of Household is a hidden event unless the player witnessed it
      Given a new Head of Household who faces pitches from trusted houseguests
      When the pitches are made
      Then each pitch is recorded with the Head of Household as a witness
      And a pitch the player did not witness is hidden from the player's knowledge
      And a trusted safety pitch seals a quiet pact between the two

