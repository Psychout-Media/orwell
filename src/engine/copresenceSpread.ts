import type { EntityId } from "../domain/ids";
import type { KnowledgeService } from "../ports/KnowledgeService";
import type { RandomnessSource } from "../ports/RandomnessSource";
import { disclosureDecision, topHeldFacts, type DisclosureInput, type HeldFact } from "./disclosure";
import { heldCandidates, type ToldLedger, type Told } from "./heldFacts";
import { GOSSIP, driftRetelling } from "./gossip";
import { GOSSIP_DRIFT } from "./gossipDriftConstants";
import type { VoiceProfile } from "../domain/voiceProfile";
import type { StrategyStyle } from "./characterFactory";
import { networkMotive, type NetworkRoles } from "./networkSpread";

/**
 * B10 / B11 slice 3 (design S3) - the scene-time SPREAD. For each CO-PRESENT pair of a night's off-screen scenes (the scene IS the co-presence: both are in the room), each side, as holder,
 * considers the facts they hold that the other lacks (top-K by motive, ASSUMED K=2 pending Ryne), draws ONE closed-set decision per (holder, fact, listener) ONCE (the told ledger), and a `share`
 * or `slip` moves the fact exactly ONE hop through `KnowledgeService.transmitGossip` (recorded as an event with the telling pair as witnesses - the same receipt path the graph diffusion used).
 * No network hops, no cross-room spread. Replaces the automatic graph rumor ONLY while `ORWELL_GOSSIP_COPRESENCE` is on (the default) (default ON, so off is byte-identical: this is never called).
 * B34: SPIN is applied to the TRANSMISSION, never to authored text (ASSUMED, pending Ryne - the engine holds structured facts, not scripts, so it cannot write a falsehood): a `spun` share arrives with a
 * little distortion and less confidence; a `lie` (a share by a houseguest whose cunning reaches `DISCLOSURE.lieAt`) is recorded as `lied` in the told ledger - the engine's decision of WHO lied, limited not by a cap but by
 * `LIE_COST` (each lie told makes the next believed less) - and arrives with strong distortion and low confidence; content falsification waits for the narrator-facing slice.
 * Hidden layer only: never reads/writes a player projection; the player is not a holder or listener here (off-screen scenes exclude them); each pair rolls on its OWN dedicated rng.
 */
export interface SpreadDeps {
  knowledge: KnowledgeService;
  told: ToldLedger;
  /** A dedicated rng per (holder, listener, scene tick), derived by the caller - never the shared stream. */
  rngFor: (holder: EntityId, listener: EntityId) => RandomnessSource;
  /** Directed edge reads, 0..1 (trust and affinity of `a` toward `b`; threat likewise). */
  trust: (a: EntityId, b: EntityId) => number;
  affinity: (a: EntityId, b: EntityId) => number;
  threat: (a: EntityId, b: EntityId) => number;
  style: (id: EntityId) => StrategyStyle | undefined;
  volatility: (id: EntityId) => number;
  /** Awake others in earshot besides the pair (the caller excludes sleepers). */
  audienceOf: (holder: EntityId, listener: EntityId) => number;
  /** Max facts considered per holder per scene. */
  topK?: number;
  /** Override a holder's cunning (0..1). Absent => the style table. Used to prove the lie path; the live wiring leaves it unset. */
  cunning?: (id: EntityId) => number;
  /**
   * B48 (ORWELL_CREDIBILITY): how far `listener` believes `holder`'s word, 0..1 (see `credibility.ts`; the caller derives it from the listener's own caught-lie evidence), given `repeatsToListener` = the
   * lies this holder already told this listener. When present it REPLACES the B34 `LIE_COST` stand-in for a lie's arriving confidence; absent => the stand-in (byte-identical to B34).
   */
  credibilityOf?: (holder: EntityId, listener: EntityId, repeatsToListener: number) => number;
  /**
   * B24/B36 - an OBSERVER of each one-hop receipt (the co-presence analogue of the graph path's `onReceipt`): told the listener, the (believed) subject, the nature and the transmitted
   * confidence, so the caller can record a `heard-rumor` belief claim. Read-only: it fires AFTER the transmit, draws no randomness, and moves no edge. Only fired for a fact with a subject.
   */
  onTold?: (r: { holder: EntityId; listener: EntityId; subject: EntityId; factId: string; confidence: number; slipped: boolean; content: string }) => void;
  /** 0179 (Theme 3 slice 9): the house's shape (brokers, cliques, weak ties, loners) adds to the share motive (`networkSpread.ts`). Absent => byte-identical. */
  network?: NetworkRoles;
  /**
   * ORW-589 (ORWELL_GOSSIP_DRIFT): present => each transmitted retelling drifts like the graph path's (`driftRetelling`: from the 2nd retelling a scene rumor's nature may move a rung and a hedge in the
   * reteller's PUBLIC voice is added), on a FORK of the pair's rng so no other draw moves. Absent => the text passes through unchanged (byte-identical).
   */
  drift?: { voiceOf?: (id: EntityId) => VoiceProfile | undefined };
}

/**
 * B34 (card 24 ruling: NO arbitrary hard cap on lying, for the player or NPCs - limits come from CONSEQUENCES). A lie is always allowed; what limits a habitual liar is that each lie told
 * makes the next one believed less (a stand-in for B48's credibility memory, ASSUMED pending Ryne): the lie's arriving confidence is multiplied by `LIE_COST.perPriorLie ^ (lies this holder has
 * told) x LIE_COST.perRepeatToListener ^ (lies already told to THIS listener)`, floored at `LIE_COST.floor`. `LIE_COST.safetyValve` is a purely technical backstop against a runaway ledger, not a
 * gameplay limit (far above anything a season produces).
 */
export const LIE_COST = { perPriorLie: 0.85, perRepeatToListener: 0.6, floor: 0.05, safetyValve: 500 } as const;
/** B34: how a spun / lied share arrives (transmit-side only). */
export const SPIN = { spunConfidence: 0.85, spunDistortion: 0.15, lieConfidence: 0.5, lieDistortion: 0.5 } as const;

export const CUNNING: Partial<Record<StrategyStyle, number>> = { strategic: 0.7, aggressive: 0.6, "under-the-radar": 0.55 };
export const LEAKY: Partial<Record<StrategyStyle, number>> = { emotional: 0.7, social: 0.5, aggressive: 0.4, loyal: 0.2, strategic: 0.1, "under-the-radar": 0.1 };

/** ORW-688: the lineage-id prefixes of rumor-origin beliefs (diffused scene rumor, thread rumor, pre-show tie, confide); the origin is already recorded in the id, so no new state. */
const RUMOR_ORIGIN_PREFIXES = ["fact:", "thread-belief:", "tie-belief:", "confide:"] as const;
const isRumorOrigin = (factId: string | undefined): boolean => factId !== undefined && RUMOR_ORIGIN_PREFIXES.some((p) => factId.startsWith(p));

/** How much `holder` wants `listener` to hear fact `c`: affinity to the listener, the threat of the fact's subject, and the fact's confidence. 0..1, no rng. Shared by the spread and by seeking. */
export function factMotive(c: { subject?: EntityId; confidence: number; factId?: string }, holder: EntityId, listener: EntityId, d: Pick<SpreadDeps, "affinity" | "threat">): number {
  // ORW-688: a rumor-origin fact (scene rumor, thread rumor, pre-show tie, confide) only just gained its subject; it keeps the motive it had without one (no threat term), so populating the subject does not move gossip volume. ORW-702 may revisit.
  const subjThreat = c.subject !== undefined && !isRumorOrigin(c.factId) ? d.threat(holder, c.subject) : 0;
  return Math.max(0, Math.min(1, 0.5 * d.affinity(holder, listener) + 0.4 * subjThreat + 0.1 * c.confidence));
}

/** 0179: the fact motive plus the house's shape (`networkSpread.ts`), clamped 0..1; exactly `factMotive` when no shape is supplied. The spread and seeking both use it. */
export function shapedMotive(c: { subject?: EntityId; confidence: number; factId?: string }, holder: EntityId, listener: EntityId, d: Pick<SpreadDeps, "affinity" | "threat" | "network">): number {
  const base = factMotive(c, holder, listener, d);
  return d.network ? Math.max(0, Math.min(1, base + networkMotive(holder, listener, c.subject, d.network))) : base;
}

/** B35 (seeking): how strongly a holder is drawn toward a listener who does not yet have a fact they have not decided about. `minMotive` is the smallest motive that bends movement; `k` the strength. */
export const SEEK = { minMotive: 0.5, k: 1 } as const;

/**
 * B35 - for each candidate listener, the HIGHEST motive among the holder's undecided, undelivered facts (those the listener lacks and the holder has not yet decided about telling them). Pure read:
 * no rng, no writes, no knowledge mutation. The adapter uses it to lean the holder's MOVEMENT toward the right audience (the same pull channel as the A10 want), never to tell anything.
 */
export function seekTargets(holder: EntityId, listeners: readonly EntityId[], d: Pick<SpreadDeps, "knowledge" | "told" | "affinity" | "threat" | "network">): Array<{ listener: EntityId; motive: number }> {
  const out: Array<{ listener: EntityId; motive: number }> = [];
  const mine = d.knowledge.knownTo(holder);
  for (const listener of listeners) {
    if (listener === holder) continue;
    const cands = d.told.undecided(holder, listener, heldCandidates(mine, d.knowledge.knownTo(listener)));
    if (cands.length === 0) continue;
    out.push({ listener, motive: Math.max(...cands.map((c) => shapedMotive(c, holder, listener, d))) }); // 0179: the house's shape draws movement as it moves telling
  }
  return out;
}

export interface SpreadResult { holder: EntityId; listener: EntityId; factId: string; decision: Told; transmitted: boolean }

export function spreadBetween(holder: EntityId, listener: EntityId, d: SpreadDeps): SpreadResult[] {
  const cands = d.told.undecided(holder, listener, heldCandidates(d.knowledge.knownTo(holder), d.knowledge.knownTo(listener)));
  if (cands.length === 0) return [];
  const rng = d.rngFor(holder, listener);
  const held: HeldFact[] = cands.map((c) => {
    const motive = shapedMotive(c, holder, listener, d);
    // Telling something about YOURSELF is the risky class; a third party's business is cheap.
    const risk = c.subject === holder ? 0.8 : c.firstHand ? 0.35 : 0.2;
    return { factId: c.factId, motive, risk, ...(c.subject !== undefined ? { subject: c.subject } : {}) };
  });
  const style = d.style(holder);
  const out: SpreadResult[] = [];
  for (const h of topHeldFacts(held, d.topK ?? 2)) {
    const input: DisclosureInput = {
      motive: h.motive, holderTrustsListener: d.trust(holder, listener), listenerTrustsHolder: d.trust(listener, holder), risk: h.risk,
      audience: d.audienceOf(holder, listener), leakiness: (style ? LEAKY[style] ?? 0.3 : 0.3) + 0.2 * d.volatility(holder),
      cunning: d.cunning ? d.cunning(holder) : style ? CUNNING[style] ?? 0.3 : 0.3, rattled: Math.max(0, d.volatility(holder) - 0.5) * 2, pressure: 0, roll: rng.next(),
    };
    const { decision, spin: rawSpin } = disclosureDecision(input);
    // B34: no hard cap - a repeat liar's lies simply land weaker (LIE_COST); only a technical safety valve demotes a lie to a spin.
    const priorLies = d.told.count(holder, "lied");
    const spin = rawSpin === "lie" && priorLies >= LIE_COST.safetyValve ? "spun" : rawSpin;
    const standIn = Math.max(LIE_COST.floor, Math.pow(LIE_COST.perPriorLie, priorLies) * Math.pow(LIE_COST.perRepeatToListener, d.told.countTo(holder, listener, "lied")));
    const lieCredibility = d.credibilityOf ? d.credibilityOf(holder, listener, d.told.countTo(holder, listener, "lied")) : standIn;
    const told: Told = decision === "share" ? (spin === "lie" ? "lied" : "shared") : decision === "slip" ? "slipped" : "held";
    d.told.record(holder, h.factId, listener, told);
    let transmitted = false;
    if (decision !== "hold") {
      const src = d.knowledge.knownTo(holder).find((f) => (f.factId ?? f.id) === h.factId);
      if (src) {
        const hops = (src.hops ?? 0) + 1;
        const spinConf = decision !== "share" ? 1 : spin === "lie" ? SPIN.lieConfidence * lieCredibility : spin === "spun" ? SPIN.spunConfidence : 1;
        const spinDist = decision !== "share" ? 0 : spin === "lie" ? SPIN.lieDistortion : spin === "spun" ? SPIN.spunDistortion : 0;
        const base = (src.confidence ?? 1) * GOSSIP.decay * (decision === "slip" ? 0.8 : 1) * spinConf;
        const retold = d.drift ? driftRetelling(src.content, hops, rng.fork(`gossip-drift:${h.factId}:${holder}:${listener}:${hops}`), d.drift.voiceOf?.(holder)) : { content: src.content, drifted: false };
        d.knowledge.transmitGossip(holder, listener, {
          content: retold.content, originalContent: src.originalContent ?? src.content, factId: h.factId, confidence: base, source: holder, hops,
          distortion: Math.min(1, Math.max(src.distortion ?? 0, spinDist) + (retold.drifted ? GOSSIP_DRIFT.sameRoomDistortionStep : 0)), ...(src.subject !== undefined ? { subject: src.subject } : {}),
        }, `told-by:${holder}`);
        transmitted = true;
        if (d.onTold && src.subject !== undefined) d.onTold({ holder, listener, subject: src.subject, factId: h.factId, confidence: base, slipped: decision === "slip", content: retold.content });
      }
    }
    out.push({ holder, listener, factId: h.factId, decision: told, transmitted });
  }
  return out;
}

/** Run the spread for every scene pair, both directions, in a stable order. */
export function spreadForScenes(pairs: ReadonlyArray<readonly [EntityId, EntityId]>, d: SpreadDeps): SpreadResult[] {
  const out: SpreadResult[] = [];
  for (const [a, b] of pairs) { out.push(...spreadBetween(a, b, d)); out.push(...spreadBetween(b, a, d)); }
  return out;
}
