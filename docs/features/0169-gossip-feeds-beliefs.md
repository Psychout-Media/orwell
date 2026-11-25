# 0169 - Off-screen gossip feeds beliefs

ORW-546 (theme 2, Ryne's question 2). Status: built, flag `ORWELL_GOSSIP_BELIEFS`, ON by default, `=0` is the kill switch.

## The gap

Gossip told off-screen already wrote a `heard-rumor` belief, but with no teller and a nature that no decision read. So the house knew more and acted the same. On the default path (the co-presence spread) it also moved no feelings.

## The rule

- **Source and conviction.** The rumor records its teller. Its confidence is the listener's conviction: trust in the teller (plus a kept-word credit) through the heard-tell confidence, scaled by the listener's own credulity (0160). `src/engine/gossipBeliefs.ts`.
- **Decisions.** A heard rumor with a teller and a threat nature (betrayal, conflict, strategy; not alliance, which is a bond not a threat) is a soft grievance, kind `rumored-threat`, weight 0.35 (`beliefDecisions.ts`). It gets decay, refutation, testing and the strength seam like every belief. Alone it is far below the revenge bar.
- **Feelings.** The E44 receipt fold stays the one feelings channel on the graph path. Where a telling folded nothing (the co-presence spread), the same fold is applied scaled by conviction, on its own stream `${seed}:gossip-belief:${listener}:${factId}`, never the shared society rng. The delta is kept on the claim so a refutation takes half of it back.
- **Gates.** Needs `ORWELL_NPC_BELIEFS` and full belief strength. Flag off: the observer is today's, claims carry no teller, so no decision counts them.

## Walls

Engine-only, hidden layer. Nothing is projected; the live-sentinel sweep now plays with the flag on and its planted gossip rumor is read by decisions.

## Not covered

Thread, legend and barter gossip paths still record nothing new. Follow-up if the owner wants them. (ORW-825)
