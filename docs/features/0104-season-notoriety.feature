Feature: 0104 — Season-over-season notoriety (a reputation that precedes you into a new cast)
  When the same physical-world user starts a new season, a BOUNDED notoriety summary derived
  from their finished season's open-set outcome record (placement, loyalty/treachery posture,
  comp profile, jury respect — never raw Vault state) precedes them into the new cast: it
  biases the new houseguests' day-one reads of the player. The engine still owns every outcome
  magnitude (anti-sycophancy); the Vault Wall holds for the player AND admin (notoriety is
  hidden-layer bias, felt only through later behaviour and Vault-free callbacks); cross-user
  isolation holds (a user's new season reflects only their OWN prior games); and the whole
  mechanic is opt-in, so with it off the calibration spine is byte-identical.

  # Role-only (testing rule): the-player, a houseguest, the new cast, a known schemer,
  # a known loyalist, a wary archetype, a second physical user.

  Background:
    Given a physical-world user with one active game per user
    And season notoriety is enabled for that user

  Rule: A bounded notoriety summary persists across the season door — never raw Vault state

    Scenario: A finished season derives a bounded, open-set notoriety summary
      Given the user has finished a prior season with a recorded outcome
      When the engine derives that user's notoriety at the season-end terminal
      Then a bounded, fixed-shape notoriety summary is persisted at the user-account level
      And the summary is derived only from the prior season's open-set outcome record
      And no Vault record, soul, or hidden edge from the prior season crosses into the summary

    Scenario: Notoriety accumulates across seasons and never thins
      Given the user already has a notoriety summary from an earlier season
      When the user finishes another season and the engine accumulates notoriety
      Then the seasons-played count only ever increases
      And the best placement and reputation are merged, never overwritten to a thinner state
      And the prior season's full durable record still remains on disk

  Rule: Notoriety biases the new cast's day-one reads — direction only, engine owns magnitude

    Scenario: A treacherous past precedes the player as wariness
      Given the user's notoriety reflects a treacherous, blindside-heavy prior season
      When the next season is created for that user with a fixed seed
      Then the new cast's day-one reads of the player lean warier and higher-threat
      And the same seed with no prior season leans neither way
      And no notoriety number is ever shown to the player

    Scenario: A beloved past precedes the player as warmth
      Given the user's notoriety reflects a loyal, jury-respected prior season
      When the next season is created for that user with a fixed seed
      Then the new cast's day-one reads of the player lean warmer
      And the bias never pushes a move-in edge outside the existing move-in scatter band

    Scenario: Notoriety never inflates the player's outcome odds
      Given a new season created for a user with a strong notoriety
      When competitions and votes are resolved at a fixed seed
      Then the first competition result and the NPC-to-NPC move-in layer are byte-identical to the same seed with no notoriety
      And notoriety has touched only the day-one relationship edges

  Rule: The Vault Wall holds — for the player and for admin

    # PO ruling 2026-11-01: a NEW character is a clean slate; a RETURNING character (chosen at creation)
    # carries their legend. The short legend clauses are PUBLIC for a returning player — the house may
    # voice "what it has heard" (#1791). The reputation NUMBERS and the summary's structure stay sealed.
    Scenario: Notoriety's hidden numbers appear on no player-facing or admin surface
      Given a new season created for a returning character with a notoriety summary
      When the player and the admin inspect every available projection
      Then the notoriety numbers and their bias appear on no player-facing surface
      And they appear on no admin or God-Mode surface
      And a sentinel sweep of the assembled day-one prompt finds no notoriety number

    Scenario: A NEW character is a clean slate — no legend on any surface
      Given a user with a notorious prior season who starts a new character
      When the player and the admin inspect every available projection
      Then no legend clause from the prior season appears on any player-facing surface
      And they appear on no admin or God-Mode surface

    Scenario: The narrator may voice notoriety only as a Vault-free callback
      Given a new cast that has heard of the returning player
      When the narrator frames a returning-cast callback
      Then it voices only the Vault-free legend gist as texture
      And it states no number and asserts no outcome the player must accept

  Rule: Cross-user isolation — a user's new season reflects only their OWN prior games

    Scenario: One user's new season never folds another user's notoriety
      Given a second physical user with a different prior-season history
      And both users start a new season at the same seed
      When the engine seeds each user's new cast's day-one reads
      Then the first user's day-one reads reflect only the first user's prior seasons
      And no call for one user ever folds the other user's notoriety

  Rule: Opt-in — with notoriety off, nothing changes

    Scenario: Disabled notoriety leaves the calibration spine byte-identical
      Given a user for whom season notoriety is disabled
      When the next season's day-one reads are seeded at a fixed seed
      Then the seeded move-in edges are byte-identical to the build with no notoriety
      And the jury-reach and full-game calibration results are unchanged
      And no second season-restart path was added
