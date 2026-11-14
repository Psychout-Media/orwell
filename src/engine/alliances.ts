import type { EntityId } from "../domain/ids";
import { clamp01Raw as clamp01 } from "../domain/num";

/**
 * Feature 0107 — NAMED ALLIANCES. An explicit, NAMED, multi-party pact layered over the emergent bloc
 * (0043) + deal (0039) systems. The point is the *name*: in Big Brother, naming an alliance cements it
 * "in reality" — real or not. So a named alliance does three things, all bounded:
 *
 *   1. CEMENT — a small per-pair TIE BOOST added to co-members' mutual bond in `detectBlocs`, so naming
 *      pulls a borderline cluster together and tightens it. But the real bonds still rule: the boost is
 *      bounded, so a HOLLOW alliance over weak bonds never reaches the bloc threshold — it stays hollow.
 *   2. FAVOR — a bounded GOODWILL bump toward each co-ally (feeds the 0075 confidence ledger): naming an
 *      alliance is an easy way to bank a little good favor with the people in it.
 *   3. STAKES — betraying a NAMED co-ally is a heavier betrayal than breaking an unspoken bond (a
 *      multiplier on the reconciliation demerit): putting it on record raises the cost of breaking it.
 *
 * SATURATION DILUTES (the owner's "the show has too many alliances that mean nothing"): the more
 * alliances a houseguest piles into, the less each one cements — so a tight, exclusive pact beats a web
 * of overlapping ones. Pure + deterministic; Vault-only (the cement/favor magnitudes never cross to the
 * player — they see the NAME + members, never a number).
 */

export interface Alliance {
  id: string;
  name: string;
  members: EntityId[];
  founder: EntityId;
  /** The beat the alliance was named (for ordering / recency). */
  formedBeat: number;
  /** Who is AWARE the alliance exists (symmetric perspective, like a campaign's `knownTo`): the members,
   *  plus anyone who later learns of it through a pathway. Never the whole house by default. */
  knownTo: EntityId[];
}

export interface AllianceConstants {
  /** Base per-pair tie boost a single named alliance adds to co-members' mutual bond (cements clustering). */
  tieBoost: number;
  /** The bounded favor (goodwill) co-membership banks toward an ally — feeds the 0075 confidence ledger. */
  favor: number;
  /** Saturation: a member's Nth alliance contributes `saturationFalloff^(N-1)` of the effect (dilution). */
  saturationFalloff: number;
  /** A houseguest declines to JOIN unless their mutual bond toward the founder clears this floor. */
  joinBondFloor: number;
  /** How much heavier a betrayal of a NAMED co-ally is vs. an unspoken bond (multiplier on the demerit). */
  betrayalMultiplier: number;
  /** Phase B: an NPC names an alliance only over co-members whose mutual bond clears this (higher than the
   *  player floor — an NPC commits to real bonds, not a hopeful pitch). */
  npcAllyFloor: number;
  /** ORW-341: how much warmer a houseguest who has been pitched this week counts toward the pitcher when deciding to join (a bounded bonus on the mutual bond, not a new magnitude). */
  pitchedWarmth: number;
  /** Phase B: the most houseguests an NPC-named alliance starts with (the founder + up to this−1 allies). */
  maxNpcSize: number;
  /** Phase B: an NPC founder pitches the PLAYER into their alliance only when their mutual bond clears this. */
  pitchPlayerFloor: number;
  /** Phase B: the bounded threat bump a named-alliance betrayal lands on the wronged → betrayer edge. */
  betrayalThreatBump: number;
}

export const ALLIANCE: AllianceConstants = {
  tieBoost: 0.12,        // bounded — a hollow (low-bond) pact never reaches the 0.5 bloc threshold on this alone
  favor: 0.15,           // ≈ an open deal's goodwill: a little good favor, never trust on its own
  saturationFalloff: 0.6,
  joinBondFloor: 0.45,
  betrayalMultiplier: 1.5,
  npcAllyFloor: 0.58,
  pitchedWarmth: 0.05,
  maxNpcSize: 4,
  pitchPlayerFloor: 0.6,
  betrayalThreatBump: 0.18,
};

/** Generic, BB-plausible alliance NAMES (never a houseguest name) — an NPC names theirs from this pool. */
export const ALLIANCE_NAMES: readonly string[] = [
  "The Brigade", "The Committee", "The Core", "The Nucleus", "Final Four", "The Quad", "Six Pack",
  "The Pact", "The Syndicate", "The Inner Circle", "The Crew", "The Founders", "The Outsiders",
  "The Regulators", "The Hitmen", "The Bloc Party", "The Round Table", "The Cartel",
];

/** Pick an unused alliance name (seeded); falls back to a numbered one if the pool is exhausted. */
export function pickAllianceName(rng: { int(n: number): number }, taken: ReadonlySet<string>): string {
  const free = ALLIANCE_NAMES.filter((n) => !taken.has(n));
  if (free.length > 0) return free[rng.int(free.length)]!;
  return `${ALLIANCE_NAMES[rng.int(ALLIANCE_NAMES.length)]!} ${taken.size + 1}`;
}

/** Whether two member lists are the same set (order-independent) — the NPC-formation dedup. */
export function sameMembers(a: readonly EntityId[], b: readonly EntityId[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((m) => s.has(m));
}

/** The active alliances a houseguest is a member of. */
export function alliancesOf(alliances: readonly Alliance[], member: EntityId): Alliance[] {
  return alliances.filter((a) => a.members.includes(member));
}

/** Saturation weight for a member's `n`th-and-up alliances: 1 for the first, falling off thereafter. */
function saturationWeight(count: number, c: AllianceConstants): number {
  return count <= 0 ? 0 : Math.pow(c.saturationFalloff, count - 1);
}

/**
 * The CEMENT — the bounded tie boost the NAMED alliances two houseguests SHARE add to their mutual bond
 * in `detectBlocs`. Saturation-diluted by how many alliances each is in (the busier the web, the weaker
 * each strand), and capped so naming can pull a borderline pair together but never fabricate a bloc from
 * nothing. 0 when they share no alliance ⇒ byte-identical bloc detection.
 */
export function allianceTieBoost(alliances: readonly Alliance[], a: EntityId, b: EntityId, c: AllianceConstants = ALLIANCE): number {
  const shared = alliances.filter((al) => al.members.includes(a) && al.members.includes(b)).length;
  if (shared === 0) return 0;
  const busiest = Math.max(alliancesOf(alliances, a).length, alliancesOf(alliances, b).length);
  // The pair's strongest shared strand, diluted by the busiest member's saturation. Capped at the base
  // boost so even several shared alliances never exceed one clean tie (no stacking a hollow bloc into being).
  return clamp01(Math.min(c.tieBoost, c.tieBoost * shared * saturationWeight(busiest, c)));
}

/**
 * The FAVOR — the bounded goodwill co-membership in named alliances banks toward `ally` from `holder`'s
 * side (added to the 0075 deal-goodwill ledger). Saturation-diluted; 0 if they share no alliance.
 */
export function allianceFavor(alliances: readonly Alliance[], holder: EntityId, ally: EntityId, c: AllianceConstants = ALLIANCE): number {
  const shared = alliances.filter((al) => al.members.includes(holder) && al.members.includes(ally)).length;
  if (shared === 0) return 0;
  return clamp01(c.favor * saturationWeight(alliancesOf(alliances, holder).length, c));
}

/**
 * The STAKES — the betrayal multiplier when `actor` moves against `target` and they share a named
 * alliance: a named betrayal cuts deeper than breaking an unspoken bond. 1 (no scaling) when they share
 * none, so the existing reconciliation is unchanged absent alliances.
 */
export function allianceBetrayalScale(alliances: readonly Alliance[], actor: EntityId, target: EntityId, c: AllianceConstants = ALLIANCE): number {
  const shared = alliances.some((al) => al.members.includes(actor) && al.members.includes(target));
  return shared ? c.betrayalMultiplier : 1;
}

/**
 * Enroll the WILLING members of a proposed alliance (the bond-gated join — anti-watering-down): the
 * founder is always in; every other proposed member joins ONLY if their mutual bond toward the founder
 * clears `joinBondFloor`. So you cannot name everyone your ally — a houseguest who barely knows you
 * declines, and the alliance forms only over real-enough bonds. PURE: the caller supplies the bond reads.
 */
export function willingMembers(
  founder: EntityId,
  proposed: readonly EntityId[],
  mutualBondTo: (member: EntityId) => number,
  c: AllianceConstants = ALLIANCE,
): EntityId[] {
  const out = [founder];
  for (const m of proposed) {
    if (m === founder || out.includes(m)) continue;
    if (mutualBondTo(m) >= c.joinBondFloor) out.push(m);
  }
  return out;
}

/** A live, mutable store of named alliances (sibling to the 0039 `DealStore`). Engine-only; Vault-sealed. */
export class AllianceStore {
  private alliances: Alliance[] = [];
  private seq = 0;

  all(): readonly Alliance[] { return this.alliances; }

  add(name: string, founder: EntityId, members: EntityId[], formedBeat: number): Alliance {
    const a: Alliance = {
      id: `alliance:${++this.seq}`,
      name: name.trim() || `Alliance ${this.seq}`,
      members: [...members],
      founder,
      formedBeat,
      knownTo: [...members], // symmetric perspective: only the members know at formation
    };
    this.alliances.push(a);
    return a;
  }

  forMember(member: EntityId): Alliance[] { return alliancesOf(this.alliances, member); }

  byId(id: string): Alliance | undefined { return this.alliances.find((a) => a.id === id); }

  /** The alliances a houseguest is AWARE of but NOT a member of (a pitch they can still accept). */
  pitchesFor(who: EntityId): Alliance[] {
    return this.alliances.filter((a) => a.knownTo.includes(who) && !a.members.includes(who));
  }

  /** Make `who` aware of an alliance (a pitch surfaces it without enrolling them). */
  reveal(id: string, who: EntityId): void {
    const a = this.byId(id);
    if (a && !a.knownTo.includes(who)) a.knownTo.push(who);
  }

  /** Enroll `who` (they accepted a pitch); also makes them aware. No-op if already a member. */
  join(id: string, who: EntityId): Alliance | undefined {
    const a = this.byId(id);
    if (!a) return undefined;
    if (!a.members.includes(who)) a.members.push(who);
    if (!a.knownTo.includes(who)) a.knownTo.push(who);
    return a;
  }

  /** Remove `who` (they betrayed it / left); an alliance that falls below two members dissolves. */
  removeMember(id: string, who: EntityId): void {
    const a = this.byId(id);
    if (!a) return;
    a.members = a.members.filter((m) => m !== who);
    if (a.members.length < 2) this.alliances = this.alliances.filter((x) => x.id !== id);
  }

  /** Every active alliance the two houseguests SHARE (for the betrayal-stakes fold). */
  shared(a: EntityId, b: EntityId): Alliance[] {
    return this.alliances.filter((al) => al.members.includes(a) && al.members.includes(b));
  }

  /** Drop any member who has left the game (evicted); a one-member alliance dissolves. */
  prune(living: ReadonlySet<EntityId>): void {
    this.alliances = this.alliances
      .map((a) => ({ ...a, members: a.members.filter((m) => living.has(m)), knownTo: a.knownTo.filter((k) => living.has(k)) }))
      .filter((a) => a.members.length >= 2);
  }

  serialize(): Alliance[] { return this.alliances.map((a) => ({ ...a, members: [...a.members], knownTo: [...a.knownTo] })); }

  load(rows: readonly Alliance[]): void {
    this.alliances = rows.map((a) => ({ ...a, members: [...a.members], knownTo: [...a.knownTo] }));
    this.seq = rows.length;
  }
}
