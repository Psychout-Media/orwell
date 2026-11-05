import type { EntityId } from "../domain/ids";
import type { KnowledgeService } from "../ports/KnowledgeService";
import type { RandomnessSource } from "../ports/RandomnessSource";
import { disclosureDecision, topHeldFacts, type DisclosureInput, type HeldFact } from "./disclosure";
import { heldCandidates, type ToldLedger, type Told } from "./heldFacts";
import { GOSSIP } from "./gossip";
import type { StrategyStyle } from "./characterFactory";

/**
 * B10 / B11 slice 3 (design S3) - the scene-time SPREAD. For each CO-PRESENT pair of a night's off-screen scenes (the scene IS the co-presence: both are in the room), each side, as holder,
 * considers the facts they hold that the other lacks (top-K by motive, ASSUMED K=2 pending Ryne), draws ONE closed-set decision per (holder, fact, listener) ONCE (the told ledger), and a `share`
 * or `slip` moves the fact exactly ONE hop through `KnowledgeService.transmitGossip` (recorded as an event with the telling pair as witnesses - the same receipt path the graph diffusion used).
 * No network hops, no cross-room spread. Replaces the automatic graph rumor ONLY while `ORWELL_GOSSIP_COPRESENCE` is on (default OFF, so off is byte-identical: this is never called).
 * Spin is carried on the decision but NOT yet applied to content in this slice (a spun/lied share transmits truthfully; ASSUMED, spin lands with the narrator-facing slice).
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
  /**
   * B24/B36 - an OBSERVER of each one-hop receipt (the co-presence analogue of the graph path's `onReceipt`): told the listener, the (believed) subject, the nature and the transmitted
   * confidence, so the caller can record a `heard-rumor` belief claim. Read-only: it fires AFTER the transmit, draws no randomness, and moves no edge. Only fired for a fact with a subject.
   */
  onTold?: (r: { holder: EntityId; listener: EntityId; subject: EntityId; factId: string; confidence: number; slipped: boolean }) => void;
}

const CUNNING: Partial<Record<StrategyStyle, number>> = { strategic: 0.7, aggressive: 0.6, "under-the-radar": 0.55 };
const LEAKY: Partial<Record<StrategyStyle, number>> = { emotional: 0.7, social: 0.5, aggressive: 0.4, loyal: 0.2, strategic: 0.1, "under-the-radar": 0.1 };

export interface SpreadResult { holder: EntityId; listener: EntityId; factId: string; decision: Told; transmitted: boolean }

export function spreadBetween(holder: EntityId, listener: EntityId, d: SpreadDeps): SpreadResult[] {
  const cands = d.told.undecided(holder, listener, heldCandidates(d.knowledge.knownTo(holder), d.knowledge.knownTo(listener)));
  if (cands.length === 0) return [];
  const rng = d.rngFor(holder, listener);
  const held: HeldFact[] = cands.map((c) => {
    const subjThreat = c.subject !== undefined ? d.threat(holder, c.subject) : 0;
    const motive = Math.max(0, Math.min(1, 0.5 * d.affinity(holder, listener) + 0.4 * subjThreat + 0.1 * c.confidence));
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
      cunning: style ? CUNNING[style] ?? 0.3 : 0.3, rattled: Math.max(0, d.volatility(holder) - 0.5) * 2, pressure: 0, roll: rng.next(),
    };
    const { decision } = disclosureDecision(input);
    const told: Told = decision === "share" ? "shared" : decision === "slip" ? "slipped" : "held";
    d.told.record(holder, h.factId, listener, told);
    let transmitted = false;
    if (decision !== "hold") {
      const src = d.knowledge.knownTo(holder).find((f) => (f.factId ?? f.id) === h.factId);
      if (src) {
        const hops = (src.hops ?? 0) + 1;
        const base = (src.confidence ?? 1) * GOSSIP.decay * (decision === "slip" ? 0.8 : 1);
        d.knowledge.transmitGossip(holder, listener, {
          content: src.content, originalContent: src.originalContent ?? src.content, factId: h.factId, confidence: base, source: holder, hops,
          distortion: src.distortion ?? 0, ...(src.subject !== undefined ? { subject: src.subject } : {}),
        }, `told-by:${holder}`);
        transmitted = true;
        if (d.onTold && src.subject !== undefined) d.onTold({ holder, listener, subject: src.subject, factId: h.factId, confidence: base, slipped: decision === "slip" });
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
