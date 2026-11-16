import { RICHNESS } from "./richnessConfig";
import type { EventStore } from "../ports/EventStore";
import type { RandomnessSource } from "../ports/RandomnessSource";
import type { EntityId, GameEvent } from "../domain/event";
import type { EdgeSignals } from "./relationshipConstants";
import type { InteractionType } from "./relationships";
import { SeededRandom } from "../adapters/random/SeededRandom";
import { hashSeed, type HiddenElement } from "./characterFactory";
import { hiddenSurfaces } from "../domain/temperatureConstants";
import { tiltNatureWeights, type Trajectory } from "./trajectory";

/**
 * Minimal off-screen life: records NPC-to-NPC interactions the player is not
 * present for (witness sets exclude the player; hidden until surfaced). Feature
 * 0003 (behavioral fidelity) builds the richness/volume thresholds on top of
 * this; here it exists so the visibility model has genuine off-screen events.
 */
export function simulateOffscreenStretch(deps: {
  events: EventStore;
  rng: RandomnessSource;
  npcs: readonly EntityId[];
  interactions: number;
}): GameEvent[] {
  const { events, rng, npcs, interactions } = deps;
  const verbs = ["schemed with", "gossiped about the house with", "bonded with", "argued with"];
  const produced: GameEvent[] = [];

  for (let i = 0; i < interactions; i++) {
    const a = rng.pick(npcs);
    let b = rng.pick(npcs);
    let guard = 0;
    while (b === a && guard++ < 16) b = rng.pick(npcs);

    const event: GameEvent = {
      id: `offscreen:${events.count()}:${rng.int(1_000_000_000)}`,
      ts: i,
      type: "conversation",
      initiator: a,
      witnessSet: [a, b],
      hidden: true,
      content: `${a} ${rng.pick(verbs)} ${b}`,
    };
    events.record(event);
    produced.push(event);
  }

  return produced;
}

/** A typed off-screen scene — the interaction's real nature, so callers fold the right impact. */
export interface OffscreenScene {
  event: GameEvent;
  type: InteractionType;
  initiator: EntityId;
  partner: EntityId;
}

/** The seven real interaction natures (matches `simulation.ts` / the relationship model). */
const RICH_VERBS: Record<InteractionType, string> = {
  alliance: "formed an alliance with",
  gossip: "gossiped about the house with",
  conflict: "clashed with",
  bonding: "bonded with",
  strategy: "talked strategy with",
  showmance: "grew close to",
  betrayal: "quietly turned on",
};
const RICH_TYPES = Object.keys(RICH_VERBS) as InteractionType[];

/**
 * Social-coherence tunables (audit E45): the off-screen society is MOTIVATED, not uniform noise.
 * Partners are drawn by the strength of any charged tie; a scene's NATURE follows the initiator's
 * actual read of that partner (affinity → bonding, alignment → strategy, threat → conflict); and
 * BETRAYAL is gated — you can only "quietly turn on" someone you genuinely bonded with, and only
 * with an incentive (a real threat read). Magnitudes live here only (the B59 pattern, like GOSSIP).
 */
export const SOCIETY = {
  /** A betrayal scene needs a PRIOR bond at least this strong — no betraying strangers. */
  betrayalBondFloor: 0.45,
  /** ...and an incentive: the initiator must read the bond-mate as at least this much threat. */
  betrayalThreatFloor: 0.25,
  /** Every (non-gated) nature keeps this floor weight so the house stays varied, never monotone. */
  baseWeight: 0.08,
  /** Gossip is ambient — a flat propensity beside the edge-driven natures. */
  gossipWeight: 0.3,
  /**
   * PV1 (#1029) — how often an off-screen scene NAMES THE PLAYER as its SUBJECT. The player was
   * structurally invisible to off-screen NPC cognition: partners are drawn from `npcs` only, so the
   * player could never be a scene subject — over a whole game NO NPC ever schemed/whispered/assessed
   * ABOUT them, though the player rode to Final 2. The fix lets an NPC's off-screen strategy/threat-
   * assessment beat occasionally read the PLAYER, framed by the existing NPC→player hidden edge. The
   * player is a SUBJECT only (named in the scene's hidden content), NEVER an initiator, NEVER in the
   * witness set (they must never "see" these scenes), and it reaches them ONLY via the existing
   * gossip/pathway mechanism — never directly. Rolled on a per-scene SIDE rng (hashed off the event
   * id) so the main `rng` stream — and the seeded calibration spine — stays byte-identical. Bounded /
   * occasional, exactly like the B50 hidden-element reveal it sits beside.
   */
  playerSubjectProb: 0.1,
  /**
   * OFF-SCREEN SCHEMING NAMES A REAL TARGET (Wave-2 fidelity enrichment; default ON, opt out via `ORWELL_SCHEME_TARGETS=0`).
   * The NPC counterpart of `playerSubjectProb`: a strategy/alliance/conflict scene between two NPCs is
   * really ABOUT a THIRD houseguest — the person they're plotting against — yet the scene names only its
   * two participants, so the hidden layer (and the gossip that rises from it) carried no concrete target.
   * When on, such a scene occasionally names the initiator's strongest live THREAT read among the OTHER
   * houseguests as the scheme's target — grounded in the real NPC→NPC edge, never invented. The target is
   * a SUBJECT only (named in still-hidden content), NEVER added to the witness set / made an actor, and it
   * reaches the player ONLY via the existing gossip/pathway mechanism. Rolled on the SAME kind of per-scene
   * SIDE rng as PV1 (distinct salt) so the main `rng` stream — and the seeded calibration spine — stays
   * byte-identical. Bounded / occasional, exactly like the B50 reveal and PV1 it sits beside.
   */
  schemeTargetProb: 0.14,
} as const;

/**
 * How an NPC initiator privately reads the PLAYER at an off-screen beat (PV1 #1029) — grounded in the
 * NPC→player hidden edge, never invented. A real threat read frames the player as a TARGET; a real
 * bond frames them as an ALLY; otherwise a watchful, undecided read. Returns the subject clause
 * appended to the scene's already-hidden content. The player is NAMED, never witnessed.
 */
export function playerSubjectClause(e: EdgeSignals, initiator: EntityId, player: EntityId): string {
  const bond = (e.trust + e.affinity) / 2;
  if (e.threat >= SOCIETY.betrayalThreatFloor && e.threat >= bond) {
    return ` — ${initiator} sizes up ${player} as a threat they need gone`;
  }
  if (bond >= SOCIETY.betrayalBondFloor && bond > e.threat) {
    return ` — ${initiator} counts ${player} as someone to work with to the end`;
  }
  return ` — ${initiator} is still reading ${player}, unsure where they land`;
}

/**
 * OFF-SCREEN SCHEMING NAMES A REAL TARGET — the initiator's strongest live THREAT read among the OTHER
 * houseguests (never the scene partner, never the player), or `undefined` when no candidate reads as a
 * genuine threat (no incentive to scheme about anyone — no target is invented). Pure over the supplied
 * edge reader; grounded in the real NPC→NPC edge, so a scheme names a plausible target, never a random
 * name. Returns the entity id; the caller appends the clause to the scene's already-HIDDEN content.
 */
export function schemeTargetOf(
  edgeOf: (from: EntityId, to: EntityId) => EdgeSignals,
  initiator: EntityId,
  exclude: readonly EntityId[],
  pool: readonly EntityId[],
): EntityId | undefined {
  let best: EntityId | undefined;
  let bestThreat: number = SOCIETY.betrayalThreatFloor; // a real incentive floor — below it, nobody is worth scheming on
  for (const c of pool) {
    if (c === initiator || exclude.includes(c)) continue;
    const threat = edgeOf(initiator, c).threat;
    if (threat > bestThreat) {
      bestThreat = threat;
      best = c;
    }
  }
  return best;
}

/** The clause a scheming scene gets when it names its real third-party target — grounded in the
 *  initiator's threat read, appended to the scene's still-hidden content. No number ever crosses. */
export function npcTargetClause(initiator: EntityId, target: EntityId, type: InteractionType): string {
  if (type === "alliance") return ` — plotting to take ${target} out`;
  if (type === "conflict") return ` — both fed up with ${target}`;
  return ` — ${initiator} wants ${target} gone next`;
}

/** One weighted draw. `weights` must be non-negative; zero-total falls back to the first item. */
function weightedPick<T>(items: readonly T[], weights: readonly number[], rng: RandomnessSource): T {
  const total = weights.reduce((a, w) => a + w, 0);
  if (total <= 0) return items[0]!;
  let roll = rng.next() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i]!;
    if (roll <= 0) return items[i]!;
  }
  return items[items.length - 1]!;
}

/** The nature propensities of a scene FROM the initiator's directed read of the partner (E45). */
function natureWeights(e: EdgeSignals): number[] {
  const bond = (e.trust + e.affinity) / 2;
  return RICH_TYPES.map((t) => {
    switch (t) {
      case "bonding": return e.affinity + SOCIETY.baseWeight;
      case "showmance": return e.affinity * 0.5 + SOCIETY.baseWeight;
      case "alliance": return (e.trust + e.alignment) / 2 + SOCIETY.baseWeight;
      case "strategy": return e.alignment + SOCIETY.baseWeight;
      case "gossip": return SOCIETY.gossipWeight + SOCIETY.baseWeight;
      case "conflict": return e.threat + SOCIETY.baseWeight;
      case "betrayal":
        // Gated (E45): only over an existing bond AND with incentive — and never floored.
        return bond >= SOCIETY.betrayalBondFloor && e.threat >= SOCIETY.betrayalThreatFloor
          ? e.threat * bond
          : 0;
    }
  });
}

/**
 * Richer off-screen life (feature 0038): the house lives in MORE than one way —
 * each scene carries its real interaction *type* (alliance/gossip/conflict/…), so
 * the caller folds the correct hidden impact and information can travel by kind.
 * Hidden (witness excludes the player), bounded by `interactions`, seed-deterministic.
 *
 * With `edgeOf`/`occupancy` (audit E45) the society is socially COHERENT: scenes happen between
 * CO-PRESENT houseguests (the 0049 presence model is ground truth — no scene between people in
 * different rooms), partners are drawn by tie strength, natures follow the relationship, and
 * betrayal only fires over a real prior bond with incentive. Without those deps the legacy
 * uniform draw is preserved byte-for-byte (pure tests and the pre-wiring tick are unchanged).
 */
/**
 * 0120 — the STRATEGIC-DRIVE initiator cadence weights (tunable in one place). Deliberately a SLIGHT
 * slope (the owner's "slight variance, not wildly skewed"): across the mental range the weight roughly
 * doubles at the extremes, so a sharp mind schemes a touch more often than a passive one — never dominates.
 */
export const STRATEGIC_CADENCE = {
  floor: 0.7,        // the least-strategic houseguest's relative initiate rate
  mentalSlope: 0.6,  // added across mental ∈ [0,1] — strategic intelligence
  styleBonus: 0.15,  // a scheming-forward strategyStyle nudges up; a passive one down — personality
};

const SCHEMING_STYLES: ReadonlySet<string> = new Set(["strategic", "aggressive"]);
const PASSIVE_STYLES: ReadonlySet<string> = new Set(["under-the-radar", "loyal"]);

/**
 * 0120 — a bounded, gently-sloped POSITIVE weight for how often a houseguest INITIATES an off-screen
 * scene, from their strategic intelligence (`mental`) + personality (`strategyStyle`). Pure; no rng.
 * Always > 0 so `weightedPick` has a valid distribution. Engine-internal (the off-screen society is
 * hidden) — never a player-facing number.
 */
export function strategicDriveWeight(mental: number, style?: string): number {
  const m = Math.max(0, Math.min(1, mental));
  let w = STRATEGIC_CADENCE.floor + STRATEGIC_CADENCE.mentalSlope * m;
  if (style && SCHEMING_STYLES.has(style)) w += STRATEGIC_CADENCE.styleBonus;
  else if (style && PASSIVE_STYLES.has(style)) w -= STRATEGIC_CADENCE.styleBonus;
  return Math.max(0.1, w);
}

export function richOffscreenStretch(deps: {
  events: EventStore;
  rng: RandomnessSource;
  npcs: readonly EntityId[];
  interactions: number;
  /**
   * The initiator's hidden elements (B50). When provided, one RARELY (gated by `hiddenSurfaces`)
   * surfaces into the scene's HIDDEN content — never reaching the player without a later pathway.
   * Rolled on a per-scene SIDE rng (hashed off the event id) so the main `rng` stream is untouched.
   */
  hiddenElementsOf?: (id: EntityId) => readonly HiddenElement[];
  /** The initiator's directed relationship read (E45) — when present, scenes are motivated. */
  edgeOf?: (from: EntityId, to: EntityId) => EdgeSignals;
  /** Who is in which room (0049/E45) — when present, scenes require co-presence. */
  occupancy?: ReadonlyMap<EntityId, string>;
  /**
   * Orientation-plausibility gate for a SHOWMANCE scene (#840 — mirrors the seeded layer's 0063
   * `showmanceEligible`, `src/engine/diversity.ts#showmancePlausible`). When supplied, a drawn
   * `showmance` between an orientation-implausible pair is DEMOTED to ordinary `bonding` (warm
   * downtime, not romance) — a QUEER showmance is first-class, only a pairing that makes no sense
   * for BOTH parties is ruled out. Omitted ⇒ no gating (back-compat: pre-0063 casts, pure tests).
   */
  showmancePlausible?: (a: EntityId, b: EntityId) => boolean;
  /**
   * Active-showmance EXCLUSIVITY source (#840 — mirrors the seeded layer's one-partner discipline,
   * `src/engine/seededRelationships.ts`). When supplied, returns whether a houseguest ALREADY holds
   * an active showmance partner coming into this stretch (the seeded showmance layer). A drawn
   * `showmance` is demoted to `bonding` if either party is already partnered (pre-existing OR newly
   * paired earlier in THIS stretch), so no houseguest ever holds more than one active showmance.
   */
  hasActiveShowmance?: (id: EntityId) => boolean;
  /**
   * PV1 (#1029) — make the PLAYER a SUBJECT of off-screen NPC cognition. When supplied, an NPC
   * initiator's STRATEGY / THREAT-or-TRUST assessment beat occasionally (gated by
   * `SOCIETY.playerSubjectProb`) names the player in its still-HIDDEN content, framed by the
   * initiator's `edgeOf` read of the player. CRITICAL (Vault Wall): the player is a SUBJECT only —
   * `id` is NEVER added to the scene's witness set, NEVER becomes an initiator/partner, and these
   * scenes reach the player ONLY through the existing gossip/pathway mechanism (they are hidden
   * here). Rolled on the same per-scene SIDE rng as the B50 reveal, so the main `rng` stream stays
   * byte-identical (omitted ⇒ no player subject: the pure tests and the pre-wiring tick are intact).
   * Requires `edgeOf` (the motivated path) — in the legacy uniform draw there is no edge to read.
   */
  playerSubject?: EntityId;
  /**
   * RELATIONSHIP TRAJECTORIES (feature 0087, default ON, opt out via `ORWELL_TRAJECTORIES=0`). When supplied (live-society
   * trajectories ON), the directed `a→b` arc's hidden momentum TILTS this scene's nature weights toward
   * continuing the arc (`tiltNatureWeights` over `natureWeights`'s output) BEFORE the existing single
   * `weightedPick` — so a curdling friendship gets more clash scenes as it cools. CRITICAL (calibration):
   * the tilt re-weights the SAME draw and adds NO rng — draw count/order are unchanged, only which nature a
   * draw lands on shifts — so the seeded competition/vote spine reading this same stream stays in phase.
   * Absent (the default) ⇒ today's `natureWeights` exactly (byte-identical). Requires `edgeOf` (the
   * motivated path; the legacy uniform draw has no per-pair nature weights to tilt).
   */
  trajectoryOf?: (a: EntityId, b: EntityId) => Trajectory;
  /**
   * STRATEGIC-DRIVE INITIATOR CADENCE (feature 0120, default ON, opt out via `ORWELL_STRATEGIC_CADENCE=0`). When supplied,
   * the initiator of each off-screen scene is drawn WEIGHTED by each houseguest's strategic drive (a
   * bounded, gently-sloped positive weight — a sharper/more-strategic player schemes a touch more often;
   * "slight variance", never a wild skew). CRITICAL (calibration): it replaces the uniform `rng.pick` with
   * a single-draw `weightedPick` — the SAME one `rng.next()` — so the draw count/order is unchanged and the
   * seeded competition/vote spine reading this same stream stays in phase; only WHICH eligible initiator
   * this one draw lands on shifts. Absent (the default / the calibration harness) ⇒ today's uniform
   * `rng.pick` exactly (byte-identical). Requires `edgeOf` (the motivated path).
   */
  initiatorDriveOf?: (id: EntityId) => number;
  /**
   * OFF-SCREEN SCHEMING NAMES A REAL TARGET (Wave-2 fidelity enrichment, default ON, opt out via `ORWELL_SCHEME_TARGETS=0`).
   * When true (and `edgeOf` present), a strategy/alliance/conflict scene occasionally NAMES the initiator's
   * strongest live THREAT read among the OTHER houseguests as the scheme's target in its still-HIDDEN content
   * (`schemeTargetOf`/`npcTargetClause`, gated by `SOCIETY.schemeTargetProb`). CRITICAL (Vault Wall): the
   * named target is a SUBJECT only — never added to `witnessSet`, never an initiator/partner, and reaches the
   * player ONLY via the existing gossip/pathway mechanism (the scene is hidden here). CRITICAL (calibration):
   * rolled on a per-scene SIDE rng (keyed off the event id, distinct salt from the B50 reveal and PV1) so the
   * main `rng` stream stays byte-identical — absent/false ⇒ no target clause (the pure tests and the seeded
   * spine are untouched). Requires `edgeOf` (the motivated path has the reads to ground a real target).
   */
  nameSchemeTargets?: boolean;
}): OffscreenScene[] {
  const {
    events, rng, npcs, interactions, hiddenElementsOf, edgeOf, occupancy,
    showmancePlausible, hasActiveShowmance, playerSubject, trajectoryOf, initiatorDriveOf,
    nameSchemeTargets,
  } = deps;
  const scenes: OffscreenScene[] = [];
  // #840 — houseguests who pick up a NEW showmance partner during this stretch, so a later scene in
  // the same stretch cannot give one person a second partner (the one-partner cap, within-tick half).
  const newlyPartnered = new Set<EntityId>();
  let revealsThisStretch = 0; // the no-dumping cap, per stretch (one committed moment's off-screen tick)

  for (let i = 0; i < interactions; i++) {
    let a: EntityId;
    let b: EntityId;
    let type: InteractionType;
    if (edgeOf) {
      // E45 — the motivated, co-present draw.
      const candidatesFor = (x: EntityId): EntityId[] => {
        const room = occupancy?.get(x);
        return npcs.filter((n) => n !== x && (!occupancy || occupancy.get(n) === room));
      };
      const initiators = npcs.filter((n) => candidatesFor(n).length > 0);
      if (initiators.length === 0) break; // nobody shares a room with anybody — no scene to have
      // 0120 — the sharper players scheme a touch more often: a single-draw WEIGHTED pick by strategic
      // drive when supplied (byte-identical uniform `rng.pick` when off — same one rng.next() either way).
      a = initiatorDriveOf
        ? weightedPick(initiators, initiators.map((n) => initiatorDriveOf(n)), rng)
        : rng.pick(initiators);
      const candidates = candidatesFor(a);
      b = weightedPick(
        candidates,
        // Any charged tie pulls a pair together: warmth, shared agenda, or friction.
        candidates.map((c) => {
          const e = edgeOf(a, c);
          return e.affinity + e.alignment + e.threat + SOCIETY.baseWeight;
        }),
        rng,
      );
      // The scene's nature follows the initiator's read (E45). Feature 0087: when a trajectory is
      // supplied, the directed `a→b` arc's momentum TILTS those weights toward continuing the arc FIRST
      // (`tiltNatureWeights`) — a `steady`/zero-momentum arc is the identity (byte-identical). The tilt is
      // applied to the SAME single `weightedPick` below, so it consumes NO extra rng: the off-screen draw
      // sequence is unchanged with trajectories on, only which nature this one draw lands on shifts.
      const baseWeights = natureWeights(edgeOf(a, b));
      const weights = trajectoryOf ? tiltNatureWeights(RICH_TYPES, baseWeights, trajectoryOf(a, b)) : baseWeights;
      type = weightedPick(RICH_TYPES, weights, rng);
    } else {
      // The legacy uniform draw (kept byte-stable for pure tests and the pre-E45 tick).
      a = rng.pick(npcs);
      b = rng.pick(npcs);
      let guard = 0;
      while (b === a && guard++ < 16) b = rng.pick(npcs);
      type = rng.pick(RICH_TYPES);
    }

    // #840 — gate a SHOWMANCE scene the same way the SEEDED layer gates a showmance: it may only form
    // between an orientation-PLAUSIBLE pair, and no houseguest may hold more than ONE active showmance
    // partner. An ineligible draw is DEMOTED to ordinary `bonding` (a warm, non-romantic downtime
    // scene) rather than re-drawn — so this consumes ZERO extra rng and the seeded competition/vote
    // spine stays in phase (only the gated scene's nature/fold changes). Gates only when the relevant
    // dep is supplied (omitted ⇒ no gating: pre-0063 casts and the pure byte-identity paths are intact).
    // `bonding` and `showmance` are both FRIENDLY natures (affinity-only fold), so the demotion stays a
    // friendly scene — it never injects strategic (vote-affecting) weight.
    if (type === "showmance") {
      const orientationOk = !showmancePlausible || showmancePlausible(a, b);
      const exclusivityOk = !hasActiveShowmance
        || (!hasActiveShowmance(a) && !hasActiveShowmance(b) && !newlyPartnered.has(a) && !newlyPartnered.has(b));
      if (!orientationOk || !exclusivityOk) {
        type = "bonding"; // demote: they grew close, but it is not a romance
      } else if (hasActiveShowmance) {
        // A genuine new showmance forms — claim BOTH so a later scene this stretch can't re-pair either.
        newlyPartnered.add(a);
        newlyPartnered.add(b);
      }
    }

    const event: GameEvent = {
      // Store-size-keyed id (the B40 lesson, found live by the B71 smoke): a restarted process
      // re-seeds the per-user rng, so an index+rng id REGENERATES identically against a restored
      // store and the duplicate-id guard kills the tick. The store size is restart-monotonic.
      id: `offscreen:${type}:${events.count()}:${rng.int(1_000_000_000)}`,
      ts: i,
      type,
      initiator: a,
      witnessSet: [a, b],
      hidden: true,
      content: `${a} ${RICH_VERBS[type]} ${b}`,
    };
    event.baseContent = event.content; // capture the Vault-free base before enrichment
    // B50: a hidden element of the initiator occasionally slips into the (still-hidden) scene — the
    // rare-reveal "treat" loop. The side rng keeps the main stream byte-stable; the content stays hidden.
    // NO DUMPING (0003, #2005): each scene's reveal is rare on its own, but a stretch plays several scenes and nothing capped their SUM, so a
    // single moment could surface two hidden elements. The stretch now reveals at most `RICHNESS.MAX_REVEALS_PER_MOMENT` (the side-rng draws
    // below are unchanged, so the only effect is that a later scene's would-be reveal is dropped and its content stays plain).
    if (hiddenElementsOf) {
      const side = new SeededRandom(hashSeed(event.id));
      if (hiddenSurfaces(side) && revealsThisStretch < RICHNESS.MAX_REVEALS_PER_MOMENT) {
        const els = hiddenElementsOf(a);
        if (els.length > 0) {
          event.content += ` — ${a} ${els[side.int(els.length)]!.detail}`;
          event.reveal = true; // structural (B54): the richness gate counts reveals from the store
          revealsThisStretch++;
        }
      }
    }
    // PV1 (#1029) — the PLAYER as a SUBJECT of NPC cognition. On a STRATEGY/THREAT-driven scene the
    // initiator occasionally turns their private read onto the player (never a partner here — the
    // player is co-present in the *game*, not this NPC-only scene). The clause is grounded in the
    // initiator's NPC→player edge. The player is NAMED in the still-hidden content but is NEVER added
    // to `witnessSet` (so `validateEvent` holds and the player can never "see" it) and never becomes
    // an actor — it surfaces only later via gossip/pathways. The side rng (keyed off the event id,
    // distinct salt from the B50 reveal) keeps the main stream byte-identical; requires `edgeOf`.
    if (playerSubject && edgeOf && playerSubject !== a && playerSubject !== b
        && (type === "strategy" || type === "conflict" || type === "alliance")) {
      const side = new SeededRandom(hashSeed(`${event.id}:player-subject`));
      if (side.next() < SOCIETY.playerSubjectProb) {
        event.content += playerSubjectClause(edgeOf(a, playerSubject), a, playerSubject);
      }
    }
    // OFF-SCREEN SCHEMING NAMES A REAL TARGET — a strategy/alliance/conflict scene occasionally names the
    // initiator's strongest THREAT read among the OTHER houseguests as the scheme's target (grounded in the
    // real NPC→NPC edge). The target is a SUBJECT only: never a witness, never an actor — it surfaces only
    // later via gossip/pathways. The side rng (distinct salt) keeps the main stream byte-identical; requires
    // `edgeOf`. The player is never a target here (PV1 above owns the player-subject case; excluded below).
    if (nameSchemeTargets && edgeOf
        && (type === "strategy" || type === "conflict" || type === "alliance")) {
      const side = new SeededRandom(hashSeed(`${event.id}:scheme-target`));
      if (side.next() < SOCIETY.schemeTargetProb) {
        const exclude = playerSubject ? [b, playerSubject] : [b];
        const target = schemeTargetOf(edgeOf, a, exclude, npcs);
        if (target) event.content += npcTargetClause(a, target, type);
      }
    }
    events.record(event);
    scenes.push({ event, type, initiator: a, partner: b });
  }

  return scenes;
}
