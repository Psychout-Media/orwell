import type { EntityId } from "../domain/ids";

/**
 * Feature 0184 part 2a (Theme 3 slice 8, ORW-564) - SOCIAL ROLES, AS ONE OBSERVER READS THEM. Roles emerge from what a houseguest is SEEN doing, never assigned:
 *  - villain: starts fights and turns on people;
 *  - peacemaker: makes up with both sides of a fight they were not in;
 *  - therapist: takes the one who just got hit aside, one on one;
 *  - jokester: has a sense of humour and gets the group going;
 *  - outcast: seen with almost nobody, in a house the observer has seen plenty of;
 *  - snake: the observer's own reputation read (0184 part 1) is poor;
 *  - floater: nobody the observer can see is close to them.
 * Each observer reads from the scenes THEY were in or saw (witness set or house-life `seenBy`), plus the labels they were TOLD (Theme 2 claims, each at its
 * confidence). So a role can be wrong, and spreads as gossip. PURE: no rng, no I/O, no Vault. ENGINE-ONLY: a role is never shown as a label or a number;
 * houseguests voice it in their own words as gossip (Ryne's Q3 ruling, 2026-11-17).
 */
export type RoleLabel = "snake" | "floater" | "villain" | "peacemaker" | "jokester" | "therapist" | "outcast";
const LABELS: Readonly<Record<RoleLabel, true>> = { snake: true, floater: true, villain: true, peacemaker: true, jokester: true, therapist: true, outcast: true };
export const isRoleLabel = (s: string | undefined): s is RoleLabel => s !== undefined && Object.prototype.hasOwnProperty.call(LABELS, s);

export const ROLES = {
  /** How many of each kind of seen act make the role (a told label adds its confidence x `toldWeight` toward it). */
  bar: { villain: 3, peacemaker: 1, therapist: 1, jokester: 3 } as Readonly<Record<"villain" | "peacemaker" | "therapist" | "jokester", number>>,
  /** A told label counts as this many seen acts at full confidence. */
  toldWeight: 1.5,
  /** Snake: the observer's standing of them (0184 part 1, 1 = clean) at or below this. */
  snakeAtOrBelow: 0.7,
  /** Floater: the observer's floater read of them (0..1) at or above this. */
  floaterAtOrAbove: 0.85,
  /** Outcast: seen with at most this many different people, in a house the observer has seen at least `outcastMinScenes` scenes of. */
  outcastAtMostPartners: 1,
  outcastMinScenes: 12,
  /** In a leak, how often a speaker who holds a role read of someone says THAT rather than pass on a belief (measured: with beliefs to pass on, a pure fallback never fired in play). */
  voiceShare: 0.25,
  /** How far back a read looks: the last this many events of the record (a technical bound; events carry no clock). */
  recentEvents: 600,
  /** "Recently": a fight within this many events before an act counts as the fight it answers. */
  answerWindow: 40,
} as const;

/** The observer that sees every scene: the engine's own read from the record, used only to judge whether a told label is TRUE (never voiced). */
export const EVERYONE = "*" as EntityId;

/** A scene as the read needs it. */
export interface RoleScene { type: string; initiator: EntityId; people: readonly EntityId[]; seenBy: readonly EntityId[] }

export interface RoleEvidence { villain: number; peacemaker: number; therapist: number; jokester: number; partners: number; scenesSeen: number }

/** What `observer` saw `subject` do, from the recent scenes (oldest first). */
export function roleEvidence(scenes: readonly RoleScene[], observer: EntityId, subject: EntityId, hasHumor: boolean): RoleEvidence {
  const out: RoleEvidence = { villain: 0, peacemaker: 0, therapist: 0, jokester: 0, partners: 0, scenesSeen: 0 };
  const partners = new Set<EntityId>();
  const recent = scenes.slice(-ROLES.recentEvents);
  const saw = (s: RoleScene) => observer === EVERYONE || s.people.includes(observer) || s.seenBy.includes(observer);
  for (let i = 0; i < recent.length; i++) {
    const s = recent[i]!;
    if (!saw(s)) continue;
    out.scenesSeen++;
    if (!s.people.includes(subject)) continue;
    for (const p of s.people) if (p !== subject && p !== observer) partners.add(p);
    if (s.initiator !== subject) continue;
    if (s.type === "conflict" || s.type === "betrayal") { out.villain++; continue; }
    if (s.type !== "bonding") continue;
    if (hasHumor && s.people.length >= 3) out.jokester++;
    const others = s.people.filter((p) => p !== subject);
    // the fights this observer saw just before, that the subject was NOT in
    const fights = recent.slice(Math.max(0, i - ROLES.answerWindow), i).filter((f) => saw(f) && f.type === "conflict" && !f.people.includes(subject));
    if (others.length === 1 && fights.some((f) => f.people.includes(others[0]!) && f.initiator !== others[0])) out.therapist++; // the one who got hit, taken aside
    if (fights.some((f) => others.includes(f.initiator) && f.people.some((p) => p !== f.initiator && others.includes(p)))) out.peacemaker++; // both sides of the fight, brought together
  }
  out.partners = partners.size;
  return out;
}

/** The role `observer` holds of someone: the strongest over its bar, or undefined. `told` = labels they were told, at their confidence. Ties by label order. */
export function roleRead(e: RoleEvidence, standing: number, floater: number, told: Partial<Record<RoleLabel, number>>): RoleLabel | undefined {
  const t = (l: RoleLabel) => (told[l] ?? 0) * ROLES.toldWeight;
  const scores: Array<[RoleLabel, number]> = [
    ["snake", standing <= ROLES.snakeAtOrBelow ? 1 + (ROLES.snakeAtOrBelow - standing) + t("snake") : t("snake")],
    ["villain", (e.villain + t("villain")) / ROLES.bar.villain],
    ["peacemaker", (e.peacemaker + t("peacemaker")) / ROLES.bar.peacemaker],
    ["therapist", (e.therapist + t("therapist")) / ROLES.bar.therapist],
    ["jokester", (e.jokester + t("jokester")) / ROLES.bar.jokester],
    ["outcast", (e.scenesSeen >= ROLES.outcastMinScenes && e.partners <= ROLES.outcastAtMostPartners ? 1 : 0) + t("outcast")],
    ["floater", (floater >= ROLES.floaterAtOrAbove ? 1 : 0) + t("floater")],
  ];
  let best: RoleLabel | undefined;
  let top = 1 - 1e-9; // a role needs a full bar
  for (const [l, s] of scores) if (s > top) { best = l; top = s; }
  return best;
}
