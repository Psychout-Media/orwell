Feature: 0063 — Casting diversity floor (a cast that authentically reflects the country)
  The cast is GUARANTEED to be authentically diverse — engine-seeded FLOORS, not hoped-for-from-the-LLM.
  At cast creation the factory validates/repairs to a minimum BIPOC representation, a gender balance, an
  age spread, and an LGBTQ+ representation (extending L28's variety-via-CAPS with the symmetric minimums,
  and 0058's physical-characteristics facet with an ethnicity-grounded identity axis). Sexual orientation
  is handled the ORGANIC way: each houseguest has a seeded orientation, but disclosure is character-driven
  — some publicly out (a public facet), some PRIVATE (a Vault-sealed attribute that surfaces ONLY through
  an in-game pathway, 0002, never from a stat or a projection, never forced or telegraphed). A private
  orientation is hidden state until the player learns it organically. Ties into 0059: the seeded showmance
  layer may seed a QUEER showmance that surfaces only organically under the 0025/0059 reserve governance.
  Diversity is the depth of a full character, never a reductive single-word label. Floors hold across seeds;
  same seed ⇒ same cast. Roles only — no names.
  #
  # BUILT & GREEN — wired into cucumber.cjs. The engine guarantees the floors off a DEDICATED isolated
  # seeded sub-stream (the #338 RNG-isolation lesson), so the public competition/vote outcome stream is
  # byte-identical with the diversity layer on vs. off (proved by the golden test). The diversity +
  # personality public facets ALSO enrich the cast portrait prompt (each shot is uniquely that person).

  # §3 — the BIPOC representation floor holds across seeds (a minimum, not just an L28 cap)
  Scenario: across seeds the cast meets the minimum BIPOC representation floor
    Given a generated 15-houseguest cast at seed "0063-1"
    When the cast's ethnicity-grounded identity facet is read for every houseguest
    Then at least the minimum number of houseguests of color are present
    And no single appearance facet exceeds its L28 cap on the same cast

  # §3 — the gender balance floor holds across seeds
  Scenario: across seeds the cast is gender-balanced, never incidental
    Given a generated 15-houseguest cast at seed "0063-2"
    When the cast's gender presentation is read for every houseguest
    Then neither binary gender falls below the gender-balance minimum
    And each houseguest's name coheres with their gender presentation

  # §3 — the age spread floor: the cast spans generations, not just the 20s
  Scenario: across seeds the cast spans the age bands above the L18c eligibility floor
    Given a generated 15-houseguest cast at seed "0063-3"
    When every houseguest's age is read
    Then every houseguest is at least the eligible minimum age
    And each defined age band carries at least its minimum number of houseguests

  # §3/§4 — the LGBTQ+ representation floor holds across seeds
  Scenario: across seeds the cast meets the minimum LGBTQ+ representation floor
    Given a generated 15-houseguest cast at seed "0063-4"
    When every houseguest's seeded orientation is read from the engine
    Then at least the minimum number of houseguests have a non-straight orientation

  # §3 — floors and caps coexist on the same cast (balanced spread, not just un-clumped)
  Scenario: the same cast satisfies the L28 maximums and the 0063 minimums together
    Given a generated 15-houseguest cast at seed "0063-5"
    Then every L28 diversity cap is satisfied
    And every 0063 diversity floor is satisfied

  # §4/§5 — a PRIVATE orientation is Vault-sealed and never on any outward surface until surfaced
  Scenario: a privately-held orientation never reaches the player or the admin before a pathway surfaces it
    Given a generated cast at seed "0063-6" with a houseguest whose orientation is held privately
    When a sentinel is planted in that houseguest's private-orientation field
    Then the planted private-orientation sentinel never appears on any player surface
    And the planted private-orientation sentinel never appears on the admin surface
    And the planted private-orientation sentinel never appears in that houseguest's voicing projection
    And the planted private-orientation sentinel never appears in the moment prompt

  # §4/§5 — a publicly-out orientation IS observable (public facet), the house knows it
  Scenario: a publicly-out houseguest's orientation is an observable public facet
    Given a generated cast at seed "0063-7" with a houseguest who is publicly out
    Then that houseguest's orientation is available as a public character facet
    And no competition stat or hidden number is derivable from it

  # §4/§5 — pathway-only disclosure: the player learns a private orientation only organically
  Scenario: a private orientation reaches the player only after an in-game pathway terminates at them
    Given a generated cast at seed "0063-8" with a houseguest whose orientation is held privately
    And the player holds no knowledge of that orientation
    When no in-game pathway has surfaced the private orientation
    Then the player's knowledge still contains nothing about that orientation
    When an in-game pathway surfaces it to the player
    Then the player holds a belief about the orientation with a source and a confidence
    And the verbatim private-orientation field never appears on any player surface

  # §4.1 — 0059 can seed a queer showmance that surfaces only organically under reserve governance
  Scenario: the seeded showmance layer can seed a queer showmance that surfaces organically
    Given a season seeded so the 0059 showmance layer pairs two same-gender houseguests at seed "0063-9"
    Then the queer showmance is sealed from the player and the admin at cast time
    And the seeded showmance count stays within the 0059 sparseness budget
    When the season is simulated and the showmance has not yet earned visibility
    Then no player or admin surface reveals the showmance
    When the showmance earns visibility through an in-game pathway over weeks
    Then it surfaces as an event, never week-one and never telegraphed

  # §2/§6 — authentic, never reductive: identity is a facet, not a defining single word
  Scenario: no houseguest is reduced to a single identity word on any surface
    Given a generated 15-houseguest cast at seed "0063-10"
    Then every houseguest carries a multi-facet profile beyond their ethnicity and orientation
    And no player surface reduces a houseguest to a single identity label

  # §5 — anti-sycophancy: identity never bends a seeded COMPETITION outcome. (PO ruling 2026-11-02:
  # orientation may shape social play through realistic showmances — decision #3 — so later
  # nominations/votes can differ; competition odds and results never do.)
  Scenario: ethnicity and orientation never alter a competition outcome
    Given two casts identical except for one houseguest's ethnicity and orientation facets at seed "0063-11"
    When the identical seeded competition is resolved for both
    Then the seeded outcome is byte-identical across the two casts

  # §7 — seeded reproducibility: same seed ⇒ same cast identity facets and orientation
  Scenario: the cast's identity facets and orientation are reproducible by seed and player-independent
    Given two generated casts at the same seed "0063-12" with different player profiles
    Then both casts carry byte-identical ethnicity-grounded identity facets
    And both casts carry the identical orientation assignment
    And neither cast mirrors its player's identity facets
