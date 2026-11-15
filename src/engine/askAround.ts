/**
 * ORW-475 (Kevin with Ryne, 2026-11-15): asking around. A houseguest asked about a third houseguest answers from their OWN record of who they saw go where; whether they tell it straight, dodge or mislead is not one rule
 * for everyone but comes from THEIR character sheet (how candid their archetype and style make them) and from how they feel about the player and about the person asked about. Pure and deterministic (the caller supplies a
 * seeded roll): it draws no rng and reads no Vault.
 */
export type AskOutcome = "tells" | "dodges" | "misleads";

export interface AskSheet {
  /** 0..1, from the archetype and strategy style (the same candor the mood-cause telling uses). */
  candor: number;
  /** How the asked houseguest feels about the PLAYER, 0..1. */
  affinityToPlayer: number;
  /** How the asked houseguest feels about the PERSON asked about, 0..1. */
  affinityToSubject: number;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * The chances come from the sheet: a candid houseguest (candor near 1) always tells. A guarded one protects someone they are fonder of than the player (misleads, at most `candor`'s complement times how much fonder),
 * and is evasive with a player they do not warm to (dodges). Everything else is told straight. `roll` is a seeded value in [0, 1).
 */
export function askDisposition(s: AskSheet, roll: number): AskOutcome {
  const guarded = 1 - clamp01(s.candor);
  const protect = clamp01(s.affinityToSubject - s.affinityToPlayer);
  const pMislead = guarded * protect;
  const pDodge = guarded * 0.5 * (1 - protect) * (1 - clamp01(s.affinityToPlayer));
  if (roll < pMislead) return "misleads";
  if (roll < pMislead + pDodge) return "dodges";
  return "tells";
}

/** The seeded roll in [0, 1) for one houseguest asked about one subject in one part of one day (deterministic; no rng stream is advanced). */
export function askRoll(hash: number): number {
  return ((hash >>> 0) % 10000) / 10000;
}
