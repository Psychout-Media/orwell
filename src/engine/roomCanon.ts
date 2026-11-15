/**
 * ROOM CANON (Showrunner memory part B, canon ledger v1, house map only; ORW-223 slice 1). Pure helpers for the
 * `recordRoomCanon` write-back: validate the request shape, build the single canon proposal, and render the
 * Show Brief's Canon section for the room the player is in.
 *
 * The write-back accepts ONLY `{ roomId, feature }`. The feature is advice from the front-end, re-validated by the
 * canon ledger's own fence (`recordCanon`): no events, outcomes, secrets, new places, plot devices, relationships,
 * knowledge or numbers can pass. This adapter tier holds no Vault, so there is nothing hidden here to leak or to
 * touch. No randomness, no I/O.
 */
import { HOUSE_ROOMS, type Room } from "../domain/house";
import { roomMapEntry, roomPhrase, type PropCategory } from "../domain/houseFixtures";
import type { CanonEntry, CanonProposal } from "../domain/canon";
import { normalizeCanonText } from "./canonLedger";

/** A feature is one short line: at most this many characters. */
export const ROOM_CANON_FEATURE_MAX = 120;
/** The brief lists at most this many canon features for the current room. */
export const ROOM_CANON_BRIEF_MAX = 6;

export type RoomCanonRejection = "bad-shape" | "bad-room" | "empty" | "too-long";

export const isKnownRoom = (r: unknown): r is Room => typeof r === "string" && (HOUSE_ROOMS as readonly string[]).includes(r);

/** Keyword hints for which loose-prop category a feature is about; the room's first allowed one stands when none match. */
const HINTS: ReadonlyArray<readonly [PropCategory, RegExp]> = [
  ["drinkware", /\b(mug|cup|glass|bottle|kettle|teapot|tumbler|pitcher)\w*\b/i],
  ["food-snack", /\b(snack|cereal|fruit|bowl of|jar|cookie|candy|bread)\w*\b/i],
  ["towel-linen", /\b(towel|blanket|pillow|sheet|quilt|throw|rug)\w*\b/i],
  ["book-magazine", /\b(book|magazine|journal|paperback)\w*\b/i],
  ["game-toy", /\b(cards?|board game|puzzle|dice|chess|dominoes)\b/i],
  ["plant-flower", /\b(plant|flower|fern|vase|succulent|cactus)\w*\b/i],
  ["fitness-gear", /\b(dumbbell|weights?|mat|yoga|kettlebell)\b/i],
  ["clothing", /\b(hoodie|jacket|sweater|shirt|hat|cap|scarf)\w*\b/i],
  ["footwear", /\b(shoes?|slippers?|flip-flops?|sandals?|boots?)\b/i],
  ["toiletry", /\b(soap|shampoo|toothbrush|lotion|candle)\w*\b/i],
  ["craft-hobby", /\b(knitting|sketch\w*|paint\w*|craft\w*)\b/i],
];

/** The prop category backing a feature in a room: a keyword match the room allows, else the room's first allowed one. */
export function propCategoryFor(room: Room, feature: string): PropCategory | undefined {
  const allowed = roomMapEntry(room)?.allowedProps ?? [];
  for (const [cat, re] of HINTS) if (allowed.includes(cat) && re.test(feature)) return cat;
  return allowed[0];
}

/** Check the request shape and build the proposal. A string result is the rejection code. */
export function roomCanonProposal(req: unknown): { room: Room; feature: string; proposal: CanonProposal } | RoomCanonRejection {
  if (!req || typeof req !== "object" || Array.isArray(req)) return "bad-shape";
  const keys = Object.keys(req as object).sort();
  if (keys.length !== 2 || keys[0] !== "feature" || keys[1] !== "roomId") return "bad-shape";
  const { roomId, feature } = req as { roomId: unknown; feature: unknown };
  if (typeof roomId !== "string" || typeof feature !== "string") return "bad-shape";
  if (!isKnownRoom(roomId)) return "bad-room";
  const text = normalizeCanonText(feature);
  if (!text) return "empty";
  if (text.length > ROOM_CANON_FEATURE_MAX) return "too-long";
  const propCategory = propCategoryFor(roomId, text);
  return {
    room: roomId,
    feature: text,
    proposal: {
      text, category: "house-detail", scope: { kind: "room", room: roomId }, persistence: "permanent",
      speaker: "narrator", witnesses: ["player"], room: roomId, quote: text,
      ...(propCategory !== undefined ? { propCategory } : {}),
    },
  };
}

/** The Show Brief's Canon section for the player's room, or undefined when nothing is recorded there. */
export function roomCanonSection(room: Room, entries: readonly CanonEntry[]): string | undefined {
  const mine = entries
    .filter((e) => e.status === "active" && e.category === "house-detail" && e.scope.kind === "room" && e.scope.room === room)
    .sort((a, b) => Number(a.id.slice(6)) - Number(b.id.slice(6)))
    .slice(0, ROOM_CANON_BRIEF_MAX);
  if (!mine.length) return undefined;
  return [
    "4. CANON",
    `Already established about ${roomPhrase(room)} (keep it consistent; do not contradict it):`,
    ...mine.map((e) => `- ${e.text}`),
  ].join("\n");
}
