import type { EntityId } from "../domain/ids";
import { PLAYER } from "../domain/ids";
import type { RandomnessSource } from "../ports/RandomnessSource";
import type { EventStore } from "../ports/EventStore";
import type { GameEvent } from "../domain/event";
import { RelationshipModel } from "./relationships";
import type { InteractionType, EdgeSignals } from "./relationships";
import {
  CONSEQUENCE_DIRECTION_IMPACTS, CONSEQUENCE_EMPHASIS, THIRD_PARTY_CONSEQUENCE, RELATIONSHIP_CONSTANTS,
  clamp01, scaleImpact, scaleImpactByValence, type ConsequenceDirection, type RelationshipConstants,
} from "./relationshipConstants";

/**
 * #1419 — the ASYMMETRIC fatigue valence for a scene's INITIATOR: a tired actor's WARMING folds land
 * softer (`warm` < 1) and their SOURING folds cut deeper (`sore` > 1). `{ warm: 1, sore: 1 }` (the
 * default everywhere) is a no-op ⇒ byte-identical to the pre-#1419 fold. Supplied on the player channel
 * from the session's rest deficit; absent / rested / clock-off ⇒ `NO_FATIGUE`.
 */
export interface FatigueValence { warm: number; sore: number }
export const NO_FATIGUE: FatigueValence = { warm: 1, sore: 1 };
const rested = (v: FatigueValence): boolean => v.warm === 1 && v.sore === 1;
/** ORW-561 (spec 0176): the valence may depend on WHICH edge moves (homophily is per pair). A plain valence applies to every edge (the pre-0176 shape); a function gets (holder, about) - the edge's two ends. */
export type ValenceSource = FatigueValence | ((holder: EntityId, about: EntityId) => FatigueValence);
const valenceFor = (v: ValenceSource, holder: EntityId, about: EntityId): FatigueValence => (typeof v === "function" ? v(holder, about) : v);
import { InMemoryEventStore } from "../adapters/inmemory/InMemoryEventStore";
import { SeededRandom } from "../adapters/random/SeededRandom";

/**
 * The consequence & memory loop (feature 0023) — the MVP-1 backbone.
 *
 *   happening → recorded as an event (witness set + hidden flag, 0002)
 *            → the engine folds its HIDDEN impact into the relationship layer (0017)
 *               (trust/affinity/threat move — your action changes how they feel about you)
 *            → snapshot persists every event detail + the derived hidden state (0007)
 *            → restore recalls the full superset on return/restart — the house remembers.
 *
 * The opinion change lives in the hidden layer only; it never reaches the player (Vault Wall,
 * 0001) — the player sees later behavior, never the ledger. The ENGINE owns the magnitude
 * (anti-sycophancy); a caller may PROPOSE the interaction's nature (`kind`).
 */
/**
 * A per-edge consequence PROPOSAL (ADR 0005 — the generative path). The caller/LLM reads the scene
 * and proposes WHICH directed edge moves, in WHICH direction, with what RELATIVE emphasis. The engine
 * owns the AMOUNT (it maps `direction`→signal+sign and `emphasis`→a bounded multiplier of its OWN
 * base) — so a proposal can never inflate how far a hidden number moves (anti-sycophancy #3).
 */
export interface EdgeConsequence {
  /** Whose hidden opinion of the initiator moves. */
  toward: EntityId;
  /** Which signal(s) move and their sign — a member of the closed `EdgeSignals` space. */
  direction: ConsequenceDirection;
  /** RELATIVE weight only (NOT a magnitude). */
  emphasis?: "slight" | "notable" | "strong";
}

/**
 * A per-edge THIRD-PARTY consequence PROPOSAL (Phase 1 of "the player can play offense" — layered
 * on ADR 0005). Unlike `EdgeConsequence` (whose opinion of the INITIATOR moves), this names a
 * SEPARATE directed edge: `holder`'s hidden opinion of `about`. The caller/LLM proposes the shape
 * (which edge, which direction, relative emphasis); the engine owns the amount, gates the fold on
 * `holder` having actually witnessed the scene (I3), and may fail/backfire (I2) rather than
 * auto-succeed. See `foldThirdPartyConsequence` below.
 */
export interface ThirdPartyConsequence {
  /** Who the initiator is actually talking to — MUST be a witness of this scene (I3/Vault Wall). */
  holder: EntityId;
  /** The third party whose standing with `holder` is being pitched (must differ from holder/initiator). */
  about: EntityId;
  /** Which signal(s) move and their sign — the SAME closed `EdgeSignals` space as `EdgeConsequence`. */
  direction: ConsequenceDirection;
  /** RELATIVE weight only (NOT a magnitude). */
  emphasis?: "slight" | "notable" | "strong";
}

/**
 * The generative-consequence descriptor (ADR 0005). Open-set interpretation (which edge, which
 * direction, why) rides here + the free-text `content`; the magnitude stays engine-owned. The
 * `rationale` is RECORDED (open-set content) but NEVER scored into any magnitude.
 */
export interface ConsequenceDescriptor {
  edges?: EdgeConsequence[];
  /** THIRD-PARTY proposals (Phase 1) — see `ThirdPartyConsequence` + `foldThirdPartyConsequence`. */
  aboutEdges?: ThirdPartyConsequence[];
  rationale?: string;
}

export interface Happening {
  initiator: EntityId;
  witnessSet: EntityId[];
  content: string;
  /** The interaction's nature (caller/LLM-proposed); the engine applies the magnitude (0017). */
  kind?: InteractionType;
  /** Whose hidden opinion of the initiator moves (default: the other witnesses). */
  toward?: EntityId[];
  /**
   * The OPTIONAL generative-consequence descriptor (ADR 0005). When present it REFINES the
   * partner-edge targeting/direction; `kind` stays the floor (it may still seed the base magnitude).
   * Absent ⇒ the fold is byte-identical to the `kind`-only path.
   */
  consequence?: ConsequenceDescriptor;
  /** Event kind for the record (default "conversation"). */
  type?: string;
}

export interface MemorySnapshot {
  events: GameEvent[];
  relationships: { edges: Array<{ from: EntityId; to: EntityId } & EdgeSignals> };
  seq: number;
  tick: number;
}

/**
 * THE hidden-impact fold (0023 — B59 collapsed the duplicate): the initiator's action moves how
 * the OTHERS feel about the initiator. The engine owns the magnitude (anti-sycophancy); callers
 * may propose the interaction's nature and a bounded `cap` (B39's flood guard). Used by BOTH the
 * 0023 ConsequenceEngine and the live `recordInteraction` seam — one implementation, zero drift.
 */
export function foldHiddenImpact(
  rel: RelationshipModel,
  rng: RandomnessSource,
  initiator: EntityId,
  witnessSet: readonly EntityId[],
  kind: InteractionType,
  toward?: readonly EntityId[],
  cap = Number.POSITIVE_INFINITY,
  bystanders?: readonly EntityId[],
  fatigue: ValenceSource = NO_FATIGUE,
): void {
  // PARTNERS — those the initiator actually engaged: the full directed fold. #1419 — scaled by the
  // initiator's fatigue valence (warming dampened, souring amplified); `NO_FATIGUE` ⇒ byte-identical.
  const partners = (toward ?? witnessSet.filter((w) => w !== initiator)).slice(0, cap);
  for (const o of partners) { const f = valenceFor(fatigue, o, initiator); rel.applyDirectedValence(o, initiator, kind, rng, f.warm, f.sore); }
  // BYSTANDERS — co-present witnesses who merely SAW it (audit 2026-06-18): each reacts by their
  // OWN beliefs, small and individuated, never the partner's full bond and never a uniform step.
  // (A bystander reads the scene by their OWN beliefs, so the initiator's fatigue does NOT scale it —
  // fatigue is the actor's reduced EFFECTIVENESS on the person they ENGAGED, not on a passer-by's read.)
  if (bystanders) {
    const seen = new Set(partners);
    for (const b of bystanders) {
      if (b === initiator || seen.has(b)) continue;
      rel.applyObservation(b, initiator, partners, kind, rng);
    }
  }
}

/**
 * Phase 3 of "the player can play offense" (audit finding SG-2, 2026-07-03 final-pre-ship audit) —
 * the PLAYER-CHANNEL RECIPROCAL fold. `foldHiddenImpact` above moves ONLY the partner's opinion OF
 * the initiator (`partner→initiator`); the initiator's OWN edge toward the people they just engaged
 * never budges. That is correct for the engine's off-screen society (an NPC bystander's belief
 * moving is enough) — but on the PLAYER channel it left `player→NPC` frozen at its move-in scatter
 * forever, under every mutual-bond gate `formAlliance`/`joinAlliance` (0107) and bloc detection
 * (0043) read, making them ~unreachable however much the player genuinely engaged.
 *
 * ADR 0002 holds the engine computes BOTH `NPC→player` and `player→NPC` from history (never a
 * number the player sees) — so when the PLAYER is the initiator of a `kind`-tagged scene, this
 * reciprocates a BOUNDED SHARE (`RECIPROCAL_SHARE`, always < 1 — the player's own read should firm
 * up more slowly than a houseguest's memorable read of the player) of the SAME engine-owned `kind`
 * impact onto `initiator→partner`, through the identical proven update rule (disposition × jitter ×
 * clamp). It spends NO new budget: `partners` is the list the caller ALREADY metered against the
 * per-beat-per-edge fold budget (E21) for the other direction, so this can never become a second,
 * unbounded pump lever.
 *
 * Scoped to PLAYER-initiated scenes only — a no-op for any other initiator. An NPC-initiated scene
 * reaching this channel already folds the reverse via `foldHiddenImpact`'s own partner pass (the
 * "other witness" IS the player in that case); live NPC-initiated calls don't happen today anyway
 * (`frontend/src/tool_implementations.py`'s `do_record_interaction` always sends `initiator: player`).
 * Draws its OWN rng — the isolated player-channel `commands:` stream `EngineCommandsAdapter` already
 * uses for overhears, never the main season/competition/vote stream, so this cannot perturb the
 * seeded calibration spine (`tests/property/juryReach.property.test.ts` never calls
 * `recordInteraction`, and the gradient gate's only exposure is its own isolated stream too).
 */
export function foldPlayerReciprocal(
  rel: RelationshipModel,
  rng: RandomnessSource,
  initiator: EntityId,
  partners: readonly EntityId[],
  kind: InteractionType,
  constants: RelationshipConstants = RELATIONSHIP_CONSTANTS,
): void {
  if (initiator !== PLAYER || partners.length === 0) return;
  const impact = scaleImpact(constants.IMPACT[kind], constants.RECIPROCAL_SHARE);
  for (const partner of partners) {
    if (partner === initiator) continue;
    rel.applyImpactDirected(initiator, partner, impact, rng);
  }
}

/**
 * The GENERATIVE-consequence fold (ADR 0005 — "split authority by openness"). Where `foldHiddenImpact`
 * collapses every social scene onto ONE global 7-way `kind` magnitude, this lets the caller/LLM propose
 * a PER-EDGE shape — which directed signal moves, in which direction, with what relative emphasis —
 * read off the specific scene. The engine still OWNS the amount (anti-sycophancy #3): the caller's
 * `direction` only selects which engine-owned base impact applies, and `emphasis` only picks a bounded,
 * clamped multiplier of it; no raw number ever crosses from the caller. Folds run through the SAME
 * proven update rule (`applyImpactDirected` → disposition × jitter × clamp) as every other fold.
 *
 * Important subtlety (ADR 0005): the relationship SIGNAL space (trust/affinity/threat/alignment) is
 * legitimately a small CLOSED, finite set — `direction` names a member of it, and that is fine. What
 * stays OPEN is the *interpretation* of the scene, which lives in the free-text `content` + the
 * recorded `rationale`, never collapsed. The generative win is the per-edge, scene-chosen
 * direction/targeting/emphasis REPLACING the single global `kind` — not a new closed enum by the back
 * door (these directions are just the existing edge signals, exposed).
 *
 * Returns the set of `toward` entities whose PARTNER edge the descriptor moved, so the caller can run
 * its own bystander pass on the witnesses the descriptor did NOT name (the partner/bystander split
 * stays the caller's, exactly as in the `kind`-only path). Respects the per-edge `cap` budget.
 */
export function foldGenerativeConsequence(
  rel: RelationshipModel,
  rng: RandomnessSource,
  initiator: EntityId,
  edges: readonly EdgeConsequence[],
  spend: (toward: EntityId) => boolean = () => true,
  fatigue: ValenceSource = NO_FATIGUE,
): Set<EntityId> {
  const moved = new Set<EntityId>();
  for (const e of edges) {
    if (e.toward === initiator) continue; // an action never folds onto its own initiator
    const base = CONSEQUENCE_DIRECTION_IMPACTS[e.direction];
    const factor = CONSEQUENCE_EMPHASIS[e.emphasis ?? "notable"]; // RELATIVE weight → engine multiplier
    // BE-101: `direction`/`emphasis` are caller-proposed open-set values (ADR 0005) — the MCP boundary
    // only shape-guards them as strings, never enum membership. An unrecognized value used to index
    // these lookup tables with no fallback: `base` came back `undefined` and `scaleImpact(undefined,…)`
    // threw (`Object.entries(undefined)`), or `factor` came back `undefined` and `v * undefined` wrote
    // a silent `NaN` into the PERMANENT relationship layer. Skip the edge instead — a proposal the
    // engine doesn't recognize folds nothing rather than crashing the call or corrupting state.
    if (!base || factor === undefined) continue;
    // ORW-1091: the budget is spent only on a fold that will land - a rejected proposal (above) spends nothing.
    if (!spend(e.toward)) continue; // the per-beat-per-edge budget (E21) gates the descriptor too
    // #1419 — a tired initiator's generative fold is valence-scaled too (charm dampened, barbs amplified);
    // `NO_FATIGUE` ⇒ `scaleImpact(base, factor)` unchanged (byte-identical).
    const scaled = scaleImpact(base, factor);
    const f = valenceFor(fatigue, e.toward, initiator);
    rel.applyImpactDirected(e.toward, initiator, rested(f) ? scaled : scaleImpactByValence(scaled, f.warm, f.sore), rng);
    moved.add(e.toward);
  }
  return moved;
}

/**
 * The THIRD-PARTY consequence fold (Phase 1 of "the player can play offense" — layered on ADR
 * 0005). Where `foldGenerativeConsequence` only lets a scene move how someone feels about the
 * INITIATOR, this lets the caller/LLM propose a completely separate directed edge: `holder`'s
 * hidden opinion of a THIRD PARTY (`about`) — the classic "I pulled Lorenzo aside and floated that
 * Maeve is the bigger threat." Three invariants hold this to the same discipline as every other
 * fold:
 *
 *  • I3 / Vault Wall (witness-gated): `holder` must be in `witnessSet` — a belief can only form
 *    from what was actually witnessed. An entry naming an absent holder is SILENTLY DROPPED, never
 *    minting an off-screen read from the player channel (off-screen life is the engine's alone to
 *    mint, `EngineCommandsAdapter`'s own player-witness invariant).
 *  • Anti-sycophancy #3 (engine owns the amount): `direction`/`emphasis` pick a member of the SAME
 *    closed sets `foldGenerativeConsequence` uses; the actual delta is the engine's own base scaled
 *    by a bounded, seeded TRUST GATE (the proven shape `campaignTilt` already uses, 0085) — a holder
 *    who barely trusts the initiator moves near the `trustFloor`, a trusted initiator's pitch lands
 *    closer to the full bounded amount. No raw number ever crosses from the caller.
 *  • I2 / anti-sycophancy (can fail or backfire): when `holder` doesn't trust the initiator AND
 *    already has a STRONGER bond with `about` than with the initiator, the pitch is at risk of
 *    reading as transparent manipulation — a seeded roll may BACKFIRE it: instead of moving
 *    holder→about at all, a small bounded hit lands on holder→initiator ("that felt like being
 *    worked"). A social move is never an auto-success lever.
 *
 * Rides the caller-supplied `spend(holder, about)` budget (the SAME per-beat-per-edge anti-pump
 * spend `EngineCommandsAdapter` already uses, keyed `holder->about` instead of `holder->initiator`)
 * so a scene can't spam a huge third-party swing. Pure aside from the injected `rng`; never mutates
 * its inputs beyond the relationship model's own proven update rule.
 */
export function foldThirdPartyConsequence(
  rel: RelationshipModel,
  rng: RandomnessSource,
  initiator: EntityId,
  witnessSet: ReadonlySet<EntityId> | readonly EntityId[],
  edges: readonly ThirdPartyConsequence[],
  spend: (holder: EntityId, about: EntityId) => boolean = () => true,
  fatigue: ValenceSource = NO_FATIGUE,
  /** ORW-1091: called just before a backfire lands on holder->initiator, so the fold meter can wear that edge too (no-op by default). */
  meterBackfire: (holder: EntityId, initiator: EntityId) => void = () => {},
): Set<EntityId> {
  const witnesses = witnessSet instanceof Set ? witnessSet : new Set(witnessSet);
  const moved = new Set<EntityId>();
  for (const e of edges) {
    // Never a self-pitch, never pitching someone's opinion of themselves or of the initiator (that
    // is what `edges`/`EdgeConsequence` is for — this channel is strictly third-party).
    if (e.holder === e.about || e.holder === initiator || e.about === initiator) continue;
    if (!witnesses.has(e.holder)) continue; // I3: only an ACTUAL witness can form this read
    const base = CONSEQUENCE_DIRECTION_IMPACTS[e.direction];
    const factor = CONSEQUENCE_EMPHASIS[e.emphasis ?? "notable"]; // RELATIVE weight → engine multiplier
    // BE-101: same open-set/closed-magnitude guard as `foldGenerativeConsequence` — an unrecognized
    // `direction`/`emphasis` must fold nothing, never crash or write NaN into the third-party edge.
    // ORW-1091: checked BEFORE the budget is spent and before the backfire roll, so a rejected pitch spends nothing and cannot backfire.
    if (!base || factor === undefined) continue;
    if (!spend(e.holder, e.about)) continue; // the per-beat-per-edge budget (E21) gates this channel too
    const B = THIRD_PARTY_CONSEQUENCE;
    const trustOfInitiator = rel.read(e.holder, initiator).signals.trust;
    const bondWithAbout = rel.bondStrength(e.holder, e.about);
    const bondWithInitiator = rel.bondStrength(e.holder, initiator);
    // I2 — the backfire gate: only at risk when the holder doesn't (yet) trust the initiator AND
    // already leans more toward the very person being pitched against. The roll is drawn ONLY when
    // the gate is open, so the common (trusted) case never spends an extra rng draw.
    if (trustOfInitiator < B.backfire.trustCeiling && bondWithAbout > bondWithInitiator
      && rng.next() < B.backfire.chance) {
      meterBackfire(e.holder, initiator); // ORW-1091: the edge a backfire lands on is metered like any other fold
      rel.applyImpactDirected(e.holder, initiator, B.backfire.impact, rng);
      continue; // the pitch backfired — holder->about is untouched
    }
    const trustMult = B.trustFloor + (1 - B.trustFloor) * clamp01(trustOfInitiator);
    // #1419 — a tired initiator lands a third-party pitch less warmly / more cuttingly too (valence-scaled
    // on top of the trust gate); `NO_FATIGUE` ⇒ byte-identical to the pre-#1419 pitch.
    const pitch = scaleImpact(base, factor * trustMult);
    const f = valenceFor(fatigue, e.holder, e.about);
    rel.applyImpactDirected(e.holder, e.about, rested(f) ? pitch : scaleImpactByValence(pitch, f.warm, f.sore), rng);
    moved.add(e.holder);
  }
  return moved;
}

export class ConsequenceEngine {
  private seq = 0;
  private tick = 0;

  constructor(
    private readonly events: EventStore,
    private readonly rel: RelationshipModel,
    private readonly rng: RandomnessSource,
  ) {}

  /** The hidden relationship layer (engine-only; never handed to a player surface). */
  relationships(): RelationshipModel {
    return this.rel;
  }

  /** Record a happening AND fold its hidden impact into the relationship layer. */
  record(h: Happening): { eventId: string } {
    const eventId = `evt:cons:${++this.seq}`;
    const ts = ++this.tick;
    this.events.record({
      id: eventId, ts, type: h.type ?? "conversation",
      initiator: h.initiator, witnessSet: h.witnessSet,
      hidden: !h.witnessSet.includes(PLAYER), content: h.content,
    });
    // The generative path (ADR 0005): a supplied descriptor refines the PARTNER-edge targeting/
    // direction (the engine still owns the amount). The named edges take the per-edge fold; any
    // `kind` then runs the bystander pass over the witnesses the descriptor did NOT name, so the
    // tag stays the floor. With NO descriptor, this is byte-identical to the prior `kind`-only path.
    const named = h.consequence?.edges?.length
      ? foldGenerativeConsequence(this.rel, this.rng, h.initiator, h.consequence.edges)
      : null;
    if (h.kind) {
      if (named) {
        const bystanders = h.witnessSet.filter((w) => w !== h.initiator && !named.has(w));
        foldHiddenImpact(this.rel, this.rng, h.initiator, h.witnessSet, h.kind, [], undefined, bystanders);
      } else {
        foldHiddenImpact(this.rel, this.rng, h.initiator, h.witnessSet, h.kind, h.toward);
      }
    }
    // Phase 1 (player-offense) — the SAME third-party channel the live `recordInteraction` seam
    // uses, witness-gated against this happening's own witness set (I3).
    if (h.consequence?.aboutEdges?.length) {
      foldThirdPartyConsequence(this.rel, this.rng, h.initiator, h.witnessSet, h.consequence.aboutEdges);
    }
    return { eventId };
  }

  /** A competition win is recorded as an event (consequential moment). */
  recordCompetitionWin(winner: EntityId, type: string): { eventId: string } {
    return this.record({ initiator: winner, witnessSet: [winner], content: `won the ${type} competition`, type: "competition" });
  }

  /** A vote against the player (or their interest): recorded + raises the voter's threat toward the player. */
  recordVoteAgainstPlayer(voter: EntityId, evictee: EntityId): { eventId: string } {
    const ack = this.record({ initiator: voter, witnessSet: [voter], content: `voted to evict ${evictee}`, type: "vote" });
    this.rel.applyDirected(voter, PLAYER, "conflict", this.rng); // threat ▲, affinity/trust ▼
    return ack;
  }

  /** Persist: every event detail + the derived hidden state (0007 — lossless, accumulating). */
  snapshot(): MemorySnapshot {
    return { events: this.events.queryAll(), relationships: this.rel.serialize(), seq: this.seq, tick: this.tick };
  }
}

/**
 * Recall: rebuild a ConsequenceEngine from a snapshot — re-recording every event into a fresh
 * store and reloading the hidden state. Simulates leaving/returning and a process restart; the
 * result is a SUPERSET of what was saved (never a reset, never a thinning).
 */
export function restoreMemory(snap: MemorySnapshot, allianceThreshold = 0.5, rng: RandomnessSource = new SeededRandom(1)): ConsequenceEngine {
  const events = new InMemoryEventStore();
  for (const e of snap.events) events.record(e); // ids/ts/hidden preserved exactly
  const rel = new RelationshipModel(allianceThreshold);
  rel.load(snap.relationships.edges);
  const engine = new ConsequenceEngine(events, rel, rng);
  // Restore the counters so new happenings continue (don't collide with restored ids).
  (engine as unknown as { seq: number; tick: number }).seq = snap.seq;
  (engine as unknown as { seq: number; tick: number }).tick = snap.tick;
  return engine;
}
