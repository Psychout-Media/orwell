import type { Room } from "../../domain/house";

/**
 * ORW-466 (Ryne 2026-11-15: "a total of 16 beds in those three bedrooms... every house guest is choosing which bed they would like to sleep in for the season"; "I think there could definitely be
 * doubles in the mix"): the bedroom LAYOUT as data, so his open answers (the mix of singles and doubles, the room themes) drop in here without touching the bed rules in `beds.ts`.
 *
 * - `singles`: one-person beds. `doubles`: beds two houseguests share (two sleeping spots each, as on the show). The three bedrooms hold 16 sleeping spots in all, one per houseguest; the HOH also has
 *   the HOH room, so the HOH's spot waits for them.
 * - `theme`: the room's themed name, used everywhere instead of "bedroom A". UNSET until Ryne picks a house theme (design note "Assigned Beds And Themed Bedrooms Design"); unset reads as today's label.
 *
 * Default mix (proposed, Auditor 2026-11-15): the six-spot room has 2 doubles + 2 singles, each five-spot room 1 double + 3 singles (4 doubles, 8 singles).
 */
export interface BedroomSpec {
  readonly room: Room;
  readonly singles: number;
  readonly doubles: number;
  readonly theme?: string;
}

export const BEDROOM_LAYOUT: readonly BedroomSpec[] = [
  { room: "bedroom-a", singles: 2, doubles: 2 },
  { room: "bedroom-b", singles: 3, doubles: 1 },
  { room: "bedroom-c", singles: 3, doubles: 1 },
];

/** Sleeping spots in a room (a double sleeps two). */
export const spotsIn = (r: BedroomSpec): number => r.singles + 2 * r.doubles;
