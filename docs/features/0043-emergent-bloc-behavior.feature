# Executable spec — IMPLEMENTED & green; BDD-gated in cucumber.cjs. (Originally drafted failing-first.)
# Feature 0043 — Emergent multi-party bloc behavior: blocs DERIVED from the relationship graph at decision
# time (never stored — decision 0002), driving coordinated targeting/voting and fracture on betrayal.
# HARD rule: roles only (houseguest, HOH, nominee, bloc-mate). Add to cucumber.cjs when green.

Feature: Emergent multi-party bloc behavior

  Houseguests form blocs that vote together, shield each other, and target a shared enemy — but the bloc is
  an emergent read of the relationship graph, computed every time and stored never. A betrayal that drops a
  bond fractures the bloc on the next read. The player infers alliances from behavior, never a roster.

  Scenario: Blocs emerge from mutual bonds without being stored
    Given several houseguests with strong mutual bonds
    When blocs are detected from the relationship graph
    Then they are grouped into a bloc
    And no alliance or ally/enemy label is stored anywhere

  Scenario: A bloc has a derived shared target
    Given a detected bloc
    Then it carries a shared target derived from the members' aggregate threat

  Scenario: Bloc-mates coordinate more than chance
    Given a bloc within the house
    When nominations and eviction votes resolve
    Then bloc-mates shield each other from nomination and vote together
    And they lean toward targeting their shared enemy

  Scenario: A bloc is only as loyal as its members
    Given two blocs under the same outside pressure
    And one bloc's members are dispositionally loyal while the other's include a free agent
    When nominations and eviction votes resolve across the following weeks
    Then the loyal bloc holds together and coordinates measurably longer
    And the low-loyalty bloc's coordination is overridden by individual incentives sooner

  Scenario: A low-loyalty member defects without a formal betrayal
    Given a bloc containing a member with low derived loyalty
    And that member holds a stronger bond outside the bloc
    When the next decisions are read
    Then that member peels away from the bloc's coordination before any betrayal event
    And no stored membership existed to update

  Scenario: Loyalty is derived from character and soul, never stored per bloc
    Given a bloc whose member suffers a consequential event that shifts their soul state
    When blocs are next detected
    Then the bloc's loyalty strength reflects the member's current soul state
    And the serialized save contains no bloc loyalty value

  Scenario: A betrayal fractures the bloc
    Given a bloc of houseguests
    When one member betrays another and their bond drops
    Then the next bloc detection yields a smaller or split bloc
    And nothing about the old bloc was stored to update

  Scenario: No bloc or label is ever persisted
    Given a game in which blocs have formed
    When the soul/save is serialized
    Then it contains no bloc membership and no ally/enemy label

  Scenario: A named alliance keeps its own label while no bloc or ally label is persisted
    Given a game in which blocs have formed and a named alliance exists
    When the soul/save is serialized
    Then the alliance's own name is stored as the alliance's label
    And it contains no bloc membership and no ally/enemy label

  Scenario: Blocs are Vault-free and deterministic
    Given a started game in which blocs have formed
    When any player surface is read
    Then no bloc roster or hidden state appears
    And the same relationship graph and seed yield the same blocs
