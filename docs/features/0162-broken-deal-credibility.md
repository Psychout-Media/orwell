# 0162 - A broken deal lowers the breaker's credibility (ORW-545)

The owner's Theme 2 ruling (Q3): no built-in tells, truth reaches the player only through normal paths; low trust in a person makes a low-trust deal. The mirror: a BROKEN deal counts against
the breaker's word like a caught lie.

As built, with no new belief kind and no new scale: when a formal deal is broken in an attributed way, the wronged NPC holds a `lied-to-me` claim about the breaker (confidence = 0.8 x
`breakSeverityScale`, the same weight as a broken casual assurance), and each formation witness holds one at the existing assurance witness factor (x0.5). `credibility()` (B48) already reads
those claims, so the breaker is believed for less from then on (it fades with the existing half-life, never raises, floors at the B48 floor). One claim per (holder, breaker, deal): the same break
counted twice is counted once. A kept deal writes nothing. A break tied to a SECRET eviction ballot writes nothing (it would name the voter; the E12/#1963 rule), and the player as wronged party
holds no claim (nothing acts on the player's hidden read). Gated by the existing `ORWELL_LIES_CAUGHT` flag (and the belief layer); off => byte-identical. No view shows credibility.

Pure part: `src/engine/dealCredibility.ts`. Writers: the deal-break `reveal` and `revealToWitness` sinks in `GameSessionAdapter`. Tests: `tests/unit/brokenDealCredibility.test.ts`, BDD `0162-broken-deal-credibility.feature`.

Waiting on the BDD Auditor's conviction slice (`dealTrust(trust)`, ORW-330): weighing a deal by the holder's trust in the other party is theirs; this slice does not scale by trust.
