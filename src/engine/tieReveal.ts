/**
 * Feature 0095 — the pre-show-TIE REVEAL pathway (the OVERHEAR route). A SEPARATE, distinct module from
 * 0059 §5's `seededTieSurfacing.ts`, which deliberately produces only ambient "these two seem close"
 * suspicion and folds nothing but a mild third-party re-read. This module is the time-bomb going off:
 * when a sealed tie's pair are conspicuously close, an observer catches the REAL connection (the actual
 * pre-show fact, not a vague hunch). The DIRECT witness (the observer) takes the full, near-confidence
 * `BETRAYAL_SHOCK` blow (0026) — a genuine betrayal-grade read, folded once, directly. Anyone the belief
 * DIFFUSES to afterward rides the EXISTING `GOSSIP_HEARD.betrayal` hearsay nudge (confidence-scaled, the
 * same small "about to turn on someone" fold any gossip already applies) — a fifth-hand rumor barely
 * registers, exactly the discipline `gossipFolds.test.ts`'s bounded-nudge gate holds every GOSSIP_HEARD
 * entry to; the strong fold belongs to direct witnessing, never to hearsay.
 *
 * CALIBRATION (sacred — mandate #4): the caller (`GameSessionAdapter.advanceTieReveal`) runs this ONLY
 * behind the default-ON `ORWELL_TIE_REVEAL` flag, on a DEDICATED rng (never the shared society/
 * competition/vote stream) — so with it off, or with no eligible tie, the seeded juryReach/gradient/UAT
 * sims never enter this code at all (byte-identical to the pre-feature build).
 */
import { isPrivateRoom, type Occupancy } from "../domain/house";
import type { EntityId } from "../domain/ids";
import type { KnowledgeService } from "../ports/KnowledgeService";
import type { RandomnessSource } from "../ports/RandomnessSource";
import type { RelationshipModel } from "./relationships";
import { scaleImpact, RELATIONSHIP_CONSTANTS } from "./relationshipConstants";
import { makeSocialGraph, diffuseGossip, GOSSIP } from "./gossip";
import { TIE_REVEAL } from "./tieRevealConstants";
import { nextTieExposure, tieExposureOf, type PreGameTie, type TieExposure } from "./seededRelationships";

export interface TieRevealDeps {
  /** The sealed pre-game ties (engine-only) — mutated in place by the caller from the returned event. */
  ties: readonly PreGameTie[];
  npcs: readonly EntityId[];
  player: EntityId;
  affinity: (a: EntityId, b: EntityId) => number;
  nameOf: (id: EntityId) => string;
  /** The Vault-free prose of WHY the pair knew each other (e.g. "already knew each other before the show"). */
  natureProse: (t: PreGameTie) => string;
  knowledge: KnowledgeService;
  /** The live relationship model — folds the direct-witness blow + rides `diffuseGossip`'s receipt fold. */
  rel: RelationshipModel;
  occupancy?: Occupancy;
  /** Per-season EXPOSURE count so far (ties promoted past `sealed`) — the hard cap. */
  exposureCount: number;
  /** A DEDICATED rng — MUST NOT be the shared society/vote stream (calibration neutrality). */
  rng: RandomnessSource;
}

/** What was exposed this tick (for tests/telemetry) — never the raw ids beyond what's already public. */
export interface TieRevealEvent {
  pair: readonly [EntityId, EntityId];
  observer: EntityId;
  /** The tie's exposure AFTER this event (never regresses) — the caller writes this back onto the tie. */
  exposure: TieExposure;
  /** True the FIRST time this tie is promoted past `sealed` (counts against the season cap). */
  firstExposure: boolean;
}

/**
 * Surface ONE conspicuous, unexposed-or-still-surfacing pre-game tie this tick (≤1 per call — the
 * reveal trickles, never bursts), or `[]` when nothing rose (no eligible tie, the cap is spent, the gate
 * stayed shut, or no observer was positioned). Vault-free by construction: what crosses is the SAME real
 * fact a genuine in-game pathway would carry (the pair's actual prior connection), never a raw sealed
 * record — the engine has already decided to expose it before this content is ever voiced.
 */
export function overhearTieReveal(deps: TieRevealDeps): TieRevealEvent[] {
  const { ties, npcs, player, affinity, nameOf, natureProse, knowledge, rel, occupancy, exposureCount, rng } = deps;
  if (exposureCount >= TIE_REVEAL.maxExposuresPerSeason) return [];
  const alive = new Set(npcs);

  const candidates = ties.filter((t) => {
    if (tieExposureOf(t) === "public") return false; // fully out already — nothing left to reveal
    if (!alive.has(t.a) || !alive.has(t.b)) return false;
    const mutual = Math.min(affinity(t.a, t.b), affinity(t.b, t.a));
    return mutual >= TIE_REVEAL.conspicuousAffinity;
  });
  if (candidates.length === 0) return [];
  if (rng.next() >= TIE_REVEAL.overhearProb) return [];
  const tie = candidates[rng.int(candidates.length)]!;
  const pair: readonly [EntityId, EntityId] = [tie.a, tie.b];

  const inPair = new Set<EntityId>(pair);
  const observers = npcs.filter((id) => !inPair.has(id) && !isPrivateRoom(occupancy?.get(id) ?? "kitchen"));
  if (observers.length === 0) return [];
  const pull = (id: EntityId): number => Math.max(affinity(id, tie.a), affinity(id, tie.b));
  const observer = observers.reduce((best, id) => (pull(id) > pull(best) ? id : best));

  const wasSealed = tieExposureOf(tie) === "sealed";
  const exposure = nextTieExposure(tieExposureOf(tie), "overhear");

  // The DIRECT witness fold — the observer's OWN read of BOTH members takes the FULL betrayal-grade
  // blow (0026's `BETRAYAL_SHOCK`, scaled by their near-full confidence), applied ONCE, before the
  // diffused/hearsay version spreads further (diffuseGossip below never folds the origin's own edges).
  for (const member of pair) {
    rel.applyImpactDirected(
      observer, member,
      scaleImpact(RELATIONSHIP_CONSTANTS.BETRAYAL_SHOCK, TIE_REVEAL.directWitnessConfidence),
      rng,
    );
  }

  // Diffuse the REAL connection NPC↔NPC (and to the player, if a chain reaches them) — WITH `rel` +
  // `subjects` this time (unlike 0059 §5's deliberately vague, fold-free observation), riding the
  // EXISTING `betrayal` GOSSIP_HEARD hearsay nudge (mild, confidence-scaled per learner — a secret
  // pre-alliance coming out reads exactly like any other "about to turn on someone" rumor once it's
  // secondhand). The PLAYER's own edges are never folded (0017 — the human forms their own read);
  // their KNOWLEDGE still updates if the chain reaches them.
  const everyone = [player, ...npcs];
  const edges: Array<readonly [EntityId, EntityId]> = [];
  for (let i = 0; i < everyone.length; i++) {
    for (let j = i + 1; j < everyone.length; j++) {
      if (affinity(everyone[i]!, everyone[j]!) > GOSSIP.affinityEdge) edges.push([everyone[i]!, everyone[j]!] as const);
    }
  }
  diffuseGossip({
    knowledge,
    graph: makeSocialGraph(edges),
    rng,
    origin: observer,
    fact: { content: `word is out: ${nameOf(tie.a)} and ${nameOf(tie.b)} ${natureProse(tie)} — they never told anyone` },
    rounds: GOSSIP.rounds,
    transmitProb: GOSSIP.transmitProb,
    decay: GOSSIP.decay,
    rel,
    subjects: pair,
    sceneType: "betrayal",
  });

  return [{ pair, observer, exposure, firstExposure: wasSealed }];
}
