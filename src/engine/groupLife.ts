/**
 * 0172 (Theme 3 slice 6, ORW-603 / ORW-611) - GROUP LIFE: roles in an alliance, an inner circle, a private cut order, a spy, a shadow group, a purpose that shifts, and the crack that follows.
 *
 * PURE and ENGINE-ONLY. Every function reads what the caller hands it (the bond tie, the comp stats, the threat each holds) and returns an engine key or an id; none touches a random stream, a
 * store or the clock. A tie that needs a draw takes a keyed `agendaRoll` the caller supplies. VAULT-CLASS: a role, a nesting, a spy, a shadow link and a cut order live in `live.groupLife`
 * (engine-only, persisted, never projected) and in the alliance history; no view, tool result or narrator prompt carries them. The roles are engine enums: the words a player ever reads about a
 * group are the ones the houseguests say, authored live from the house's facts, never a label from here.
 *
 * No list in this module feeds a pick. Roles are filled greedily by a SCORE read off the members' own bonds and stats; the order in which the roles are offered only breaks a tie between roles, and a
 * tie between members goes to a keyed roll, then the id.
 */
import type { EntityId } from "../domain/ids";

/** The engine roles of a member of an alliance. Keys, not words: never shown to a player. */
export type GroupRole = "leader" | "strategist" | "shield" | "swing" | "glue" | "comp-threat";
/** What the group is for right now: it shifts with how much of the house is left. */
export type GroupPurpose = "survival" | "power" | "endgame";

export interface GroupLife {
  /** member -> role. */
  roles: Record<EntityId, GroupRole>;
  purpose: GroupPurpose;
  /** A nested group: a few members closer to each other than to the rest, which the rest do not know of. */
  inner?: EntityId[];
  /** member -> that member's private cut order (the first few they would take out, in order). */
  cutOrder?: Record<EntityId, EntityId[]>;
  /** The target the majority has agreed (the Borda head of the members' cut orders). */
  agreed?: EntityId;
  /** A member who is here only to learn the group's plans, and the person they really work for. `reported` is the last target they passed on. */
  spy?: { member: EntityId; reportsTo: EntityId; reported?: EntityId };
  /** This group formed against another one (its id). */
  shadowOf?: string;
  /** A shadow group has already formed against this one. */
  shadowed?: true;
  /** The group has cracked (once); the day it did. */
  crackedDay?: number;
  /** The in-game day the cut orders were last drawn up. */
  planDay?: number;
}

export const GROUP_LIFE = {
  /** The cut order keeps this many names per member. */
  cutDepth: 3,
  /** A purpose is `survival` while at least this share of the starting cast is still in the house. */
  survivalShare: 0.62,
  /** ... and `power` while at least this share is (below it, `endgame`). */
  powerShare: 0.34,
  /** An inner circle's mean tie must beat its mean tie to the rest of the alliance by this much. */
  innerMargin: 0.08,
  /** The inner circle's size. */
  innerSize: 3,
  /** The smallest alliance that nests an inner circle (it needs someone outside it). */
  innerMinMembers: 4,
  /** The daily chance a qualifying alliance cracks once its members' cut orders collide (power / endgame; power is milder). */
  crackChance: 0.3,
  powerCrackScale: 0.5,
  /** The daily chance (per alliance) an outsider is drawn to spy on it. */
  spyChance: 0.015,
  /** A spy must be at least this close to the person they report to (the mutual bond, 0..1). */
  spyTieFloor: 0.5,
  /** The daily chance a group that is running the house draws a counter-alliance among those it would cut. */
  shadowChance: 0.25,
  /** A bounded, one-time threat step a member's read of the agreed target takes when the majority settles on them. */
  planThreatBump: 0.03,
  /** The bounded threat step a leaked plan lands on the wronged one's read of each member of the group that planned it. */
  leakThreatBump: 0.08,
} as const;

/** The roles in the order they are offered. Only a tie between two roles' best candidates reads this order. */
const OFFER: readonly GroupRole[] = ["leader", "strategist", "comp-threat", "shield", "glue", "swing"];

/** What the role scores read, per member of the alliance. All 0..1; the caller builds it from the bond reader, the house graph and the character. */
export interface MemberRead {
  id: EntityId;
  stats: { physical: number; mental: number; social: number };
  /** The member's mean tie to the other members. */
  inner: number;
  /** The member's weakest tie to any other member. */
  weakest: number;
  /** The member's mean tie to houseguests outside the alliance. */
  outside: number;
  hub: boolean;
  broker: boolean;
}

const clamp = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

function score(role: GroupRole, m: MemberRead, leader: MemberRead | undefined, tieTo: (a: EntityId, b: EntityId) => number): number {
  switch (role) {
    case "leader": return clamp(m.inner * 0.7 + (m.hub ? 0.2 : 0) + m.stats.social * 0.1);
    case "strategist": return clamp(m.stats.mental * 0.8 + m.inner * 0.2);
    case "comp-threat": return clamp(Math.max(m.stats.physical, m.stats.mental) * 0.7 + Math.min(m.stats.physical, m.stats.mental) * 0.3);
    case "shield": return clamp(m.outside * 0.7 + m.stats.social * 0.3);
    case "glue": return clamp(m.weakest * 0.7 + m.inner * 0.3);
    case "swing": return clamp((leader ? 1 - tieTo(m.id, leader.id) : 0.5) * 0.4 + m.outside * 0.3 + (m.broker ? 0.3 : 0));
  }
}

/**
 * Deal the roles. Every member holds one: the six roles fill in the offered order, each to the best remaining score (a keyed roll, then the id, breaks a tie), and a member left over in a bigger alliance is glue.
 * With fewer members than roles, the roles that fit are filled and none is left held by nobody while a member is without one. Pure and deterministic.
 */
export function assignRoles(reads: readonly MemberRead[], tieTo: (a: EntityId, b: EntityId) => number, roll: (id: EntityId, role: GroupRole) => number, keep: Readonly<Record<EntityId, GroupRole>> = {}): Record<EntityId, GroupRole> {
  const out: Record<EntityId, GroupRole> = {};
  const free = new Map(reads.map((r) => [r.id, r] as const));
  const taken = new Set<GroupRole>();
  for (const r of reads) { const k = keep[r.id]; if (k && !taken.has(k)) { out[r.id] = k; taken.add(k); free.delete(r.id); } }
  let leader = reads.find((r) => out[r.id] === "leader");
  for (const role of OFFER) {
    if (taken.has(role) || free.size === 0) continue;
    const best = [...free.values()].sort((a, b) => score(role, b, leader, tieTo) - score(role, a, leader, tieTo) || roll(b.id, role) - roll(a.id, role) || a.id.localeCompare(b.id))[0]!;
    out[best.id] = role; taken.add(role); free.delete(best.id);
    if (role === "leader") leader = best;
  }
  for (const r of free.values()) out[r.id] = "glue";
  return out;
}

/**
 * The inner circle: the triple whose members are closer to each other than to the rest of the alliance, by `innerMargin`. Undefined for a small alliance or when no triple stands out.
 * Ties between triples go to the lexically first.
 */
export function innerCircle(members: readonly EntityId[], tieTo: (a: EntityId, b: EntityId) => number): EntityId[] | undefined {
  const ms = [...members].sort();
  const n = GROUP_LIFE.innerSize;
  if (ms.length < GROUP_LIFE.innerMinMembers || ms.length <= n) return undefined;
  let best: { set: EntityId[]; gap: number } | undefined;
  const pick = (start: number, cur: EntityId[]): void => {
    if (cur.length === n) {
      let inSum = 0, inN = 0, outSum = 0, outN = 0;
      for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
        const t = tieTo(ms[i]!, ms[j]!);
        if (cur.includes(ms[i]!) && cur.includes(ms[j]!)) { inSum += t; inN++; } else if (cur.includes(ms[i]!) || cur.includes(ms[j]!)) { outSum += t; outN++; }
      }
      const gap = inSum / Math.max(1, inN) - outSum / Math.max(1, outN);
      if (!best || gap > best.gap + 1e-12) best = { set: [...cur], gap };
      return;
    }
    for (let i = start; i < ms.length; i++) pick(i + 1, [...cur, ms[i]!]);
  };
  pick(0, []);
  return best && best.gap >= GROUP_LIFE.innerMargin ? best.set : undefined;
}

/** What the group is for, from how much of the starting cast is still in the house. */
export function purposeAt(living: number, cast: number): GroupPurpose {
  const share = cast > 0 ? living / cast : 1;
  return share >= GROUP_LIFE.survivalShare ? "survival" : share >= GROUP_LIFE.powerShare ? "power" : "endgame";
}

/** What a member reads when drawing up their own cut order. All 0..1. */
export interface CutRead {
  /** The threat the candidate is to the member's own game (the member's read of them). */
  threat: number;
  /** The candidate's comp strength. */
  comp: number;
  /** The member's tie to the candidate. */
  tie: number;
}

/**
 * One member's private cut order: everyone living but themselves, worst for their game first (threat and comp weight up, a tie weighs down). While the group is in survival its own members are not on the order;
 * once the purpose moves on they are, and a member's tie to a fellow member only softens it. Pure; the first `cutDepth` names.
 */
export function cutOrderOf(self: EntityId, living: readonly EntityId[], members: readonly EntityId[], purpose: GroupPurpose, read: (other: EntityId) => CutRead): EntityId[] {
  const mine = new Set(members);
  const weight = purpose === "endgame" ? 1 : 0.8;
  return living
    .filter((o) => o !== self && (purpose !== "survival" || !mine.has(o)))
    .map((o) => { const r = read(o); return { o, s: (r.threat * 0.55 + r.comp * 0.45 - r.tie * 0.5) * (mine.has(o) ? weight : 1) }; })
    .sort((a, b) => b.s - a.s || a.o.localeCompare(b.o))
    .slice(0, GROUP_LIFE.cutDepth)
    .map((x) => x.o);
}

/** The majority's agreed target: the Borda head of the members' orders over those who are NOT members. Undefined when no order names an outsider. */
export function agreedTarget(orders: Readonly<Record<EntityId, readonly EntityId[]>>, members: readonly EntityId[]): EntityId | undefined {
  const mine = new Set(members);
  const pts = new Map<EntityId, number>();
  for (const order of Object.values(orders)) order.filter((o) => !mine.has(o)).forEach((o, i) => pts.set(o, (pts.get(o) ?? 0) + (GROUP_LIFE.cutDepth - i)));
  return [...pts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

/**
 * Do the members' private cut orders collide? A member whose FIRST name is a fellow member, in a group whose purpose has moved past survival, is aimed at someone inside. Returns the member most often
 * named first (the one the others would cut) and who named them: those cutters are the faction that breaks away. Undefined when the orders agree.
 */
export function collision(orders: Readonly<Record<EntityId, readonly EntityId[]>>, members: readonly EntityId[], purpose: GroupPurpose): { cut: EntityId; cutters: EntityId[] } | undefined {
  if (purpose === "survival") return undefined;
  const mine = new Set(members);
  const by = new Map<EntityId, EntityId[]>();
  for (const [m, order] of Object.entries(orders)) { const head = order[0]; if (head && mine.has(head) && head !== m) by.set(head, [...(by.get(head) ?? []), m]); }
  const top = [...by.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  return top ? { cut: top[0], cutters: [...top[1]].sort() } : undefined;
}
