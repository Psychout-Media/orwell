import { hashSeed } from "./characterFactory";
import { composedAt } from "./data/composedFloor";
import { CURIOSITY_NEEDLES } from "./curiosityNeedle";

/**
 * ORW-509: the composed curiosity-needle floor. `curiosityNeedle(seed)` (curiosityNeedle.ts) is the fixed five-line public pool and stays pinned; this is the wider
 * floor a season is dealt offline: the same five lines first, then lead + close compositions, every part truthful generic framing of how the season is built
 * (never a person, a pairing, a secret or an outcome, so it is as Vault-free as the pool). The writer, when reachable, voices the needle from the season's own cast.
 */
export function composedCuriosityNeedle(seed: number, avoid: readonly string[] = []): string {
  // ORW-509: the five authored lines stay as the first region; the rest is composed from a truthful lead and a truthful close, so the line a season gets
  // is rarely the one the last season got. `avoid` is the previous seasons' needles (explicit input, default empty); the draw moves on past them (bounded).
  const size = NEEDLE_SPACE;
  const start = hashSeed(`${seed}:curiosity-needle`) % size;
  const skip = new Set(avoid);
  for (let k = 0; k < 64; k++) {
    const line = curiosityNeedleAt(start + k);
    if (!skip.has(line)) return line;
  }
  return curiosityNeedleAt(start);
}

const NEEDLE_LEADS: readonly string[] = [
  "this cast wasn't thrown together", "nobody walks through that door as simple as they look", "the game starts the second the doors open", "not one of them is only what they're showing you",
  "they were cast to collide", "every face in that house has a second one", "the people in there already have a history with the game, whether they say so or not",
  "somebody in that house is already a step ahead", "the quiet ones are not as quiet as they seem", "the house is not the blank slate it looks like",
  "they all arrive with a plan, and not all of them will survive it",
];
const NEEDLE_CLOSES: readonly string[] = [
  "the friction is the point", "and there is more under the surface than the cameras have caught", "and the first reads are forming already", "and the whole house is a little more watchful than it lets on",
  "and a room built for alliances and grudges is quietly in motion", "and nobody in there is telling you the whole of it", "so watch the small things first",
  "and the real game is already underway out of sight", "and every hello is also a measurement", "and what they hide is half of what you will play against",
];
const NEEDLE_JOINS: readonly string[] = ["; ", " - ", ": "];
const NEEDLE_SPACE = CURIOSITY_NEEDLES.length + NEEDLE_LEADS.length * NEEDLE_CLOSES.length * NEEDLE_JOINS.length;

/** The `index`th needle: the authored lines first, then lead + join + close. Every part is generic framing of how the season is built (Vault-free). */
export function curiosityNeedleAt(index: number): string {
  const i = ((Math.floor(index) % NEEDLE_SPACE) + NEEDLE_SPACE) % NEEDLE_SPACE;
  if (i < CURIOSITY_NEEDLES.length) return CURIOSITY_NEEDLES[i]!;
  const [lead, close, join] = composedAt([NEEDLE_LEADS, NEEDLE_CLOSES, NEEDLE_JOINS], i - CURIOSITY_NEEDLES.length) as [string, string, string];
  return `${lead}${close.startsWith("and ") || close.startsWith("so ") ? (join === " - " ? " - " : ", ") : join}${close}`;
}
export const CURIOSITY_NEEDLE_SPACE = NEEDLE_SPACE;

