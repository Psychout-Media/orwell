import type { SpokenClaim } from "./spokenClaims";

/**
 * ORW-592 (T2-9) - the contradiction check reads TIME. Two claims by one speaker can only expose a lie if they were about the same world:
 * a stance (`final-two-with`, `going-after`) can honestly change once the house changes, so it only clashes with another stance told the same
 * in-game day (same week; the day when both carry one); a vote claim (`voted-to-keep`, `voted-against`) is a past fact about one week's eviction, so it
 * clashes only inside the same week. Pure, deterministic, no rng. The pair table itself stays `contradicts` (caughtLies.ts).
 */
const VOTE_KINDS: readonly string[] = ["voted-to-keep", "voted-against"];

export function sameMoment(a: Pick<SpokenClaim, "kind" | "week" | "day">, b: Pick<SpokenClaim, "kind" | "week" | "day">): boolean {
  if (a.week !== b.week) return false;
  if (VOTE_KINDS.includes(a.kind) && VOTE_KINDS.includes(b.kind)) return true;
  return a.day === undefined || b.day === undefined || a.day === b.day;
}
