/**
 * ORW-480: the SHOT CARD and the FACE CARD, dealt across the cast for the portrait prompt.
 *
 * Why: every photo used to be built alone from one shared recipe, so one value of any attribute (the same living
 * room, the same mug, a closed smile at the lens, the same square jaw) landed on many people. The fix is at the level
 * of the cast: each person gets a shot card (place, time of day through the light, framing, angle, lens, the moment,
 * gaze, and a held prop only when the sheet gives a reason) and a face card (face shape, nose, eyes, brows, jaw,
 * mouth, one quirk), both dealt with a cap per value across the cast.
 *
 * Nothing here is stored and nothing draws from any game stream: the deal is a pure function of the cast's public
 * sheets (ids, names, ages, casting read, demeanor, voice energy, vocation) through its OWN seeded stream, so no other
 * dealt value can move (the tests pin that with a hash). Public facets only, Vault-free by construction.
 */
import { fnv1a } from "../domain/num";
import table from "../domain/castRealism.json";
import { dealPerformances, perfCaps, type Gaze, type TraitId, type PlaceFlags } from "./performance";
export type { Gaze };

interface CapSpec { share: number; min: number }
/** The cap of a kind in a cast of `n`, read from the shared casting-director table (castRealism.json): floor(share * n), never below min. */
export function capOf(kind: string, n: number): number {
  const cap = (table.kinds as Record<string, { cap: CapSpec }>)[kind]!.cap;
  return Math.max(cap.min, Math.floor(cap.share * n + 1e-9));
}
/** The caps for a cast of `n` (15: place 3, light 4, prop 2, eyes on the lens 9, face value 3). */
export const shotCaps = (n: number) => ({
  place: capOf("place", n), light: capOf("light", n), prop: capOf("prop", n),
  lensGaze: capOf("gaze", n), faceValue: capOf("face-value", n),
});


export interface ShotSheet {
  id: string;
  name?: string;
  age: number;
  genderPresentation?: "man" | "woman" | "nonbinary";
  demeanor?: string;
  /** The casting read ("cool stare, shoulders loose, unbothered") and label ("the rebel"). */
  castingRead?: string;
  castingLabel?: string;
  /** The voice's energy dial ("bright on top, flat underneath"). */
  energy?: string;
  vocation?: string;
  identityConcept?: string;
  /** The written face line; a feature it names (round, square jaw, deep-set eyes ...) is kept, the rest is dealt. */
  facialFeatures?: string;
  /** The written height and build ("short and slight"): the neck and shoulders are dealt to agree with it. */
  heightBuild?: string;
  /** "City, State": the setting should look like where they live. */
  hometown?: string;
  /** The public biography: hobbies and places named there are read for the place. */
  biography?: string;
  /** What the person wears (wardrobe and style): a place must fit the clothes (no tweed blazer in the gym). */
  clothes?: string;
}

export interface ShotCard {
  placeId: string;
  /** "Setting:" text: where, with what is readable behind the person. */
  place: string;
  outdoor: boolean;
  framingId: string;
  framing: string;
  angle: string;
  lens: string;
  lightId: string;
  light: string;
  momentId: string;
  /** The moment: the expression at full strength, the posture, what the hands do (no subject; phrases). */
  moment: string;
  gaze: Gaze;
  /** One word for who the person is at a glance (loud, sly, shy, intense, warm, guarded, cocky, dreamy, playful, poised), derived from their sheet. */
  trait: TraitId;
  expression: string; posture: string; hands: string;
  smiles: boolean; closedHalf: boolean;
  /** A held prop (something a person holds at home), only when the sheet gives a reason (vocation / identity), at most 2 per cast. */
  prop?: string;
  /** Which of the person's own sheet lines the moment was derived from, for the report: "type the jock (athletic ease, ...); demeanor ...". */
  why: string;
  /** The kind of place: home-interior, home-exterior, town, nature, work-adjacent. */
  placeKind: PlaceKind;
}

export interface FaceCard {
  shape: string;
  neck: string;
  nose: string;
  eyes: string;
  brows: string;
  jaw: string;
  mouth: string;
  quirk: string;
}

export interface PortraitPlan { shot: ShotCard; face: FaceCard }

// ---------------------------------------------------------------------------------------------------- the stream

/** mulberry32: a tiny seeded stream of this module's own. */
function stream(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pickFrom = <T>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length) % xs.length]!;
function shuffled<T>(rnd: () => number, xs: readonly T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
}
/** The cast's seed: its ids and names only, so the same cast always gets the same deal and nothing else is read. */
export function castSeed(sheets: readonly ShotSheet[], tag: string): number {
  return fnv1a(`${tag}|` + sheets.map((s) => `${s.id}~${s.name ?? ""}`).sort().join("|"));
}

/** The sheets in id order, so the deal never depends on the order the caller lists the cast in. */
const byId = <T extends { id: string }>(xs: readonly T[]): T[] => [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** A cast larger than 15 scales every cap up (ceil(n / 15) times). */
const scale = (n: number): number => Math.max(1, Math.ceil(n / 15));

// ---------------------------------------------------------------------------------------------------- places

/**
 * These are PRE-SEASON cast photos: the show's production visited each person on a roughly ordinary day of their own life and
 * photographed them there. So the place is somewhere from their day (their home, their town, a place they spend time), looking
 * like where they live, and the job does not define the photo (at most a few of the cast are at or near work, in their own clothes).
 */
export type PlaceKind = "home-interior" | "home-exterior" | "town" | "nature" | "work-adjacent";
interface Place {
  id: string; kind: PlaceKind; outdoor: boolean; phrase: string;
  /** Things a moment can use: what to perch on, lean on, sit on, and whether there is room to walk. */
  perch?: string; lean?: string; seat?: string; walk?: boolean;
  /** A table to sit at, only where the place really has one. */
  table?: string;
  /** What is in this place, one per person dealt it (a back yard is a different yard each time): {detail}. */
  details?: readonly string[];
}

export const PLACES: readonly Place[] = [
  { id: "home-kitchen", kind: "home-interior", outdoor: false, phrase: "the person's own kitchen in {town}, {home}, {detail} behind", table: "the kitchen table", details: ["the counters and a window over the sink", "open shelves, a fridge covered in magnets", "a window onto the back yard and a dish rack", "painted cupboards and a calendar on the wall"], perch: "the kitchen counter", lean: "the kitchen island", seat: "on a kitchen stool" },
  { id: "home-living-room", kind: "home-interior", outdoor: false, phrase: "the person's own living room in {town}, {home}, {detail} behind", details: ["a sofa, shelves and family photos", "a TV, a lamp and a bookcase", "a worn armchair and a window with curtains", "framed photos and a crowded side table"], perch: "the arm of the sofa", lean: "the bookshelf", seat: "on the sofa" },
  { id: "family-table", kind: "home-interior", outdoor: false, phrase: "a family dining table in {town}, {home}, {detail} behind", table: "the dining table", details: ["a window and a sideboard", "a china cabinet and patterned wallpaper", "a doorway into the kitchen", "a wall of family photos"], lean: "the sideboard", seat: "in a dining chair" },
  { id: "window-seat", kind: "home-interior", outdoor: false, phrase: "a bright window seat in the person's apartment in {town}, {detail}", details: ["the street visible outside", "a radiator and a shelf of plants beside it", "a stack of books and a view over rooftops"], lean: "the window frame", seat: "on the window seat" },
  { id: "front-porch", kind: "home-exterior", outdoor: true, phrase: "the front porch of the person's home in {town}, {detail}, {out}", details: ["a screen door and a hanging plant", "a worn railing and a doormat", "a swing at one end and a pile of shoes by the door", "wooden steps down to a short front walk"], lean: "the porch post" },
  { id: "back-yard", kind: "home-exterior", outdoor: true, phrase: "the back yard of the person's home in {town}, {detail}, {out}", details: ["a chain-link fence and a shed behind", "a clothesline and a single big tree", "a patchy lawn, a hose and a neighbor's fence", "a garden bed along a wooden fence"], lean: "the fence", seat: "in a lawn chair", walk: true },
  { id: "balcony", kind: "home-exterior", outdoor: true, phrase: "an apartment balcony in {town}, {detail}", details: ["rooftops and open sky behind", "potted plants and a folding chair", "a neighbor's balcony across the way and a string of laundry"], lean: "the balcony railing", seat: "in a balcony chair" },
  { id: "stoop", kind: "home-exterior", outdoor: true, phrase: "the stoop of the person's building in {town}, {detail}", details: ["a brick wall and the street behind", "a row of mailboxes and a parked car", "a metal railing and the next building's stoop"], lean: "the stoop railing" },
  { id: "diner-booth", kind: "town", outdoor: false, phrase: "a corner booth in a local diner in {town}, {detail} behind", table: "the booth table", details: ["a window and a counter", "a pie case and a row of stools", "a wall of faded photos and a menu board"], seat: "in the booth" },
  { id: "main-street", kind: "town", outdoor: true, phrase: "the main street of {town}, {detail}, {out}", details: ["shopfronts behind", "a hardware store and a bank clock behind", "angled parking and a crosswalk behind"], lean: "a shopfront wall", walk: true },
  { id: "park-bench", kind: "town", outdoor: true, phrase: "a park bench in {town}, {detail}, {out}", details: ["trees and a path behind", "a playground in the distance", "a duck pond and a gravel walk behind"], seat: "on the bench", walk: true },
  { id: "ball-field", kind: "town", outdoor: true, phrase: "the fence of a local ball field in {town}, {detail}, {out}", details: ["bleachers behind", "a scoreboard and a dugout behind", "a concession stand and the outfield behind"], lean: "the fence" },
  { id: "farmers-market", kind: "town", outdoor: true, phrase: "a farmers market in {town}, {detail}, {out}", details: ["stalls and awnings behind", "crates of produce and a chalkboard sign behind", "a flower stall and folding tables behind"], lean: "a stall table", walk: true },
  { id: "coffee-shop", kind: "town", outdoor: false, phrase: "a neighborhood coffee shop in {town}, {detail} behind", table: "a small café table", details: ["a window and the street", "a pastry case and a chalkboard menu", "mismatched chairs and a shelf of mugs"], seat: "on a window stool", lean: "the counter" },
  { id: "lakeside", kind: "nature", outdoor: true, phrase: "a lakeside dock near {town}, {detail}, {out}", details: ["still water and trees behind", "a rowboat tied up and reeds behind", "a far shore and a few other docks behind"], walk: true },
  { id: "trail", kind: "nature", outdoor: true, phrase: "a trail near {town}, {detail}, {out}", details: ["trees and open sky behind", "a trail marker and a slope behind", "rocks and low scrub beside the path"], lean: "a tree", walk: true },
  { id: "open-field", kind: "nature", outdoor: true, phrase: "an open field near {town}, {detail}, {out}", details: ["tall grass and a long horizon", "a fence line and a lone tree", "a dirt track and bales in the distance"], lean: "a fence post", walk: true },
  { id: "work-plaza", kind: "work-adjacent", outdoor: true, phrase: "a bench in a plaza near where the person works in {town}, in their own everyday clothes, {detail}, {out}", details: ["office windows behind", "a fountain behind", "a row of bikes behind"], seat: "on the bench", walk: true },
  { id: "work-cafe", kind: "work-adjacent", outdoor: false, phrase: "a café table across from where the person works in {town}, in their own everyday clothes, {detail} behind", table: "the café table", details: ["a window", "a menu board", "a wall of local flyers"], seat: "in a café chair" },
  { id: "work-street", kind: "work-adjacent", outdoor: true, phrase: "the sidewalk outside a shop near where the person works in {town}, in their own everyday clothes, {detail}, {out}", details: ["a shop window behind", "a bus stop behind", "a row of parked cars behind"], lean: "the shop wall", walk: true },
];

// where they live: the setting should look like it (a Nebraska town, a Mississippi porch, a Los Angeles street)
type Region = "new-england" | "mid-atlantic" | "southeast" | "deep-south" | "great-lakes" | "plains" | "texas" | "southwest" | "mountain-west" | "pacific" | "pacific-nw";
const STATE_REGION: Record<string, Region> = {};
for (const [r, names] of Object.entries({
  "new-england": "Maine,New Hampshire,Vermont,Massachusetts,Rhode Island,Connecticut",
  "mid-atlantic": "New York,New Jersey,Pennsylvania,Delaware,Maryland,District of Columbia,Washington DC",
  southeast: "Virginia,North Carolina,South Carolina,Georgia,Tennessee,Kentucky,West Virginia",
  "deep-south": "Alabama,Mississippi,Louisiana,Arkansas",
  "great-lakes": "Ohio,Michigan,Indiana,Illinois,Wisconsin,Minnesota",
  plains: "Iowa,Missouri,Kansas,Nebraska,North Dakota,South Dakota,Oklahoma",
  southwest: "Arizona,New Mexico,Nevada",
  "mountain-west": "Colorado,Utah,Idaho,Montana,Wyoming",
} as Record<Region, string>)) for (const n of names.split(",")) STATE_REGION[n.toLowerCase()] = r as Region;
const REGION_FLAVOR: Record<Region | "none", { out: readonly string[]; home: readonly string[] }> = {
  "new-england": { out: ["white clapboard houses and maples", "stone walls and bare-branched trees", "a church steeple and shingled houses"], home: ["an older wood-floored home", "a narrow house with low ceilings"] },
  "mid-atlantic": { out: ["brick rowhouses and narrow streets", "stoops and fire escapes", "tight lots and chain-link"], home: ["a brick row home", "a small apartment in an older building"] },
  southeast: { out: ["tall pines and red clay", "magnolias and brick bungalows", "a cracked driveway and crepe myrtles", "kudzu at the edge of the lot"], home: ["a brick ranch house", "a low frame house with a carport"] },
  "deep-south": { out: ["live oaks and humid green", "tin roofs and a gravel lane", "a pecan tree and cicadas in the heat"], home: ["a wood-frame house with a deep porch", "a low brick house with window units"] },
  "great-lakes": { out: ["maples, brick and a soft grey sky", "a flat street of frame houses", "bare trees and a slate-coloured sky"], home: ["a two-story frame house", "a brick bungalow"] },
  plains: { out: ["flat farmland and a grain elevator", "a huge sky and a gravel road", "a water tower on the horizon", "wind-bent cottonwoods"], home: ["a simple ranch house", "a one-story house with a porch light"] },
  texas: { out: ["dry grass and pickup trucks", "a big sky and a metal fence", "mesquite and a dusty road"], home: ["a low brick ranch house", "a house with a wide carport"] },
  southwest: { out: ["adobe-coloured walls and dry light", "gravel yards and desert plants", "a cinder-block wall and a bare mountain"], home: ["a stucco home", "a flat-roofed house"] },
  "mountain-west": { out: ["mountains on the horizon and sage", "pines and a dirt road", "a pickup and a snow fence"], home: ["a log-trimmed home", "a small house with a woodpile"] },
  pacific: { out: ["palms and stucco in bright dry light", "a hazy hillside and low hedges", "a bougainvillea wall and parked cars"], home: ["a stucco bungalow", "a small apartment with a window unit"] },
  "pacific-nw": { out: ["tall firs and wet green", "soft grey light and moss on the fence", "a cedar fence and fern beds"], home: ["a wood-shingled home", "a small house with a covered porch"] },
  none: { out: [], home: [] },
};
/**
 * Towns whose look the state rule would get wrong (a Gulf island, a mountain town in a pine state, a coast): the regional phrase is left out
 * rather than guessed.
 */
const TOWN_NO_REGION_RE = /\b(?:Key|Keys|Island|Isle|Beach|Bay|Harbou?r|Coast|Cape|Port|Gulf|Shores|Sound|Landing|Savannah|Charleston|Biloxi|Gulfport|Mobile|New Orleans|Galveston|Wilmington|Hilton Head|Beaufort|Brunswick|Norfolk|Provincetown|Nantucket|Newport|Mystic|Asheville|Boone|Gatlinburg|Blue Ridge|Dahlonega|Pigeon Forge|Tahoe|Reno|Duluth|Marquette)\b/i;
/** The region of a "City, State" hometown whose look the state rule fits, else undefined (the regional phrase is then left out). */
export function regionOf(hometown: string | undefined): Region | undefined {
  const parts = (hometown ?? "").split(",");
  const st = parts.pop()?.trim().toLowerCase() ?? "";
  if (TOWN_NO_REGION_RE.test(parts.join(","))) return undefined;
  return STATE_REGION[st];
}
/**
 * The place phrase with the person's town, its regional look and the specifics of this place filled in. `k` is how many people in the cast are already
 * in this same place: it picks the detail and the regional look, so two people in the same kind of place never get the same sentence.
 */
export function placeText(place: Place, hometown: string | undefined, k = 0): string {
  const f = REGION_FLAVOR[regionOf(hometown) ?? "none"];
  const town = (hometown ?? "").trim() !== "" ? hometown!.trim() : "their home town";
  const h = fnv1a(town);
  const pickAt = <X>(xs: readonly X[], i: number): X => xs[i % xs.length]!;
  const out = f.out.length > 0 ? pickAt(f.out, k + (h % 5)) : "", home = f.home.length > 0 ? pickAt(f.home, k + (h % 3)) : "";
  return place.phrase.replace(/\{town\}/g, town).replace(/\{detail\}/g, pickAt(place.details ?? [""], k + (h % 7)))
    .replace(/,\s*\{out\}/g, out !== "" ? `, ${out}` : "").replace(/,\s*\{home\}/g, home !== "" ? `, ${home}` : "");
}

// ---------------------------------------------------------------------------------------------------- light, framing, angle

interface Light { id: string; phrase: string; where: "in" | "out" | "any" }
export const LIGHTS: readonly Light[] = [
  { id: "window", phrase: "ordinary window light from the side, mid-morning", where: "in" },
  { id: "bright-room", phrase: "ordinary daylight coming in through the windows", where: "in" },
  { id: "overcast", phrase: "flat overcast daylight", where: "any" },
  { id: "golden", phrase: "low late-afternoon sun, warm", where: "any" },
  { id: "shade", phrase: "open shade, even daylight", where: "out" },
  { id: "lamps", phrase: "the room's own warm evening lamps with a little window light", where: "in" },
  { id: "afternoon", phrase: "afternoon sun with ordinary shadows", where: "out" },
];

/**
 * ONE PORTRAIT FORMAT for the whole cast, so a sheet of 15 reads as one photographer's series: half-length, mid-torso up, both shoulders and
 * at least one hand in frame, the camera at the same distance and at eye level, one lens, the head the same size in every photo, the eyes on
 * the same line, room above the head. Nothing about framing, lens or angle is dealt: all variety comes from place, light, pose, hands and expression.
 */
export const PORTRAIT_FORMAT = {
  id: "portrait",
  phrase: "a half-length portrait from mid-torso up, both shoulders and at least one hand in frame, the head about a quarter of the frame height, the eyes on the upper-third line, room above the head, seated or standing upright enough that the head stays the same size as in every other photo",
  angle: "the camera level, at eye level",
  lens: "a 50mm lens",
} as const;

/** Props: only a thing a person would hold AT HOME, and only when the sheet gives a reason (the vocation or the identity line). No work props. */
const PROP_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:barista|coffee)\b/i, "holding a paper coffee cup"],
  [/\b(?:teacher|professor|tutor|librarian|author|novelist|editor)\b/i, "holding a paperback, a finger keeping the page"],
  [/\b(?:musician|guitarist|singer|drummer|bassist)\b/i, "holding an acoustic guitar by the neck"],
  [/\b(?:photographer)\b/i, "holding an old film camera by its strap"],
];
export function propFor(s: ShotSheet): string | undefined {
  const t = `${s.vocation ?? ""} ; ${s.identityConcept ?? ""}`;
  for (const [re, prop] of PROP_RULES) if (re.test(t)) return prop;
  return undefined;
}

// ---------------------------------------------------------------------------------------------------- place fit

/** Which sheets a place suits: casting labels (6), words in the biography / identity (4 each), the vocation read only for a HOME or TOWN place (3 each; never defines the photo). */
interface PlaceFit { labels: readonly string[]; words: RegExp }
const PLACE_FIT: Record<string, PlaceFit> = {
  "home-kitchen": { labels: ["the sweetheart", "the parent of the house", "the natural"], words: /\b(?:cook\w*|chef|baker|bak\w*|food|restaurant|kitchen|recipes?)\b/i },
  "home-living-room": { labels: ["the charmer", "the natural", "the sweetheart", "the flirt", "the brain"], words: /\b(?:read\w*|books?|movies?|games?|relax\w*)\b/i },
  "family-table": { labels: ["the parent of the house", "the wise head", "the class clown", "the distinguished one"], words: /\b(?:family|dinner|sisters?|brothers?|grandm\w*|cook\w*|host\w*)\b/i },
  "window-seat": { labels: ["the dreamer", "the brain", "the underdog", "the quiet storm", "the mastermind in plain sight"], words: /\b(?:writer|podcast\w*|apartment|student|laptop|producer|journal\w*)\b/i },
  "front-porch": { labels: ["the sweetheart", "the rebel", "the free spirit", "the parent of the house", "the straight shooter", "the underdog"], words: /\b(?:porch|small-town|neighbo\w*|guitar|musician|southern|rural)\b/i },
  "back-yard": { labels: ["the jock", "the class clown", "the life of the party", "the parent of the house"], words: /\b(?:barbecue|grill\w*|garden\w*|dogs?|yard|kids)\b/i },
  balcony: { labels: ["the flirt", "the showstopper", "the dreamer", "the hustler"], words: /\b(?:city|apartment|plants|skyline|sunset|rooftop)\b/i },
  stoop: { labels: ["the rebel", "the hustler", "the class clown", "the wildcard", "the showstopper"], words: /\b(?:brooklyn|bronx|neighborhood|block|city)\b/i },
  "diner-booth": { labels: ["the straight shooter", "the class clown", "the underdog", "the rebel", "the hustler"], words: /\b(?:diner|breakfast|waitress|small-town|trucks?|cook\w*|restaurant)\b/i },
  "main-street": { labels: ["the charmer", "the hustler", "the showstopper", "the wildcard", "the natural"], words: /\b(?:town|local|shops?|business|sales|market)\b/i },
  "park-bench": { labels: ["the brain", "the dreamer", "the wise head", "the underdog", "the quiet storm"], words: /\b(?:park|read\w*|walks?|walking|dogs?|writer|teacher)\b/i },
  "ball-field": { labels: ["the jock", "the competitor", "the class clown", "the gentle giant"], words: /\b(?:baseball|softball|football|little league|coach\w*|pickup|basketball|athlet\w*|sports?|trainer|ballpark)\b/i },
  "farmers-market": { labels: ["the free spirit", "the sweetheart", "the natural", "the parent of the house"], words: /\b(?:garden\w*|farm\w*|markets?|bak\w*|produce|flowers|craft\w*)\b/i },
  "coffee-shop": { labels: ["the brain", "the dreamer", "the flirt", "the charmer", "the mastermind in plain sight"], words: /\b(?:podcast\w*|writer|laptop|student|barista|coffee|editor|producer)\b/i },
  lakeside: { labels: ["the free spirit", "the dreamer", "the jock", "the gentle giant", "the natural"], words: /\b(?:lakes?|fish\w*|boat\w*|kayak\w*|paddl\w*|swim\w*|camp\w*|river)\b/i },
  trail: { labels: ["the free spirit", "the competitor", "the jock", "the wildcard", "the rebel"], words: /\b(?:hik\w*|trails?|mountains?|camp\w*|climb\w*|runn\w*|outdoors?|backpack\w*|mesa)\b/i },
  "open-field": { labels: ["the dreamer", "the quiet storm", "the wise head", "the gentle giant", "the free spirit"], words: /\b(?:farm\w*|ranch\w*|prairie|horses?|rural|country|harvest|tractor)\b/i },
};

/** How well a place suits a person, from their own lines, and which lines said so; undefined when the place is not for them (a work-adjacent place needs a job). */
export function placeFit(place: Place, s: ShotSheet): { score: number; why: string } | undefined {
  if (place.kind === "work-adjacent") return (s.vocation ?? "").trim() === "" ? undefined : { score: 0, why: `hometown ${s.hometown ?? "unknown"}; a few of the cast are photographed near work, never in work clothes (${s.vocation})` };
  const fit = PLACE_FIT[place.id];
  if (fit === undefined) return { score: 0, why: "" };
  const hobby = `${s.biography ?? ""} ; ${s.identityConcept ?? ""}`;
  const count = (t: string): string[] => t.match(new RegExp(fit.words.source, "gi")) ?? [];
  let score = 0; const why: string[] = [];
  if (s.castingLabel !== undefined && fit.labels.includes(s.castingLabel.toLowerCase())) { score += 6; why.push(`type "${s.castingLabel}"`); }
  const h = count(hobby); if (h.length > 0) { score += 4 * Math.min(2, h.length); why.push(`biography/identity (${[...new Set(h.map((x) => x.toLowerCase()))].join(", ")})`); }
  const v = count(s.vocation ?? ""); if (v.length > 0 && place.kind !== "nature") { score += 3; why.push(`their day (${s.vocation}: at home or in town, not at work)`); }
  const rg = regionOf(s.hometown); if (s.hometown) why.push(`hometown ${s.hometown}${rg ? ` (${rg})` : ""}`);
  return { score, why: why.join("; ") };
}

// ---------------------------------------------------------------------------------------------------- the shot deal

const count = <T>(m: Map<T, number>, k: T): number => m.get(k) ?? 0;
const bump = <T>(m: Map<T, number>, k: T): void => { m.set(k, count(m, k) + 1); };

/** Pick, among candidates, one whose count is under the cap (preferring the least used); with none under the cap, the least used. */
function pickCapped<T>(rnd: () => number, cands: readonly T[], used: Map<string, number>, key: (x: T) => string, cap: number | ((x: T) => number)): T {
  const capOfX = (x: T): number => (typeof cap === "number" ? cap : cap(x));
  const under = cands.filter((c) => count(used, key(c)) < capOfX(c));
  const pool = under.length > 0 ? under : cands;
  const least = Math.min(...pool.map((c) => count(used, key(c))));
  return pickFrom(rnd, pool.filter((c) => count(used, key(c)) === least));
}

const poss = (g: ShotSheet["genderPresentation"]): string => (g === "man" ? "his" : g === "woman" ? "her" : "their");

/** Deal one shot card per sheet. One portrait format for everyone; caps (cast of 15): no place on more than 3, no light on more than 4, a prop on at most 2, closed half-smile on at most 3, at least 4 not smiling, eyes on the lens within the table's cap. */
export function dealShotCards(sheets: readonly ShotSheet[]): Map<string, ShotCard> {
  const rnd = stream(castSeed(sheets, "shot-cards"));
  const caps = shotCaps(sheets.length);
  const placeRegionUsed = new Set<string>();
  const placeUsed = new Map<string, number>(), kindUsed = new Map<string, number>(), placeWhy = new Map<string, string>(), lightUsed = new Map<string, number>();
  const order = shuffled(rnd, byId(sheets));
  // the kinds: at most 5 of 15 in any one kind (the table's place-kind cap), at most 3 near work (place-work); a couple of people near work
  const kindCap = (kind: PlaceKind): number => (kind === "work-adjacent" ? capOf("place-work", sheets.length) : capOf("place-kind", sheets.length));
  const workIds = new Set(order.filter((s) => (s.vocation ?? "").trim() !== "").slice(0, Math.min(2, Math.max(0, Math.floor(sheets.length / 10)))).map((s) => s.id));
  const base = new Map<string, { place: Place; light: Light; k: number; prop?: string }>();
  let props = 0;
  for (const s of order) {
    // The place is somewhere from the person's ordinary day, scored against their own sheet (hometown, biography hobbies, type); the cap per
    // place and per KIND (home inside, home outside, town, nature, near work) spreads the cast. Only a couple of people are near work.
    const open = (p: Place): boolean => count(placeUsed, p.id) < caps.place && count(kindUsed, p.kind) < kindCap(p.kind) && placeFit(p, s) !== undefined;
    let pool = PLACES.filter((p) => (p.kind === "work-adjacent") === workIds.has(s.id) && open(p));
    if (pool.length === 0) pool = PLACES.filter((p) => p.kind !== "work-adjacent" && placeFit(p, s) !== undefined && count(placeUsed, p.id) < caps.place);
    if (pool.length === 0) pool = PLACES.filter((p) => p.kind !== "work-adjacent");
    const leastKind = Math.min(...pool.map((p) => count(kindUsed, p.kind)));
    // never two people in the same place AND the same region when another place will do
    const prKey = (p: Place): string => `${p.id}|${regionOf(s.hometown) ?? "none"}`;
    const scored = pool.map((p) => ({ p, v: (placeFit(p, s)?.score ?? 0) + (count(kindUsed, p.kind) === leastKind ? 1 : 0) + (count(placeUsed, p.id) === 0 ? 5 : 0) - (placeRegionUsed.has(prKey(p)) ? 8 : 0) }));
    const top = Math.max(...scored.map((x) => x.v));
    const place = pickFrom(rnd, scored.filter((x) => x.v === top)).p;
    placeWhy.set(s.id, `place ${place.id} (${place.kind}): ${placeFit(place, s)?.why || "no line of the sheet matched: dealt"}`);
    bump(kindUsed, place.kind);
    const placeK = count(placeUsed, place.id);
    placeRegionUsed.add(prKey(place));
    bump(placeUsed, place.id);
    const lights = LIGHTS.filter((l) => l.where === "any" || l.where === (place.outdoor ? "out" : "in"));
    const light = pickCapped(rnd, lights, lightUsed, (l) => l.id, caps.light);
    bump(lightUsed, light.id);
    const prop = props < caps.prop ? propFor(s) : undefined;
    if (prop !== undefined) props++;
    base.set(s.id, { place, light, k: placeK, ...(prop !== undefined ? { prop } : {}) });
  }
  // The performance: expression at full strength, posture and hands, from the person's own sheet; the caps are kept across the cast.
  const flags = new Map<string, PlaceFlags>([...base].map(([id, b]) => [id, { ...(b.place.perch ? { perch: b.place.perch } : {}), ...(b.place.lean ? { lean: b.place.lean } : {}), ...(b.place.seat ? { seat: b.place.seat } : {}), ...(b.place.table ? { table: b.place.table } : {}) }] as const));
  const perfSheets = order.map((s) => ({ id: s.id, ...(s.castingLabel ? { castingLabel: s.castingLabel } : {}), ...(s.castingRead ? { castingRead: s.castingRead } : {}),
    ...(s.demeanor ? { demeanor: s.demeanor } : {}), ...(s.energy ? { energy: s.energy } : {}), ...(s.genderPresentation ? { genderPresentation: s.genderPresentation } : {}),
    ...(base.get(s.id)!.prop ? { prop: base.get(s.id)!.prop } : {}) }));
  const perf = dealPerformances(perfSheets, flags, rnd, perfCaps(sheets.length, caps.lensGaze));
  const sheetById = new Map(sheets.map((s) => [s.id, s] as const));
  const out = new Map<string, ShotCard>();
  const settingSeen = new Set<string>();
  for (const s of order) {
    const b = base.get(s.id)!, pf = perf.get(s.id)!, sheet = sheetById.get(s.id)!;
    // the setting sentence, with the town taken out, is never the same for two people in a cast: a later one takes the next detail and regional look
    const townTag = (sheet.hometown ?? "").trim();
    const norm = (t: string): string => (townTag !== "" ? t.split(townTag).join("TOWN") : t);
    let kk = b.k, text = placeText(b.place, sheet.hometown, kk);
    for (let guard = 0; guard < 24 && settingSeen.has(norm(text)); guard++) text = placeText(b.place, sheet.hometown, ++kk);
    settingSeen.add(norm(text));
    out.set(s.id, {
      placeId: b.place.id, place: text, outdoor: b.place.outdoor, placeKind: b.place.kind,
      framingId: PORTRAIT_FORMAT.id, framing: PORTRAIT_FORMAT.phrase, angle: PORTRAIT_FORMAT.angle, lens: PORTRAIT_FORMAT.lens,
      lightId: b.light.id, light: b.light.phrase,
      momentId: `${pf.expressionId}+${pf.postureId}`, moment: pf.moment, gaze: pf.gaze,
      trait: pf.trait, expression: pf.expression, posture: pf.posture, hands: pf.hands, smiles: pf.smiles, closedHalf: pf.closedHalf,
      ...(b.prop !== undefined ? { prop: b.prop } : {}),
      why: `${pf.why} | ${placeWhy.get(s.id)!}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- the face deal

type Axis = keyof FaceCard;
type BuildClass = "slender" | "mid" | "thick";
interface FaceValue { v: string; pin?: RegExp; build?: BuildClass; jaws?: readonly string[]; lean?: "man" | "woman" }

/** Jaw and chin values, so a shape can name the ones that go with it (a round face never gets "a long, prominent chin"). */
const J = {
  square: "a square jaw", soft: "a soft, rounded jaw", pointed: "a pointed chin", cleft: "a cleft chin", small: "a small chin",
  wide: "a wide, heavy jaw", narrow: "a narrow, tapered jaw", long: "a long, prominent chin",
} as const;

const SHAPES: readonly FaceValue[] = [
  { v: "a round, full-cheeked face", pin: /\bround\b/i, jaws: [J.soft, J.small, J.cleft] },
  { v: "an oval face", pin: /\boval\b/i, jaws: [J.soft, J.square, J.pointed, J.cleft, J.narrow, J.small] },
  { v: "a long, narrow face", pin: /\b(?:narrow|long|elongated)\b/i, jaws: [J.long, J.narrow, J.square, J.pointed] },
  { v: "a broad, squarish face", lean: "man", pin: /\b(?:broad face|wide face|squarish)\b/i, jaws: [J.square, J.wide] },
  { v: "a heart-shaped face", pin: /\bheart\b/i, jaws: [J.pointed, J.narrow, J.small] },
  { v: "a diamond-shaped face with high cheekbones", pin: /\bcheekbones?\b/i, jaws: [J.pointed, J.narrow, J.square] },
  { v: "a soft, rounded-square face", jaws: [J.square, J.soft, J.wide] },
];
const AXES: Record<Exclude<Axis, "shape" | "jaw">, readonly FaceValue[]> & { jaw: readonly FaceValue[] } = {
  jaw: [
    { v: J.square, pin: /\b(?:square|strong|angular) jaw\b|\bangular\b/i }, { v: J.soft, pin: /\bsoft jaw\b/i },
    { v: J.pointed, pin: /\bpointed chin\b/i }, { v: J.cleft, lean: "man", pin: /\bcleft\b/i }, { v: J.small, pin: /\bsmall chin\b/i },
    { v: J.wide, lean: "man", pin: /\b(?:wide|broad) jaw\b/i }, { v: J.narrow, pin: /\bnarrow jaw\b/i }, { v: J.long },
  ],
  neck: [
    { v: "a long, slender neck", pin: /\bslender neck\b/i, build: "slender" },
    { v: "a slim neck", build: "slender" },
    { v: "an average neck and even shoulders", build: "mid" },
    { v: "a strong neck and square shoulders", build: "mid", lean: "man" },
    { v: "a thick neck and broad, heavy shoulders", pin: /\bthick neck\b/i, build: "thick", lean: "man" },
    { v: "a short, thick neck and a deep chest", build: "thick", lean: "man" },
  ],
  nose: [
    { v: "a straight nose", pin: /\bstraight nose\b/i }, { v: "a small button nose", pin: /\bbutton\b/i },
    { v: "an aquiline nose with a slight bridge", pin: /\b(?:aquiline|hawk|roman)\b/i },
    { v: "a broad nose with wide nostrils", pin: /\b(?:broad|wide) nose\b/i }, { v: "an upturned nose", pin: /\bupturned\b/i },
    { v: "a long, narrow nose", pin: /\bnarrow nose\b/i }, { v: "a nose with a rounded, slightly bulbous tip" },
    { v: "a nose with a low bridge and a soft tip" },
  ],
  eyes: [
    { v: "wide-set almond eyes", pin: /\bwide-set\b/i }, { v: "deep-set eyes", pin: /\bdeep-set\b/i },
    { v: "large round eyes", pin: /\bround eyes\b/i }, { v: "hooded eyes with heavy lids", pin: /\bhooded\b/i },
    { v: "close-set eyes", pin: /\bclose-set\b/i }, { v: "downturned eyes with soft outer corners", pin: /\bdownturned\b/i },
    { v: "narrow, upward-slanting eyes", pin: /\bslanting\b/i }, { v: "small bright eyes set slightly apart" },
  ],
  brows: [
    { v: "thick, straight brows", pin: /\b(?:thick|straight|bushy) brows?\b/i }, { v: "thin, high-arched brows", lean: "woman", pin: /\b(?:thin|arched) brows?\b/i },
    { v: "heavy dark brows", lean: "man", pin: /\bheavy[^,.]*\bbrows?\b|\bbrows? that\b/i }, { v: "light, sparse brows", pin: /\bsparse\b/i },
    { v: "low, flat brows", pin: /\b(?:low|flat) brows?\b/i }, { v: "brows that rise at the outer ends" },
    { v: "soft, rounded brows" }, { v: "one brow that sits a little higher than the other", pin: /\buneven brows?\b/i },
  ],
  mouth: [
    { v: "full lips", pin: /\bfull lips\b/i }, { v: "thin lips", pin: /\bthin lips\b/i },
    { v: "a wide mouth", pin: /\b(?:wide mouth|broad grin|wide smile)\b/i }, { v: "a small mouth", pin: /\bsmall mouth\b/i },
    { v: "a pronounced cupid's bow", pin: /\bcupid\b/i }, { v: "mouth corners that turn down at rest" },
    { v: "a mouth that sits slightly higher on one side" }, { v: "a full lower lip and a thinner upper lip" },
  ],
  quirk: [
    { v: "ears that stand out a little" }, { v: "a slightly lopsided smile" }, { v: "one eye a touch larger than the other" },
    { v: "a prominent, high forehead" }, { v: "a long upper lip" }, { v: "a slight overbite" },
    { v: "a faint crease between the brows" }, { v: "a dimple in the chin" }, { v: "a slightly crooked nose bridge" },
    { v: "cheeks that flush easily" }, { v: "a strong, visible jaw muscle when relaxed", lean: "man" }, { v: "a lot of lid space below the brow" },
    { v: "deep smile lines around the mouth" }, { v: "a prominent philtrum" }, { v: "small, tight ears set close to the head" },
    { v: "a slightly deviated septum that tilts the nose" }, { v: "a heavy brow ridge", lean: "man" }, { v: "full, round cheeks that lift when the mouth moves" },
    { v: "a wide forehead with a widow's peak" }, { v: "a slight asymmetry between the two sides of the face" },
  ],
};
const AXIS_ORDER: readonly Axis[] = ["shape", "jaw", "brows", "neck", "nose", "eyes", "mouth", "quirk"];
/** Quirks about age lines are held back from the young. */
const OLD_QUIRK_RE = /smile lines/i;
/** Two faces must differ on at least this many of the eight axes (relaxed step by step only when the pool runs out). */
export const FACE_MIN_DISTANCE = 4;

/** A quirk that would contradict a feature already dealt to the same face is not offered. */
const QUIRK_CONFLICTS: ReadonlyArray<readonly [RegExp, RegExp]> = [
  [/dimple in the chin/, /cleft chin/], [/jaw muscle/, /narrow|pointed|small|soft|round/i], [/heavy brow ridge/, /sparse|thin|light/i],
  [/lid space below the brow/, /hooded|deep-set|heavy lids/], [/high forehead|widow's peak/, /low, flat brows/],
  [/crooked nose|deviated/, /straight nose/], [/lopsided smile/, /sits slightly higher on one side/], [/one eye a touch larger/, /close-set|wide-set/],
  [/flush easily/, /deep brown/i], [/cheeks that lift|full, round cheeks/, /diamond|long, narrow|heart/], [/ears that stand out|small, tight ears/, /^$/],
];
const quirkFits = (quirk: string, face: Partial<FaceCard>): boolean => {
  const text = Object.entries(face).filter(([k]) => k !== "quirk").map(([, v]) => v).join(" | ");
  return !QUIRK_CONFLICTS.some(([q, c]) => q.test(quirk) && c.test(text));
};

const valuesOf = (axis: Axis): readonly FaceValue[] => (axis === "shape" ? SHAPES : AXES[axis]);

/** The build class the written height and build reads as, so the dealt neck and shoulders agree with it. */
export function buildClassOf(build: string | undefined): BuildClass | undefined {
  if (!build) return undefined;
  const slender = /\b(?:slight|slender|petite|lean|lanky|wiry|willowy|thin|light-boned|narrow)\b/i.test(build);
  const thick = /\b(?:muscular|solid|solidly|sturdy|athletic|powerful|stocky|heavy|burly|barrel|thick|broad-shouldered|broad shoulders|brawny|strong frame)\b/i.test(build);
  return slender && thick ? undefined : slender ? "slender" : thick ? "thick" : undefined;   // a lanky frame with broad shoulders is neither: any neck that does not say otherwise
}

function pinsOf(text: string | undefined): Partial<Record<Axis, string>> {
  const out: Partial<Record<Axis, string>> = {};
  if (!text) return out;
  for (const axis of AXIS_ORDER) {
    if (axis === "quirk") continue;
    const hit = valuesOf(axis).find((x) => x.pin?.test(text));
    if (hit) out[axis] = hit.v;
  }
  return out;
}

/**
 * Deal one face card per sheet so no two share a combination: at most 3 of the cast on any value, quirks never repeat, any two
 * faces differ on at least 4 of 8 axes. A feature the written face line names is kept as a pin. The jaw goes with the face shape
 * (never "a round face" with "a long, prominent chin") and the neck and shoulders go with the written build.
 */
export function dealFaceCards(sheets: readonly ShotSheet[]): Map<string, FaceCard> {
  const rnd = stream(castSeed(sheets, "face-cards"));
  const k = scale(sheets.length);
  const cap = shotCaps(sheets.length).faceValue;
  const used = new Map<string, number>();
  const dealt: FaceCard[] = [];
  const out = new Map<string, FaceCard>();
  const key = (a: Axis, v: string): string => `${a}|${v}`;
  const distance = (a: FaceCard, b: FaceCard): number => AXIS_ORDER.filter((x) => a[x] !== b[x]).length;
  for (const s of shuffled(rnd, byId(sheets))) {
    const pins = pinsOf(s.facialFeatures);
    const bc = buildClassOf(s.heightBuild);
    const draw = (): FaceCard => {
      const face = {} as FaceCard;
      for (const axis of AXIS_ORDER) {
        const pinned = pins[axis];
        if (pinned !== undefined) { face[axis] = pinned; continue; }
        let vals = valuesOf(axis);
        // ORW-480: a feature that leans one way (a thick neck, heavy brows, a wide jaw; thin arched brows) is not dealt to the other binary gender
        if (s.genderPresentation === "man" || s.genderPresentation === "woman") { const g = s.genderPresentation; const fit = vals.filter((x) => x.lean === undefined || x.lean === g); if (fit.length > 0) vals = fit; }
        if (axis === "shape" && pins.jaw !== undefined) { const ok = SHAPES.filter((x) => x.jaws?.includes(pins.jaw!)); if (ok.length > 0) vals = ok; }
        if (axis === "jaw") {
          const shape = SHAPES.find((x) => x.v === face.shape);
          if (shape?.jaws) vals = vals.filter((x) => shape.jaws!.includes(x.v));
        }
        if (axis === "neck" && bc !== undefined) vals = vals.filter((x) => x.build === bc || x.build === "mid");
        let pool = vals.map((x) => x.v).filter((v) => count(used, key(axis, v)) < (axis === "quirk" ? 1 * k : cap));
        if (axis === "quirk" && s.age < 40) pool = pool.filter((v) => !OLD_QUIRK_RE.test(v));
        if (axis === "quirk") { const fit = pool.filter((v) => quirkFits(v, face)); if (fit.length > 0) pool = fit; }
        if (pool.length === 0) pool = vals.map((x) => x.v);
        face[axis] = pickFrom(rnd, pool);
      }
      // a pinned jaw that disagrees with a dealt shape: re-pick the shape to one that takes it
      return face;
    };
    let best: FaceCard | undefined;
    for (let want = FACE_MIN_DISTANCE; want >= 1 && best === undefined; want--) {
      for (let t = 0; t < 200; t++) {
        const f = draw();
        // a draw whose jaw (held to the face shape) would pass the value cap is thrown away while there is room to try again
        const capsOk = AXIS_ORDER.every((a) => a === "quirk" || pins[a] !== undefined || count(used, key(a, f[a])) < cap);
        if (dealt.every((d) => distance(d, f) >= want) && (capsOk || want < 2)) { best = f; break; }
      }
    }
    const face = best ?? draw();
    for (const axis of AXIS_ORDER) bump(used, key(axis, face[axis]));
    dealt.push(face);
    out.set(s.id, face);
  }
  return out;
}

/** The face line of the prompt: the two plain facts that carry the likeness first (face shape and jaw, then brow weight and neck and shoulders), then the finer features. */
export function faceSentence(f: FaceCard, mark?: string): string {
  return `Face: ${f.shape} and ${f.jaw}, ${f.brows}, ${f.neck}; also ${f.nose}, ${f.eyes}, ${f.mouth}, and ${f.quirk}${mark ? `, with ${mark}` : ""}.`;
}

/** Shot card and face card for every sheet. */
export function dealPortraitPlans(sheets: readonly ShotSheet[]): Map<string, PortraitPlan> {
  const shots = dealShotCards(sheets), faces = dealFaceCards(sheets);
  const out = new Map<string, PortraitPlan>();
  for (const s of sheets) out.set(s.id, { shot: shots.get(s.id)!, face: faces.get(s.id)! });
  return out;
}
