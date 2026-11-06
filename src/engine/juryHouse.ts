import type { EventStore } from "../ports/EventStore";
import type { KnowledgeService } from "../ports/KnowledgeService";
import type { RandomnessSource } from "../ports/RandomnessSource";
import type { EntityId } from "../domain/ids";
import type { EdgeSignals } from "./relationshipConstants";
import type { EvictionManner } from "./jury";
import { richOffscreenStretch, type OffscreenScene } from "./offscreen";
import { diffuseGossip, makeSocialGraph, gossipEdgeAffinity } from "./gossip";
import { JURY_HOUSE, BEARING_THRESHOLDS, BEARING_MAX, MANNER_GRUDGE } from "./juryHouseConstants";

/**
 * Feature 0100 — the JURY HOUSE: a sequestered SECOND society of the last-nine evictees who keep
 * living (hidden, NPC↔NPC) and gossip about the player and each other between turns, so the
 * accumulated treatment a finalist carried into the jury is HARDENED or SOFTENED by what the room
 * does with it before the vote. This module is PURE in the 0075/0038 sense — no Vault handle, no
 * direct adapter import; it is handed the already-read signals (juror set, directed edges, recorded
 * manner) plus the `EventStore`/`KnowledgeService`/dedicated `rng` it records onto, and returns the
 * BOUNDED per-(juror, finalist) grudge adjustment the caller accumulates into the persisted jury read.
 *
 * The Vault Wall holds by construction (mandate #2): the jurors form the entire society + gossip
 * graph (the PLAYER is never a node), the recorded scenes are hidden (witness set = the two jurors,
 * never the player — the player is not in the jury house), and the grievance rumor names the player
 * only as a SUBJECT of its content. No jury-house pathway can terminate at the player — there is no
 * edge to the player to travel — so the player learns nothing of it until the finale, and even then
 * only through a juror's (hidden-state-driven) bearing and the vote that breaks.
 *
 * Calibration (the hard requirement): the caller drives this on a DEDICATED, isolated rng (the
 * `campaignTick` pattern) and gates the whole call behind `ORWELL_JURY_HOUSE`. The grievance
 * diffusion takes NO relationship fold (`diffuseGossip` without `rel`/`subjects`, like
 * `whisperConspicuousPairings`) — it moves no live edge and the grudge is folded into a SEPARATE,
 * saturated map the finale reads alongside the recorded manner — so with the flag off NOTHING runs
 * (zero draws, no fold ⇒ the seeded `juryReach`/UAT spine is byte-identical), and even with it on the
 * main house's seeded competition/vote stream is untouched (only the hidden finale lean changes).
 */

/** A grievance a juror carries OUT of the game, against a specific finalist (the manner baseline). */
export interface JurorGrievance {
  /** The juror who holds it (the diffusion ORIGIN). */
  juror: EntityId;
  /** The finalist they hold it against (the rumor's subject framing). */
  against: EntityId;
}

export interface JuryHouseDeps {
  events: EventStore;
  /** The DEDICATED, isolated rng (forked off the game seed + a jury-house tick counter by the caller). */
  rng: RandomnessSource;
  knowledge: KnowledgeService;
  /** The sequestered juror set (the last-nine NPC evictees; NEVER the player — they are not modelled here). */
  jurors: readonly EntityId[];
  /** The directed jury-house read a→b (juror↔juror), so the society + gossip graph are MOTIVATED (0038/E45). */
  edgeOf: (a: EntityId, b: EntityId) => EdgeSignals;
  /** Each juror's recorded eviction MANNER toward each finalist (`mannerByEvictee[juror][finalist]`). */
  mannerOf: (juror: EntityId, finalist: EntityId) => EvictionManner;
  /** The two finalists still in the game — the subjects a grievance is carried against. */
  finalists: readonly EntityId[];
  /** Scenes per stretch (defaults to `JURY_HOUSE.scenesPerTick`). */
  scenes?: number;
  /** Grievance diffusion rounds per stretch (defaults to `JURY_HOUSE.rounds`). */
  rounds?: number;
}

/** A bounded per-(juror, finalist) grudge increment this stretch — accumulated by the caller (saturated). */
export interface GrudgeAdjustment {
  juror: EntityId;
  finalist: EntityId;
  /** The (positive) amount this stretch DEEPENED the juror's grudge — capped per call by the saturation. */
  delta: number;
}

export interface JuryHouseResult {
  scenes: OffscreenScene[];
  grudges: GrudgeAdjustment[];
}

/** A juror reads a finalist's eviction manner as a GRIEVANCE iff a betrayal/blindside/disrespect/cold goodbye. */
function isGrievance(m: EvictionManner): boolean {
  return !!(m.betrayed || m.blindsided || m.disrespected || m.goodbye === "cold");
}

/**
 * Run ONE bounded jury-house stretch: the jurors live (juror↔juror scenes via `richOffscreenStretch`),
 * each carried grievance DIFFUSES through the jury-house affinity graph (via `diffuseGossip`, player as
 * subject only), and the result is each juror's BOUNDED grudge increment toward the responsible
 * finalist — confidence-scaled by how strongly the grievance reached them, capped per stretch by the
 * saturation. Records only hidden events; folds no live edge. Seed-deterministic on the supplied rng.
 */
export function runJuryHouseStretch(deps: JuryHouseDeps): JuryHouseResult {
  const { events, rng, knowledge, jurors, edgeOf, mannerOf, finalists } = deps;
  // Need at least two jurors to have a society / a graph to gossip along.
  if (jurors.length < 2) return { scenes: [], grudges: [] };

  // 1) The jurors LIVE: bounded juror↔juror scenes, MOTIVATED + hidden (witness set excludes the player —
  //    the player is not in `jurors`). Reuses the proven off-screen society verbatim, over the juror set.
  const scenes = richOffscreenStretch({
    events,
    rng,
    npcs: jurors,
    interactions: deps.scenes ?? JURY_HOUSE.scenesPerTick,
    edgeOf,
  });

  // 2) The jury-house social graph: who actually talks to whom, by symmetric affinity (the #565 rule).
  //    The PLAYER is never a node — only jurors — so no diffusion chain can ever terminate at the player.
  const rel = { edge: (a: EntityId, b: EntityId): EdgeSignals => edgeOf(a, b) };
  const graphEdges: Array<readonly [EntityId, EntityId]> = [];
  for (let i = 0; i < jurors.length; i++) {
    for (let j = i + 1; j < jurors.length; j++) {
      if (gossipEdgeAffinity(rel, jurors[i]!, jurors[j]!) > JURY_HOUSE.affinityEdge) {
        graphEdges.push([jurors[i]!, jurors[j]!] as const);
      }
    }
  }
  const graph = makeSocialGraph(graphEdges);

  // 3) Each carried grievance DIFFUSES from its holder through the graph; the grudge is read off the
  //    RESULT (which jurors received the belief, at what confidence). NO `rel`/`subjects` fold (like the
  //    0077 whisper) — the grudge lands ONLY in the separate, saturated adjustment the finale reads, so
  //    the live relationship edges (and every system that reads them) stay untouched. Bounded per stretch.
  const grudges: GrudgeAdjustment[] = [];
  for (const finalist of finalists) {
    for (const origin of jurors) {
      if (!isGrievance(mannerOf(origin, finalist))) continue; // only a real grievance is contagious
      // A vague, player-as-SUBJECT grievance gloss — never a number, never the verbatim manner read.
      const fact = { content: `word in the jury house is that ${finalist} did ${origin} dirty on the way out` };
      const { beliefOf } = diffuseGossip({
        // A STABLE lineage per (origin, finalist): the same grievance re-told in a later stretch reunites
        // with the belief the room already holds instead of minting a duplicate fact (#1922).
        factId: `jury-grievance:${origin}:${finalist}`,
        knowledge,
        graph,
        rng,
        origin,
        fact,
        rounds: deps.rounds ?? JURY_HOUSE.rounds,
        transmitProb: JURY_HOUSE.transmitProb,
        decay: JURY_HOUSE.decay,
        // CALIBRATION + bound: NO `rel`/`subjects` — the receipt fold into live edges is deliberately
        // omitted; the grudge is the separate saturated adjustment below, the only thing the vote reads.
      });
      // Read who now holds the grievance belief and how strongly (confidence = decayed by hops). The
      // ORIGIN's own grievance is the recorded manner (already in the lean) — the jury house's job is
      // to spread it to OTHERS, so the origin's own read is not re-grudged here (only fresh recipients).
      for (const juror of jurors) {
        if (juror === origin) continue;
        const belief = beliefOf(juror); // memoized `knownTo(juror).find(factId)` — same answer, no list copy
        if (!belief) continue; // no pathway reached this juror — they are unmoved (the omniscience ban)
        const confidence = belief.confidence ?? 1;
        const delta = JURY_HOUSE.grudgePerHop * confidence; // a fainter (further) rumor moves them less
        if (delta > 0) grudges.push({ juror, finalist, delta });
      }
    }
  }

  return { scenes, grudges };
}


/**
 * #1790 — PURE, Vault-safe functional BEARING word for a juror's grudge value.
 * Maps a numeric grudge (0..`adjustmentCap`) to one of four words: "settled", "cold", "warm",
 * or "burning", using the thresholds from `BEARING_THRESHOLDS`. Returns a WORD, NEVER a number.
 * Clamps input to [0, adjustmentCap] so negative values are always "settled".
 */
export function bearingWord(grudge: number): string {
  const clamped = Math.max(0, Math.min(BEARING_MAX, grudge));
  // Iterate thresholds high-to-low: return the first tier whose min <= clamped.
  for (let i = BEARING_THRESHOLDS.length - 1; i >= 0; i--) {
    if (clamped >= BEARING_THRESHOLDS[i]!.min) return BEARING_THRESHOLDS[i]!.word;
  }
  return BEARING_THRESHOLDS[0]!.word;
}

/**
 * ORW-110 - the grudge floor a juror's recorded manner toward a finalist implies: betrayed or blindsided on the way out => the "burning" tier, disrespected => the "warm" tier, otherwise 0.
 * Pure, no rng; the finale bearing takes max(jury-house grudge, this).
 */
export function mannerGrudge(m: { betrayed?: boolean; blindsided?: boolean; disrespected?: boolean } | undefined): number {
  if (!m) return 0;
  if (m.betrayed || m.blindsided) return MANNER_GRUDGE.wronged;
  if (m.disrespected) return MANNER_GRUDGE.disrespected;
  return 0;
}
