# Feature 0156 - house meetings (theme 2, slice 7; ORW-330).
# Design note: 0156-house-meetings.md. Plan: the vault note "Theme 2 Slice Plan", slice 7. Builds on 0149 (the claims core) and the 0151 narrator seam.
# A rumor goes PUBLIC. Someone calls the house together and accuses a houseguest of something (a claim from the claims core's fixed set); the accused answers (the engine
# decides: deny, admit or redirect); each houseguest present then decides who to believe from how much they trust each side. The ENGINE decides who calls, who
# speaks, what they claim and how each listener moves; the narrator only words it, and only what the player is present to hear: the speakers' words, never whether
# an accusation or a denial is true, never the speaker's real reason, never how any NPC privately settled.
# Who may call one is behind ONE seam (the owner has not answered): by default both the player and NPCs can. Roles only.

Feature: House meetings

  Scenario: At a house meeting each listener decides who to believe
    Given a started season with house meetings on
    And an accusation is made against a houseguest in front of the house
    When the accused answers
    Then each houseguest present updates their belief by how much they trust each side
    And a listener who trusts the accuser more comes out holding the accusation harder, and one who trusts the accused more comes out doubting it

  Scenario: The accused answers by denying, admitting or redirecting, decided by the engine
    Given an accusation is made against a houseguest in front of the house
    Then the engine decides the answer from what is true, the accused's candor and how the room stands
    And the same inputs always give the same answer
    And a true accusation can be admitted, denied or redirected, and a false one denied or redirected

  Scenario: Redirecting turns the accusation back on the accuser
    Given the accused redirects
    Then the accused tells the house that the accuser is lying
    And each listener who believes the accused holds that as a claim from the accused

  Scenario: An NPC can call a house meeting over a grievance they hold, and the player can call one
    Given an NPC holds a strong grievance belief about a houseguest
    Then the NPC can call a house meeting about it, at most once a week
    And the player can call one by saying so in their own words
    And who may call one is decided in one place

  Scenario: The player hears the meeting as its audience, and never its truth
    Given the player is in the house and awake when a meeting is called
    Then the narrator is handed the accusation and the accused's answer as the speakers' words
    And is never told whether either is true, why the caller called it, or how any houseguest settled

  Scenario: A meeting held while the player is asleep or out of the house is never narrated
    Given a meeting is called while the player is asleep
    Then the narrator is handed nothing about it
    And the houseguests still update their beliefs

  Scenario: A meeting moves nothing a secret ballot would show
    When houseguests accuse and answer each other about how they voted
    Then no view shows any houseguest's actual ballot before the retrospective

  Scenario: The house mix and the late-game guards still pass
    When seeded seasons play with house meetings on
    Then the week-one house mix stays within the agreed reference
    And the late-game guard stays green
