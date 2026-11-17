import { SWING, TRIADS } from "./triadsConstants";

/**
 * Feature 0174 (Theme 3 slice 13) - triads, swing votes, kingmakers. PURE and ENGINE-ONLY: structural balance over the holders' own reads (the enemy of my enemy; two friends of one person; an unbalanced triad)
 * and the swing read of a close vote. Nothing here is shown, no rng (keyed rolls are the caller's), no writes. Ids are sorted so the same house in any input order gives the same output.
 */
export type Id = string;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const pairKey = (a: Id, b: Id): string => (a < b ? `${a}|${b}` : `${b}|${a}`);
export { pairKey as triadPairKey };

export interface TriadView {
  /** The living houseguests. */
  living: readonly Id[];
  /** Each holder's strongest enemies (already ranked, strongest first). */
  enemiesOf(holder: Id): readonly Id[];
  /** Each holder's closest friends (already ranked, strongest first). */
  friendsOf(holder: Id): readonly Id[];
  /** The mutual tie 0..1. */
  tie(a: Id, b: Id): number;
}
export interface TriadNudge { a: Id; b: Id; kind: "shared-enemy" | "common-friend"; via: Id }
export interface TriadStrain { center: Id; weaker: Id; other: Id }

/** The enemy of my enemy: two holders who share an enemy and are not enemies themselves grow warmer. Deterministic order. */
export function sharedEnemyNudges(v: TriadView): TriadNudge[] {
  const out = new Map<string, TriadNudge>();
  const people = [...v.living].sort(cmp);
  for (const x of people) for (const y of people) {
    if (x >= y) continue;
    if (v.enemiesOf(x).includes(y) || v.enemiesOf(y).includes(x)) continue;
    const via = v.enemiesOf(x).filter((e) => e !== y && v.enemiesOf(y).includes(e)).sort(cmp)[0];
    if (via) out.set(pairKey(x, y), { a: x, b: y, kind: "shared-enemy", via });
  }
  return [...out.values()];
}

/** Two friends of one person who barely know each other drift together. Deterministic order. */
export function commonFriendNudges(v: TriadView): TriadNudge[] {
  const out = new Map<string, TriadNudge>();
  for (const p of [...v.living].sort(cmp)) {
    const f = [...v.friendsOf(p)].sort(cmp);
    for (let i = 0; i < f.length; i++) for (let j = i + 1; j < f.length; j++) {
      const a = f[i]!, b = f[j]!;
      if (v.tie(a, b) >= TRIADS.strangersBelow || v.enemiesOf(a).includes(b) || v.enemiesOf(b).includes(a)) continue;
      if (!out.has(pairKey(a, b))) out.set(pairKey(a, b), { a, b, kind: "common-friend", via: p });
    }
  }
  return [...out.values()];
}

/** An unbalanced triad: one person is close to two who are enemies of each other. The center's bond to the one they like less gives way. */
export function strainedTriads(v: TriadView, closeness: (center: Id, other: Id) => number): TriadStrain[] {
  const out: TriadStrain[] = [];
  for (const p of [...v.living].sort(cmp)) {
    const f = [...v.friendsOf(p)].sort(cmp);
    for (let i = 0; i < f.length; i++) for (let j = i + 1; j < f.length; j++) {
      const a = f[i]!, b = f[j]!;
      if (!(v.enemiesOf(a).includes(b) || v.enemiesOf(b).includes(a))) continue;
      const [weaker, other] = closeness(p, a) <= closeness(p, b) ? [a, b] : [b, a];
      out.push({ center: p, weaker, other });
    }
  }
  return out;
}

export interface VotePreview { voter: Id; pick: Id; gap: number }
export interface SwingRead {
  /** Voters whose single ballot could change who leaves, softest first (at most `SWING.maxCourted`). */
  swings: Id[];
  /** True when the player's own ballot could decide it (the others leave the vote close and the player votes). */
  playerSwing: boolean;
}
/**
 * Which ballots decide a close vote. `previews` = each NPC voter's pick and firmness. The vote is close when the NPC margin is within `SWING.closeMargin`;
 * the swing voters are the softest ballots on the leading side (flipping one of them changes the result), and the player, when they vote, is a possible swing.
 */
export function swingRead(previews: readonly VotePreview[], nominees: readonly [Id, Id] | readonly Id[], playerVotes: boolean): SwingRead {
  const [n0, n1] = nominees as readonly [Id, Id];
  const c0 = previews.filter((p) => p.pick === n0).length, c1 = previews.filter((p) => p.pick === n1).length;
  const margin = Math.abs(c0 - c1);
  if (margin > SWING.closeMargin) return { swings: [], playerSwing: false };
  const lead = c0 === c1 ? undefined : c0 > c1 ? n0 : n1;
  const pool = previews.filter((p) => lead === undefined || p.pick === lead)
    .sort((x, y) => x.gap - y.gap || cmp(x.voter, y.voter));
  return { swings: pool.slice(0, SWING.maxCourted).map((p) => p.voter), playerSwing: playerVotes && margin <= 1 };
}

/** The kingmaker of a finished vote: when it was close, the softest ballot on the winning side (or the HOH who broke a tie). Undefined when it was not close. */
export function kingmakerOf(
  voteOf: Readonly<Record<Id, Id>>, evictee: Id, gapOf: (voter: Id) => number | undefined, hoh: Id | undefined,
): Id | undefined {
  const winners = Object.keys(voteOf).filter((v) => voteOf[v] === evictee).sort(cmp);
  const total = Object.keys(voteOf).length;
  const losers = total - winners.length;
  if (winners.length === losers) return hoh; // a tie: the HOH's own choice decided it
  if (winners.length - losers > SWING.closeMargin) return undefined;
  return [...winners].sort((a, b) => (gapOf(a) ?? Infinity) - (gapOf(b) ?? Infinity) || cmp(a, b))[0];
}

/** The price a camp pays to a courted voter: it rises with the number of rival bidders (a tier, never a number shown). */
export function priceTier(rivalBidders: number): number {
  return Math.max(1, Math.min(SWING.priceCap, 1 + Math.max(0, Math.floor(rivalBidders))));
}
