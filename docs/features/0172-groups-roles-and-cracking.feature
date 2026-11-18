# Feature 0172 - groups: roles, nesting, shadow alliances, spies, cracking (Theme 3 slice 6), plus ORW-603 (a pitch shows what the player was told) and ORW-611 (plans aimed at the player are acted on).
# Design note: 0172-groups-roles-and-cracking.md. Rests on the owner's 2026-11-16 rulings: Q1, Q4 (NPC to NPC from the start), Q5, the culture leans (ORW-551) and the Theme 3 ruling that the player is plugged in, in both directions.
# Alliance history (0161) is already kept; this slice extends it. Vault Wall: roles, nesting, spies, shadow groups and cut orders are Vault content until the post-season retrospective; never shown as a roster, a chart or a number.
# ORW-616 (all four equal): the player's own alliances fade, break and crack like any other; the player learns only by an observable act, never a roster. Every group-life step is worded with the groups: prefix.

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

  Scenario: A spy comes to like the group more than the one they work for and turns loyal
    Given groups: a season where a spy is warmer toward the alliance than toward the person they work for
    Then groups: the spy turns, the history keeps it, and a spy who has turned never reports the real plan to the one they worked for again

  Scenario: A spy who still holds to the one they work for never turns
    Given groups: a season where a spy is closer to the person they work for than to anyone in the alliance
    Then groups: the spy never turns

  Scenario: A double-crossing spy tells the one they work for a wrong target, as a lie
    Given groups: a season where a spy has turned and feeds the person they work for a wrong target
    Then groups: the one they report to is told one claim naming a target the alliance did not agree, and the engine holds it as a lie

  Scenario: A spy's honest report reaches the one they work for as one told claim
    Given groups: a season where an outsider is drawn to an alliance only to learn its plans
    Then groups: the report is one claim about the member who drives the plan, true, meant to inform

  Scenario: A spy who has turned warns the player, only if they really talk
    Given groups: a season where a spy who works for another turns while the alliance has settled on the player, in the player's room
    Then groups: the player heard one claim from the spy
    And groups: the same season with the player in another room leaves the player no claim

  Scenario: The spy's report is overheard only with the one they report to in the room and the player awake
    Given groups: a season where the spy is in the player's room but the one they report to is not
    Then groups: the player did not witness the report
    And groups: with the player asleep in the same room as both, the player did not witness it either

  Scenario: An alliance that dominates by a majority draws a counter-alliance of the threatened
    Given groups: a season where an alliance is most of the houseguests left and the others read its members as a threat
    Then groups: the threatened outsiders form a counter-alliance

  Scenario: An alliance that carried the last two evictions draws a counter-alliance
    Given groups: a season where an alliance has carried the last two evictions without the crown and the others read its members as a threat
    Then groups: the threatened outsiders form a counter-alliance

  Scenario: A group that dominates nothing draws no counter-alliance, however threatened the others feel
    Given groups: a season where a small alliance holds neither the crown, a majority, nor a streak and the others read its members as a threat
    Then groups: no counter-alliance forms

  Scenario: The agreed target's threat step is taken once, however often the target flips back
    Given groups: a season where an alliance's agreed target flips away and back
    Then groups: each member's read of that target moved one step only

  Scenario: A member who breaks away tells the person the group means to take out
    Given groups: a season where two members of an alliance break away while the alliance means to take out an outsider they like
    Then groups: that outsider is told one claim about the member who drives the plan
    And groups: with the player as the target and in the breakaway's room, the player is told it too, and in another room is not

  Scenario: The NPC members of the player's own alliance hold hidden roles, and the player never does
    Given groups: a season where the player belongs to an alliance with three houseguests
    Then groups: the three hold roles in the history, the player holds none, the alliance is unchanged, and no view shows them

  Scenario: The player's alliance fades after inactivity like an NPC's (ORW-616)
    Given groups: a season where the player belongs to an alliance whose bonds with the player have gone cold
    Then groups: the alliance fades by the same days an NPC one would, and the player is told by an event that names it and no roster

  Scenario: A member whose goal is to get the player out turns on the alliance and the player sees it (ORW-616)
    Given groups: a season where a member of the player's alliance has a goal to get the player out
    Then groups: the member leaves and the player witnessed it as an event naming the alliance, never a roster

  Scenario: Members who aim their first cut at the player break away, and the player sees them go (ORW-616)
    Given groups: a season where two members of the player's alliance have a goal to get the player out and the house is late
    Then groups: the two break away into a new alliance, and the player witnessed it as an event that names the alliance and one name only
    And groups: no view shows a roster, a role or a cut order of the player's alliance
