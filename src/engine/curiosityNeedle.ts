import { hashSeed } from "./characterFactory";

/**
 * The Day-1 curiosity needle (feature 0111, Pillar 2 / #909).
 *
 * The engine already runs a whole dramatic-irony apparatus — off-screen scheming (0038), seeded
 * hidden relationships (0059), emergent blocs (0043) — but Day 1 never so much as WHISPERS that any
 * of it exists, so a brand-new player never senses "the house already has a life I'm walking into."
 * This module lets the producer plant ONE truthful "there's a hidden game already in motion" beat.
 *
 * THE VAULT WALL IS STRUCTURAL HERE (mandate #2, player AND admin). A needle is built from PUBLIC /
 * SEEDED framing ONLY — facts the engine can stand behind about how the season is CONSTRUCTED (the
 * cast was assembled for friction; a diversity floor guarantees a wide mix; every houseguest arrives
 * with hidden sides). It NEVER reads the Vault, and it never names a specific secret, relationship, or
 * scheme. The model "cannot leak what it never receives": these lines carry no Vault content to leak.
 * What crosses is the PROMISE of depth, never a fact.
 *
 * PURE and Vault-free by construction: the only input is a seed. There is no `VaultStore` import here,
 * and dependency-cruiser proves no outward module reaches the Vault.
 */

/**
 * The needle pool — every line is a TRUTHFUL, generic framing of how the season is built, grounded
 * only in things the engine guarantees for EVERY cast (never a specific hidden fact):
 *
 *  - the cast is deliberately assembled for friction/contrast (the archetype + diversity spread);
 *  - every houseguest arrives with hidden sides the cameras will find (hidden elements exist on all);
 *  - the social game is already in motion the minute the doors open (off-screen life is real).
 *
 * None references a person, a pairing, a secret, a target, or an outcome — so each is safe on any
 * player OR admin surface. Keep them this way: a needle that names a specific is a Vault leak.
 */
export const CURIOSITY_NEEDLES: readonly string[] = [
  "this cast wasn't thrown together — every one of them was picked to rub against the others; the friction is the point",
  "nobody walks through that door as simple as they look; everyone in there is carrying something the cameras haven't found yet",
  "the game starts the second the doors open — reads are already forming, sides are already being sized up, long before the first competition",
  "not one of them is only what they're showing you; the house is full of people playing a game you can't see the whole of yet",
  "they were cast to collide — a room built for alliances and grudges, and it's already quietly in motion",
];

/**
 * Pick exactly ONE curiosity needle for a season, deterministically off the game seed (a dedicated
 * `:curiosity-needle` sub-key, never the shared season/competition stream — so this can never perturb
 * a seeded outcome). Always returns a single, Vault-free line.
 */
export function curiosityNeedle(seed: number): string {
  const i = hashSeed(`${seed}:curiosity-needle`) % CURIOSITY_NEEDLES.length;
  return CURIOSITY_NEEDLES[i]!;
}

/**
 * The producer's instruction to plant the needle during casting (Pillar 2). This is FRAMING handed to
 * the model to VOICE — a fact to say once, never a script to recite. It names the ONE-needle rule and
 * the hard Vault-Wall bound (generic promise-of-depth only, never a specific secret).
 */
export const CURIOSITY_NEEDLE_INSTRUCTION = [
  "THE ONE CURIOSITY NEEDLE — before casting ends, plant EXACTLY ONE truthful beat that a hidden game is",
  "already in motion in that house: this cast was assembled for friction, and nobody in there is only",
  "what they seem. Say it ONCE, in your producer voice, as a knowing tease — never a second time, never a",
  "list. It is the promise of depth, the thing that makes them want to watch. HARD RULE: keep it GENERIC —",
  "you may hint that secrets and sides EXIST, but you must never name a specific secret, a specific pairing",
  "or alliance, a specific target, or anything about any actual houseguest's hidden side (you do not know",
  "them, and the game will never tell you). Tease that the depth is there; reveal none of it.",
].join("\n");
