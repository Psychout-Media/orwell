import type { TellBand, TellKind } from "./tells";
import { clamp01 } from "../domain/num";

/**
 * B29 (#2017 15.4 E3, flag ORWELL_TELL_REACTIONS) - OBSERVERS REACT to a visible tell. A houseguest in the same room as someone visibly rattled can respond, chosen by the OBSERVER's own personality and bond
 * (never by anything the player says): COMFORT (a warm bond: lowers the rattled one's distress a little and builds their trust), EXPLOIT (cunning + no warm bond: a small, decaying nomination/vote tilt toward the
 * rattled), AVOID (a snapping tell on someone you do not like: you keep your distance). Seeded and bounded; the gate is the caller's co-presence/earshot (ADR 0019). PURE: no rng of its own (the caller
 * supplies the draw), no I/O, no Vault. Roles only; ASSUMED defaults (pending Ryne, design 15.9) are all in `TELL_REACTION`.
 */
export type TellReaction = "comfort" | "exploit" | "avoid";

export const TELL_REACTION = {
  /** Only these tells read as "visibly rattled" and invite a reaction (a giddy or warm-open houseguest does not). */
  rattled: ["withdrawn", "tearful", "snapping", "brittle-calm"] as readonly TellKind[],
  /** Chance an observer reacts at all, by the tell's band (faint is easy to miss). */
  pByBand: { faint: 0.15, clear: 0.35, strong: 0.55 } as Readonly<Record<TellBand, number>>,
  /** A bond (0..1, observer -> target) at or above this is "warm"; below `coldBond` is "cold". */
  warmBond: 0.6,
  coldBond: 0.35,
  /** Strategy styles that exploit / that comfort (the observer's own character). */
  cunning: ["strategic", "aggressive", "under-the-radar"] as readonly string[],
  tender: ["social", "emotional", "loyal"] as readonly string[],
  /** Effect sizes (bounded, tiny). */
  comfortDistress: 0.04, comfortTrust: 0.02, exploitTilt: 0.05, exploitCap: 0.12, exploitDecay: 0.6,
  /** ORW-32: the avoid tilt an `avoid` reaction records (decays like exploit; scales the movement avoid pull). */
  avoidTilt: 0.1, avoidGain: 6, avoidMin: 0.02,
  /** An observer reacts to the same target at most once per this many weeks. */
  cooldownWeeks: 1,
} as const;

export interface ReactionInput {
  tell: { kind: TellKind; band: TellBand };
  /** The observer's read of the target, 0..1 (trust/affinity blend). */
  bond: number;
  /** The observer's strategy style (their CHARACTER), if any. */
  style?: string;
  /** The observer's baseline disposition. */
  disposition: "clash" | "bond" | "neutral";
  /** A seeded draw in [0, 1) from a dedicated stream. */
  roll: number;
}

/** Decide what (if anything) an observer does about a visible tell. Pure and monotone in the roll. */
export function chooseTellReaction(i: ReactionInput): TellReaction | null {
  if (!TELL_REACTION.rattled.includes(i.tell.kind)) return null;
  if (i.roll >= TELL_REACTION.pByBand[i.tell.band]) return null;
  const bond = clamp01(i.bond);
  const cunning = !!i.style && TELL_REACTION.cunning.includes(i.style);
  const tender = !!i.style && TELL_REACTION.tender.includes(i.style);
  if (bond >= TELL_REACTION.warmBond && !(cunning && i.disposition === "clash")) return "comfort";
  if (cunning && bond < TELL_REACTION.warmBond) return "exploit";
  if (bond < TELL_REACTION.coldBond && i.tell.kind === "snapping") return "avoid";
  if (tender && bond >= TELL_REACTION.coldBond) return "comfort";
  return null;
}

/** The exploit tilt after one more exploit reaction, capped. */
export const addExploit = (cur: number): number => Math.min(TELL_REACTION.exploitCap, cur + TELL_REACTION.exploitTilt);
/** The exploit tilt after a tick of decay (it fades; a lasting tilt needs the tell to persist). */
export const decayExploit = (cur: number): number => (cur * TELL_REACTION.exploitDecay < 0.005 ? 0 : cur * TELL_REACTION.exploitDecay);

/**
 * B30 (#2017 15.6 E4a) - emotion into more decisions. PURE bounded terms read off an NPC's persisted tells (words only), each behind its OWN flag:
 *  - veto save (ORWELL_MOOD_VETO): a visibly rattled veto holder (withdrawn / tearful / brittle-calm) rescues the nominee they are close to (+ `vetoRescue` x bond); a snapping holder is less forgiving (- `vetoSnap`).
 *  - approaches (ORWELL_MOOD_APPROACH): a withdrawn / tearful NPC seeks the player out less, a snapping one a little less, a giddy / warm-open one more.
 */
export const MOOD_TERMS = { vetoRescue: 0.08, vetoSnap: 0.05, approachWithdrawn: -0.12, approachSnapping: -0.06, approachUp: 0.08, dealProtect: 0.08, dealSnap: -0.05 } as const;
const LOW = new Set<TellKind>(["withdrawn", "tearful", "brittle-calm"]);
const UP = new Set<TellKind>(["giddy", "warm-open"]);

export function moodVetoTerm(tells: ReadonlyArray<{ kind: TellKind }> | undefined, bond: number): number {
  if (!tells?.length) return 0;
  if (tells.some((t) => LOW.has(t.kind))) return MOOD_TERMS.vetoRescue * clamp01(bond);
  if (tells.some((t) => t.kind === "snapping")) return -MOOD_TERMS.vetoSnap;
  return 0;
}

export function moodApproachTerm(tells: ReadonlyArray<{ kind: TellKind }> | undefined): number {
  if (!tells?.length) return 0;
  if (tells.some((t) => t.kind === "withdrawn" || t.kind === "tearful")) return MOOD_TERMS.approachWithdrawn;
  if (tells.some((t) => t.kind === "snapping")) return MOOD_TERMS.approachSnapping;
  if (tells.some((t) => UP.has(t.kind))) return MOOD_TERMS.approachUp;
  return 0;
}

/** B31 / #2017 E4b: a visibly rattled NPC is likelier to accept PROTECTION (safety / veto-save), a snapping one is less willing to commit to anything. Signed shift on the consent willingness score; no player wording enters. */
export function moodDealTerm(tells: ReadonlyArray<{ kind: TellKind }> | undefined, kind: string): number {
  if (!tells?.length) return 0;
  if (tells.some((t) => LOW.has(t.kind))) return kind === "safety" || kind === "veto-save" ? MOOD_TERMS.dealProtect : 0;
  if (tells.some((t) => t.kind === "snapping")) return MOOD_TERMS.dealSnap;
  return 0;
}

/** B31: a visibly rattled or snapping NPC cannot hold a campaign steady, so none forms from them this tick. */
export function moodUnsteady(tells: ReadonlyArray<{ kind: TellKind }> | undefined): boolean {
  return !!tells?.some((t) => LOW.has(t.kind) || t.kind === "snapping");
}
