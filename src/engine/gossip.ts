import type { KnowledgeService } from "../ports/KnowledgeService";
import type { RandomnessSource } from "../ports/RandomnessSource";
import type { EntityId } from "../domain/ids";
import { PLAYER } from "../domain/ids";
import { scaleImpact } from "./relationshipConstants";
import type { EdgeSignals } from "./relationshipConstants";
import type { RelationshipModel } from "./relationships";
import { edgeDelta, type EdgeDelta } from "./beliefStore";
import type { NotableActClass } from "./legends";
import type { VoiceProfile } from "../domain/voiceProfile";
import {
  GOSSIP_DRIFT,
  HEDGE_POOLS,
  escalationBias as voiceEscalationBias,
  hedgePool as voiceHedgePool,
} from "./gossipDriftConstants";

/**
 * The social graph gossip travels along. Minimal here (undirected adjacency); the
 * organic, graded relationship model (decision 0002) refines edge selection later.
 */
export interface SocialGraph {
  nodes(): EntityId[];
  neighbors(id: EntityId): EntityId[];
}

/**
 * The undirected affinity for a candidate social-graph edge a↔b: the MAX of the two directed
 * reads (issue #565). The social graph is undirected (`makeSocialGraph` symmetrizes adjacency),
 * so edge SELECTION must be symmetric too — a rumor can travel along a bond whenever EITHER party
 * is warm enough toward the other to carry it. The directed-only `edge(a,b).affinity` test (a→b
 * only) structurally excluded the PLAYER (always built as `everyone[0]`, so only player→NPC was
 * ever read) from the graph until their OWN outbound affinity crossed the threshold — so however
 * warmly NPCs felt about them, a diffusion chain could never terminate at the player and the
 * dramatic irony ran backwards. Reads only the GRADED relationship signals (decision 0002); the
 * diffusion stays in the hidden layer and the player's knowledge updates only when a pathway
 * actually terminates at them (the Vault Wall is unchanged — no Vault handle crosses here).
 */
export function gossipEdgeAffinity(rel: { edge(a: EntityId, b: EntityId): EdgeSignals }, a: EntityId, b: EntityId): number {
  return Math.max(rel.edge(a, b).affinity, rel.edge(b, a).affinity);
}

export function makeSocialGraph(edges: ReadonlyArray<readonly [EntityId, EntityId]>): SocialGraph {
  const adj = new Map<EntityId, Set<EntityId>>();
  const link = (a: EntityId, b: EntityId): void => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const [a, b] of edges) {
    link(a, b);
    link(b, a);
  }
  return {
    nodes: () => [...adj.keys()],
    neighbors: (id) => [...(adj.get(id) ?? [])],
  };
}

/**
 * Live-diffusion tunables (B27b — the 0028 constants pattern). A rumor RISES from a scene only
 * occasionally, travels with a LOW transmit probability over the affinity graph, and decays —
 * partial, distorted spread that reaches the player rarely, as a belief with source+confidence.
 * Volume is also a cost bound: every retelling is a recorded event (the B54/UAT lesson).
 */
export const GOSSIP = {
  /** Chance per off-screen tick that one of the night's scenes becomes a rumor. */
  riseProb: 0.15,
  /** Per-edge chance a holder retells the rumor each round. */
  transmitProb: 0.25,
  /** Diffusion rounds per rumor (one hop per round). */
  rounds: 2,
  /** Confidence decay per hop. */
  decay: 0.7,
  /** Affinity above this makes a social-graph edge (who actually talks to whom). */
  affinityEdge: 0.35,
} as const;

/**
 * What HEARING a rumor does to the listener's read of its SUBJECTS (audit E44): a rumor finally
 * changes minds, not just hands. Small directed folds keyed by the scene's nature, scaled by the
 * listener's CONFIDENCE in the belief (a fifth-hand whisper barely registers) — so noms, votes,
 * saves and blocs (which all read the relationship layer) now genuinely move on what travels.
 * Magnitudes live here only (the B59 pattern); the fold runs through the proven 0026 update rule.
 */
export const GOSSIP_HEARD: Record<string, Partial<EdgeSignals>> = {
  alliance: { threat: +0.06 },                  // "getting awfully close" — a pair is a power read
  strategy: { threat: +0.05 },                  // "plotting something"
  bonding: { threat: +0.03 },                   // "thick as thieves lately"
  showmance: { threat: +0.04 },                 // "more than friends" — a duo to the end
  gossip: { trust: -0.04 },                     // "talking about everyone behind their backs"
  conflict: { affinity: -0.03 },                // "at each other's throats" — messy to be near
  betrayal: { trust: -0.06, threat: +0.07 },    // "about to turn on someone" — dangerous to trust
  // 0121 R1 — the POSITIVE mirror: hearing someone "keeps their word" makes them a bit more LIKED (a small,
  // bounded AFFINITY-only whisper toward the subject — a faint social/jury warmth). AFFINITY-ONLY is
  // deliberate: the deal consequence lives in the explicit deal-willingness lean (`mintNpcDeal`), so the
  // whisper must NOT touch trust or it would double-count into the deal-trust read. The only warming
  // GOSSIP_HEARD entry; only ever seeded by the deal-depth reputation reward (gated ⇒ off = never used).
  reliable: { affinity: +0.03 },  // "keeps their word" — a proven partner (affinity-only whisper)
};

/** The vague gloss a scene's nature gets when it becomes a rumor — NEVER the verbatim scene. */
export const RUMOR_GLOSS: Record<string, string> = {
  alliance: "getting awfully close",
  gossip: "talking about everyone behind their backs",
  conflict: "at each other's throats",
  bonding: "thick as thieves lately",
  strategy: "plotting something",
  showmance: "more than friends",
  betrayal: "about to turn on someone",
};

/**
 * The rumor a hidden scene gives rise to (B27b): a vague PARAPHRASE of who-with-whom and the vibe —
 * never the verbatim hidden content, so the 0031 leak sweep can stay strict about exact strings.
 */
export function rumorFrom(initiator: EntityId, partner: EntityId, type: string): string {
  return `word around the house is that ${initiator} and ${partner} are ${RUMOR_GLOSS[type] ?? "up to something"}`;
}

/**
 * Feature 0101 — NPC myth-making tunables (the `THREAD`/`GOSSIP` single-tunable-home pattern). A
 * player-subject LEGEND is the outward complement to the NPC↔NPC rumor above: seeded rarely from a
 * genuinely notable player act (`src/engine/legends.ts`'s `notablePlayerActs`), then spread through the
 * SAME `diffuseGossip` machinery — with NO `rel`/`subjects` fold (see `GameSessionAdapter.legendTick`),
 * so the seeded calibration spine stays byte-identical whether the layer is on or off.
 */
export const LEGEND = {
  /** Chance per off-screen tick — once at least one unclaimed notable act exists — that the house mints
   *  a legend about the player. Kept low: folklore is rare and earned, not constant chatter. */
  seedProb: 0.35,
  /** ORW-283 (BDD card 29: no arbitrary hard caps): replaces the old per-season count. Each legend ALREADY minted makes the next one
   *  rarer (the seed chance is multiplied by this once per legend), so folklore stays scarce and legible because it gets costlier,
   *  never because a counter says stop. */
  costDecay: 0.6,
} as const;

/** The chance a tick mints a legend, given how many the house has already minted: `seedProb * costDecay^count` (a rising cost, not a cap). */
export function legendSeedProbability(alreadyMinted: number): number {
  return LEGEND.seedProb * Math.pow(LEGEND.costDecay, Math.max(0, Math.trunc(alreadyMinted)));
}

/** The vague, PUBLIC-facing gloss a notable player act becomes as a legend — never the verbatim act,
 *  never a hidden cause (the sibling of `RUMOR_GLOSS`, keyed by `NotableActClass` instead of scene type). */
export const LEGEND_GLOSS: Record<NotableActClass, string> = {
  "hoh-win": "the new HOH is running this house",
  "veto-win": "won that veto out of nowhere",
  "veto-save": "not as harmless as they look",
  "nominations": "not afraid to make a big move",
  "finale-win": "the one who won the whole game",
};

/** The legend a notable player act gives rise to — a vague PARAPHRASE, never the verbatim act. */
export function legendFrom(actClass: NotableActClass): string {
  return LEGEND_GLOSS[actClass] ?? "become the talk of the house";
}

/** Each retelling appends a hedge — a cosmetic "how sure are they" marker (stripped at display by
 * `humanize.ts tidyPathwaySlugs`). This alone is NOT the distortion the design mandate means by
 * "drift" (audit SG-6) — see `driftSeverity`/`swapSubject` below for the CONTENT-level mutation.
 * The reteller's PUBLIC voice may select which hedge `pool` colors THEIR phrasing (issue #1397); the
 * default (`HEDGE_POOLS.base`) is the pre-feature agnostic pool, and the single `rng.pick` draw is
 * unchanged whatever the pool — so the drift draw stream stays calibration-neutral. */
function distort(content: string, rng: RandomnessSource, pool: readonly string[] = HEDGE_POOLS.base): string {
  return `${content} · ${rng.pick(pool)}#${rng.int(1000)}`;
}

/**
 * SG-6 fix: a severity ladder for scene-rumor NATURE (mild → alarming). A retelling can nudge the
 * CLAIM one rung in either direction — the classic game-of-telephone effect where the story itself
 * becomes wrong, not merely less certain. Order is a plausible house read, not canon; it only needs
 * to be a believable escalation/de-escalation. Covers exactly the `RUMOR_GLOSS`/`GOSSIP_HEARD` keys.
 */
const SEVERITY_LADDER: readonly string[] = [
  "bonding",
  "alliance",
  "showmance",
  "gossip",
  "strategy",
  "conflict",
  "betrayal",
];

/** Retellings before content-level drift can kick in — a direct (1-hop) retelling stays faithful to
 * the nature of what was actually seen; the story only starts to warp on the SECOND retelling
 * onward (real telephone-game behavior, and it keeps the direct-hearsay case minimally changed). */
const CONTENT_DRIFT_MIN_HOPS = 2;
/** The base per-hop drift probabilities (nature nudge / subject swap) live in the single-tunable
 * `gossipDriftConstants` module beside the voice-mediation weights — `GOSSIP_DRIFT.baseTypeDriftProb`
 * (0.3) and `GOSSIP_DRIFT.baseSubjectSwapProb` (0.15), byte-identical to the pre-feature constants. */

/** Nudge a scene-rumor's claimed nature one rung on the severity ladder. The single `rng.next()` draw sets
 * the DIRECTION against `escalationBias` (default `0.5` = the pre-feature 50/50 — `1 - 0.5 = 0.5`, so the
 * off/no-voice path is byte-identical): a rumor can escalate OR soften, and the RETELLER's PUBLIC voice may
 * bias which way (issue #1397 — a dramatic voice > 0.5 amplifies toward "alarming", a blunt voice < 0.5
 * flattens toward "mild"). The draw COUNT is unchanged whatever the bias, so the drift stream stays
 * calibration-neutral. A type outside the ladder (a non-scene-rumor caller) is returned unchanged (no draw). */
function driftSeverity(type: string, rng: RandomnessSource, escalationBias: number = GOSSIP_DRIFT.baseEscalationBias): string {
  const idx = SEVERITY_LADDER.indexOf(type);
  if (idx < 0) return type;
  const step = rng.next() < 1 - escalationBias ? -1 : 1;
  const next = Math.min(SEVERITY_LADDER.length - 1, Math.max(0, idx + step));
  return SEVERITY_LADDER[next]!;
}

/** Swap ONE side of a rumor's subject pair for a socially-adjacent houseguest — "wait, I heard it
 * was HER, not you." Picks a graph-neighbor of the reteller who isn't already one of the two
 * subjects; falls back to the unchanged pair when no such neighbor exists. */
function swapSubject(
  subjects: readonly [EntityId, EntityId],
  from: EntityId,
  graph: SocialGraph,
  rng: RandomnessSource,
): readonly [EntityId, EntityId] {
  const candidates = graph.neighbors(from).filter((id) => id !== subjects[0] && id !== subjects[1]);
  if (candidates.length === 0) return subjects;
  const replacement = rng.pick(candidates);
  return rng.next() < 0.5 ? [replacement, subjects[1]] : [subjects[0], replacement];
}

/**
 * Diffuse a hidden fact NPC-to-NPC across the social graph, one hop per round.
 * Every retelling is recorded as its own event (via `transmitGossip`), each
 * recipient holds the fact as a belief with provenance + confidence (decaying
 * with hops) + distortion (growing with hops). It reaches the player only if a
 * chain of tellings terminates at the player. Deterministic under a fixed seed.
 *
 * SG-6 fix: past `CONTENT_DRIFT_MIN_HOPS` retellings, a scene-rumor (`sceneType` + `subjects`
 * present) can genuinely become WRONG, not just less certain — each holder's BELIEVED nature and
 * subject pair are tracked per branch of the retelling tree (`believedType`/`believedSubjects`;
 * different chains can end up believing different things) and, with a small seeded chance per hop,
 * `driftSeverity` nudges the claimed nature one rung and/or `swapSubject` swaps in a socially-
 * adjacent houseguest. The regenerated belief is what gets retold and what a downstream `told-by`
 * pathway can surface to the player — so a distorted belief with a source + confidence, per I3,
 * literally may not match what happened. `originalContent`/`original` (the Vault ground truth) are
 * NEVER touched by drift — only the diffusing belief is distorted, exactly as the mandate requires.
 * All drift/hedge randomness is drawn from a per-hop FORKED child stream (`RandomnessSource.fork`),
 * which by construction never advances the parent `rng`'s own sequence — so this cannot perturb any
 * other seeded draw (competition, votes, jury) sharing that parent stream this tick.
 *
 * Issue #1397 — CHARACTER-MEDIATED drift (opt-in `voiceOf`): the base drift above is personality-
 * AGNOSTIC (a fixed 50/50 severity step, a fixed hedge pool). When `voiceOf` is supplied, the RETELLER's
 * own PUBLIC voice (feature 0084 — register/rhythm/energy/directness/humor) biases HOW the claim mutates
 * through THAT mouth: a dramatic/high-energy voice AMPLIFIES (biases the severity step UP the ladder) and
 * embellishes the hedge; a blunt/flat voice FLATTENS (biases it DOWN) with a curt hedge; a strategic/
 * evasive voice hedges the phrasing toward ambiguity (`gossipDriftConstants`). It reads ONLY the public
 * voice dials — never soul/Vault (mandates #2/#3) — and re-weights ONLY the severity DIRECTION threshold +
 * the hedge POOL: the forked-rng draw COUNT/POSITION and the (voice-independent) subject-swap decision are
 * unchanged, so the seeded competition/vote/jury draw stream is byte-identical off vs on (absent `voiceOf`
 * ⇒ byte-identical to the agnostic path). It re-shapes the OPEN-SET belief content only (ADR 0005), never
 * the closed set (factId lineage, confidence/decay, which edges move, or any seeded magnitude).
 *
 * With `rel` + `subjects` (audit E44), each NPC RECEIPT also folds a small, confidence-scaled move
 * toward the rumor's CURRENTLY BELIEVED subjects (`GOSSIP_HEARD`, keyed by the currently believed
 * nature) — hearsay finally shifts third-party reads, so a betrayal-rumor reaching a future HOH
 * genuinely raises its subject's nomination danger, and a drifted rumor can misdirect that read onto
 * the wrong houseguest. The PLAYER's own edges are never gossip-folded: the human forms their own
 * reads (ADR 0003 / 0017 — the engine hands them the belief, not the feeling).
 */
export function diffuseGossip(deps: {
  knowledge: KnowledgeService;
  graph: SocialGraph;
  rng: RandomnessSource;
  origin: EntityId;
  fact: { content: string };
  rounds: number;
  transmitProb?: number;
  decay?: number;
  /** The live relationship model (E44) — when present, receipts fold toward the subjects. */
  rel?: RelationshipModel;
  /** Who the rumor is ABOUT (the scene's initiator + partner). */
  subjects?: readonly EntityId[];
  /** The originating scene's nature — keys the `GOSSIP_HEARD` impact and seeds content drift. */
  sceneType?: string;
  /**
   * Issue #1397 — CHARACTER-MEDIATED drift. When present, the RETELLER's own PUBLIC voice (feature 0084)
   * biases HOW the claim mutates as it passes through them: a dramatic voice AMPLIFIES the severity, a
   * blunt voice FLATTENS it, an evasive voice HEDGES the phrasing (`gossipDriftConstants`). Reads ONLY
   * public voice dials — never soul / Vault (mandates #2 / #3). ABSENT (the default, and every non-scene
   * caller — position whispers, legends) ⇒ byte-identical AGNOSTIC drift. The mediation re-weights ONLY
   * the severity DIRECTION threshold + the hedge POOL (existing forked-rng draws whose count & position are
   * unchanged), and holds the subject-swap decision voice-independent, so the seeded competition / vote /
   * jury draw stream is byte-identical off vs on (the drift already rides a per-hop FORK of the parent).
   */
  voiceOf?: (id: EntityId) => VoiceProfile | undefined;
  /**
   * #2017 S0b — an OBSERVER of each E44 receipt fold: told the listener, the subject, the (believed) nature, the confidence and the signed edge delta the
   * fold actually applied. READ-ONLY (it never touches `rel`, `rng` or any state the diffusion reads), so ABSENT ⇒ byte-identical and PRESENT ⇒ the same
   * edge moves and the same draws; it exists so the belief store can record provenance for what the edge absorbed.
   */
  onReceipt?: (r: { listener: EntityId; subject: EntityId; type: string; confidence: number; delta: EdgeDelta }) => void;
  /**
   * 0121 R1 — an explicit lineage id to seed the belief under (instead of minting a fresh `fact:<origin>:…`).
   * ABSENT (every existing caller) ⇒ mint as before, drawing `rng.int(1_000_000)` — byte-identical. PRESENT
   * ⇒ use it verbatim AND skip that mint draw; used only by the reliability-reputation reward, which runs on
   * its OWN dedicated side-rng (never a shared/seeded stream), so skipping the draw perturbs nothing.
   */
  factId?: string;
}): {
  factId: string;
  original: string;
  /** Each entity's belief in this fact AFTER the diffusion — the same answer as
   *  `knowledge.knownTo(e).find((k) => k.factId === factId)`, memoized. Valid until the next knowledge write. */
  beliefOf: (e: EntityId) => KnowledgeFactLike | undefined;
} {
  const { knowledge, graph, rng, origin, fact, rounds, rel, sceneType } = deps;
  const transmitProb = deps.transmitProb ?? GOSSIP.transmitProb;
  const decay = deps.decay ?? 0.7;
  const factId = deps.factId ?? `fact:${origin}:${rng.int(1_000_000)}`;
  const original = fact.content;

  // A STABLE lineage id the origin already holds (a re-told grievance, a repeated reputation) is not
  // re-recorded: every read below takes the holder's FIRST belief in this fact, so a second origin entry
  // changed nothing but grew the store each call (#1922 — the jury house piled up copies of one rumor).
  const originHolds = deps.factId !== undefined && knowledge.knownTo(origin).some((k) => k.factId === factId);
  if (!originHolds) {
    knowledge.seedBelief(
      origin,
      { content: original, originalContent: original, factId, confidence: 1, hops: 0, distortion: 0, source: origin },
      "origin",
    );
  }

  // Per-holder BELIEVED claim state (SG-6): what THIS holder currently thinks the rumor's nature and
  // subjects are — drifts independently down each branch of the retelling tree. Untouched (stays
  // `undefined`) for callers that pass no `sceneType` (e.g. position/tie whispers), which keep
  // today's cosmetic-only hedge — those never asserted a nature/subject claim to begin with.
  const believedType = new Map<EntityId, string>();
  const believedSubjects = new Map<EntityId, readonly [EntityId, EntityId]>();
  const hasSubjectPair = deps.subjects && deps.subjects.length === 2;
  if (sceneType) believedType.set(origin, sceneType);
  if (hasSubjectPair) believedSubjects.set(origin, [deps.subjects![0]!, deps.subjects![1]!]);

  /** The E44 receipt fold: listener → each (believed) subject (≠ self, ≠ player-holder), scaled by
   * confidence and keyed by the LISTENER's believed nature — a drifted belief folds as what was
   * actually heard, never silently corrected back to ground truth. */
  const foldReceipt = (
    listener: EntityId,
    confidence: number,
    type: string | undefined,
    subjects: readonly EntityId[] | undefined,
  ): void => {
    const heard = type ? GOSSIP_HEARD[type] : undefined;
    if (!rel || !subjects || !heard || listener === PLAYER) return;
    const scaled = scaleImpact(heard, confidence);
    for (const subject of subjects) {
      if (subject === listener) continue;
      if (!deps.onReceipt) { rel.applyImpactDirected(listener, subject, scaled, rng); continue; }
      const e = rel.edge(listener, subject);
      const before = { trust: e.trust, affinity: e.affinity, threat: e.threat };
      rel.applyImpactDirected(listener, subject, scaled, rng);
      deps.onReceipt({ listener, subject, type: type!, confidence, delta: edgeDelta(before, rel.edge(listener, subject)) });
    }
  };

  // Per-call memo of each entity's belief in THIS fact. `knownTo` copies the holder's WHOLE knowledge list,
  // and the loop below asks every node every round, so an un-memoized lookup is O(rounds × nodes × that
  // holder's knowledge) — the deployed-profile slowdown (#1922). The memo gives the SAME answer as the bare
  // `knownTo(e).find(...)`: the only knowledge writes inside this call are `transmitGossip(…, to, …)` below
  // (which drops `to`'s entry so the next read re-fetches it) and the origin seed above (made before any read).
  const beliefMemo = new Map<EntityId, KnowledgeFactLike | undefined>();
  const beliefOf = (e: EntityId): KnowledgeFactLike | undefined => {
    if (beliefMemo.has(e)) return beliefMemo.get(e);
    const b = knowledge.knownTo(e).find((k) => k.factId === factId);
    beliefMemo.set(e, b);
    return b;
  };
  const holds = (e: EntityId): boolean => beliefOf(e) !== undefined;

  for (let r = 0; r < rounds; r++) {
    const holders = graph.nodes().filter(holds); // snapshot: one hop per round
    for (const from of holders) {
      const belief = beliefOf(from)!;
      const fromType = believedType.get(from);
      const fromSubjects = believedSubjects.get(from);
      // Issue #1397 — read the RETELLER's PUBLIC voice ONCE (a rumor mutates the same way through the same
      // mouth this round). Absent `voiceOf`, or a reteller with no voice (e.g. the player), falls back to
      // the agnostic BASE — byte-identical to before. PUBLIC dials only; no soul / Vault crosses.
      const voice = deps.voiceOf?.(from);
      const escalation = voice ? voiceEscalationBias(voice) : GOSSIP_DRIFT.baseEscalationBias;
      const hedge = voice ? voiceHedgePool(voice) : HEDGE_POOLS.base;
      for (const to of graph.neighbors(from)) {
        if (holds(to)) continue;
        if (rng.next() >= transmitProb) continue;
        const hops = (belief.hops ?? 0) + 1;
        const confidence = (belief.confidence ?? 1) * decay;
        // A DEDICATED forked stream for this retelling's hedge/drift — `RandomnessSource.fork` reads
        // the parent's current state without advancing it, so nothing drawn here shifts what the
        // parent `rng` yields on its NEXT call (the transmit-probability roll above, or any other
        // seeded draw elsewhere this tick, is byte-identical to before this feature existed).
        const driftRng = rng.fork(`gossip-drift:${factId}:${from}:${to}:${hops}`);
        let toType = fromType;
        let toSubjects = fromSubjects;
        let believedContent = belief.content;
        if (hops >= CONTENT_DRIFT_MIN_HOPS) {
          // The nature drifts as OFTEN as before (base prob, VOICE-INDEPENDENT — this keeps the forked-rng
          // draw sequence, hence the subject-swap decision below AND the E44 fold's parent-rng draw count,
          // byte-identical off vs on); the reteller's voice biases only WHICH WAY it drifts (`escalation`):
          // a dramatic voice amplifies toward "alarming", a blunt voice flattens toward "mild" (issue #1397).
          if (fromType && driftRng.next() < GOSSIP_DRIFT.baseTypeDriftProb) toType = driftSeverity(fromType, driftRng, escalation);
          if (fromSubjects && driftRng.next() < GOSSIP_DRIFT.baseSubjectSwapProb) {
            toSubjects = swapSubject(fromSubjects, from, graph, driftRng);
          }
          if (toType && toSubjects) believedContent = rumorFrom(toSubjects[0], toSubjects[1], toType);
        }
        knowledge.transmitGossip(
          from,
          to,
          {
            content: distort(believedContent, driftRng, hedge),
            originalContent: original,
            factId,
            confidence,
            source: from,
            hops,
            // hops + fractional noise → strictly ordered by hops, with per-telling variance.
            distortion: hops + driftRng.next(),
          },
          `told-by:${from}`,
        );
        beliefMemo.delete(to); // `to`'s knowledge just changed — re-read on next ask (keeps the memo exact)
        if (toType) believedType.set(to, toType);
        if (toSubjects) believedSubjects.set(to, toSubjects);
        // E44: hearing it MOVES the listener's read of the (believed) subjects, hidden.
        foldReceipt(to, confidence, toType, toSubjects);
      }
    }
  }

  return { factId, original, beliefOf };
}

type KnowledgeFactLike = { hops?: number; confidence?: number; content: string };

/**
 * 0121 R1 — the "keeps their word" REPUTATION reward. A kept deal diffuses a Vault-free reputation about the
 * `honorer` NPC→NPC (seeded on the deal partner `other`, spread along the affinity `graph`) under a STABLE
 * `reliable:<honorer>` lineage (`factId`), so any holder's belief resolves back to who is credited — the read
 * side (`mintNpcDeal`'s deal-willingness lean) depends on that. Every THIRD PARTY who comes to hold it then
 * gets a small AFFINITY-ONLY whisper toward the honorer (`GOSSIP_HEARD.reliable`) — a faint "reliable people
 * are more liked" warmth, NOT a deal signal (the deal consequence is the explicit lean in `mintNpcDeal`, so
 * the whisper stays off the deal-trust read to avoid double-counting). The deal partner `other` is EXCLUDED
 * (they already earned the direct honored fold) and the honorer is the subject (never folds toward themself).
 *
 * A single-subject reputation, so it does NOT use `diffuseGossip`'s two-subject scene receipt fold — the
 * whisper is applied here directly, bounded, on the SAME injected rng (dedicated by the caller ⇒ the main
 * season/vote stream is never re-phased). Off (the caller only invokes it under the deal-depth flag) ⇒ never
 * runs ⇒ byte-identical. Pure but for the injected `knowledge`/`rel`/`rng` it mutates; no wall-clock, no I/O.
 */
export function spreadReliableReputation(deps: {
  knowledge: KnowledgeService;
  rel: RelationshipModel;
  graph: SocialGraph;
  rng: RandomnessSource;
  honorer: EntityId;
  other: EntityId;
  content: string;
  candidates: readonly EntityId[];
  /** 0121 R1 — the stable `reliable:<honorer>` lineage id to seed under (so a holder's belief is resolvable
   *  back to the honorer). Absent ⇒ `diffuseGossip` mints an anonymous id (used only by the pure-helper tests). */
  factId?: string;
  rounds?: number;
  transmitProb?: number;
  decay?: number;
}): { factId: string; leaned: EntityId[] } {
  const { knowledge, rel, graph, rng, honorer, other, content, candidates } = deps;
  const { factId } = diffuseGossip({
    knowledge, graph, rng, origin: other, fact: { content }, factId: deps.factId,
    rounds: deps.rounds ?? GOSSIP.rounds,
    transmitProb: deps.transmitProb ?? GOSSIP.transmitProb,
    decay: deps.decay ?? GOSSIP.decay,
  });
  const leaned: EntityId[] = [];
  for (const npc of candidates) {
    if (npc === honorer || npc === other) continue;
    if (knowledge.knownTo(npc).some((k) => k.factId === factId)) {
      rel.applyImpactDirected(npc, honorer, GOSSIP_HEARD.reliable, rng);
      leaned.push(npc);
    }
  }
  return { factId, leaned };
}
