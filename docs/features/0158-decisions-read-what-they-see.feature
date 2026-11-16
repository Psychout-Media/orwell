# Feature 0158 - decisions read what the decider can see, not the hidden truth (theme 2, slice 2b; ORW-539, from ORW-330).
# Design note: 0158-decisions-read-what-they-see.md. Builds on 0150 (beliefs drive decisions) and 0153 (NPCs tell each other claims).
# The HOH's floater and duo reads looked straight at OTHER houseguests' real relationships, which no houseguest can see. Now they read
# the bond the HOH PERCEIVES between two others: the bonding scenes the HOH witnessed between them, and what the HOH believes about them
# (an allied-with belief: "they have a final two"). A pair that bonds only out of the HOH's sight looks like strangers to the HOH; a pair
# the HOH watched get close, or was told about, looks tight - even when it is not. Ryne's Q2 seam (BELIEF_RULES.strength) decides it:
# "capped" keeps the old omniscient read, byte for byte. Measured and reported, never gated. Roles only.

Feature: Decisions read what the decider can see

  Scenario: A pair that bonds only out of the HOH's sight does not look like a duo to the HOH
    Given a house where two houseguests are close, but only ever bond where the HOH cannot see
    When the HOH reads who is a duo
    Then the HOH does not see them as a pair
    And with beliefs capped, the old read still sees them as a pair

  Scenario: A pair the HOH watched bond, or was told about, looks like a duo
    Given a house where two houseguests barely know each other
    When the HOH watches them bond, or is told they have a final two
    Then the HOH reads them as a pair, even though they are not

  Scenario: The floater read is what the HOH can see too
    Given a houseguest someone is secretly close to
    When the HOH reads who is a floater
    Then the HOH sees that houseguest as a floater, because the bond is out of sight
