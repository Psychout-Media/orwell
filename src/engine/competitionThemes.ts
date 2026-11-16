import type { CompetitionDef, CompetitionFormat, CompetitionPhase } from "./competitionLibrary";
import { hashSeed } from "./characterFactory";

/**
 * Feature 0125 — the competition THEME layer: a large, seeded pool of Vault-free "skins" laid over the
 * 0042 mechanic library so a whole season can run without a repeated competition, even when the same
 * MECHANIC recurs (an endurance comp reskinned as "Zero-Gravity Endurance" one week and "Haunted
 * Endurance" the next). A theme is pure NARRATION flavor — a name transform + a scene-setter woven into
 * the premise. It NEVER touches resolution: the mechanic (and thus which stat governs and who wins) is
 * unchanged, and the theme is chosen on a DEDICATED, deterministic hash — never the beat rng — so the
 * seeded game spine (juryReach / golden / UAT) is byte-identical whether themes are on or off.
 *
 * mechanic (0042, ~6 per phase) × theme (this pool, 24) ⇒ 100s of visibly distinct competitions, drawn
 * from a seeded per-phase PERMUTATION so no theme repeats within a phase until the pool is exhausted
 * (24 weeks >> an 11-week season). Tunable content, like the library / the temperature constants: add or
 * reword themes freely — the tests pin the STRUCTURE (no-repeat, determinism, Vault-free, floor unchanged),
 * not the flavor. The theme is the deterministic FLOOR the narrator dresses; #1400's model-authored
 * competition fiction still overrides it when generation is on.
 */
export interface CompetitionTheme {
  id: string;
  /** Display label — the theme's setting ("Outer Space", "Haunted House"). */
  label: string;
  /** Adjectival title fragment that composes into the comp name ("Zero-Gravity", "Haunted"). */
  prefix: string;
  /** A scene-setter sentence woven ahead of the mechanic's own premise. Vault-free flavor only. */
  setting: string;
}

/** How each mechanic FORMAT reads as a noun in a themed comp title. */
export const FORMAT_NOUN: Record<CompetitionFormat, string> = {
  endurance: "Endurance",
  puzzle: "Puzzle",
  quiz: "Trivia",
  skill: "Challenge",
  crapshoot: "Scramble",
  social: "Mind Games",
};

/** ORW-509: [id, label, prefix, place phrase] - a place the competition set can become. 60 worlds beside the 24 authored themes. Generic genre places only (no brands, franchises or past shows). */
const COMPOSED_WORLDS: ReadonlyArray<readonly [id: string, label: string, prefix: string, place: string]> = [
  ["lighthouse", "Lighthouse Storm", "Stormbound", "a storm-battered lighthouse station"],
  ["orchard", "Harvest Orchard", "Harvest", "an autumn orchard in full harvest"],
  ["bazaar", "Night Bazaar", "Lantern-Lit", "a lantern-lit night bazaar"],
  ["ski-lodge", "Ski Lodge", "Alpine", "a snowed-in alpine ski lodge"],
  ["observatory", "Star Observatory", "Celestial", "a hilltop observatory under a painted sky"],
  ["library", "Grand Library", "Bookbound", "a grand library of towering shelves and rolling ladders"],
  ["pirate-cove", "Pirate Cove", "Buccaneer", "a smugglers' cove with a half-sunk galleon"],
  ["rail-yard", "Rail Yard", "Locomotive", "a steam-era rail yard of boxcars and signal lamps"],
  ["greenhouse", "Glass Greenhouse", "Overgrown", "a steamy glass greenhouse run wild"],
  ["quarry", "Stone Quarry", "Bedrock", "a chalk-white quarry of cut stone and cranes"],
  ["arcade", "Retro Arcade", "High-Score", "a wall-to-wall arcade of glowing cabinets"],
  ["bakery", "Grand Bakery", "Sourdough", "an enormous bakery of copper ovens and flour clouds"],
  ["monastery", "Mountain Monastery", "Hushed", "a cliffside monastery of bells and stone stairs"],
  ["film-lot", "Studio Back Lot", "Clapperboard", "a Hollywood-style back lot of half-built sets"],
  ["salvage", "Salvage Yard", "Scrapyard", "a towering salvage yard of crushed cars and cranes"],
  ["airship", "Airship Deck", "Skybound", "the open deck of a creaking airship"],
  ["bamboo", "Bamboo Grove", "Whispering", "a swaying bamboo grove with rope bridges"],
  ["ice-rink", "Ice Rink", "Slick", "a floodlit ice rink ringed by bleachers"],
  ["desert", "Desert Outpost", "Sun-Scorched", "a dusty desert outpost under a hammering sun"],
  ["swamp", "Bayou Swamp", "Bayou", "a mossy bayou swamp of stilt shacks and lanterns"],
  ["gameshow", "Game Show Set", "Buzzer-Beater", "a garish game-show stage of flashing lights"],
  ["fireworks", "Fireworks Factory", "Sparkler", "a fireworks factory of painted crates and fuse lines"],
  ["lab", "Mad Laboratory", "Voltaic", "a crackling mad-scientist laboratory"],
  ["castle-siege", "Castle Siege", "Siege-Ready", "a besieged castle wall with catapults"],
  ["underground", "Underground Metro", "Subway", "an echoing underground metro platform"],
  ["farm", "County Fair Farm", "Barnyard", "a county-fair farm of hay bales and tractors"],
  ["glacier", "Glacier Cave", "Crystalline", "a blue glacier cave of dripping ice"],
  ["opera", "Opera House", "Operatic", "a gilded opera house with a trapdoor stage"],
  ["samurai", "Samurai Dojo", "Ronin", "a paper-walled dojo with a raked-gravel court"],
  ["backstage", "Rock Tour Backstage", "Headliner", "a backstage maze of road cases and amp stacks"],
  ["harbor", "Fishing Harbor", "Dockside", "a foggy fishing harbor of nets and creaking piers"],
  ["maze-garden", "Hedge Maze", "Labyrinthine", "a high-hedged garden maze"],
  ["time-museum", "Museum After Dark", "Exhibit", "a museum after dark where every exhibit looms"],
  ["roller-disco", "Roller Rink", "Wheelie", "a neon roller rink with a spinning ball"],
  ["savanna", "Safari Savanna", "Safari", "a golden savanna with a watchtower and acacia"],
  ["tea-house", "Tea Garden", "Blossom", "a lantern-hung tea garden with stepping stones"],
  ["mine", "Gold Mine", "Prospector", "an abandoned gold mine of rails and lanterns"],
  ["drive-in", "Drive-In Theater", "Matinee", "a retro drive-in theater of tail fins and a giant screen"],
  ["hot-air", "Balloon Festival", "Billowing", "a balloon festival field of striped canopies"],
  ["wizard", "Wizard's Tower", "Arcane", "a crooked wizard's tower of floating candles"],
  ["junkyard-robots", "Robot Factory", "Assembly-Line", "a robot factory of conveyor belts and sparks"],
  ["boot-camp", "Boot Camp", "Drill-Sergeant", "a muddy boot-camp course of nets and ropes"],
  ["ghost-town", "Ghost Town", "Abandoned", "an abandoned ghost town of swinging signs"],
  ["lake-camp", "Summer Camp", "Campfire", "a lakeside summer camp of canoes and cabins"],
  ["rooftop", "City Rooftop", "Skyline", "a windy city rooftop strung with lights"],
  ["vineyard", "Vineyard Estate", "Vintage", "a sprawling vineyard estate with a stone cellar"],
  ["ice-palace", "Ice Palace", "Frozen-Court", "a glittering ice palace of frosted columns"],
  ["bunker", "Cold War Bunker", "Classified", "a concrete bunker of blinking panels"],
  ["theme-park", "Thrill Park", "Rollercoaster", "a thrill park of looping track and queue lines"],
  ["wharf", "Neon Wharf", "Waterfront", "a rain-slick neon wharf at midnight"],
  ["castle-kitchen", "Royal Kitchen", "Gourmet", "a roaring royal kitchen of hanging pots"],
  ["trade-floor", "Trading Floor", "Bull-Market", "a frantic trading floor of ticker boards"],
  ["mountain-pass", "Mountain Pass", "Summit", "a windswept mountain pass of switchbacks"],
  ["pyramid", "Desert Pyramid", "Hieroglyph", "the torch-lit chambers of a desert pyramid"],
  ["toy-factory", "Toy Factory", "Wind-Up", "a clattering toy factory of wind-up giants"],
  ["lagoon", "Glowing Lagoon", "Bioluminescent", "a glowing lagoon of floating lanterns"],
  ["clocktower", "Clock Tower", "Chiming", "the gear-filled inside of a giant clock tower"],
  ["mirror-hall", "Hall of Mirrors", "Reflected", "a fun-house hall of warped mirrors"],
  ["flea-market", "Flea Market", "Bargain-Bin", "a sprawling flea market of oddities"],
  ["canyon", "Red Canyon", "Canyon", "a red-rock canyon strung with rope bridges"],
];

const SETTING_OPENERS: readonly string[] = [
  "The yard has been rebuilt as", "Overnight the set became", "The crew has turned the arena into", "Today the whole competition floor is",
  "The houseguests step out into", "Production has dressed the set as",
];
const SETTING_DRESSINGS: readonly string[] = [
  "with a crowd of extras hovering at the edges", "lit by hard floodlights and a rolling haze", "its floor slick and its props built to be knocked over",
  "with a scoreboard looming overhead", "wired for sound from every corner", "with banners snapping in a wind machine", "every surface painted a shade too bright",
  "a tangle of ropes and rigging hanging overhead", "with a ticking clock on a giant display", "the air thick with fog and stage smoke", "a drumline marking time offstage",
  "marked out with bold chalk lines", "smelling faintly of paint and popcorn", "with lights chasing around its edges", "everything scaled a little too large",
  "dressed in a hundred small, silly details", "with a horn blasting at each stage", "ringed by cameras on cranes", "its colors washed in a slow-turning spotlight",
  "with a cheering section of crew in costume", "and a flag planted at the far end", "every prop numbered and bolted down", "the walls hung with hand-painted signs",
  "with a pit of foam waiting below", "its path marked by flickering torches", "with a podium for the winner at the center", "strung with banners from the last show",
  "the floor sprayed with a fresh coat of glitter", "its entrance framed in a crooked archway", "with a muffled announcer somewhere above",
  "every prop a little crooked on purpose", "with a rain machine on a timer", "the soundtrack a looping drumbeat", "buzzers mounted at every station",
  "bathed in a color-changing glow", "with a wind machine pushing everyone sideways", "the starting line a painted stripe in the dirt",
  "a camera dolly sliding along its length", "built entirely out of oversized parts", "the finish marked by one enormous bell",
];

/** The scene-setter of a composed world: opener + place + dressing, picked from a hash (a pure function of the key; no rng draw). */
export function composeSetting(place: string, key: number): string {
  const o = SETTING_OPENERS[key % SETTING_OPENERS.length]!;
  const d = SETTING_DRESSINGS[Math.floor(key / SETTING_OPENERS.length) % SETTING_DRESSINGS.length]!;
  return `${o} ${place}, ${d}.`;
}

export const COMPETITION_THEMES: CompetitionTheme[] = [
  { id: "space", label: "Outer Space", prefix: "Zero-Gravity", setting: "The yard has been rebuilt as a derelict space station strung with wires and warning lights." },
  { id: "haunt", label: "Haunted House", prefix: "Haunted", setting: "Fog rolls across a graveyard set and something keeps groaning in the dark." },
  { id: "winter", label: "Winter Wonderland", prefix: "Frostbitten", setting: "The whole yard is a frozen tundra of fake snow, icicles, and a biting wind machine." },
  { id: "casino", label: "Casino Royale", prefix: "High-Roller", setting: "Neon slot machines and felt tables turn the living room into a midnight casino floor." },
  { id: "candy", label: "Candy Land", prefix: "Sugar-Rush", setting: "Giant lollipops and gumdrop mountains make the set look edible enough to bite." },
  { id: "west", label: "Wild West", prefix: "Frontier", setting: "A dusty saloon-town has been raised in the backyard, tumbleweeds and all." },
  { id: "sea", label: "Under the Sea", prefix: "Deep-Sea", setting: "Bubble curtains and drifting jellyfish sink the yard beneath an imaginary ocean." },
  { id: "prehist", label: "Prehistoric", prefix: "Primeval", setting: "Animatronic dinosaurs loom over a tar-pit obstacle course of ferns and bones." },
  { id: "hero", label: "Superhero City", prefix: "Caped", setting: "A comic-book skyline of cardboard skyscrapers frames the yard in bold primary colors." },
  { id: "fairy", label: "Fairytale Kingdom", prefix: "Enchanted", setting: "A storybook castle, a beanstalk, and a fake dragon set the scene for a fairytale." },
  { id: "cyber", label: "Neon Cyberpunk", prefix: "Neon", setting: "Rain-slick chrome and holographic ad-boards flood the set in electric magenta and cyan." },
  { id: "tropic", label: "Tropical Getaway", prefix: "Castaway", setting: "Palm fronds, tiki torches, and a fake lagoon turn the yard into a desert island." },
  { id: "circus", label: "Big Top Circus", prefix: "Center-Ring", setting: "A striped big-top tent, trapeze rigs, and a ringmaster's podium take over the yard." },
  { id: "noir", label: "Film Noir", prefix: "Midnight", setting: "Everything is black-and-white shadow, venetian-blind light, and a lonely saxophone." },
  { id: "jungle", label: "Lost Jungle", prefix: "Overgrown", setting: "Vines, temple ruins, and hidden idols bury the set in a lost-world jungle." },
  { id: "arctic", label: "Polar Expedition", prefix: "Glacial", setting: "A cracked ice-shelf and a stranded expedition tent chill the entire competition." },
  { id: "royal", label: "Royal Ball", prefix: "Regal", setting: "Chandeliers, red carpet, and a throne dress the set for a palace ball." },
  { id: "toon", label: "Cartoon World", prefix: "Looney", setting: "The whole set is painted in exaggerated cartoon lines, springs, and anvils." },
  { id: "spy", label: "Secret Agent", prefix: "Covert", setting: "Laser grids, a vault door, and a briefcase turn the yard into a spy's obstacle run." },
  { id: "volcano", label: "Volcano Island", prefix: "Molten", setting: "A smoking papier-mache volcano drips fake lava across a black-rock arena." },
  { id: "carnival", label: "Boardwalk Carnival", prefix: "Midway", setting: "Ring-toss booths, a fun-house mirror maze, and a Ferris wheel light up the yard." },
  { id: "steam", label: "Steampunk Workshop", prefix: "Clockwork", setting: "Brass gears, copper pipes, and hissing steam valves crowd an inventor's workshop set." },
  { id: "disco", label: "Disco Fever", prefix: "Groovy", setting: "A mirror ball, a light-up dance floor, and a wall of speakers throw the set back to the disco era." },
  { id: "myth", label: "Mount Olympus", prefix: "Titan", setting: "Marble columns, laurel wreaths, and thunderbolt props raise the set to the home of the gods." },
  // ORW-509: the composed worlds. Each is a place the set can become; its scene-setter is built from the place + an opener + a set-dressing clause (see
  // `composeSetting`), so the same world reads differently every time it is drawn. Authored as parts, not as 60 more fixed sentences.
  ...COMPOSED_WORLDS.map(([id, label, prefix, place]): CompetitionTheme => ({ id, label, prefix, setting: composeSetting(place, hashSeed(`world-default:${id}`)) })),
];

/**
 * A seeded permutation of `0..n-1` from a string key — a small LCG Fisher-Yates. Deterministic and
 * independent of the beat rng, so choosing a theme perturbs no seeded roll.
 */
function seededOrder(key: string, n: number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  let x = (hashSeed(key) >>> 0) || 1;
  for (let i = n - 1; i > 0; i--) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0; // LCG step
    const j = x % (i + 1);
    const t = idx[i]!; idx[i] = idx[j]!; idx[j] = t;
  }
  return idx;
}

/**
 * The week's theme for a phase. Both phases ride ONE seeded permutation, indexed by week; each same-week
 * "beat" reads it rotated by its own seed-derived NONZERO offset `k ∈ [1, N-1]` (N = pool size):
 *  - VETO rotates by a veto offset — so the same-week HOH and veto themes ALWAYS differ (two independent
 *    permutations could collide at a shared index — the bug this replaces);
 *  - a compressed twist CYCLE (the double-eviction second cycle, which reruns a same-phase comp in the
 *    SAME week) rotates by a further cycle offset — so the second crown of a double-eviction night never
 *    reuses the first cycle's skin.
 * A nonzero rotation of a permutation is still a permutation, so no phase repeats a theme for the first N
 * weeks (24 >> a season), and a nonzero rotation can never map an index to itself, so every distinct beat
 * at the same week lands on a distinct theme. It is a pure function of (seed, phase, week, cycle) — no rng
 * draw, no persistence, restart-stable — so choosing a theme perturbs no seeded roll.
 */
export function themeForWeek(
  seed: number, phase: CompetitionPhase, week: number, cycle = 0, avoid: readonly string[] = [],
): CompetitionTheme {
  // ORW-509 season memory: `avoid` is the previous season's theme ids (an explicit input, default empty). They leave the permutation while a season's worth
  // of fresh worlds remains (MIN_FRESH_WORLDS), so consecutive seasons do not wear the same skins. Empty => the whole pool, as before.
  const skip = new Set(avoid);
  const fresh = skip.size === 0 ? COMPETITION_THEMES : COMPETITION_THEMES.filter((t) => !skip.has(t.id));
  const pool = fresh.length >= MIN_FRESH_WORLDS ? fresh : COMPETITION_THEMES;
  const n = pool.length;
  const order = seededOrder(`${seed}:comp-theme:hoh`, n); // one shared permutation for both phases
  const idx = (Math.max(1, week) - 1) % n;
  // Rotate the SAME permutation by nonzero, seed-derived offsets — each keeps the phase repeat-free while
  // guaranteeing a same-week beat lands on a distinct theme (idx + k mod n can never equal idx for k≠0).
  // ORW-509: with a pool this size the veto offset keeps >= 14 weeks of clearance either side, so a ~14-week season's HOH and veto skins are also disjoint from each
  // other (one shared permutation, so the same world would otherwise land on both phases in different weeks about half the time).
  const vetoK = phase === "veto" ? (n >= 28 + 2 ? 14 + ((hashSeed(`${seed}:comp-theme:veto-offset`) >>> 0) % (n - 27)) : 1 + ((hashSeed(`${seed}:comp-theme:veto-offset`) >>> 0) % (n - 1))) : 0;
  const cycleK = cycle > 0 ? 1 + ((hashSeed(`${seed}:comp-theme:cycle-offset`) >>> 0) % (n - 1)) : 0;
  const base = pool[order[(idx + vetoK + cycleK) % n]!]!;
  return dressTheme(base, `${seed}:comp-theme-dress:${phase}:${week}:${cycle}`);
}

/** A full season's worth of distinct worlds (both phases x ~14 weeks) must remain before `avoid` is honoured. */
export const MIN_FRESH_WORLDS = 30;

/** Intensifiers that read naturally before any theme prefix; half the draws take none, so the plain "Haunted Trivia" still occurs. */
const INTENSIFIERS: readonly string[] = ["", "", "", "Grand", "Midnight", "Sudden-Death", "Last-Chance", "Full-Tilt", "All-Out", "Mega", "Ultimate", "Double-Down", "Wild", "Epic", "Extreme", "Total"];

/**
 * ORW-509: the world is the pool entry; the SKIN is the world plus a per-(season, phase, week) dressing. A composed world re-rolls its scene-setter, and
 * any world may take an intensifier on its title. Pure function of the key (a dedicated hash, no rng draw), so the same season draws the same skin.
 */
function dressTheme(base: CompetitionTheme, key: string): CompetitionTheme {
  const k = hashSeed(key) >>> 0;
  const world = COMPOSED_WORLDS.find((w) => w[0] === base.id);
  const intensifier = INTENSIFIERS[k % INTENSIFIERS.length]!;
  const setting = world ? composeSetting(world[3], Math.floor(k / INTENSIFIERS.length)) : base.setting;
  const prefix = intensifier ? `${intensifier} ${base.prefix}` : base.prefix;
  return setting === base.setting && prefix === base.prefix ? base : { ...base, prefix, setting };
}

/** The themed comp NAME: the theme's adjectival prefix + the mechanic format's noun ("Haunted Trivia"). */
export function themedName(def: CompetitionDef, theme: CompetitionTheme): string {
  return `${theme.prefix} ${FORMAT_NOUN[def.format]}`;
}

/**
 * Apply a theme to a mechanic def, returning the Vault-free surfaced scaffold. The mechanic's own
 * premise (the ACTION) and beats are kept — the theme only prepends a scene-setter and renames — so the
 * result stays coherent (the theme is a skin, never a new mechanic). No stat, score, or hidden field.
 */
export function applyTheme(
  def: CompetitionDef, theme: CompetitionTheme, beatKey?: string,
): { name: string; theme: string; narrative: { premise: string; beats: string[]; winReads: string } } {
  return {
    name: themedName(def, theme),
    theme: theme.label,
    narrative: {
      premise: `${theme.setting} ${def.narrative.premise}`,
      // ORW-509: with a `beatKey` (the season seed + phase + week + cycle) each authored beat takes one clause from a wide set, so the same mechanic's
      // three beats read differently every time it is drawn (30 mechanics x 3 fixed beats was the whole beat space). No key => the authored beats, as before.
      beats: beatKey === undefined ? [...def.narrative.beats] : def.narrative.beats.map((b, i) => `${b}, ${BEAT_FLOURISHES[hashSeed(`${beatKey}:beat:${i}:${def.id}`) % BEAT_FLOURISHES.length]}`),
      winReads: def.narrative.winReads,
    },
  };
}

/** Clauses that sit on the end of any beat ("... the first grips fail, as the crowd noise swells"). Public, Vault-free staging only. */
export const BEAT_FLOURISHES: readonly string[] = [
  "as the crowd noise swells", "while a camera swings in close", "and the host's voice cracks over the speakers", "with the clock eating into every move",
  "as someone off-screen groans", "and a hush drops over the set", "while the lights flicker overhead", "as the floor crew scrambles to reset",
  "with half the house on their feet", "and a horn blares the warning", "as a rival glances over", "while the scoreboard ticks over",
  "and nobody dares look away", "as a gust catches the banners", "with sweat running into every eye", "while the music cuts out",
  "as a staffer mutters into a headset", "and the next moves come out slower", "while the others call out advice nobody takes", "as the timer passes the halfway mark",
  "with the confetti cannon already loaded", "and a surprised laugh runs round the set", "while someone swears they have it figured out", "as the spotlight finds the front-runner",
  "with a bell clanging somewhere", "and it all comes down to nerve", "as the dust settles and the order sorts itself", "while one houseguest quietly changes tactics",
  "and the cheering section loses its place", "with a long, tense pause on the buzzer", "as the pace turns ragged", "while the others pretend not to watch",
  "and a murmur runs down the line", "as the set groans under the strain", "with a flash of bad luck for someone", "while a staffer waves a flag",
  "and the leader's lead shrinks", "as every eye follows the clock", "while a gasp goes up from the sidelines", "and somebody mutters a prayer",
  "as the wind machine picks up", "with the smell of the set hanging in the air", "while the announcer calls it too close to call", "and the whole house leans in",
  "as the first mistake sets off another", "while the host stalls for effect", "and a cheer goes up for the wrong person", "as a prop gives way at the worst moment",
];
