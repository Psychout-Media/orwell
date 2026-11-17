# Feature 0190 - NPC decisions read the decider's own view (ORW-574, Fable audit T1-6; widens 0163; Ryne 11-03: "what each NPC believes").
# In a PLAYED game, comp intent, Houseguest's Choice, the nomination tactic, pitch strength, the vote's jury term and HOH-target read, vote counting, the final
# HOH's estimate and the floater/duo read take how someone ELSE feels only as the decider can see it: their own edges, the public record (archetype, comp
# wins), the scenes they were in or watched, and their beliefs. Never another houseguest's hidden edge or stat. A decider who has not seen reads a neutral
# prior, never the truth. Flag ORWELL_OWN_VIEW (default ON; OFF and headless games = the hidden reads, byte for byte). Engine-only; nothing is projected. Roles only.

Feature: Decisions read the decider's own view

  Scenario: own view: comp intent ignores what rivals secretly think of the decider
    Given own view: a played season with a quiet house
    When own view: every rival secretly reads a cautious houseguest as a huge threat
    Then own view: their comp intent has not changed
    And own view: it changes once the house watches them win and they believe someone targets them

  Scenario: own view: Houseguest's Choice ignores the candidate's hidden trust and stats
    Given own view: a played season with a quiet house
    When own view: a candidate secretly trusts the nominee and is secretly a comp monster
    Then own view: the nominee's pick strategy has not changed
    And own view: it changes once the nominee trusts the candidate themselves

  Scenario: own view: the nomination tactic and pitch strength read the HOH's own view
    Given own view: a played season with a quiet house
    When own view: the whole house secretly fears one houseguest
    Then own view: the week is not a runaway week for the HOH
    And own view: a pitch's strength has not moved with the HOH's hidden read of the pitcher

  Scenario: own view: the vote reads the nominee's trust and the HOH's target as the voter sees them
    Given own view: a played season with a quiet house
    When own view: a nominee secretly trusts the voter and the HOH secretly fears the other nominee
    Then own view: the voter's jury term and read of the HOH's target have not changed
    And own view: they change once the voter holds an assurance from the nominee

  Scenario: own view: vote counting and the final HOH's estimate read what the actor saw
    Given own view: a played season with a quiet house
    When own view: the voters and a rival secretly grow close to the target
    Then own view: the actor's count and the final HOH's estimate have not changed
    And own view: they change once the actor watches those bonds

  Scenario: own view: the floater and duo read is only what the decider saw
    Given own view: a played season with a quiet house
    When own view: a pair becomes secretly close out of the decider's sight
    Then own view: the decider still reads them as strangers
    And own view: a scene the decider watches changes the read

  Scenario: own view: switched off, or in a headless game, the hidden reads stand and nothing is projected
    Given own view: a played season with a quiet house
    Then own view: with the flag off the comp intent follows the hidden read
    And own view: a headless game carries no perceived reads
    And own view: no player view carries the perceived-state internals

  Scenario: own view: the same seed plays the same
    Given own view: two played seasons from one seed
    Then own view: the same turns give the same result
