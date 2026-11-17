# Feature 0179 - the house's shape in how news spreads (Theme 3 slice 9, ORW-552; Ryne approved the Theme 3 plan 2026-11-17).
# Design note: 0179-network-shape-in-the-spread.md. Code: src/engine/networkSpread.ts (pure), the co-presence spread's motive, the adapter's networkRoles().
# Built on the house graph (0177: cliques, brokers, loners, from the bonds) and Theme 2's co-presence spread (a holder passes a fact on, or not, scene by
# scene). A broker carries news across cliques; a casual tie between cliques carries it too; a loner hears late. Engine-only: no role, motive or graph reaches
# the player. Flag ORWELL_NETWORK_SPREAD (default ON; =0 = the spread reads no shape). Roles only.

Feature: The house's shape in how news spreads

  Background:
    Given a played season whose house has two close cliques, a broker tied into both, and a loner

  Scenario: A broker carries news about one clique to the other more readily
    When the broker, holding news about someone in the first clique, meets someone from the second clique many times over
    Then they pass it on more often than they would in a house with no shape

  Scenario: A loner hears late
    When a clique member, holding news, meets the loner many times over, and meets a clique friend as many times
    Then they pass it to the loner less often than to the friend

  Scenario: The house's shape is never shown
    Then no player or admin view carries a clique, a broker, a loner or a role
