/**
 * The HOUSE MAP (Showrunner memory, Part B / Decision 1): what is BUILT INTO each room, and which kinds of
 * loose personal props may lie around in it. Pure data + pure functions in the dependency-free core.
 *
 * Why it exists: the engine knew every room and who stood in it, but nothing about what a room contains, so
 * nothing stopped a narrator from inventing a new place or a plot object in the yard (2026-11-06). The map
 * gives the narrator a closed list to describe freely, and gives the later checks (the canon gate, the
 * after-turn classifier, the canon ledger's house-detail rule) a ground truth to hold prose to.
 *
 * STATUS: v0 — pending Ryne sign-off (C1). The fixture and prop-category table below is the K9 §1.2 draft,
 * transcribed as written. Ryne's team owns the final content (Plane ORW-223, question C1): the list, the
 * "have-not room" question, and the per-season dressing (C2). Nothing here is wired into the narrator
 * prompt yet; the only reader is the Show Brief behind `ORWELL_SHOW_BRIEF` (default off).
 *
 * Rules the data follows (K9 §1.2, K4 §1.2):
 *   - a FIXTURE is permanent: it never moves, appears or disappears. Labels are what the narrator may say;
 *     aliases are synonyms for the later sentence gate and are never printed.
 *   - a PROP CATEGORY is a class of loose, personal, minor things (a towel, a book). A prop is never a plot device.
 *   - no hidden places, no devices, no found objects (`validateHouseMap` enforces it with a forbidden-term list).
 *   - the house has no TV and no internet (the base prompt's NO LIVE MEDIA rule); the HOH music player is the
 *     one sanctioned exception, and it already exists in the prompt.
 *   - "set by season" items (bed layout, the bedroom decor piece) are generic in this floor; the seeded
 *     dressing that specialises them is a later step (C2).
 *
 * Vault-free by construction: a room's furniture is public, observable fact. No randomness, no I/O.
 */
import { HOUSE_ROOMS, roomDisplayName, zonesFor, type Room, type Zone } from "./house";

/** The map's content version and its review status (printed nowhere; carried for logs and the admin view). */
export const HOUSE_MAP_VERSION = "v0";
export const HOUSE_MAP_STATUS = "v0 — pending Ryne sign-off (C1)";

export type FixtureKind = "furniture" | "appliance" | "structure" | "outdoor" | "decor" | "plumbing";

/** A permanent thing built into or standing in a room. Never moves, never appears or disappears. */
export interface RoomFixture {
  /** `<room>.<slug>`, unique across the house (e.g. `backyard.hot-tub`). */
  readonly id: string;
  /** What the narrator may call it ("hot tub"). */
  readonly label: string;
  /** Synonyms the later sentence gate also accepts ("jacuzzi"). Never printed to the narrator. */
  readonly aliases: readonly string[];
  readonly kind: FixtureKind;
  /** The earshot zone it sits in, for the zoned rooms only (ties to `ROOM_ZONES` in house.ts). */
  readonly zone?: Zone;
}

/** Categories of loose, personal, minor props that may lie around a room. A prop is NEVER a plot device. */
export const PROP_CATEGORIES = [
  "drinkware", "food-snack", "towel-linen", "clothing", "footwear", "jewelry-accessory", "book-magazine",
  "game-toy", "fitness-gear", "toiletry", "plant-flower", "tech-personal", "craft-hobby",
] as const;
export type PropCategory = typeof PROP_CATEGORIES[number];

/** How a prop category reads in the brief's "loose things" line (v0 wording, pending C1). */
export const PROP_CATEGORY_LABELS: Readonly<Record<PropCategory, string>> = {
  "drinkware": "drinks and mugs",
  "food-snack": "snacks",
  "towel-linen": "towels",
  "clothing": "clothes",
  "footwear": "shoes and flip-flops",
  "jewelry-accessory": "jewelry",
  "book-magazine": "books and magazines",
  "game-toy": "cards and games",
  "fitness-gear": "workout gear",
  "toiletry": "toiletries",
  "plant-flower": "plants and flowers",
  "tech-personal": "a watch or an earbuds case",
  "craft-hobby": "puzzles and craft supplies",
};

export interface RoomMapEntry {
  readonly room: Room;
  readonly fixtures: readonly RoomFixture[];
  readonly allowedProps: readonly PropCategory[];
}

export type HouseMap = ReadonlyMap<Room, RoomMapEntry>;

/** Words that are true of EVERY room and are never gated (K4 §1.2): structure the plan always has. */
export const UNIVERSAL_STRUCTURES: readonly string[] = ["door", "wall", "floor", "ceiling", "window", "light", "stairs"];

/** The most fixtures a room may list (K9 §1.2: "6-12 fixtures per room"; the diary room is deliberately bare). */
export const MAX_FIXTURES_PER_ROOM = 12;
/** A label or alias is a short noun phrase, never a sentence. */
export const MAX_FIXTURE_LABEL_CHARS = 60;

/**
 * Terms no fixture, alias or prop label may contain (K4 §3.2 classes A and B, K9 §1.2): hidden places and
 * plot devices are ENGINE-ONLY (Decision 1) and can never be part of the house. A v0 floor kept here so the
 * map can be validated now; the shared canon lexicon replaces it when the sentence gate lands (K4 §3.2).
 * Deliberately NOT here: "vent" (the living room's air-conditioner vents exist; K4 gates "vent" only in a
 * passage frame) and "photo" (the hallway's framed photo wall exists; K4 gates "photo" only when found/left).
 */
export const FORBIDDEN_FIXTURE_TERMS: readonly string[] = [
  "hatch", "trapdoor", "trap door", "tunnel", "crawl space", "crawlspace", "cellar", "basement", "attic",
  "bunker", "shed", "gazebo", "gate", "secret", "hidden", "false wall", "false bottom", "loose floorboard",
  "loose tile", "loose brick", "note", "letter", "envelope", "key", "keys", "map", "clue", "evidence", "usb",
  "flash drive", "phone", "recording", "package", "parcel", "crate", "briefcase", "lockbox", "safe", "code",
  "cipher", "password", "engraving", "inscription", "carving", "symbol", "buried", "shovel", "trowel",
  "plate", "spike strip",
];

const f = (room: Room, slug: string, label: string, kind: FixtureKind, extra: { aliases?: readonly string[]; zone?: Zone } = {}): RoomFixture => ({
  id: `${room}.${slug}`, label, aliases: extra.aliases ?? [], kind, ...(extra.zone !== undefined ? { zone: extra.zone } : {}),
});

const bedroom = (room: Room): RoomMapEntry => ({
  room,
  fixtures: [
    f(room, "beds", "beds", "furniture"), // bunks or singles, set by season (C2)
    f(room, "nightstands", "nightstands", "furniture"),
    f(room, "dresser", "dresser", "furniture"),
    f(room, "closet", "closet", "structure"),
    f(room, "hamper", "shared hamper", "furniture"),
    f(room, "lamp", "lamp", "decor"),
    f(room, "window", "window with blinds", "structure"),
    f(room, "mirror", "wall mirror", "decor"),
    f(room, "decor-piece", "themed decor piece", "decor"), // one per room, set by season (C2)
  ],
  allowedProps: ["clothing", "footwear", "jewelry-accessory", "book-magazine", "toiletry", "tech-personal", "plant-flower", "towel-linen"],
});

/** The one house (it does not remodel, like `house.ts`). K9 §1.2, v0 — pending Ryne sign-off (C1). */
export const BASE_HOUSE_MAP: HouseMap = new Map<Room, RoomMapEntry>([
  ["kitchen", {
    room: "kitchen",
    fixtures: [
      f("kitchen", "fridge", "fridge", "appliance"),
      f("kitchen", "pantry", "pantry cupboard", "structure"),
      f("kitchen", "island", "island with stools", "furniture"),
      f("kitchen", "stovetop", "stovetop and oven", "appliance"),
      f("kitchen", "microwave", "microwave", "appliance"),
      f("kitchen", "dishwasher", "dishwasher", "appliance"),
      f("kitchen", "sink", "double sink", "plumbing"),
      f("kitchen", "coffee-maker", "coffee maker", "appliance"),
      f("kitchen", "toaster", "toaster", "appliance"),
      f("kitchen", "cabinets", "cabinets", "structure"),
      f("kitchen", "dish-rack", "dish rack", "furniture"),
    ],
    allowedProps: ["drinkware", "food-snack", "towel-linen", "craft-hobby"],
  }],
  ["living-room", {
    room: "living-room",
    fixtures: [
      f("living-room", "sectional", "big sectional couch", "furniture"),
      f("living-room", "armchairs", "armchairs", "furniture"),
      f("living-room", "coffee-table", "coffee table", "furniture"),
      f("living-room", "rug", "area rug", "decor"),
      f("living-room", "glass-doors", "floor-to-ceiling glass doors to the yard", "structure"),
      f("living-room", "console-table", "console table", "furniture"),
      f("living-room", "bean-bags", "bean bags", "furniture"),
      f("living-room", "feature-wall", "feature wall", "decor"),
      f("living-room", "ac-vents", "air-conditioner vents", "appliance"),
      f("living-room", "hoh-stairs", "staircase up to the HOH room", "structure"),
    ],
    allowedProps: ["drinkware", "food-snack", "book-magazine", "game-toy", "clothing", "footwear", "tech-personal"],
  }],
  ["dining-room", {
    room: "dining-room",
    fixtures: [
      f("dining-room", "table", "long dining table", "furniture"),
      f("dining-room", "chairs", "chairs", "furniture"),
      f("dining-room", "sideboard", "sideboard", "furniture"),
      f("dining-room", "pendant-lights", "pendant lights", "decor"),
      f("dining-room", "mirror", "wall mirror", "decor"),
      f("dining-room", "fruit-bowl", "fruit bowl", "decor"),
    ],
    allowedProps: ["drinkware", "food-snack", "book-magazine", "game-toy"],
  }],
  ["backyard", {
    room: "backyard",
    // Aliases are K4 §1.3's synonyms for the later sentence gate (never printed).
    fixtures: [
      f("backyard", "pool", "pool", "outdoor", { aliases: ["swimming pool"], zone: "poolside" }),
      f("backyard", "hot-tub", "hot tub", "outdoor", { aliases: ["jacuzzi", "spa"], zone: "poolside" }),
      f("backyard", "pool-pump", "pool pump house", "plumbing", { aliases: ["pump", "equipment box"], zone: "poolside" }),
      f("backyard", "patio-set", "patio furniture and umbrella", "furniture", { aliases: ["patio furniture", "patio chairs", "patio table", "umbrella"], zone: "patio" }),
      f("backyard", "hammock", "hammock", "furniture", { zone: "patio" }),
      f("backyard", "grill", "grill", "appliance", { aliases: ["bbq"], zone: "patio" }),
      f("backyard", "workout", "workout bench and weights", "furniture", { aliases: ["weights", "weight bench"], zone: "workout" }),
      f("backyard", "planters", "planters", "decor", { aliases: ["garden beds"] }),
      f("backyard", "fence", "privacy fence", "structure", { aliases: ["fence", "fence line"] }),
      f("backyard", "sprinklers", "sprinkler heads", "plumbing", { aliases: ["sprinkler", "sprinklers", "irrigation"] }),
      f("backyard", "drain", "pool-deck drain", "plumbing", { aliases: ["drain", "drain grate"], zone: "poolside" }),
      f("backyard", "string-lights", "string lights", "decor", { zone: "patio" }),
    ],
    allowedProps: ["drinkware", "towel-linen", "footwear", "book-magazine", "game-toy", "fitness-gear", "plant-flower", "food-snack"],
  }],
  ["hallway", {
    room: "hallway",
    fixtures: [
      f("hallway", "photo-wall", "framed photo wall", "decor"),
      f("hallway", "doors", "doors to the bedrooms, bathroom and lounge", "structure"),
      f("hallway", "laundry", "laundry alcove with a washer and dryer", "appliance"),
      f("hallway", "linen-closet", "linen closet", "structure"),
      f("hallway", "thermostat", "thermostat", "appliance"),
      f("hallway", "runner", "runner rug", "decor"),
      f("hallway", "mirror", "wall mirror", "decor"),
    ],
    allowedProps: ["towel-linen", "clothing", "footwear", "toiletry"],
  }],
  ["bedroom-a", bedroom("bedroom-a")],
  ["bedroom-b", bedroom("bedroom-b")],
  ["bedroom-c", bedroom("bedroom-c")],
  ["bathroom", {
    room: "bathroom",
    fixtures: [
      f("bathroom", "vanity", "double vanity", "plumbing"),
      f("bathroom", "mirrors", "mirrors", "decor"),
      f("bathroom", "toilets", "toilet stalls", "plumbing"),
      f("bathroom", "showers", "shower stalls", "plumbing"),
      f("bathroom", "towel-hooks", "towel hooks", "furniture"),
      f("bathroom", "medicine-cabinet", "medicine cabinet", "furniture"),
      f("bathroom", "hamper", "hamper", "furniture"),
    ],
    allowedProps: ["toiletry", "towel-linen", "jewelry-accessory"],
  }],
  ["lounge", {
    room: "lounge",
    fixtures: [
      f("lounge", "couches", "couches", "furniture", { zone: "couches" }),
      f("lounge", "window-nook", "window nook", "structure", { zone: "window-nook" }),
      f("lounge", "bookshelf", "bookshelf", "furniture"),
      f("lounge", "game-shelf", "board-game shelf", "furniture"),
      f("lounge", "cushions", "floor cushions", "furniture"),
      f("lounge", "table", "small table", "furniture"),
      f("lounge", "rug", "rug", "decor"),
    ],
    allowedProps: ["book-magazine", "game-toy", "craft-hobby", "drinkware", "plant-flower"],
  }],
  ["hoh-room", {
    room: "hoh-room",
    fixtures: [
      f("hoh-room", "bed", "HOH bed", "furniture"),
      f("hoh-room", "desk", "desk", "furniture"),
      f("hoh-room", "armchair", "armchair", "furniture"),
      f("hoh-room", "bathroom", "private bathroom", "plumbing"),
      f("hoh-room", "closet", "closet", "structure"),
      f("hoh-room", "balcony", "balcony", "structure"),
      f("hoh-room", "mini-fridge", "mini fridge", "appliance"),
      f("hoh-room", "music", "music player and speakers", "appliance"), // the HOH perk: the one live-media exception
      f("hoh-room", "window", "window", "structure"),
    ],
    allowedProps: ["clothing", "jewelry-accessory", "book-magazine", "toiletry", "tech-personal", "drinkware", "plant-flower"],
  }],
  ["storage-room", {
    room: "storage-room",
    fixtures: [
      f("storage-room", "shelving", "metal shelving", "furniture"),
      f("storage-room", "food-bins", "bulk food bins", "furniture"),
      f("storage-room", "cleaning-shelf", "cleaning supplies shelf", "furniture"),
      f("storage-room", "mop-sink", "mop sink", "plumbing"),
      f("storage-room", "linens", "spare linens", "decor"),
      f("storage-room", "costume-closet", "costume closet", "structure"),
      f("storage-room", "cots", "folded cots", "furniture"),
    ],
    allowedProps: ["food-snack", "towel-linen", "craft-hobby"],
  }],
  ["diary-room", {
    room: "diary-room",
    // Private: nothing else, and nothing loose lies around in it.
    fixtures: [
      f("diary-room", "chair", "the chair", "furniture"),
      f("diary-room", "camera-wall", "the camera wall", "structure"),
      f("diary-room", "lighting", "soft lighting", "decor"),
      f("diary-room", "door", "padded door", "structure"),
    ],
    allowedProps: [],
  }],
]);

const FIXTURE_KINDS: readonly FixtureKind[] = ["furniture", "appliance", "structure", "outdoor", "decor", "plumbing"];
const FIXTURE_ID_RE = /^[a-z][a-z0-9-]*\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FORBIDDEN_RE = new RegExp(`\\b(?:${FORBIDDEN_FIXTURE_TERMS.map((t) => t.replace(/ /g, "\\s+")).join("|")})\\b`, "i");

/** The forbidden term a text contains, or undefined. Exported for the tests and the later Show Bible write-back. */
export function forbiddenFixtureTerm(text: string): string | undefined {
  const m = FORBIDDEN_RE.exec(text);
  return m ? m[0].toLowerCase() : undefined;
}

function textProblem(where: string, text: unknown): string | undefined {
  if (typeof text !== "string" || text.trim().length === 0) return `${where}: empty text`;
  if (text !== text.trim() || /[\r\n\t]/.test(text)) return `${where}: text must be one trimmed line`;
  if (text.length > MAX_FIXTURE_LABEL_CHARS) return `${where}: longer than ${MAX_FIXTURE_LABEL_CHARS} characters`;
  const bad = forbiddenFixtureTerm(text);
  return bad ? `${where}: contains the engine-only term "${bad}"` : undefined;
}

/**
 * Validate a house map. Returns every problem found as a plain sentence; `[]` means valid. Used by the tests
 * and, later, by the Show Bible write-back (an authored dressing passes this before it can stand, K4 §1.4).
 * Checks: every house room has exactly one entry under its own key; each room lists 1-12 fixtures; fixture ids
 * are `<room>.<slug>` and unique across the house; labels and aliases are short single lines, unique within the
 * room, and free of engine-only terms (hidden places, plot devices); kinds and zones are known; prop categories
 * are known and not repeated; the diary room carries no props.
 */
export function validateHouseMap(map: HouseMap): readonly string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  for (const room of HOUSE_ROOMS) if (!map.has(room)) problems.push(`${room}: missing from the map`);
  for (const [key, entry] of map) {
    if (!HOUSE_ROOMS.includes(key)) { problems.push(`${String(key)}: not a house room`); continue; }
    if (entry.room !== key) problems.push(`${key}: entry names room "${entry.room}"`);
    if (entry.fixtures.length === 0) problems.push(`${key}: lists no fixtures`);
    if (entry.fixtures.length > MAX_FIXTURES_PER_ROOM) problems.push(`${key}: lists more than ${MAX_FIXTURES_PER_ROOM} fixtures`);
    const zones = zonesFor(key);
    const names = new Set<string>();
    for (const fx of entry.fixtures) {
      if (!FIXTURE_ID_RE.test(fx.id) || !fx.id.startsWith(`${key}.`)) problems.push(`${key}: fixture id "${fx.id}" is not "${key}.<slug>"`);
      if (seenIds.has(fx.id)) problems.push(`${key}: fixture id "${fx.id}" is used twice`);
      seenIds.add(fx.id);
      if (!FIXTURE_KINDS.includes(fx.kind)) problems.push(`${fx.id}: unknown kind "${String(fx.kind)}"`);
      if (fx.zone !== undefined && !zones.includes(fx.zone)) problems.push(`${fx.id}: zone "${fx.zone}" is not a zone of ${key}`);
      for (const [where, text] of [["label", fx.label] as const, ...fx.aliases.map((a, i) => [`alias ${i}`, a] as const)]) {
        const p = textProblem(`${fx.id} ${where}`, text);
        if (p) { problems.push(p); continue; }
        const norm = text.toLowerCase();
        if (names.has(norm)) problems.push(`${fx.id} ${where}: "${text}" is listed twice in ${key}`);
        names.add(norm);
      }
    }
    const props = new Set<string>();
    for (const p of entry.allowedProps) {
      if (!(PROP_CATEGORIES as readonly string[]).includes(p)) problems.push(`${key}: unknown prop category "${String(p)}"`);
      if (props.has(p)) problems.push(`${key}: prop category "${p}" is listed twice`);
      props.add(p);
    }
    if (key === "diary-room" && entry.allowedProps.length > 0) problems.push("diary-room: is private and must carry no props");
  }
  return problems;
}

/** How a room reads in a sentence: "the living room", "the HOH room", but "bedroom A" (a named room takes no article). */
export function roomPhrase(room: Room): string {
  const name = roomDisplayName(room);
  return /^bedroom [A-Z]$/.test(name) ? name : `the ${name}`;
}

/** The map entry for a room (the BASE map unless another is given). */
export function roomMapEntry(room: Room, map: HouseMap = BASE_HOUSE_MAP): RoomMapEntry | undefined {
  return map.get(room);
}

/**
 * The current room's fixtures for the Show Brief, about 0.1K tokens (K9 §1.3): the closed list of what is
 * built in, stated positively ("that is the whole list"), then the loose-prop line. Adjacent rooms are never
 * described here. Positive-only by design (K4 D7): it names what exists, never what does not.
 * `undefined` for a room the map does not know.
 */
export function fixturesForBrief(room: Room, map: HouseMap = BASE_HOUSE_MAP): string | undefined {
  const entry = map.get(room);
  if (!entry || entry.fixtures.length === 0) return undefined;
  const lines = [
    `Built into ${roomPhrase(room)}: ${entry.fixtures.map((fx) => fx.label).join("; ")}. That is the whole list.`,
    entry.allowedProps.length
      ? `Loose things that may be lying around: ${entry.allowedProps.map((p) => PROP_CATEGORY_LABELS[p]).join(", ")}.`
      : "Nothing loose lies around in here.",
  ];
  return lines.join("\n");
}
