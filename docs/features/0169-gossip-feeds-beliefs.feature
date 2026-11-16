# Feature 0169 - off-screen gossip feeds beliefs (theme 2; ORW-546, Ryne's ruling on question 2: belief and conviction decide how far heard gossip moves feelings and choices).
# Design note: 0169-gossip-feeds-beliefs.md. Builds on 0150 (beliefs drive decisions), 0160 (conviction) and the E44 gossip receipt.
# Before this, gossip told in the house changed what a houseguest KNEW (a heard-rumor belief with no teller) but nothing counted it in a choice.
# Now the rumor carries its teller and a conviction (trust in the teller, scaled by the listener's own credulity); a rumor that someone is
# dangerous is a soft grievance in nominations and votes; and where the telling moved no feelings, the same small move happens, scaled by
# conviction. Flag ORWELL_GOSSIP_BELIEFS, ON by default, "=0" restores today's record-only rumor byte for byte. Roles only.

Feature: Gossip feeds beliefs - what a houseguest hears moves them in proportion to how far they believe it

  Scenario: A heard rumor carries who told it and how far the listener believes it
    Given a played season with a houseguest who trusts the teller and one who does not
    When each hears the same betrayal rumor from the teller
    Then each holds the rumor with the teller as its source
    And the one who trusts the teller holds it with more conviction

  Scenario: A rumor that someone is dangerous nudges a choice, softly
    Given a listener who holds a firm betrayal rumor about a subject
    Then the rumor counts against the subject in the listener's choices
    And it is too soft to start a revenge goal on its own
    And an alliance rumor counts for nothing

  Scenario: A telling that moved no feelings still moves them, in proportion
    Given a played season with a listener who trusts the teller
    When the listener hears a betrayal rumor in a scene
    Then the listener's trust in the subject falls a little
    And a refuted rumor takes half of that back

  Scenario: The kill switch restores the record-only rumor
    Given a played season with the gossip-beliefs flag off
    When a listener hears a betrayal rumor from a teller
    Then the rumor has no source and counts in no choice
    And no feelings moved beyond what the telling already did
