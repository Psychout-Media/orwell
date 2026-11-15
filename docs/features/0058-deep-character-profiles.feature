Feature: 0058 — Deep character profiles (born deep, persist, play out)
  Each houseguest is born deep before they walk in — a real biography and a structured physical
  facet (PUBLIC), and 2–3 secrets, true goals, a named weakness, and a Day-1 read of the player
  (HIDDEN, Vault-sealed). The public depth is byte-stable and crosses to the player; the hidden
  depth NEVER reaches the player OR the admin, seeds the NPC→player edge, and seeds story threads
  that play out through the existing consequence fold. Roles only — no names.

  # §9 — the public profile is born deep and crosses the wall
  Scenario: every active houseguest is born with a public biography and a structured physical facet
    Given a deep-profile season started with seed "0058-1"
    Then every active houseguest card carries a multi-sentence biography
    And every active houseguest card carries a structured physical-characteristics facet
    And no houseguest card carries a secret, a true goal, a weakness, or a perception number

  # §8 — the Vault-Wall non-negotiables (player + admin + npcVoice + moment prompt)
  Scenario: no hidden deep-profile detail reaches any outward surface
    Given a deep-profile season started with seed "0058-2"
    When a sentinel is planted in every secret, weakness, true goal, and Day-1 perception field
    Then the planted sentinel never appears on any player surface
    And the planted sentinel never appears on the admin surface
    And the planted sentinel never appears in any houseguest's voicing projection
    And the planted sentinel never appears in the moment prompt

  # §3 — the Day-1 perception seeds the NPC→player edge (not from zero)
  Scenario: the authored Day-1 read seeds the NPC to player relationship edge
    Given a deep-profile season started with seed "0058-3"
    Then at move-in every houseguest with a Day-1 read has a seeded NPC to player edge that differs from the player to NPC edge
    And no relationship number ever crosses to the player

  # §5 — story threads are seeded, sealed, and play out through the consequence fold
  Scenario: story threads are seeded from the depth, sealed in the Vault, and fold a hidden weight on activation
    Given a deep-profile season started with seed "0058-4"
    Then hidden story threads are sealed in the Vault for the cast
    And no story thread premise appears on any player surface
    When a dormant story thread is activated for a houseguest
    Then that thread is now active and its hidden weight folded into the relationship layer

  # §6 / L27b — full-fidelity recall + byte-stable persistence
  Scenario: authored depth persists byte-stable and is held in full fidelity
    Given a deep-profile season started with seed "0058-5"
    Then a houseguest's biography established at cast time is held in full later
    And the public profile survives snapshot and restore byte-identical
    And the sealed hidden threads survive snapshot and restore

  # §7 / L28 — diversity & non-mirroring (same seed ⇒ same cast regardless of player)
  Scenario: the deep cast is player-independent and reproducible by seed
    Given a deep-profile season started with seed "0058-6" and player vocation echoed
    And a second deep-profile season started with seed "0058-6" and a different player
    Then both seasons produce the same public deep profiles
    And neither cast biography echoes the player's authored profile

  # §4 / L28b — the write-back seam is typed and split-safe (Phase 1 stub)
  Scenario: the cast-profile write-back seam reports its public and hidden fields without leaking a value
    Given a deep-profile season started with seed "0058-7"
    When an authored profile is written back for a houseguest
    Then the write-back is accepted and reports its public and hidden field names
    And the write-back result never echoes a hidden value
