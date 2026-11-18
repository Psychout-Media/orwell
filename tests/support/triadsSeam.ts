import { PLAYER } from "../../src/domain/ids";
import { playedSession, type Played, type Edge } from "./favorsSeam";

/**
 * 0174 test seam: a played session (favors on) with the private triad methods reachable. TEST-ONLY. Roles only.
 */
export type TriadSeam = {
  live: { playedGame?: boolean; week: number; dayNumber?: number; dealOffer?: { id?: string; from: string; kind: string; terms: string; madeWeek?: number }; votePitch?: { id: string; from: string; kind: string; terms: string; madeWeek: number }; lastDealOfferWeek?: number; pending?: unknown; triads?: { day?: number; drift?: Record<string, number>; courted?: Array<{ week: number; voter: string; bidders: string[]; tier: number }>; kingmakers?: Array<{ week: number; voter: string; evictee: string; courted: boolean }>; lastGaps?: unknown }; evictionOrder: string[] };
  rel: { edge(a: string, b: string): Edge };
  triadsTick(): void;
  swingAtVote(v: { nominees: readonly string[]; voters: readonly string[]; previews: ReadonlyArray<{ voter: string; pick: string; gap: number }> }): void;
  triadsAtResult(r: { evictee: string; voteOf: Record<string, string>; hoh: string | undefined }): void;
  buildVaultUnseal(): { hiddenStory?: Array<{ type: string; content: string }> };
  setOnPlayerEvent(f: (c: string, w: string[], t?: string) => string | undefined): void;
};
export const seamOf = (p: Played): TriadSeam => p.session as unknown as TriadSeam;

export function triadSession(seed: number, opts: { triads?: boolean } = {}): Played {
  const p = playedSession(seed);
  p.session.setTriadsEnabled(opts.triads ?? true);
  return p;
}

/** Everyone at baseline toward everyone (no friends, no enemies), so only what a scenario sets stands out. */
export function flatten(p: Played): void {
  const ids = [PLAYER, ...p.npcs];
  for (const a of ids) for (const b of ids) if (a !== b) Object.assign(p.seam.rel.edge(a, b), { trust: 0.25, affinity: 0.25, threat: 0.1 });
}
export const set = (p: Played, a: string, b: string, e: Partial<Edge>): void => { Object.assign(p.seam.rel.edge(a, b), e); };
export const close = (p: Played, a: string, b: string, v = 0.9): void => { set(p, a, b, { trust: v, affinity: v, threat: 0.05 }); set(p, b, a, { trust: v, affinity: v, threat: 0.05 }); };

/** Run `days` in-game days of the daily step. */
export function runDays(p: Played, days: number, from = 2): void {
  const s = seamOf(p);
  for (let d = 0; d < days; d++) { s.live.dayNumber = from + d; s.triadsTick(); }
}
