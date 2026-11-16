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

interface CapSpec { share: number; min: number }
/** The cap of a kind in a cast of `n`, read from the shared casting-director table (castRealism.json): floor(share * n), never below min. */
export function capOf(kind: string, n: number): number {
  const cap = (table.kinds as Record<string, { cap: CapSpec }>)[kind]!.cap;
  return Math.max(cap.min, Math.floor(cap.share * n + 1e-9));
}
/** The caps for a cast of `n` (15: place 3, framing 5, light 4, prop 2, eyes on the lens 9, face value 3). */
export const shotCaps = (n: number) => ({
  place: capOf("place", n), framing: capOf("framing", n), light: capOf("light", n), prop: capOf("prop", n),
  lensGaze: capOf("gaze", n), faceValue: capOf("face-value", n),
});

export type Gaze = "lens" | "off" | "aside" | "down";
export type Bucket = "expressive" | "watchful" | "easy" | "driven";

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
  /** The moment: what the person is doing and how they hold themselves (no subject; a participial phrase). */
  moment: string;
  gaze: Gaze;
  /** A held prop (something a person holds at home), only when the sheet gives a reason (vocation / identity), at most 2 per cast. */
  prop?: string;
  bucket: Bucket;
  /** Which of the person's own sheet lines the moment was derived from, for the report: "type the jock (athletic ease, ...); demeanor ...". */
  why: string;
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

interface Place {
  id: string; outdoor: boolean; phrase: string;
  /** Things a moment can use: what to perch on, lean on, sit on, and whether there is room to walk. */
  perch?: string; lean?: string; seat?: string; walk?: boolean;
}

/** Where a cast photographer would shoot someone (no laundry room, no driveway). */
export const PLACES: readonly Place[] = [
  { id: "kitchen", outdoor: false, phrase: "the house kitchen, counters, fridge and cupboards in plain view behind", perch: "the kitchen counter", lean: "the kitchen island", seat: "a kitchen stool" },
  { id: "living-room", outdoor: false, phrase: "the living room, sofas, shelves and a TV in plain view behind", perch: "the arm of the sofa", lean: "the bookshelf", seat: "the sofa" },
  { id: "dining-room", outdoor: false, phrase: "the dining room, a long table and chairs and a sideboard behind", lean: "the sideboard", seat: "a dining chair" },
  { id: "lounge", outdoor: false, phrase: "the lounge, armchairs, a low table and lamps in plain view behind", perch: "the arm of an armchair", lean: "the mantel", seat: "an armchair" },
  { id: "bedroom", outdoor: false, phrase: "a shared bedroom, bunk beds and open suitcases behind", perch: "a dresser", seat: "the edge of a bed", lean: "the bunk ladder" },
  { id: "stair-landing", outdoor: false, phrase: "the stairs landing, a wooden banister, a window and framed photos behind", perch: "the banister", seat: "a step on the landing", lean: "the landing wall" },
  { id: "gym", outdoor: false, phrase: "the house gym corner, a bench, weights and a mirrored wall behind", seat: "the weight bench", lean: "the squat rack" },
  { id: "backyard", outdoor: true, phrase: "the backyard, lawn, a wooden fence and trees behind", seat: "a lawn chair", lean: "the fence", walk: true },
  { id: "pool", outdoor: true, phrase: "the pool deck, loungers and the water behind", perch: "the edge of the pool", seat: "a pool lounger", walk: true },
  { id: "patio", outdoor: true, phrase: "the back patio, string lights, a grill and patio chairs behind", seat: "a patio chair", lean: "the patio railing", walk: true },
  { id: "front-steps", outdoor: true, phrase: "the front steps of the house, the front door and porch behind", seat: "the steps", lean: "the porch post" },
  { id: "garden", outdoor: true, phrase: "the side garden, raised beds and a wooden gate behind", seat: "a garden bench", lean: "the gate", walk: true },
];

// ---------------------------------------------------------------------------------------------------- light, framing, angle

interface Light { id: string; phrase: string; where: "in" | "out" | "any" }
export const LIGHTS: readonly Light[] = [
  { id: "window", phrase: "soft side light from a big window, mid-morning", where: "in" },
  { id: "overcast", phrase: "flat overcast daylight, grey and even", where: "any" },
  { id: "golden", phrase: "low golden-hour sun, warm and directional, late afternoon", where: "any" },
  { id: "shade", phrase: "open shade at midday, bright but cool and even", where: "out" },
  { id: "lamps", phrase: "practical lamps at night, warm pools of light and dark corners, no fill", where: "in" },
  { id: "flash", phrase: "direct on-camera flash at dusk, hard-edged, the background falling into shadow", where: "any" },
  { id: "midday", phrase: "hard midday sun, real shadows under the brow and a slight squint", where: "out" },
];

/** Cast photos are an avatar on the roster and a large image on the card: the face is always large. No full-body shot, no wide seated shot. */
interface Framing { id: string; phrase: string; lens: string; cap?: number }
export const FRAMINGS: readonly Framing[] = [
  { id: "close", phrase: "a close-up, head and shoulders, the face filling about half the frame", lens: "a 50mm lens" },
  { id: "half", phrase: "a half-length shot from the waist up, the face large in the frame", lens: "a 35mm lens" },
  // a few only (per-cast cap 3 on top of the table's framing cap)
  { id: "three-quarter", phrase: "a three-quarter-length shot to mid-thigh, the face still large and clear in the upper third of the frame", lens: "a 35mm lens", cap: 3 },
];

export const ANGLES: readonly string[] = [
  "at eye level",
  "from slightly below eye level",
  "from slightly above eye level",
  "from a three-quarter angle off to one side",
  "from a slightly tilted, caught-in-passing angle",
];

// ---------------------------------------------------------------------------------------------------- moments

type Needs = "any" | "perch" | "lean" | "seat" | "walk";
/**
 * One pose a cast unit photographer gets. `for` lists the casting labels it fits (the casting read is the first source),
 * `words` are matched against the casting read (3 points), the demeanor (2) and the voice energy (1): so the moment can be
 * traced to the person's own lines. `body`: needs the body in frame (not for a close-up). `hands`: uses both hands (no held prop).
 */
interface Moment { id: string; bucket: Bucket; needs: Needs; gaze: Gaze; text: string; for: readonly string[]; words: RegExp; body?: boolean; hands?: boolean }

export const MOMENTS: readonly Moment[] = [
  { id: "laugh-back", bucket: "expressive", needs: "any", gaze: "off", for: ["the class clown", "the life of the party", "the wildcard", "the charmer"], words: /\b(?:laugh\w*|grin|goofy|mischief|loud|big laugh)\b/i,
    text: "caught mid-laugh, head tipped back, eyes crinkled, looking off to one side at the joke" },
  { id: "arms-wide", bucket: "expressive", needs: "any", gaze: "lens", body: true, hands: true, for: ["the life of the party", "the showstopper", "the firecracker"], words: /\b(?:animated|hands|lit up|loud|warm|bubbly)\b/i,
    text: "arms thrown wide mid-story, mouth open in the middle of a word, eyebrows high, talking straight into the lens" },
  { id: "perched-grin", bucket: "expressive", needs: "perch", gaze: "lens", body: true, for: ["the class clown", "the jock", "the wildcard", "the charmer"], words: /\b(?:grin|mischief|easy|loose)\b/i,
    text: "perched on {perch}, leaning toward the camera with a big lopsided grin, looking into the lens" },
  { id: "over-shoulder", bucket: "expressive", needs: "any", gaze: "lens", for: ["the flirt", "the charmer", "the showstopper", "the rebel"], words: /\b(?:flirt\w*|playful|eye contact|confident|assured|cool)\b/i,
    text: "looking back over {poss} shoulder at the camera with a bold half-smile" },
  { id: "lean-chin-up", bucket: "driven", needs: "lean", gaze: "lens", body: true, for: ["the rebel", "the straight shooter", "the firecracker", "the competitor"], words: /\b(?:cool|stare|unbothered|level|argue|chin up|steady)\b/i,
    text: "leaning back against {lean}, arms loose, chin up, a challenging half-smile into the lens" },
  { id: "chin-up", bucket: "driven", needs: "any", gaze: "lens", for: ["the competitor", "the firecracker", "the jock", "the underdog"], words: /\b(?:chin up|set jaw|focused|ready|competitive|quick)\b/i,
    text: "chin up, shoulders squared, a direct, challenging look into the lens, jaw set" },
  { id: "comp-grin", bucket: "driven", needs: "any", gaze: "lens", for: ["the jock", "the competitor", "the wildcard"], words: /\b(?:competitive|grin|athletic|loose shoulders|lopsided|spark)\b/i,
    text: "a competitive lopsided grin, one shoulder dropped, shoulders loose, looking into the lens" },
  { id: "stride-grin", bucket: "driven", needs: "walk", gaze: "lens", body: true, for: ["the jock", "the wildcard", "the hustler"], words: /\b(?:athletic|restless|motion|forward|spark|energy)\b/i,
    text: "mid-stride toward the camera with a lopsided grin, shoulders loose, clothes moving, eyes on the lens" },
  { id: "hands-point", bucket: "expressive", needs: "any", gaze: "lens", body: true, hands: true, for: ["the hustler", "the life of the party", "the charmer", "the brain"], words: /\b(?:sharp|salesman|forward|animated|hands|talk\w*)\b/i,
    text: "hands mid-gesture as if making a point, an animated face, eyes on the lens" },
  { id: "think-aside", bucket: "watchful", needs: "any", gaze: "off", for: ["the brain", "the dreamer", "the mastermind in plain sight"], words: /\b(?:observant|thoughtful|composed|knowing|unreadable|dreamy)\b/i,
    text: "head tilted, looking just off-camera with a thoughtful half-smile" },
  { id: "listening", bucket: "watchful", needs: "any", gaze: "off", for: ["the brain", "the wise head", "the quiet storm", "the underdog"], words: /\b(?:calm|patient|watchful|listen\w*|quiet)\b/i,
    text: "listening to someone out of frame, head slightly tilted, a small amused look just starting" },
  { id: "still-direct", bucket: "watchful", needs: "any", gaze: "lens", for: ["the quiet storm", "the mastermind in plain sight", "the straight shooter", "the wise head"], words: /\b(?:still|private|level|unreadable|steady|composed)\b/i,
    text: "still and level, a calm, direct look into the lens, a faint private smile" },
  { id: "soft-smile", bucket: "easy", needs: "any", gaze: "lens", for: ["the sweetheart", "the natural", "the gentle giant", "the parent of the house"], words: /\b(?:warm|soft|open|kind|easy|unforced)\b/i,
    text: "a warm, unforced smile, head tilted a little, eyes on the lens, shoulders relaxed" },
  { id: "arms-crossed", bucket: "easy", needs: "any", gaze: "lens", body: true, hands: true, for: ["the parent of the house", "the wise head", "the gentle giant", "the distinguished one"], words: /\b(?:steady|kind|patient|solid|arms|crossed)\b/i,
    text: "arms loosely crossed, kind and steady eyes, a patient smile into the lens" },
  { id: "sofa-lounge", bucket: "easy", needs: "seat", gaze: "lens", body: true, for: ["the distinguished one", "the natural", "the charmer", "the free spirit"], words: /\b(?:amused|at ease|relaxed|easy|effortless\w*)\b/i,
    text: "relaxed back on {seat}, one arm along the back, an amused look into the lens" },
  { id: "drift", bucket: "easy", needs: "any", gaze: "off", for: ["the dreamer", "the free spirit", "the underdog"], words: /\b(?:dreamy|drifting|gaze|sunny|loose|hopeful)\b/i,
    text: "gaze drifting past the lens toward a window, a soft half-smile, shoulders dropped" },
  { id: "hair-back", bucket: "easy", needs: "any", gaze: "lens", for: ["the underdog", "the sweetheart", "the flirt"], words: /\b(?:shy|earnest|hopeful|soft|playful)\b/i,
    text: "one hand running back through the hair, a shy half-smile, eyes on the lens" },
  { id: "face-up", bucket: "easy", needs: "any", gaze: "off", for: ["the free spirit", "the dreamer", "the natural"], words: /\b(?:sunny|dreamy|loose|easy)\b/i,
    text: "face tipped up toward the light, eyes half closed, a relaxed open smile" },
  { id: "clap", bucket: "driven", needs: "any", gaze: "lens", body: true, hands: true, for: ["the competitor", "the jock", "the firecracker"], words: /\b(?:ready|focused|competitive|quick|bright-eyed)\b/i,
    text: "mid-clap and grinning, caught in the middle of a pep talk, looking into the lens" },
  { id: "head-tilt", bucket: "expressive", needs: "any", gaze: "lens", for: ["the flirt", "the charmer"], words: /\b(?:playful|eye contact|head tilt|flirt\w*|easy smile)\b/i,
    text: "head tilted, playful eye contact, one eyebrow raised, a teasing half-smile" },
  { id: "hip", bucket: "expressive", needs: "any", gaze: "lens", body: true, hands: true, for: ["the showstopper", "the hustler", "the charmer"], words: /\b(?:polished|posed|owns|sharp|salesman)\b/i,
    text: "weight on one hip, one hand on the hip, poised, chin lifted, owning the frame" },
  { id: "elbows-knees", bucket: "driven", needs: "seat", gaze: "lens", body: true, hands: true, for: ["the underdog", "the competitor", "the straight shooter"], words: /\b(?:earnest|hopeful|focused|level)\b/i,
    text: "leaning forward on {seat}, elbows on knees, hands clasped, an earnest look into the lens" },
  { id: "laugh-down", bucket: "expressive", needs: "any", gaze: "down", for: ["the class clown", "the life of the party", "the sweetheart"], words: /\b(?:laugh\w*|grin|giggl\w*|warm)\b/i,
    text: "caught mid-laugh, looking down, shoulders shaking, eyes crinkled shut" },
  { id: "squint-grin", bucket: "expressive", needs: "any", gaze: "lens", for: ["the wildcard", "the free spirit", "the class clown"], words: /\b(?:lopsided|spark|restless|sunny|mischief)\b/i,
    text: "squinting a little with a crooked grin, caught mid-laugh, looking into the lens" },
  { id: "eyebrow", bucket: "watchful", needs: "any", gaze: "lens", for: ["the straight shooter", "the brain", "the rebel"], words: /\b(?:dry|wry|knowing|brow|deadpan)\b/i,
    text: "one eyebrow raised, a dry, wry half-smile, looking into the lens" },
  { id: "look-away-cool", bucket: "watchful", needs: "any", gaze: "off", for: ["the rebel", "the competitor", "the jock", "the straight shooter", "the charmer"], words: /\b(?:cool|stare|unbothered|assured|confident|loose)\b/i,
    text: "looking away from the camera, chin lifted, a cool, unbothered half-smile" },
  { id: "laugh-friend", bucket: "easy", needs: "any", gaze: "off", for: ["the charmer", "the natural", "the flirt", "the free spirit", "the sweetheart"], words: /\b(?:easy|relaxed|assured|at home|plays|unforced)\b/i,
    text: "turned a little toward a friend out of frame, laughing easily, relaxed and at home" },
  { id: "focus-off", bucket: "driven", needs: "any", gaze: "off", for: ["the competitor", "the jock", "the firecracker", "the underdog", "the hustler"], words: /\b(?:focused|ready|set jaw|coiled|spring|stance|eyes)\b/i,
    text: "eyes locked on something off to the side, jaw set, a faint confident smile, ready" },
  { id: "neck-roll", bucket: "driven", needs: "any", gaze: "aside", for: ["the competitor", "the jock", "the wildcard"], words: /\b(?:athletic|loose|coiled|ready|restless)\b/i,
    text: "rolling a shoulder and loosening the neck, eyes narrowed with a half-grin on someone off-camera" },
  // only for a sheet that reads sly
  { id: "sly-glance", bucket: "watchful", needs: "any", gaze: "aside", for: ["the mastermind in plain sight"], words: /\b(?:sly|scheming|calculat\w*|gives nothing away)\b/i,
    text: "a knowing sideways glance with a closed-mouth smile" },
];

const BUCKET_WORDS: Record<Bucket, RegExp> = {
  expressive: /\b(?:charmer|firecracker|class clown|life of the party|flirt|wildcard|showstopper|loud|bubbly|bright|chatty|animated|manic|goofy|big laugh|playful|mischief|grin|warm|lit up|talkative|exuberant)\b/gi,
  watchful: /\b(?:brain|quiet storm|rebel|mastermind|straight shooter|guarded|wary|watchful|cold|dry|reserved|unreadable|flat|clipped|deadpan|stare|composed|observant|private|still|measured|surgical)\b/gi,
  easy: /\b(?:sweetheart|free spirit|dreamer|natural|gentle giant|parent of the house|wise head|distinguished one|easy|soft|relaxed|sunny|gentle|patient|steady|kind|dreamy|calm|easygoing|laid-back|loose)\b/gi,
  driven: /\b(?:jock|competitor|hustler|underdog|sharp|focused|athletic|intense|blunt|forward|ready|driven|ambitious|scrappy|fierce|competitive|set jaw|earnest)\b/gi,
};
const BUCKETS: readonly Bucket[] = ["expressive", "watchful", "easy", "driven"];

/** The sheet's own read of how this person carries themselves: casting read and label, demeanor, voice energy, vocation. */
export function bucketOf(s: ShotSheet, rnd: () => number): Bucket {
  const text = [s.castingLabel, s.castingRead, s.demeanor, s.energy, s.vocation].filter(Boolean).join(" ; ");
  const score = (b: Bucket): number => (text.match(BUCKET_WORDS[b]) ?? []).length;
  const best = Math.max(...BUCKETS.map(score));
  const top = BUCKETS.filter((b) => score(b) === best);
  return best === 0 ? pickFrom(rnd, BUCKETS) : top.length === 1 ? top[0]! : pickFrom(rnd, top);
}

/** How well a moment fits a person, and which of their own lines say so: the casting label (6), words in the casting read (3 each), the demeanor (2 each), the voice energy (1 each). */
export function momentFit(m: Moment, s: ShotSheet): { score: number; why: string[] } {
  const why: string[] = [];
  let score = 0;
  if (s.castingLabel !== undefined && m.for.includes(s.castingLabel.toLowerCase())) { score += 6; why.push(`type "${s.castingLabel}"`); }
  const hits = (t: string | undefined): string[] => (t ? (t.match(new RegExp(m.words.source, "gi")) ?? []) : []);
  const r = hits(s.castingRead); if (r.length > 0) { score += 3 * r.length; why.push(`read "${s.castingRead}" (${[...new Set(r.map((x) => x.toLowerCase()))].join(", ")})`); }
  const d = hits(s.demeanor); if (d.length > 0) { score += 2 * d.length; why.push(`demeanor (${[...new Set(d.map((x) => x.toLowerCase()))].join(", ")})`); }
  const e = hits(s.energy); if (e.length > 0) { score += e.length; why.push(`voice (${[...new Set(e.map((x) => x.toLowerCase()))].join(", ")})`); }
  return { score, why };
}

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

const KITCHEN_VOCATION_RE = /\b(?:cook|chef|baker|pastry|butcher|restaurant|barista|waiter|server|caterer)\b/i;
const poss = (g: ShotSheet["genderPresentation"]): string => (g === "man" ? "his" : g === "woman" ? "her" : "their");

/** Deal one shot card per sheet. Caps (cast of 15): no place on more than 3, no framing on more than 6 (three-quarter on 3), no light on more than 4, a prop on at most 2, eyes on the lens on at most 9; the moment is a consistent set with the place and the framing. */
export function dealShotCards(sheets: readonly ShotSheet[]): Map<string, ShotCard> {
  const rnd = stream(castSeed(sheets, "shot-cards"));
  const caps = shotCaps(sheets.length);
  const k = scale(sheets.length);
  const placeUsed = new Map<string, number>(), framingUsed = new Map<string, number>(), lightUsed = new Map<string, number>();
  const order = shuffled(rnd, byId(sheets));
  const buckets = new Map(order.map((s) => [s.id, bucketOf(s, rnd)] as const));
  // About a third of the cast is photographed outdoors (backyard, pool, patio, front steps, garden).
  const outdoorN = Math.max(Math.min(sheets.length, 4), Math.round(sheets.length / 3));
  const outdoorIds = new Set(order.slice(0, outdoorN).map((s) => s.id));
  const base = new Map<string, { place: Place; light: Light; framing: Framing; angle: string; prop?: string }>();
  let props = 0;
  for (const s of order) {
    const wantOut = outdoorIds.has(s.id);
    let places = PLACES.filter((p) => p.outdoor === wantOut);
    if (!wantOut && KITCHEN_VOCATION_RE.test(s.vocation ?? "") && count(placeUsed, "kitchen") < 2) places = PLACES.filter((p) => p.id === "kitchen");
    const place = pickCapped(rnd, places, placeUsed, (p) => p.id, caps.place);
    bump(placeUsed, place.id);
    const lights = LIGHTS.filter((l) => l.where === "any" || l.where === (place.outdoor ? "out" : "in"));
    const light = pickCapped(rnd, lights, lightUsed, (l) => l.id, caps.light);
    bump(lightUsed, light.id);
    const framing = pickCapped(rnd, FRAMINGS, framingUsed, (f) => f.id, (f) => Math.min(caps.framing, (f.cap ?? caps.framing) * k));
    bump(framingUsed, framing.id);
    const angle = pickFrom(rnd, ANGLES);
    const prop = props < caps.prop ? propFor(s) : undefined;
    if (prop !== undefined) props++;
    base.set(s.id, { place, light, framing, angle, ...(prop !== undefined ? { prop } : {}) });
  }
  // Moments: every (person, moment) pair that is consistent with that person's place, framing and prop is scored from their own
  // sheet lines; the best pairs are taken first, so nobody is left with a pose their sheet does not support, and no moment repeats.
  const sheetById = new Map(sheets.map((s) => [s.id, s] as const));
  const pairs: { id: string; m: Moment; score: number; why: string[]; tie: number }[] = [];
  for (const s of order) {
    const b = base.get(s.id)!;
    for (const m of MOMENTS) {
      if (m.needs !== "any" && !(m.needs === "walk" ? b.place.walk === true : b.place[m.needs] !== undefined)) continue;
      if (b.framing.id === "close" && m.body === true) continue;               // a close-up cannot show the body
      if (b.prop !== undefined && m.hands === true) continue;                  // both hands busy: nothing held
      const fit = momentFit(m, s);
      pairs.push({ id: s.id, m, score: fit.score, why: fit.why, tie: rnd() });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.tie - b.tie);
  const chosen = new Map<string, typeof pairs[number]>();
  const momentUsed = new Set<string>();
  let lensGaze = 0;
  for (const pr of pairs) {
    if (chosen.has(pr.id) || momentUsed.has(pr.m.id)) continue;
    if (pr.m.gaze === "lens" && lensGaze >= caps.lensGaze) continue;
    chosen.set(pr.id, pr); momentUsed.add(pr.m.id); if (pr.m.gaze === "lens") lensGaze++;
  }
  // A person still without a moment (a pool this small cannot happen in a cast of 15): the best repeat that is consistent.
  for (const s of order) {
    if (chosen.has(s.id)) continue;
    const cand = pairs.find((x) => x.id === s.id);
    if (cand !== undefined) chosen.set(s.id, cand);
  }
  const out = new Map<string, ShotCard>();
  for (const s of order) {
    const b = base.get(s.id)!, pr = chosen.get(s.id)!, sheet = sheetById.get(s.id)!;
    const text = pr.m.text.replace(/\{perch\}/g, b.place.perch ?? "").replace(/\{lean\}/g, b.place.lean ?? "")
      .replace(/\{seat\}/g, b.place.seat ?? "").replace(/\{poss\}/g, poss(sheet.genderPresentation));
    out.set(s.id, {
      placeId: b.place.id, place: b.place.phrase, outdoor: b.place.outdoor,
      framingId: b.framing.id, framing: b.framing.phrase, angle: b.angle, lens: b.framing.lens,
      lightId: b.light.id, light: b.light.phrase,
      momentId: pr.m.id, moment: text, gaze: pr.m.gaze,
      ...(b.prop !== undefined ? { prop: b.prop } : {}), bucket: buckets.get(s.id)!,
      why: pr.why.length > 0 ? pr.why.join("; ") : "no line of the sheet matched: dealt",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- the face deal

type Axis = keyof FaceCard;
type BuildClass = "slender" | "mid" | "thick";
interface FaceValue { v: string; pin?: RegExp; build?: BuildClass; jaws?: readonly string[] }

/** Jaw and chin values, so a shape can name the ones that go with it (a round face never gets "a long, prominent chin"). */
const J = {
  square: "a square jaw", soft: "a soft, rounded jaw", pointed: "a pointed chin", cleft: "a cleft chin", small: "a small chin",
  wide: "a wide, heavy jaw", narrow: "a narrow, tapered jaw", long: "a long, prominent chin",
} as const;

const SHAPES: readonly FaceValue[] = [
  { v: "a round, full-cheeked face", pin: /\bround\b/i, jaws: [J.soft, J.small, J.cleft] },
  { v: "an oval face", pin: /\boval\b/i, jaws: [J.soft, J.square, J.pointed, J.cleft, J.narrow, J.small] },
  { v: "a long, narrow face", pin: /\b(?:narrow|long|elongated)\b/i, jaws: [J.long, J.narrow, J.square, J.pointed] },
  { v: "a broad, squarish face", pin: /\b(?:broad face|wide face|squarish)\b/i, jaws: [J.square, J.wide] },
  { v: "a heart-shaped face", pin: /\bheart\b/i, jaws: [J.pointed, J.narrow, J.small] },
  { v: "a diamond-shaped face with high cheekbones", pin: /\bcheekbones?\b/i, jaws: [J.pointed, J.narrow, J.square] },
  { v: "a soft, rounded-square face", jaws: [J.square, J.soft, J.wide] },
];
const AXES: Record<Exclude<Axis, "shape" | "jaw">, readonly FaceValue[]> & { jaw: readonly FaceValue[] } = {
  jaw: [
    { v: J.square, pin: /\b(?:square|strong|angular) jaw\b|\bangular\b/i }, { v: J.soft, pin: /\bsoft jaw\b/i },
    { v: J.pointed, pin: /\bpointed chin\b/i }, { v: J.cleft, pin: /\bcleft\b/i }, { v: J.small, pin: /\bsmall chin\b/i },
    { v: J.wide }, { v: J.narrow }, { v: J.long },
  ],
  neck: [
    { v: "a long, slender neck and narrow shoulders", pin: /\bslender neck\b/i, build: "slender" },
    { v: "a slim neck and sloping shoulders", build: "slender" },
    { v: "an average neck and even shoulders", build: "mid" },
    { v: "a strong neck and square shoulders", build: "mid" },
    { v: "a thick neck and broad, heavy shoulders", pin: /\bthick neck\b/i, build: "thick" },
    { v: "a short, thick neck and a deep chest", build: "thick" },
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
    { v: "thick, straight brows", pin: /\b(?:thick|straight|bushy) brows?\b/i }, { v: "thin, high-arched brows", pin: /\b(?:thin|arched) brows?\b/i },
    { v: "heavy dark brows", pin: /\bheavy[^,.]*\bbrows?\b|\bbrows? that\b/i }, { v: "light, sparse brows", pin: /\bsparse\b/i },
    { v: "low, flat brows", pin: /\blow brows?\b/i }, { v: "brows that rise at the outer ends" },
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
    { v: "cheeks that flush easily" }, { v: "a strong, visible jaw muscle when relaxed" }, { v: "a wide gap between brow and eyelid" },
    { v: "deep smile lines around the mouth" }, { v: "a prominent philtrum" }, { v: "small, tight ears set close to the head" },
    { v: "a slightly deviated septum that tilts the nose" }, { v: "a heavy brow ridge" }, { v: "full, round cheeks that lift when the mouth moves" },
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
  [/gap between brow and eyelid/, /hooded|deep-set|heavy lids/], [/high forehead|widow's peak/, /low, flat brows/],
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
  if (/\b(?:slight|slender|petite|lean|lanky|wiry|willowy|thin|light-boned|narrow)\b/i.test(build)) return "slender";
  if (/\b(?:muscular|solid|solidly|sturdy|athletic|powerful|stocky|heavy|burly|barrel|thick|broad-shouldered|brawny|strong frame)\b/i.test(build)) return "thick";
  return undefined;
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
export function faceSentence(f: FaceCard): string {
  return `Face: ${f.shape} and ${f.jaw}, ${f.brows}, ${f.neck}; also ${f.nose}, ${f.eyes}, ${f.mouth}, and ${f.quirk}.`;
}

/** Shot card and face card for every sheet. */
export function dealPortraitPlans(sheets: readonly ShotSheet[]): Map<string, PortraitPlan> {
  const shots = dealShotCards(sheets), faces = dealFaceCards(sheets);
  const out = new Map<string, PortraitPlan>();
  for (const s of sheets) out.set(s.id, { shot: shots.get(s.id)!, face: faces.get(s.id)! });
  return out;
}
