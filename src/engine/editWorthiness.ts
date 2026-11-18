import type { EntityId } from "../domain/ids";

/**
 * ORW-624 (Ryne OK'd 2026-11-17: "Things you think would make the edit of the show") - EDIT-WORTHINESS, the ONE score of how much a moment would make the TV
 * edit. Shared: the audience outside (ORW-624) reads it for the public's view, and A's "your edit" (ORW-632) reads it for the post-season cut, so the two agree.
 * PURE: no I/O, no rng. Engine-only: never a number to the player.
 *
 * A moment is a closed engine kind (never player text) with who did it and to whom. Its worth is the kind's base, raised by a twist (a blindside, a close vote) and by
 * an audience in the room (a public blow-up plays bigger than a quiet one).
 */
export type EditMomentKind =
  | "comp-win" | "veto-save" | "veto-kept" | "replacement" | "nomination" | "eviction" | "blindside"
  | "blowup" | "betrayal" | "house-meeting" | "showmance" | "scheme";

export interface EditMoment {
  kind: EditMomentKind;
  /** Who did it (the winner, the saver, the one who blew up). */
  actor?: EntityId;
  /** Who it happened to (the nominee, the evictee, the one shouted at). */
  subject?: EntityId;
  week: number;
  /** A close vote / a surprise: 0..1 extra twist. */
  twist?: number;
  /** How many saw it in the house (a blow-up in front of the house plays bigger). */
  crowd?: number;
  /** Whether the HOUSE (and so the player) could see it. Hidden moments count only in the post-season recap (the wall). */
  public: boolean;
}

/** The base edit-worthiness of each kind (an engine table over the closed kinds - not a pick). */
export const EDIT_BASE: Readonly<Record<EditMomentKind, number>> = {
  "comp-win": 0.5, "veto-save": 0.55, "veto-kept": 0.25, replacement: 0.5, nomination: 0.35, eviction: 0.45, blindside: 0.85,
  blowup: 0.7, betrayal: 0.75, "house-meeting": 0.6, showmance: 0.45, scheme: 0.5,
};
export const EDIT = {
  /** The twist's reach: worth x (1 + twistGain x twist). */
  twistGain: 0.6,
  /** Each witness past two adds this much (to `crowdCap`). */
  perWitness: 0.05,
  crowdCap: 0.3,
} as const;

/** How edit-worthy a moment is, 0..1. */
export function editWorthiness(m: EditMoment): number {
  const crowd = Math.min(EDIT.crowdCap, Math.max(0, (m.crowd ?? 0) - 2) * EDIT.perWitness);
  return Math.max(0, Math.min(1, EDIT_BASE[m.kind] * (1 + EDIT.twistGain * Math.max(0, Math.min(1, m.twist ?? 0))) + crowd));
}
