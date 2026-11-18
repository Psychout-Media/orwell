import { clamp01 } from "../domain/num";
import type { EntityId } from "../domain/ids";
import { agendaRoll } from "./agenda";

/**
 * Feature 0204 (ORW-647) - THE NIGHT IT ALL COMES OUT. PURE and ENGINE-ONLY (Vault class): a secret that many houseguests already HOLD stops being a secret. On a given night it breaks in front of
 * the house (the awake room hears it at once), either said by the others once enough of them hold it, or blown up by the person it is about, who gets ahead of it when they are pressured and
 * volatile enough. Which one, and whether tonight is the night, is a closed-set rule over the facts below (never a list of reasons): every roll is a keyed `agendaRoll` (no shared rng), so a
 * seeded game stays byte-identical. The words are authored by the narrator from the recorded fact; the engine's floor line is composed from the names and the fact as it was spoken.
 * Nothing here is a Vault read: it counts who holds a fact (the knowledge layer the engine already keeps) and never carries a holder list, a truth marker or a number outward.
 */
export const SECRET_BREAK = {
  /** A fact breaks once this share of the living houseguests outside its subject hold it, and never fewer than `minHolders`. */
  holderShare: 0.6,
  minHolders: 3,
  /** The chance, on a night the fact is due, that tonight is the night it is said aloud. */
  outChance: 0.5,
  /** A pressured subject only considers blowing it up once this share of the others hold it (it is closing in). */
  closingShare: 0.34,
  /** The ceiling of a detonation's chance (the product of temper and pressure is scaled by this). */
  detonateScale: 0.6,
  /** Temper = this much volatility, the rest how unsteady they feel. */
  temperVolatility: 0.7,
  /** Pressure = how far it has spread, being on the block, and how cold the house already reads toward them. */
  pressureSpread: 0.5, pressureBlock: 0.3, pressureCold: 0.2,
  /** The room's standing hit on the subject, directed, scaled by the secret's public severity; and the share a self-detonation takes (coming clean costs less than being caught). */
  standingHit: { trust: -0.05, affinity: -0.04 },
  selfShare: 0.5,
  /** A houseguest kept out of it holds it against the holder they had trusted most (a grudge), scaled by severity. */
  keptOutSeverity: 0.35,
} as const;

export type BreakKind = "exposed" | "detonated";

export interface BreakInput {
  seed: number;
  subject: EntityId;
  factId: string;
  week: number;
  day: number;
  /** Living houseguests (not the subject, not the player) who hold the fact, and the pool they are counted against. */
  holders: number;
  pool: number;
  /** The subject's soul: volatility 0..1 and how steady they feel 0..1. */
  volatility: number;
  steadiness: number;
  /** Is the subject on the block, and how cold the house reads toward them 0..1 (the mean of how little they like them). */
  onTheBlock: boolean;
  coldness: number;
  /** A player subject never detonates by the engine's hand: that is the player's own act. */
  playerSubject: boolean;
}

export const holdersNeeded = (pool: number): number => Math.max(SECRET_BREAK.minHolders, Math.ceil(SECRET_BREAK.holderShare * pool));
export const isDue = (holders: number, pool: number): boolean => pool > 0 && holders >= holdersNeeded(pool);

/** How hard the subject is pressed, 0..1. */
export function pressureOf(i: Pick<BreakInput, "holders" | "pool" | "onTheBlock" | "coldness">): number {
  const spread = i.pool > 0 ? clamp01(i.holders / Math.max(1, holdersNeeded(i.pool))) : 0;
  return clamp01(SECRET_BREAK.pressureSpread * spread + SECRET_BREAK.pressureBlock * (i.onTheBlock ? 1 : 0) + SECRET_BREAK.pressureCold * clamp01(i.coldness));
}

/** How quick they are to blow up, 0..1: their volatility, and how unsteady they feel. */
export const temperOf = (volatility: number, steadiness: number): number =>
  clamp01(SECRET_BREAK.temperVolatility * clamp01(volatility) + (1 - SECRET_BREAK.temperVolatility) * (1 - clamp01(steadiness)));

/** The chance this subject blows up their own secret tonight (0 until the fact is closing in, and always 0 for the player). */
export function detonateChance(i: BreakInput): number {
  if (i.playerSubject || i.pool <= 0 || i.holders / i.pool < SECRET_BREAK.closingShare) return 0;
  return clamp01(SECRET_BREAK.detonateScale * temperOf(i.volatility, i.steadiness) * pressureOf(i));
}

/** Does tonight break this fact, and how? The subject's own move is considered first (they get ahead of it); else the others say it once it is due. */
export function breakDecision(i: BreakInput): BreakKind | undefined {
  const key = `${i.factId}:${i.week}:${i.day}`;
  if (agendaRoll(i.seed, i.subject, `secret-break:detonate:${key}`) < detonateChance(i)) return "detonated";
  if (isDue(i.holders, i.pool) && agendaRoll(i.seed, i.subject, `secret-break:out:${key}`) < SECRET_BREAK.outChance) return "exposed";
  return undefined;
}

/** The room's standing move on the subject (directed, per present houseguest), from the secret's public severity 0..1; a self-detonation takes less. */
export function standingMove(severity: number, kind: BreakKind): { trust: number; affinity: number } {
  const k = (0.5 + clamp01(severity)) * (kind === "detonated" ? SECRET_BREAK.selfShare : 1);
  return { trust: SECRET_BREAK.standingHit.trust * k, affinity: SECRET_BREAK.standingHit.affinity * k };
}

export const keptOutGrudge = (severity: number): number => SECRET_BREAK.keptOutSeverity * (0.5 + clamp01(severity));

/** The fact as it was said: the held wording without the retelling's hedge tail (`content · hedge#n`). */
export function spokenForm(content: string): string {
  const cut = content.indexOf(" · ");
  return (cut >= 0 ? content.slice(0, cut) : content).trim();
}

/** The floor line the record carries, composed from the names and the fact as spoken (the narrator authors the real words from it). */
export function breakLine(kind: BreakKind, subjectName: string, spoken: string, weekWords: string): string {
  return kind === "detonated"
    ? `${subjectName} blew up their own secret in front of the whole house (week ${weekWords}): ${spoken}`
    : `${subjectName}'s secret came out in front of the whole house (week ${weekWords}): ${spoken}`;
}

/** The held fact to read aloud: the holder's wording with the highest certainty, ties on the earliest holder id (deterministic). */
export function pickSpoken(held: ReadonlyArray<{ holder: EntityId; content: string; confidence?: number }>): string | undefined {
  let best: { holder: EntityId; content: string; confidence?: number } | undefined;
  for (const h of held) {
    if (!best || (h.confidence ?? 0) > (best.confidence ?? 0) || ((h.confidence ?? 0) === (best.confidence ?? 0) && h.holder < best.holder)) best = h;
  }
  return best ? spokenForm(best.content) : undefined;
}
