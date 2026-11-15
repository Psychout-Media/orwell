import type { Room } from "../../domain/house";

/**
 * ORW-466 (Ryne 2026-11-15: "a total of 16 beds in those three bedrooms... every house guest is choosing which bed they would like to sleep in for the season"): the bedroom LAYOUT as data, so his
 * open answers (single beds or doubles, the split, the room themes) drop in here without touching the bed rules in `beds.ts`.
 *
 * - `beds`: how many beds the room holds (16 across the three bedrooms; the HOH also has the HOH room, so every houseguest owns one of these and the HOH's waits for them).
 * - `theme`: the room's themed name ("the Underwater Room"), used everywhere instead of "bedroom A". UNSET until Ryne picks a theme option (design note "Assigned Beds And Themed Bedrooms Design",
 *   section 6); unset reads as today's label.
 */
export interface BedroomSpec {
  readonly room: Room;
  readonly beds: number;
  readonly theme?: string;
}

export const BEDROOM_LAYOUT: readonly BedroomSpec[] = [
  { room: "bedroom-a", beds: 6 },
  { room: "bedroom-b", beds: 5 },
  { room: "bedroom-c", beds: 5 },
];
