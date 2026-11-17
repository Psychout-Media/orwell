# Feature 0199 - the HOH room reveal (ORW-629). Design note: 0199-hoh-room-reveal.md.
# Everyone is invited to the new HOH's room. Not coming is rare and the house reads it as rude. Up there a guest's real feeling hides or slips by how well they can act. The photos and letter reveal one true thing from the HOH's own backstory. Roles only.

Feature: The new HOH opens their room to the whole house

  Scenario: Everyone is invited and skipping is rare
    Given hoh room: a house of invited guests with ordinary feelings toward the new HOH
    Then hoh room: every guest is invited, each one either comes or skips, and across many seasons skipping is rare

  Scenario: Strong feelings make a skip likelier but never certain
    Given hoh room: a house of invited guests with a strong grudge against the new HOH
    Then hoh room: across many seasons some skip and most still come

  Scenario: A good actor hides it and a poor one leaks it
    Given hoh room: guests who resent the new HOH
    Then hoh room: the best actors slip less often than the worst, and a guest with nothing against the HOH never slips

  Scenario: The letter reveals something true about the HOH
    Given hoh room: a houseguest whose public backstory is on file
    Then hoh room: every revealed fact is one the character itself carries and none repeats

  Scenario: The wall holds
    Given hoh room: a played game where the new HOH is crowned and the house resents them
    Then hoh room: the visit events name only who came, who skipped, who slipped and which way, and no surface shows a number or the mask

  Scenario: Switched off, nothing changes
    Given hoh room: a played game with the feature switched off
    Then hoh room: no visit is recorded and nothing is saved
