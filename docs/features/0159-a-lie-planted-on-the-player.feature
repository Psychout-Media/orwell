# Feature 0159 - a lie planted on the player (theme 2; the owner's Q1 ruling, option C; ORW-330).
# Design note: 0159-a-lie-planted-on-the-player.md. Builds on 0151 (what the player hears), 0153 (NPCs plant lies) and 0152 (who told you that).
# Under option C the ENGINE decides the substance of a consequential lie (which claim, about whom, that it is false, and why the speaker tells it); the narrator words it
# freely and is handed only {kind, subject, object, certainty}: never whether it is true, never the speaker's reason. A houseguest who is working against someone can plant a
# story on the player the same way they plant one on an NPC. The lie sounds exactly as sure as a true claim (no built-in tells, Q3).
# Roles only.

Feature: A houseguest plants a lie on the player

  Scenario: A houseguest working against someone can plant a lie on the player, decided by the engine
    Given a started season with claims on
    And an NPC holds a goal against a second NPC
    When the NPC is in a scene with the player
    Then the engine can have the NPC tell the player a false claim about the second NPC, once a day
    And the claim is recorded as a lie told to the player, with what the NPC meant by it
    And the player is handed no belief

  Scenario: The narrator is handed the lie as a claim, with the same certainty a true claim would carry
    Given an NPC plants a lie on the player
    Then the narrator is handed the kind, the subject, the object and a certainty band
    And never whether it is true, why the NPC told it, or the claim's id
    And across seeds the certainty of lies matches the certainty of true claims

  Scenario: A houseguest with nothing against anyone plants nothing
    Given an NPC holds no goal against anyone
    When the NPC is in a scene with the player
    Then the NPC plants no lie on the player, across seeds

  Scenario: Asking "who told you that?" about a planted lie never names a made-up source
    Given an NPC planted a lie on the player
    When the player asks who told them
    Then the NPC says they saw it themself, and names no one
    And the narrator is not told the answer is untrue

  Scenario: The house mix and the late-game guards still pass
    When seeded seasons play with lies planted on the player
    Then the week-one house mix stays within the agreed reference
    And the late-game guard stays green
