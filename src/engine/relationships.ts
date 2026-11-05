import type { EntityId } from "../domain/ids";
import type { RandomnessSource } from "../ports/RandomnessSource";
import { TEMPERATURE_CONSTANTS } from "../domain/temperatureConstants";
import {
  RELATIONSHIP_CONSTANTS,
  CURRENT_READ,
  clamp01 as clamp,
  scaleImpact,
  scaleImpactByValence,
  type EdgeSignals,
  type InteractionType,
  type RelationshipConstants,
  type RelationshipDisposition,
} from "./relationshipConstants";

/**
 * Directed, graded, asymmetric relationship beliefs (decision 0002): no binary
 * ally/enemy flags. An "alliance" is not stored — it's read off the graded
 * signals crossing a threshold, and can form or fracture as the signals move.
 *
 * The *shape* lives here (0017); the *numbers* — impacts, betrayal-shock, decay,
 * confidence, disposition × temperature — live in the single tunable constants
 * module (`relationshipConstants.ts`, feature 0026), injected so the feel is
 * retunable without touching this logic.
 */
export type { EdgeSignals, InteractionType, RelationshipDisposition };

const baseline = (c: RelationshipConstants): EdgeSignals => ({ ...c.baseline });
export const NEUTRAL_BOND =
  (RELATIONSHIP_CONSTANTS.baseline.trust + RELATIONSHIP_CONSTANTS.baseline.affinity) / 2;

/** A read below this confidence is a SUSPICION (hunch), not knowledge (decision 0002). */
export const CONFIDENCE_KNOWLEDGE = RELATIONSHIP_CONSTANTS.thresholds.knowledge;

export interface RelationshipRead {
  signals: EdgeSignals;
  confidence: number;
  kind: "knowledge" | "suspicion";
}

/**
 * Read an organic label from graded signals THROUGH the holder's disposition — the
 * same history reads as more of a threat to a paranoid (clash) holder and more of a
 * bond to a trusting (bond) one. Derived on the spot; an "ally/enemy" label is NEVER
 * stored (decision 0002).
 */
export function relationshipLabel(
  s: Pick<EdgeSignals, "trust" | "affinity" | "threat">,
  disposition: RelationshipDisposition,
  constants: RelationshipConstants = RELATIONSHIP_CONSTANTS,
): "ally" | "enemy" | "acquaintance" {
  const bond = (s.trust + s.affinity) / 2;
  const threatW = disposition === "clash" ? 1.5 : disposition === "bond" ? 0.6 : 1.0;
  const bondW = disposition === "bond" ? 1.5 : disposition === "clash" ? 0.6 : 1.0;
  const threatScore = s.threat * threatW;
  const bondScore = bond * bondW;
  if (threatScore >= bondScore) return threatScore > constants.thresholds.enemy ? "enemy" : "acquaintance";
  return bondScore > constants.thresholds.ally ? "ally" : "acquaintance";
}

/**
 * Feature 0088 — a living, per-NPC CURRENT read of the player, DERIVED on the spot
 * from the already-evolving hidden NPC→player edge (distinct from the FROZEN
 * dayOnePerception). Surfaced BEHAVIOR-ONLY as a Vault-safe carriage cue + a drift
 * word. Pure: no rng, no I/O, no Vault handle. Never a number, never the edge value.
 *
 * @param signals  The NPC→player edge signals (trust/affinity/threat).
 * @param disposition  The holder's framing (clash reads warmer as threat, etc.).
 * @param soulState  Optional emotional state (0..1), shades the toward word.
 * @param anchorBond  Optional anchor bond at a reference point (e.g. start of week);
 *                    absent ⇒ drift = "steady".
 */
export function currentReadOf(
  signals: Pick<EdgeSignals, "trust" | "affinity" | "threat">,
  disposition: RelationshipDisposition,
  soulState?: number,
  anchorBond?: number,
): { toward: string; drift: "warming" | "cooling" | "steady" } {
  const bond = (signals.trust + signals.affinity) / 2;
  // Disposition shades: a clash holder reads even a warm edge more guardedly.
  const dispScale = disposition === "bond" ? 1.15 : disposition === "clash" ? 0.85 : 1.0;
  // Soul shade: a rattled soul (low emotionalState) reads neutrally cooler.
  const soulScale = soulState !== undefined ? 0.75 + soulState * 0.5 : 1.0; // 0.75..1.25
  const effective = clamp(bond * dispScale * soulScale);

  const T = CURRENT_READ.toward;
  const W = CURRENT_READ.words;
  let toward: string;
  if (effective >= T.warm) toward = W.warm;
  else if (effective >= T.friendly) toward = W.friendly;
  else if (effective >= T.neutral) toward = W.neutral;
  else if (effective >= T.guarded) toward = W.guarded;
  else toward = W.wary;

  let drift: "warming" | "cooling" | "steady" = "steady";
  if (anchorBond !== undefined) {
    const delta = bond - anchorBond;
    if (delta > CURRENT_READ.driftEpsilon) drift = "warming";
    else if (delta < -CURRENT_READ.driftEpsilon) drift = "cooling";
  }

  return { toward, drift };
}

export class RelationshipModel {
  private readonly edges = new Map<string, EdgeSignals>();
  /** Per-holder disposition (from `Character`, 0004/0015) — the per-game-feel input (§7). */
  private readonly dispositions = new Map<EntityId, RelationshipDisposition>();

  constructor(
    private readonly allianceThreshold: number,
    private readonly constants: RelationshipConstants = RELATIONSHIP_CONSTANTS,
  ) {}

  private key(a: EntityId, b: EntityId): string {
    return `${a}->${b}`;
  }

  /** Set how a holder frames relationships (clash=sticky/paranoid, bond=forgiving). */
  setDisposition(holder: EntityId, disposition: RelationshipDisposition): void {
    this.dispositions.set(holder, disposition);
  }

  private dispositionOf(holder: EntityId): RelationshipDisposition {
    return this.dispositions.get(holder) ?? "neutral";
  }

  /** The stored (mutable) directed edge A→B, lazily created at baseline. */
  edge(a: EntityId, b: EntityId): EdgeSignals {
    const k = this.key(a, b);
    let e = this.edges.get(k);
    if (!e) {
      e = baseline(this.constants);
      this.edges.set(k, e);
    }
    return e;
  }

  /**
   * The firmed update rule (0026 §4): each signal moves by `impact × dispositionFactor ×
   * temperatureJitter`, clamped. Adverse moves (trust/affinity down, threat up) scale by the
   * holder's `adverseScale`; bonding moves by `bondScale`. Four jitter draws are taken in a
   * fixed order (trust, affinity, threat, alignment) so seeded runs stay reproducible — with a
   * NEUTRAL holder and default constants this is identical to the pre-0026 behavior.
   * `reliability` (E54: evidence, not sentiment) moves UN-jittered — proof is not a vibe — and
   * takes no rng draw, so the four-draw stream stays byte-stable.
   */
  private applyOneDirection(from: EntityId, to: EntityId, imp: Partial<EdgeSignals>, rng: RandomnessSource): void {
    const e = this.edge(from, to);
    const C = this.constants;
    const disp = C.dispositionFactors[this.dispositionOf(from)];
    const jitter = (): number => 1 + (rng.next() - 0.5) * C.TEMPERATURE_JITTER;
    const jTrust = jitter();
    const jAffinity = jitter();
    const jThreat = jitter();
    const jAlignment = jitter();
    const dTrust = imp.trust ?? 0;
    const dAffinity = imp.affinity ?? 0;
    const dThreat = imp.threat ?? 0;
    const dAlignment = imp.alignment ?? 0;
    const dReliability = imp.reliability ?? 0;
    e.trust = clamp(e.trust + dTrust * (dTrust < 0 ? disp.adverseScale : disp.bondScale) * jTrust);
    e.affinity = clamp(e.affinity + dAffinity * (dAffinity < 0 ? disp.adverseScale : disp.bondScale) * jAffinity);
    e.threat = clamp(e.threat + dThreat * (dThreat > 0 ? disp.adverseScale : disp.bondScale) * jThreat);
    e.alignment = clamp(e.alignment + dAlignment * disp.bondScale * jAlignment);
    e.reliability = clamp(e.reliability + dReliability * (dReliability < 0 ? disp.adverseScale : disp.bondScale));
    e.confidence = clamp(e.confidence + C.CONFIDENCE_STEP);
  }

  /** Apply a mutual interaction to both directed edges, with small per-telling jitter. */
  apply(a: EntityId, b: EntityId, type: InteractionType, rng: RandomnessSource): void {
    this.applyOneDirection(a, b, this.constants.IMPACT[type], rng);
    this.applyOneDirection(b, a, this.constants.IMPACT[type], rng);
  }

  /**
   * Directed update: only `holder`→`other` moves. One-sided investment (A bonds with B
   * who never reciprocates) makes the edges asymmetric — the heart of decision 0002.
   *
   * `scale` (feature 0109) multiplies the named impact's magnitude before the proven rule runs —
   * the engine-owned betrayal-duration lever (a near/at-end break costs less, a freshly-renewed one
   * more). DEFAULT 1 passes the base impact OBJECT UNCHANGED (same ref ⇒ byte-identical to pre-0109,
   * the calibration floor); only a `scale !== 1` builds a scaled copy. The four-draw jitter stream is
   * untouched either way (`scaleImpact` only changes the magnitudes `applyOneDirection` reads).
   */
  applyDirected(holder: EntityId, other: EntityId, type: InteractionType, rng: RandomnessSource, scale = 1): void {
    const base = this.constants.IMPACT[type];
    this.applyOneDirection(holder, other, scale === 1 ? base : scaleImpact(base, scale), rng);
  }

  /**
   * Directed update scaled ASYMMETRICALLY by the ACTOR's fatigue (#1419, the player-side mirror of the
   * off-screen social-fatigue fold). A tired `other` (the scene's initiator) sways the `holder` LESS on
   * WARMING components (charm/bonding dampened by `warm` < 1) and MORE on SOURING components (barbs
   * amplified by `sore` > 1) — "harder to scheme when you aren't sleeping." `warm === sore === 1` (rested /
   * fatigue off) passes the base impact OBJECT UNCHANGED (same ref ⇒ BYTE-IDENTICAL to `applyDirected`'s
   * default, the calibration floor); only a real deficit builds a valence-scaled copy. The four-draw jitter
   * stream is untouched either way (`applyOneDirection` reads only the magnitudes).
   */
  applyDirectedValence(
    holder: EntityId, other: EntityId, type: InteractionType, rng: RandomnessSource, warm = 1, sore = 1,
  ): void {
    const base = this.constants.IMPACT[type];
    const impact = warm === 1 && sore === 1 ? base : scaleImpactByValence(base, warm, sore);
    this.applyOneDirection(holder, other, impact, rng);
  }

  /**
   * Directed update from a NAMED impact object (ceremony acts E47/E48, deal honors E43, gossip
   * receipt E44) — the same proven rule (disposition × jitter × clamp), magnitudes from a
   * constants module, never an inline number at a call site (the B59 gate).
   */
  applyImpactDirected(holder: EntityId, other: EntityId, impact: Partial<EdgeSignals>, rng: RandomnessSource): void {
    this.applyOneDirection(holder, other, impact, rng);
  }

  /**
   * A BYSTANDER's read of a scene they witnessed but were NOT part of (audit 2026-06-18 owner
   * ruling: social play must move each witness by THEIR OWN beliefs — never the partner's full
   * bond, never a uniform group step). `observer`'s edge toward `actor` shifts a SMALL amount,
   * SIGNED by structural balance (how `observer` already feels about the `partners` the actor
   * engaged) and shaded by `observer`'s existing wariness of the actor:
   *   • likes the partner + a warm act → warms slightly to the actor;
   *   • dislikes the partner + a warm act → cools, and reads a forming threat;
   *   • already distrusts the actor → reads even a warm scene as scheming (threat ▲);
   *   • neutral on everyone → barely moves.
   * For an ADVERSE act the sign flips (siding against your friend cools you; hitting your rival
   * warms you). A witnessed BETRAYAL is the "universally human" exception — it chills the room
   * toward the actor directly (a small fraction of the real shock). Runs through the same proven
   * update rule (disposition × jitter × clamp); magnitudes are all config.
   */
  applyObservation(
    observer: EntityId, actor: EntityId, partners: readonly EntityId[], type: InteractionType, rng: RandomnessSource,
  ): void {
    if (observer === actor) return;
    const C = this.constants;
    const OB = C.OBSERVATION;
    const base = C.IMPACT[type];
    // Universally-human shock: the witnessed betrayal moves the room directly, scaled down.
    if (OB.universal.includes(type)) {
      this.applyImpactDirected(observer, actor, scaleImpact(base, OB.scale), rng);
      return;
    }
    // Structural-balance tilt ∈ [-1,1]: how the observer feels about who the actor engaged,
    // centered on baseline affinity. No partners (a solo/ambient beat) ⇒ no tilt ⇒ ~no move.
    let tilt = 0;
    if (partners.length) {
      let s = 0;
      for (const p of partners) s += this.edge(observer, p).affinity;
      const meanAff = s / partners.length;
      tilt = Math.max(-1, Math.min(1, (meanAff - C.baseline.affinity) / (1 - C.baseline.affinity)));
    }
    const warm = (base.affinity ?? 0) >= 0; // bonding/alliance/showmance/strategy/gossip warm; conflict adverse
    const valence = warm ? 1 : -1;
    const eo = this.edge(observer, actor);
    const wary = Math.max(0, eo.threat - eo.trust); // existing suspicion of the actor
    const imp: Partial<EdgeSignals> = {
      affinity: OB.scale * OB.refAffinity * tilt * valence,
      trust: OB.scale * OB.refTrust * tilt * valence,
      // Threat rises when the observer is wary of a warm overture, OR the actor moved against
      // someone the observer likes (tilt·valence < 0 ⇒ "you went at my friend / cozied to my rival").
      threat: OB.scale * OB.refThreat
        * ((warm ? wary * OB.suspicionWeight : 0) + Math.max(0, -tilt * valence)),
    };
    this.applyImpactDirected(observer, actor, imp, rng);
  }

  /**
   * A relationship read: the graded signals plus a confidence. Below the knowledge
   * threshold the read is a SUSPICION (a hunch with little data), not knowledge —
   * it firms up as consistent interactions accrue.
   */
  read(a: EntityId, b: EntityId): RelationshipRead {
    const e = this.edge(a, b);
    return {
      signals: { ...e },
      confidence: e.confidence,
      kind: e.confidence >= CONFIDENCE_KNOWLEDGE ? "knowledge" : "suspicion",
    };
  }

  /**
   * Neglect: mean-revert every edge toward baseline. `rate` ∈ (0,1]. Disposition-scaled
   * (0026 §6): a clash holder barely fades (sticky grudges/bonds), a bond holder fades fast
   * (forgiving). Threat reverts slower than warmth (`THREAT_DECAY_FACTOR`) so a blindside
   * outlasts a cold shoulder. A NEUTRAL holder at default constants keeps the prior behavior.
   */
  decay(rate: number): void {
    const C = this.constants;
    const base = C.baseline;
    for (const [k, e] of this.edges) {
      const holder = k.split("->")[0] as EntityId;
      const r = clamp(rate * C.dispositionFactors[this.dispositionOf(holder)].decayScale);
      e.trust += (base.trust - e.trust) * r;
      e.affinity += (base.affinity - e.affinity) * r;
      e.threat += (base.threat - e.threat) * r * C.THREAT_DECAY_FACTOR;
      e.alignment += (base.alignment - e.alignment) * r;
      e.confidence = clamp(e.confidence - r * 0.5);
      // `reliability` (E54) deliberately does NOT decay: evidence stands until contradicted.
    }
  }

  /** Plain-data snapshot of every directed edge — graded signals only, NEVER a stored label. */
  serialize(): { edges: Array<{ from: EntityId; to: EntityId } & EdgeSignals> } {
    const edges: Array<{ from: EntityId; to: EntityId } & EdgeSignals> = [];
    for (const [k, e] of this.edges) {
      const [from, to] = k.split("->") as [EntityId, EntityId];
      edges.push({ from, to, ...e });
    }
    return { edges };
  }

  /** Replace all edges from a serialized snapshot — recall after leaving/restart (0023/0007).
   *  Pre-E54 saves carry no `reliability`: those edges resume at the unproven baseline.
   *  PERSIST-3: `clamp01` (PERSIST-2) stops NEW NaN writes, but a save made BEFORE that fix (or any
   *  future bug that slips past it) can already carry a `null`/NaN numeric field on disk — JSON
   *  round-trips a NaN to `null`. A bare pass-through would let a `null` silently coerce to `0` on
   *  every downstream arithmetic read (`null + delta`), an undocumented, unannounced reset of that
   *  edge's value to its floor with no operator signal. Sanitize each field to the edge baseline
   *  (mirroring the existing `reliability ?? baseline.reliability` pattern) and log once per
   *  repaired field so a corrupted save is visible instead of silently self-healing to a wrong
   *  value. */
  load(edges: ReadonlyArray<{ from: EntityId; to: EntityId } & Omit<EdgeSignals, "reliability"> & { reliability?: number }>): void {
    this.edges.clear();
    const b = this.constants.baseline;
    const sanitize = (from: EntityId, to: EntityId, field: keyof EdgeSignals, v: number): number => {
      if (Number.isFinite(v)) return v;
      console.error(`[orwell] relationship edge ${from}->${to} had a non-finite "${field}" on load; repaired to baseline`);
      return b[field];
    };
    for (const e of edges) {
      this.edges.set(this.key(e.from, e.to), {
        trust: sanitize(e.from, e.to, "trust", e.trust),
        affinity: sanitize(e.from, e.to, "affinity", e.affinity),
        threat: sanitize(e.from, e.to, "threat", e.threat),
        alignment: sanitize(e.from, e.to, "alignment", e.alignment),
        confidence: sanitize(e.from, e.to, "confidence", e.confidence),
        reliability: sanitize(e.from, e.to, "reliability", e.reliability ?? this.constants.baseline.reliability),
      });
    }
  }

  /**
   * Houseguest's Choice / NPC motivation: pick the strongest available bond
   * (trust+affinity) with BOUNDED temperature variance — a clear bond is not
   * flipped by chance, but near-ties wobble. The default variance is the 0028
   * per-variable `allianceShift` weight (audit E53) — one knob, actually consumed.
   */
  chooseStrongestBond(
    holder: EntityId,
    candidates: EntityId[],
    rng: RandomnessSource,
    temperature = TEMPERATURE_CONSTANTS.variableWeights.allianceShift,
    /** B7 M4b (ORWELL_HC_MEMORY): an optional additive memory bias per candidate (favor / owed promise raise, grudge lowers). Absent => byte-identical; draws no rng. */
    memoryBias?: (candidate: EntityId) => number,
  ): EntityId {
    let best = candidates[0]!;
    let bestScore = -Infinity;
    for (const c of candidates) {
      const score = this.bondStrength(holder, c) + (rng.next() - 0.5) * temperature + (memoryBias ? memoryBias(c) : 0);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  /**
   * A soft, momentary read — the (trust+affinity) strength of a directed bond, shaded by
   * DEMONSTRATED loyalty (E54): a partner who has actually protected you reads as a stronger
   * bond than one who has merely been pleasant. Evidence shades sentiment, never replaces it.
   */
  bondStrength(a: EntityId, b: EntityId): number {
    const e = this.edge(a, b);
    return (e.trust + e.affinity) / 2
      + this.constants.RELIABILITY_WEIGHT * (e.reliability - this.constants.baseline.reliability);
  }

  /**
   * The veto-save read (E54 consumption tail): an NPC veto holder weighs WHO to save by trust
   * PLUS demonstrated loyalty — a nominee who has actually protected the holder (high reliability)
   * outranks an equally-liked one with no track record. Centered on the edge baseline so a clean,
   * unproven edge reads at its raw trust; evidence shades, never replaces (the `bondStrength` shape).
   * Compared against `thresholds.vetoSave` at the veto-save call sites (B59 — one number).
   */
  vetoSaveScore(holder: EntityId, candidate: EntityId): number {
    const e = this.edge(holder, candidate);
    return e.trust
      + this.constants.RELIABILITY_WEIGHT * (e.reliability - this.constants.baseline.reliability);
  }

  /**
   * The veto holder's save pick (E54 consumption tail): of the candidates the holder reads as
   * save-worthy (`vetoSaveScore` over `thresholds.vetoSave`), save the HIGHEST-scoring — so a
   * nominee who actually had the holder's back (high reliability) outranks an equally-trusted one
   * with no protective track record. Ties break by candidate order (deterministic). `undefined`
   * when no candidate clears the bar (the holder keeps the veto in their pocket).
   */
  chooseVetoSave(holder: EntityId, candidates: readonly EntityId[], bias?: (candidate: EntityId) => number): EntityId | undefined {
    let best: EntityId | undefined;
    let bestScore = this.constants.thresholds.vetoSave;
    for (const c of candidates) {
      // #1937: an optional campaign bias (a `protect` campaign on the candidate pushes toward saving them, an
      // `evict` one away) — added to the save score before the threshold; absent ⇒ +0, byte-identical.
      const score = this.vetoSaveScore(holder, c) + (bias?.(c) ?? 0);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  /** An alliance is "active" when the bond is mutual and over threshold. */
  allianceActive(a: EntityId, b: EntityId): boolean {
    return this.bondStrength(a, b) >= this.allianceThreshold && this.bondStrength(b, a) >= this.allianceThreshold;
  }

  /** Every stored directed bond strength — for change detection over time. */
  allBondStrengths(): number[] {
    return [...this.edges.values()].map((e) => (e.trust + e.affinity) / 2);
  }
}
