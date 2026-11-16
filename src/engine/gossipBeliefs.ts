import type { EntityId } from "../domain/ids";
import { convictionFor } from "./beliefConviction";
import { heardConfidence, tellerReliability } from "./heardAboutMe";
import { RUMOR_GLOSS } from "./gossip";

/**
 * Feature 0169 / ORW-546 - OFF-SCREEN GOSSIP FEEDS BELIEFS. Before this, gossip told in the house changed what a houseguest KNEW (a
 * `heard-rumor` belief, written with no teller) but not what they DID: no decision counted it. Now a heard rumor carries its teller
 * (`source`) and a CONVICTION - the listener's trust in the teller, scaled by their own credulity (Ryne's Q2 ruling: "how much I believe it
 * depends on how much I act on it") - and a rumor that someone is dangerous (betrayal, conflict, strategy; NOT an alliance) is a soft
 * grievance (`beliefDecisions.ts`, kind "rumored-threat"). The feelings channel is the existing E44 receipt fold; paths that fold nothing
 * (the co-presence spread) get the same fold scaled by conviction, on a forked stream. Pure rules; no I/O, no shared rng. ENGINE-ONLY.
 */

/** The scene natures a rumor can carry that make its subject look dangerous to the listener. An alliance rumor is not a threat (it is a perceived bond). */
export const THREAT_NATURES: ReadonlySet<string> = new Set(["betrayal", "conflict", "strategy"]);

/** The nature a rumor's text carries ("about to turn on someone" -> "betrayal"), or undefined when it matches none (drifted/hedged text still carries the gloss). */
export function natureFromContent(content: string): string | undefined {
  for (const [nature, gloss] of Object.entries(RUMOR_GLOSS)) if (content.includes(gloss)) return nature;
  return undefined;
}

/** How firmly the listener holds a tale: trust in the teller (plus a kept-word credit), through the heard-tell confidence, scaled by the listener's credulity. */
export function gossipConviction(trustInTeller: number, creditedAsKeepingWord: boolean, credulity: number): number {
  return convictionFor(heardConfidence(tellerReliability(trustInTeller, creditedAsKeepingWord)), credulity);
}

/** The dedicated stream for one listener's feelings fold from one fact: never the shared society rng (new draws there would re-roll every later tick). */
export const gossipBeliefStream = (seed: number | string, listener: EntityId, factId: string): string => `${seed}:gossip-belief:${listener}:${factId}`;
