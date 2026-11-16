# Feature 0158 - theme 2 end to end: what people know and say (ORW-330; theme 2 slice 9, the whole loop in one seeded game).
# Design note: 0158-theme-2-end-to-end.md. Plan: the vault note "Theme 2 Slice Plan", slice 9. Builds on 0149, 0151, 0152, 0154 and 0156.
# One seeded game, the real adapter, every theme 2 rule on: a lie is told and believed, a trusting houseguest confides it to the player, the player asks where it came from and is told,
# the public count catches the lie, and the house is called together about it. The engine decides every step; the narrator only voices what the player was there to hear.
# Roles only.

Feature: Theme 2 end to end - a lie is told, passed on, traced, caught and brought before the house

  Scenario: One lie travels the whole loop and the Vault Wall holds at every step
    Given one seeded season with claims, who-told-you, caught lies and house meetings all on
    When a liar tells a houseguest a lie about a third houseguest, and swears they voted to keep the houseguest
    Then the houseguest holds both as beliefs that can still be refuted
    When the houseguest trusts the player and is with them, alongside another houseguest who does not
    Then the narrator is handed what the trusting houseguest believes, with its certainty and nothing about whether it is true, and the other houseguest tells nothing
    When the player asks the houseguest who told them
    Then the houseguest names the liar, and the player learns it as something the houseguest said
    When the public count shows every voter wanted the houseguest out
    Then the vote claim is refuted, the houseguest believes the liar lied to them, and the liar's word counts for less with them
    When the houseguest calls the house together and accuses the liar of lying
    Then the narrator gets the meeting as the speakers' words, and every listener's belief about the accusation is updated
    And at every step no narrator view carried a truth, an intent, a claim id or a ballot, and the player heard only what was told to them
