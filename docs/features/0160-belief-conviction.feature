# Feature 0160 - conviction: each houseguest believes in proportion to who they are (theme 2; ORW-330, Ryne's ruling on question 2, 2026-11-16).
# Design note: 0160-belief-conviction.md. Builds on 0150 (beliefs drive decisions) and 0153 (claims between NPCs).
# Ryne: "how much that I believe it depends on how much I act on it... If I don't believe it, then maybe I'm testing and I'm looking for
# evidence for or against it... it depends on the person, how gullible they are, how open they are, how distrusting they are."
# Each belief carries a CONVICTION: from the source (trust in the teller, corroboration) and from the holder's own sheet (credulity:
# their disposition, temperament and type). High conviction: they act on it as fact. Low conviction: they TEST it - it becomes a
# question they go looking into - and each night what they find moves the conviction toward the truth (evidence can mislead). No fixed
# global strength, no model cost, deterministic. Roles only.

Feature: Conviction - a houseguest acts on a belief as far as they believe it

  Scenario: The same tale lands harder on a trusting houseguest than a suspicious one
    Given a played season with a trusting houseguest and a suspicious houseguest
    When the same teller tells each of them the same thing
    Then the trusting houseguest holds it with more conviction than the suspicious one

  Scenario: A belief held with high conviction is acted on as fact
    Given a houseguest who holds a grievance with high conviction
    Then it counts in their decisions at full weight, as a fact would

  Scenario: A doubtful belief is tested, and the evidence moves the conviction toward the truth
    Given a houseguest who doubts something they were told that is false
    Then they take up a goal to find out
    And as the nights pass their conviction falls, until they stop believing it
    And a doubted belief that is true grows into a conviction instead

  Scenario: A deal with someone you do not trust weighs less (Ryne on question 3: "Low trust in the person would create a low trust deal")
    Given an HOH who promised two houseguests safety, one they trust and one they do not
    Then the promise to the trusted houseguest protects them fully
    And the promise to the distrusted houseguest protects them less
