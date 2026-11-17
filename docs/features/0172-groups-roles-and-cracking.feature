# Feature 0172 - groups: roles, nesting, shadow alliances, spies, cracking (Theme 3 slice 6), plus ORW-603 (a pitch shows what the player was told) and ORW-611 (plans aimed at the player are acted on).
# Design note: 0172-groups-roles-and-cracking.md. Rests on the owner's 2026-11-16 rulings: Q1, Q4 (NPC to NPC from the start), Q5, the culture leans (ORW-551) and the Theme 3 ruling that the player is plugged in, in both directions.
# Alliance history (0161) is already kept; this slice extends it. Vault Wall: roles, nesting, spies, shadow groups and cut orders are Vault content until the post-season retrospective; never shown as a roster, a chart or a number.
# The player's OWN alliances are never faded or broken here (ORW-616 is the owner's pending ruling). Roles only; every group-life step is worded with the groups: prefix.

Feature: Alliances have roles and inner circles, can hold a spy, crack, and treat the player as a person in the house

  Scenario: Members of an alliance take roles
    Given groups: a season where a named alliance of five houseguests has been together a few weeks
    Then groups: each member holds a role and no role is held by two members

  Scenario: A spy passes on the alliance's plan
    Given groups: a season where an outsider is drawn to an alliance only to learn its plans
    Then groups: the spy tells the person they really work for, in a scene only the two of them are in
    And groups: the alliance history keeps the spy and the report

  Scenario: An inner circle forms inside a larger alliance
    Given groups: a season where three of an alliance's members are closer to each other than to the rest
    Then groups: the three hold a nested inner group the others do not know of

  Scenario: A majority cracks when its purpose shifts
    Given groups: a season where an alliance reaches the late house with two members aiming their first cut at a third
    Then groups: the alliance cracks, and the two who aimed at their own found a new one

  Scenario: A shadow alliance forms against the group running the house
    Given groups: a season where an alliance holds the crown and means to cut an outsider
    Then groups: the outsiders form a counter-alliance the first group is not part of

  Scenario: No view shows a role, a nesting, a spy or a cut order while the season is live
    Given groups: a season where an alliance holds a spy, an inner circle and a private cut order
    Then groups: no player or admin view shows any of them

  Scenario: The player learns of a leak only if they were in the room
    Given groups: a season where the spy and the one they work for meet while the player is in the room
    Then groups: the player witnessed that scene
    And groups: with the player in another room the player did not witness it

  Scenario: The same seed gives the same groups, and the mix stays balanced
    Given groups: a season played twice from the same seed
    Then groups: both runs hold the same roles, spies and splits in the same order
    And groups: across many seeds the share of cracked alliances and of spies sits inside the reported mix band

  Scenario: Group history survives a save and a load whole, and cracking never deletes it
    Given groups: a season where an alliance cracked into two
    When groups: the season is saved and loaded into a fresh session
    Then groups: the loaded session holds the roles, the nesting and the split the saved one held
    And groups: the alliance history still holds the original alliance and the new ones

  Scenario: The feature off leaves a season untouched
    Given groups: a season with the kill switch thrown where an alliance of five has been together a few weeks
    Then groups: the season holds no group life and no history entry of one

  Scenario: A pitched alliance shows the roster the player was told, never the live one (ORW-603)
    Given groups: a season where an alliance pitched the player with a roster, and then took in another houseguest
    Then groups: the pitch the player sees still shows the roster they were told

  Scenario: A hostile houseguest confronts the player (ORW-611)
    Given groups: a season where a houseguest the player does not trust has a goal to get the player out
    Then groups: that houseguest comes to the player through the desire clock's own approach

  Scenario: A pull-them-in goal aimed at the player pitches the player (ORW-611)
    Given groups: a season where a houseguest with an alliance has a goal to pull the player in
    Then groups: the player is pitched that alliance and shown only its roster as told

  Scenario: An alliance that has settled on the player presses them, and withdraws a pitch it no longer means (ORW-611)
    Given groups: a season where an alliance has settled on the player as its target and pitched them earlier
    Then groups: one member comes to the player through the desire clock's own approach
    And groups: the pitch is withdrawn in an event the player was in, with no roster shown
