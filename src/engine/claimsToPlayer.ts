import type { EntityId } from "../domain/ids";
import { clamp01 } from "../domain/num";
import { HEARD, heardConfidence } from "./heardAboutMe";
import type { BeliefClaim } from "./beliefStore";
import { labelOfNature, type SpokenClaimKind } from "./spokenClaims";

/**
 * Feature 0151 / ORW-330 (theme 2, slice 4a) - WHAT THE PLAYER HEARS. When the player is in a room with a houseguest who trusts them, that houseguest may pass on ONE thing they BELIEVE (mistakes
 * included), hedged by how sure they are. Pure rules: no I/O, no Vault, no rng handle - the caller supplies the draws, from its own seeded side stream (`${seed}:claims-to-player`).
 * The engine decides whether, what and how sure; the narrator only voices it. Nothing here knows whether a belief is TRUE, and nothing here carries the speaker's motive: those stay with the caller
 * and the engine-only claim log (`spokenClaims.ts`), never in this module's outputs.
 */

export type CertaintyBand = "sure" | "fairly-sure" | "not-sure";

export const TO_PLAYER = {
  /** Below this holder->player trust a houseguest never confides (the trust gate). */
  trustGate: 0.45,
  /** More than this many OTHERS in earshot and nobody confides (the crowd gate); below it each extra person still lowers the odds. */
  crowdMax: 2,
  crowdPenalty: 0.3,
  /** Chance at the trust gate and at full trust, before candor and the crowd. Small on purpose: a houseguest confides rarely, so the house mix does not move. */
  pAtGate: 0.06,
  pAtFullTrust: 0.3,
  /** Candor (0..1, from archetype/style) scales the chance by 1 +- this. */
  candorSwing: 0.4,
  /** The band cut points on a 0..1 confidence (held, or - for a lie - presented). ONE small function so slice 2's belief strength can replace it. */
  sureAt: 0.65,
  fairlySureAt: 0.4,
} as const;

/** THE band mapping (swappable in one place). Monotone in confidence; takes nothing about truth. */
export function certaintyBand(confidence: number): CertaintyBand {
  const c = clamp01(confidence);
  return c >= TO_PLAYER.sureAt ? "sure" : c >= TO_PLAYER.fairlySureAt ? "fairly-sure" : "not-sure";
}

/**
 * The confidence a speaker PRESENTS: what they hold when they hold the belief, else (a lie told to the player, slice 3: no matching belief) a seeded draw over the same range a held belief spans
 * (`HEARD` floor..ceiling). Ryne's Q3, no built-in tells: this never reads whether the claim is true, so a lie sounds exactly as sure as a true claim does.
 */
export function presentedConfidence(held: number | undefined, roll: number): number {
  return held !== undefined ? clamp01(held) : heardConfidence(clamp01(roll));
}
/** The band a speaker presents (held confidence, or a draw when they hold none). Never takes the truth. */
export function presentedBand(held: number | undefined, roll: number): CertaintyBand { return certaintyBand(presentedConfidence(held, roll)); }
export const PRESENTED_RANGE = { lo: HEARD.floorConfidence, hi: HEARD.ceilConfidence } as const;

/** A belief mapped to what the houseguest would say. `object` is the second party; for the speaker's own grievance it is the speaker. */
export interface SayableBelief { beliefId: string; kind: SpokenClaimKind; subject: EntityId; object?: EntityId; /** 0184 part 2a: a heard reputation's label */ label?: string; confidence: number; week: number }

/** Which belief kinds can be said, as which claim kind. A belief about the player, or one the claim catalogue has no honest kind for, is left unsaid. */
export function sayable(b: BeliefClaim, holder: EntityId, player: EntityId): SayableBelief | undefined {
  // 0184 part 2a: a reputation the holder heard may be passed on, about anyone but themself - the player included ("everyone thinks you're the snake").
  const label = b.kind === "heard-rumor" ? labelOfNature(b.nature) : undefined;
  if (label !== undefined) return b.refuted || !b.value || b.subject === holder ? undefined : { beliefId: b.id, kind: "has-reputation", subject: b.subject, label, confidence: b.confidence, week: b.week };
  if (b.refuted || !b.value || b.subject === player || b.subject === holder) return undefined;
  const base = { beliefId: b.id, subject: b.subject, confidence: b.confidence, week: b.week };
  switch (b.kind) {
    // "X is targeting ME" is said as X going after the speaker: the claim kind `targets-you` is about the LISTENER, which would be a different claim.
    case "targets-me": return { ...base, kind: "going-after", object: holder };
    case "allied-with": return b.object && b.object !== player && b.object !== b.subject ? { ...base, kind: "final-two-with", object: b.object } : undefined;
    case "lied-to-me": return { ...base, kind: "lying-about", object: holder };
    // 0153: "X voted to evict ME" is said as X having voted to evict the speaker (the claims core's `voted-against`, the speaker as object).
    case "voted-against-me": return { ...base, kind: "voted-against", object: holder };
    case "heard-rumor":
      if (!b.object || b.object === player || b.object === b.subject) return undefined;
      return b.nature === "going-after" ? { ...base, kind: "going-after", object: b.object }
        : b.nature === "talking-about" ? { ...base, kind: "talking-about", object: b.object }
        : b.nature === "lying" ? { ...base, kind: "lying-about", object: b.object }
        : b.nature === "voted-against" ? { ...base, kind: "voted-against", object: b.object }
        : b.nature === "voted-to-keep" ? { ...base, kind: "voted-to-keep", object: b.object }
        : undefined;
    default: return undefined;
  }
}

export interface ToPlayerScene {
  holder: EntityId;
  player: EntityId;
  /** The holder's trust in the player, 0..1. */
  trustInPlayer: number;
  /** Awake others in earshot besides the holder and the player. */
  audience: number;
  /** 0..1 personality (archetype + style): how forthcoming the holder is. */
  candor: number;
  /** True when the holder already told the player something today (once per houseguest per in-game day). */
  toldToday: boolean;
  /** Keys (`toPlayerKey`) of what the holder already told the player this season: never the same belief twice. */
  alreadyTold: ReadonlySet<string>;
  /** One uniform draw in [0,1) from the caller's `claims-to-player` side stream: it decides whether the holder confides this scene. */
  roll: number;
}

export const toPlayerKey = (kind: SpokenClaimKind, subject: EntityId, object?: EntityId): string => `${kind}|${subject}|${object ?? ""}`;

/** The chance this scene leads to a confidence: 0 below the trust gate or in a crowd. Exposed so a test can prove the gates without sampling. */
export function tellChance(s: Pick<ToPlayerScene, "trustInPlayer" | "audience" | "candor">): number {
  const trust = clamp01(s.trustInPlayer);
  if (trust < TO_PLAYER.trustGate || s.audience > TO_PLAYER.crowdMax) return 0;
  const along = (trust - TO_PLAYER.trustGate) / (1 - TO_PLAYER.trustGate);
  const base = TO_PLAYER.pAtGate + (TO_PLAYER.pAtFullTrust - TO_PLAYER.pAtGate) * along;
  const candor = 1 + TO_PLAYER.candorSwing * (2 * clamp01(s.candor) - 1);
  const crowd = Math.max(0, 1 - TO_PLAYER.crowdPenalty * Math.max(0, s.audience));
  return clamp01(base * candor * crowd);
}

export interface ToPlayerDecision { belief: SayableBelief; band: CertaintyBand }

/** Decide whether the holder tells the player ONE of their beliefs this scene, which one (the surest, then the freshest, then by id), and how sure they sound. Deterministic in its inputs. */
export function decideTellToPlayer(beliefs: readonly BeliefClaim[], s: ToPlayerScene): ToPlayerDecision | undefined {
  if (s.toldToday) return undefined;
  if (!(clamp01(s.roll) < tellChance(s))) return undefined;
  const pool = beliefs
    .map((b) => sayable(b, s.holder, s.player))
    .filter((b): b is SayableBelief => b !== undefined && !s.alreadyTold.has(toPlayerKey(b.kind, b.subject, b.object)));
  if (pool.length === 0) return undefined;
  pool.sort((a, b) => b.confidence - a.confidence || b.week - a.week || (a.beliefId < b.beliefId ? -1 : a.beliefId > b.beliefId ? 1 : 0));
  const belief = pool[0]!;
  return { belief, band: presentedBand(belief.confidence, 0) };
}
