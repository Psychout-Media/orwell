import type { EntityId } from "../domain/ids";
import { editWorthiness, type EditMoment, type EditMomentKind } from "./editWorthiness";

/**
 * ORW-624 (Ryne OK'd 2026-11-17) - THE AUDIENCE OUTSIDE. A simulated viewing public forms its own opinion of every houseguest, the player included, from what would
 * make the edit (`editWorthiness`). It is FELT, never shown: the crowd as an evictee walks out (cheers, mixed, boos or silence), a small fan reward, America's
 * Favorite after the crown. PURE: no I/O; the season's taste is the caller's seeded roll.
 *
 * The wall (the Auditor's call): during play the public sees only what the HOUSE saw (`moment.public`), so a crowd reaction can never pinpoint a secret. Hidden
 * edit-worthy moments fold into a separate full standing that is read only after the crown (the recap, America's Favorite).
 */
export const AUDIENCE = {
  /** How a moment moves the public's view of the one who did it and the one it happened to, at full edit-worthiness (signed; the season's taste scales it). */
  actor: { "comp-win": 0.12, "veto-save": 0.1, "veto-kept": -0.02, replacement: -0.04, nomination: -0.03, eviction: 0, blindside: 0.06, blowup: -0.1, betrayal: -0.12, "house-meeting": 0.04, showmance: 0.06, scheme: 0.05 } as Readonly<Record<EditMomentKind, number>>,
  subject: { "comp-win": 0, "veto-save": 0.06, "veto-kept": 0.02, replacement: 0.05, nomination: 0.04, eviction: 0.03, blindside: 0.1, blowup: 0.06, betrayal: 0.1, "house-meeting": -0.02, showmance: 0.06, scheme: -0.03 } as Readonly<Record<EditMomentKind, number>>,
  /** The season's taste: each kind's weight is scaled within 1 +/- this (a public that loves villains, one that loves underdogs). */
  tasteSpan: 0.5,
  /** Below this much total edit-worthiness, the public barely knows them: silence. */
  silentBelow: 0.6,
  /** Standing bands for the walk out. */
  cheersAt: 0.15,
  boosAt: -0.15,
  /** The weeks a fan reward is given (by week number; the engine's own schedule, not a pick). */
  perkWeeks: [4, 8] as readonly number[],
  /**
   * A fan reward is a PUBLIC moment the house sees: each houseguest reads the winner as a bigger jury threat ("America likes them"), more as the holder plays the social
   * game (social 0..1 scales it within 0.5..1.5). Applies to the player as the winner; an NPC winner is told to the player as the house event it is.
   */
  fanThreat: 0.06,
} as const;

/** How much a fan reward raises `holder`'s read of the winner as a threat, from the holder's social game (0..1). */
export const fanThreatFor = (social: number): number => AUDIENCE.fanThreat * (0.5 + Math.max(0, Math.min(1, social)));

/** One eviction's key in the folded record (a twist night's second eviction in the same week is its own fold). */
export const evictionKey = (week: number, evictee: EntityId): string => `${week}:${evictee}`;

export type CrowdReaction = "cheers" | "mixed" | "boos" | "silence";

export interface Standing {
  /** The public's view, signed (0 = neutral). */
  view: Record<EntityId, number>;
  /** How much edit-worthy screen time each has had (silence when too little). */
  screen: Record<EntityId, number>;
}
export const emptyStanding = (): Standing => ({ view: {}, screen: {} });

/** Fold one moment into a standing. `taste(kind)` is the season's scale for the kind (1 = neutral). */
export function foldMoment(st: Standing, m: EditMoment, taste: (k: EditMomentKind) => number): void {
  const w = editWorthiness(m) * taste(m.kind);
  if (m.actor !== undefined) {
    st.view[m.actor] = (st.view[m.actor] ?? 0) + AUDIENCE.actor[m.kind] * w;
    st.screen[m.actor] = (st.screen[m.actor] ?? 0) + w;
  }
  if (m.subject !== undefined && m.subject !== m.actor) {
    st.view[m.subject] = (st.view[m.subject] ?? 0) + AUDIENCE.subject[m.kind] * w;
    st.screen[m.subject] = (st.screen[m.subject] ?? 0) + w;
  }
}

/** The season's taste for a kind from its seeded roll (0..1): 1 +/- tasteSpan. */
export const tasteOf = (roll: number): number => 1 + AUDIENCE.tasteSpan * (2 * Math.max(0, Math.min(1, roll)) - 1);

/** The crowd as `id` walks out. */
export function crowdFor(st: Standing, id: EntityId): CrowdReaction {
  if ((st.screen[id] ?? 0) < AUDIENCE.silentBelow) return "silence";
  const v = st.view[id] ?? 0;
  return v >= AUDIENCE.cheersAt ? "cheers" : v <= AUDIENCE.boosAt ? "boos" : "mixed";
}

/** The public's favorite among `eligible` (highest view, ties by id); undefined when nobody has been noticed. */
export function favoriteOf(st: Standing, eligible: readonly EntityId[]): EntityId | undefined {
  const seen = eligible.filter((id) => (st.screen[id] ?? 0) > 0);
  return seen.sort((a, b) => (st.view[b] ?? 0) - (st.view[a] ?? 0) || (a < b ? -1 : a > b ? 1 : 0))[0];
}
