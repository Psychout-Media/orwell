# Feature 0161 - decisions read what the decider can see, not the hidden truth (theme 2, slice 2b; ORW-539, from ORW-330).
# Builds on 0150 (beliefs drive decisions) and 0153 (NPCs tell each other claims).
# The HOH's floater and duo reads looked straight at OTHER houseguests' real relationships, which no houseguest can see. Now they read the
# bond the HOH PERCEIVES between two others, half what the HOH could see and half the truth (a house reads more than its own scenes: tone,
# glances). What the HOH could see is the bonding scenes they took part in or watched from the same room, and what they believe about the
# pair (an allied-with belief: "they have a final two"). A pair that bonds out of the HOH's sight looks less close than it is; a pair the HOH
# watched, or was told about, looks closer than it is. Flag ORWELL_PERCEIVED_BONDS (default ON; off = the hidden-truth read, byte for byte).
# Measured and reported, never gated. Roles only.

Feature: Decisions read what the decider can see

  Scenario: A pair that bonds only out of the HOH's sight looks less close to the HOH than it is
    Given a played season where two houseguests are close, but only ever bond where the HOH cannot see
    When the HOH reads who is a duo
    Then the HOH reads them as less of a pair than they are
    And with perceived bonds off, the HOH reads the hidden truth

  Scenario: A pair the HOH watched bond from across the room looks closer than it is
    Given a played season where two houseguests barely know each other
    When the HOH watches them bond from the same room, without taking part
    Then the HOH reads them as more of a pair than they are

  Scenario: A pair the HOH was told about looks closer than it is
    Given a played season where two houseguests barely know each other
    When the HOH comes to believe they have a final two
    Then the HOH reads them as more of a pair than they are

  Scenario: A secret bond leaves its houseguest looking like a floater
    Given a played season where one houseguest is secretly close to another
    When the HOH reads who is a floater
    Then the HOH sees that houseguest as more of a floater than they are
