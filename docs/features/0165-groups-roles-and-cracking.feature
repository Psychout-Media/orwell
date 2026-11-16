# spec-only: Theme 3 draft scenarios, not built and not wired into the BDD gate; they wait for the owner's approval of the Theme 3 plan (the vault "Theme 3 Slice Plan").
# Feature 0165 - groups: roles, nesting, shadow alliances, spies, cracking (Theme 3 slice 6; Theme 3 Slice Plan, owner B). SCENARIOS DRAFTED, NOT BUILT.
# Design note: 0165-groups-roles-and-cracking.md. Rests on the owner's 2026-11-16 rulings: Q1, Q4 (NPC to NPC from the start), Q5 (both sides can call meetings),
# the culture leans (ORW-551: "majority bloc", "backstabbers", "paranoid" skew these dials) and the Theme 3 ruling. Alliance history (0161) is already kept; this
# slice builds on it. Vault Wall: roles, nesting, spies, shadow groups and cut orders are Vault content until the post-season retrospective; never shown as a roster,
# a chart or a number. Roles only, plain words.

Feature: Alliances have roles and inner circles, can hold a spy, and crack

  Scenario: Members of an alliance take roles
    Given a groups season where a named alliance of five houseguests has been together a few weeks
    Then each member holds a role in it, and no role is empty while it has enough members to fill them

  Scenario: A spy passes on the alliance's plan
    Given a groups season where an NPC joins an alliance only to learn its plans
    When the alliance agrees a target
    Then the spy tells the person they really work for

  Scenario: An inner circle forms inside a larger alliance
    Given a groups season where three of an alliance's members are closer to each other than to the rest
    Then the three hold a nested inner group the others do not know of

  Scenario: A majority cracks when its purpose shifts
    Given a groups season where a majority alliance reaches the late season
    Then its members' private cut orders start to collide, and it splits

  Scenario: A shadow alliance forms against a known one
    Given a groups season where outsiders learn an alliance is running the house
    Then they may form a counter-alliance, and keep it hidden from the first

  Scenario: No view shows a role, a nesting, a spy or a cut order while the season is live
    Given a groups season where an alliance holds a spy, an inner circle and a private cut order
    Then no player or admin view shows any of them, and the player learns of one only if told or if they overheard it

  Scenario: The same seed gives the same groups, and the mix stays balanced
    Given a groups season played twice from the same seed
    Then both runs hold the same roles, spies and splits in the same order
    And across many seeds the share of cracked alliances and of spies sits inside the reported mix band

  Scenario: Group history survives a save and a load whole, and cracking never deletes it
    Given a groups season where an alliance cracked into two
    When the season is saved and loaded into a fresh session
    Then the loaded session holds the roles, the nesting and the split the saved one held
    And the alliance history still holds the original alliance and the new ones
