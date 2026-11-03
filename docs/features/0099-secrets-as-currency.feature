Feature: 0099 — Secrets as a tradeable currency (information becomes diplomacy)
  A secret the player has LEARNED becomes a liquid currency: the player can trade a held
  fact to a third-party recipient as consideration for a concession (a deal, a vote, a comp
  throw), and NPCs barter secrets with one another off-screen to buy bonds and votes. The
  value of a traded secret is the RECIPIENT's — what they would do with it — and the engine
  owns the bounded, seeded magnitude (it colors a deal, never forces it). The Vault Wall
  holds for player AND admin: the player can only trade a fact they legitimately hold, the
  recipient learns it only through the modeled pathway of being told, the hidden NPC barter
  reaches the player only via a pathway, and no number ever crosses. Sibling of 0093
  (secrets as levers); likely one build spec.

  # Role-only (testing rule): the-player, a houseguest, a recipient, a rival, an ally,
  # a near-stranger, the subject-of-a-secret, the admin. No names.

  Background:
    Given a started season with the player in the house

  Rule: Only a legitimately-held secret can be traded (the Vault bright line)

    Scenario: The player cannot trade a secret they never learned
      Given a secret the player has no pathway to and has never been told
      When the player tries to offer that secret to a recipient for a concession
      Then the trade is rejected
      And no concession is granted
      And the secret never appears on any player-facing surface

    Scenario: A mere suspicion is not a tradeable fact
      Given the player only suspects something about a houseguest but has not learned it
      When the player tries to trade that suspicion to a recipient
      Then the trade is rejected because it references no held fact

  Rule: A held secret is consideration a third party will pay for — valued to the recipient

    Scenario: The player trades a held secret for a concession
      Given the player holds a learned secret about a rival
      And a recipient who would value leverage on that rival
      When the player offers that secret to the recipient in exchange for a deal
      Then the engine raises the bounded, seeded likelihood the recipient enters the deal
      And the recipient learns the traded secret only as a recorded told event with content lineage
      And the trade and its outcome are recorded as the player's knowledge
      And no number is shown to the player

    Scenario: The same secret is near-worthless to a recipient who does not care
      Given the player holds a learned secret about a houseguest
      And a recipient who is allied with that houseguest and wants no leverage on them
      When the player offers that same secret to that recipient for a deal
      Then the offered secret moves the deal likelihood almost not at all
      And the recipient may refuse the trade

    Scenario: A trade colors a deal but never forces it
      Given the player holds a learned secret a recipient would value
      And the recipient reads the player as a high threat and distrusts them
      When the player offers the secret for a deal
      Then the recipient can still refuse the trade
      And peddling the secret may cost the player standing with that recipient
      And with no secret offered the deal formation is byte-identical to the deal baseline

  Rule: NPCs barter secrets with each other, hidden

    Scenario: An off-screen secret trade between two houseguests stays in the Vault
      Given a houseguest who holds a juicy secret about a rival
      And an ally of that houseguest who would value it
      When the holder barters the secret to the ally off-screen to firm their bond
      Then the trade and its price are recorded only in the hidden layer
      And the ally now holds the secret in the hidden layer
      And the player learns of the barter only if a pathway later reaches them
      And the bartered secret never appears on any player-facing surface without a pathway

  Rule: The engine owns the magnitude (anti-sycophancy)

    Scenario: A traded secret cannot be pumped to force an outcome
      Given the player holds a learned secret a recipient would value
      When the player offers the secret for a concession
      Then the magnitude of its effect is bounded and seeded by the engine
      And the model may propose only which secret, to whom, and the ask
      And the model cannot inflate how far the trade moves the recipient

  Rule: The Vault Wall holds for player AND admin

    Scenario: Neither the player nor the admin sees a trade value or a hidden barter
      Given the player has traded a secret and houseguests have bartered secrets off-screen
      When the player-facing and admin-facing projections are assembled
      Then no trade value or hidden standing change appears on either surface
      And no off-screen bartered secret the player has no pathway to appears on either surface
      And both surfaces show only the fact of a trade the player is party to and observable fallout

  Rule: Trades are deterministic and calibration-neutral

    Scenario: The same seed and history reproduce the same trade outcome
      Given a fixed seed and history with a held secret offered to a recipient
      When the trade is resolved twice from the same state
      Then the trade value, the outcome, and the folds are identical both times

    Scenario: With no trade and barter off, the season is byte-identical
      Given a full season is played with no secret traded and off-screen barter disabled
      Then the seeded vote and eviction outcomes are byte-identical to the baseline season

  Rule: A traded secret persists and the knowledge layer deepens

    Scenario: A used secret is remembered across a restart
      Given the player has traded a held secret to a recipient
      When the game is saved and restored
      Then the secret is still marked as used
      And the recipient still holds the traded secret
      And the per-season trade count is unchanged by the restart
