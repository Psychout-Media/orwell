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
  /** A held prop, only when the sheet gives a reason (vocation / identity), at most 2 per cast. */
  prop?: string;
  bucket: Bucket;
}

export interface FaceCard {
  shape: string;
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

export const PLACES: readonly Place[] = [
  { id: "kitchen", outdoor: false, phrase: "the house kitchen, counters, fridge and cupboards in plain view", perch: "the kitchen counter", lean: "the kitchen island", seat: "a kitchen stool" },
  { id: "living-room", outdoor: false, phrase: "the living room, sofas, shelves and the TV in plain view", perch: "the back of the sofa", lean: "the bookshelf", seat: "the sofa" },
  { id: "dining-room", outdoor: false, phrase: "the dining room, a long table and chairs, a sideboard behind", lean: "the sideboard", seat: "a dining chair" },
  { id: "hallway", outdoor: false, phrase: "the upstairs hallway, doors and framed photos down the wall", lean: "the hallway wall", walk: true },
  { id: "staircase", outdoor: false, phrase: "the staircase, wooden steps and a banister", perch: "the banister", seat: "a stair", walk: true },
  { id: "bedroom", outdoor: false, phrase: "a shared bedroom, bunk beds and open suitcases", perch: "a dresser", seat: "the edge of a bed", lean: "the bunk ladder" },
  { id: "gym", outdoor: false, phrase: "the corner gym, a bench, weights and a mirrored wall", seat: "the weight bench", lean: "the squat rack" },
  { id: "laundry", outdoor: false, phrase: "the laundry room, a washer and dryer and a shelf of detergent behind", perch: "the washing machine", lean: "the dryer" },
  { id: "backyard", outdoor: true, phrase: "the backyard, lawn, a wooden fence and trees behind", seat: "a lawn chair", lean: "the fence", walk: true },
  { id: "pool", outdoor: true, phrase: "the pool deck, loungers, wet tile and the water behind", perch: "the edge of the pool", seat: "a pool lounger", walk: true },
  { id: "patio", outdoor: true, phrase: "the back patio, string lights, a grill and patio chairs", seat: "a patio chair", lean: "the patio railing" },
  { id: "front-steps", outdoor: true, phrase: "the front steps of the house, the front door and porch behind", seat: "the steps", lean: "the porch post" },
  { id: "driveway", outdoor: true, phrase: "the driveway, parked cars and the garage door behind", perch: "the hood of a parked car", lean: "the garage door", walk: true },
  { id: "garden", outdoor: true, phrase: "the side garden, raised beds, a watering can and a wooden gate", seat: "a garden bench", lean: "the gate" },
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

interface Framing { id: string; phrase: string; lens: string; needsSeat?: boolean }
export const FRAMINGS: readonly Framing[] = [
  { id: "close", phrase: "a close-up, head and shoulders", lens: "a 50mm lens" },
  { id: "half", phrase: "half-length, framed at the waist", lens: "a 35mm lens" },
  { id: "three-quarter", phrase: "three-quarter length, framed at the thigh", lens: "a 35mm lens" },
  { id: "seated", phrase: "a seated wide shot, the whole person and the room around them", lens: "a 28mm lens", needsSeat: true },
  { id: "full", phrase: "full length, the person smaller in the frame with the place around them", lens: "a 28mm lens" },
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
interface Moment { id: string; bucket: Bucket; needs: Needs; gaze: Gaze; text: string }

/** What the person is doing and how they hold themselves. {perch} {lean} {seat} name the place's own thing; {poss} is his / her / their. */
export const MOMENTS: readonly Moment[] = [
  { id: "e-laugh", bucket: "expressive", needs: "any", gaze: "off", text: "caught mid-laugh at something off-camera, head tipped back, eyes crinkled shut, one hand mid-gesture" },
  { id: "e-wide", bucket: "expressive", needs: "any", gaze: "lens", text: "arms thrown wide mid-story, mouth open in the middle of a word, eyebrows high, talking into the lens" },
  { id: "e-perch", bucket: "expressive", needs: "perch", gaze: "lens", text: "perched on {perch}, swinging a foot, leaning toward the camera with a big lopsided grin, looking into the lens" },
  { id: "e-stride", bucket: "expressive", needs: "walk", gaze: "off", text: "mid-stride and laughing, {poss} clothes and hair moving, looking back over {poss} shoulder at someone out of frame" },
  { id: "e-whisper", bucket: "expressive", needs: "any", gaze: "aside", text: "leaning in to whisper behind one hand to someone just outside the frame, eyes sliding sideways, trying not to laugh" },
  { id: "e-slouch", bucket: "expressive", needs: "lean", gaze: "lens", text: "slouched against {lean}, one eyebrow cocked, a teasing half-grin, mid-sentence, looking into the lens" },
  { id: "e-double", bucket: "expressive", needs: "any", gaze: "down", text: "doubled over a little with laughter, one hand pressed to {poss} chest, eyes down" },
  { id: "w-flat", bucket: "watchful", needs: "any", gaze: "aside", text: "chin down, eyes up and watchful, a long flat look at the photographer" },
  { id: "w-off", bucket: "watchful", needs: "any", gaze: "off", text: "looking off-camera at something across the room, jaw set, lips pressed together" },
  { id: "w-lean", bucket: "watchful", needs: "lean", gaze: "lens", text: "one shoulder against {lean}, arms folded, head tilted slightly, weighing the photographer up, looking into the lens" },
  { id: "w-turn", bucket: "watchful", needs: "any", gaze: "aside", text: "half turned away, glancing back over {poss} shoulder, face unreadable" },
  { id: "w-forward", bucket: "watchful", needs: "seat", gaze: "off", text: "sitting forward on {seat}, elbows on knees, hands clasped, eyes on something off to one side, thinking" },
  { id: "w-still", bucket: "watchful", needs: "any", gaze: "lens", text: "straight-faced and still, no smile, looking directly into the lens, hands loose at {poss} sides" },
  { id: "w-neck", bucket: "watchful", needs: "any", gaze: "down", text: "eyes lowered, one hand rubbing the back of {poss} neck, caught in thought" },
  { id: "y-drift", bucket: "easy", needs: "any", gaze: "off", text: "gaze drifting past the lens toward a window, a soft absent half-smile, shoulders dropped" },
  { id: "y-slump", bucket: "easy", needs: "seat", gaze: "lens", text: "slumped comfortably on {seat}, legs stretched out, a relaxed lopsided smile, looking into the lens" },
  { id: "y-listen", bucket: "easy", needs: "any", gaze: "off", text: "listening to someone out of frame, head slightly tilted, a small amused look just starting" },
  { id: "y-ankles", bucket: "easy", needs: "lean", gaze: "aside", text: "leaning on {lean}, ankles crossed, squinting a little, easy and unhurried" },
  { id: "y-stroll", bucket: "easy", needs: "walk", gaze: "down", text: "strolling with hands in pockets, looking at the ground, a private smile" },
  { id: "y-blink", bucket: "easy", needs: "any", gaze: "lens", text: "caught between expressions mid-blink, a natural relaxed face that is not smiling for the camera, looking into the lens" },
  { id: "y-up", bucket: "easy", needs: "perch", gaze: "off", text: "perched on {perch}, leaning back on both hands, face tipped up toward the light" },
  { id: "d-hips", bucket: "driven", needs: "any", gaze: "lens", text: "jaw set, chin lifted, hands on hips, a challenging look straight into the lens" },
  { id: "d-stride", bucket: "driven", needs: "walk", gaze: "off", text: "mid-stride, eyes forward and purposeful, one arm swinging, walking out of the frame" },
  { id: "d-lean", bucket: "driven", needs: "seat", gaze: "lens", text: "leaning forward on {seat}, elbows on knees, intense eye contact, looking into the lens" },
  { id: "d-roll", bucket: "driven", needs: "any", gaze: "aside", text: "rolling a shoulder and stretching the neck, eyes narrowed on someone off-camera" },
  { id: "d-arms", bucket: "driven", needs: "lean", gaze: "off", text: "arms crossed against {lean}, scowling a little at something out of frame, competitive tension in the shoulders" },
  { id: "d-clap", bucket: "driven", needs: "any", gaze: "lens", text: "mid-clap and grinning fiercely, caught in the middle of a pep talk, looking into the lens" },
  { id: "d-restless", bucket: "driven", needs: "perch", gaze: "down", text: "perched on {perch}, head down, fiddling with {poss} cuff, restless" },
];

const BUCKET_WORDS: Record<Bucket, RegExp> = {
  expressive: /\b(?:charmer|firecracker|class clown|life of the party|flirt|wildcard|showstopper|diva|loud|bubbly|bright|chatty|animated|manic|goofy|big laugh|playful|mischief|grin|warm|lit up|talkative|exuberant)\b/gi,
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

/** Props only when the sheet gives a reason (the vocation or the identity line). */
const PROP_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:cook|chef|baker|pastry|line cook|butcher)\b/i, "a folded dish towel over one shoulder"],
  [/\b(?:barista|coffee)\b/i, "a paper coffee cup"],
  [/\b(?:coach|trainer|gym|referee)\b/i, "a clipboard held low at one side"],
  [/\b(?:mechanic|welder|electrician|plumber|carpenter|trimmer|lineman|roofer|construction)\b/i, "a work glove tucked into a back pocket"],
  [/\b(?:teacher|professor|tutor|librarian|author|novelist|editor)\b/i, "a paperback held loosely, a finger keeping the page"],
  [/\b(?:musician|guitarist|singer|drummer|bassist|dj)\b/i, "an acoustic guitar held by the neck"],
  [/\b(?:photographer)\b/i, "an old film camera hanging from its strap"],
  [/\b(?:gardener|florist|landscap|farmer|arborist)\b/i, "a pair of garden gloves in one hand"],
  [/\b(?:driver|trucker|courier|pilot)\b/i, "a set of keys hooked on one finger"],
  [/\b(?:painter|illustrator|tattoo artist)\b/i, "a pencil tucked behind one ear"],
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
function pickCapped<T>(rnd: () => number, cands: readonly T[], used: Map<string, number>, key: (x: T) => string, cap: number): T {
  const under = cands.filter((c) => count(used, key(c)) < cap);
  const pool = under.length > 0 ? under : cands;
  const least = Math.min(...pool.map((c) => count(used, key(c))));
  return pickFrom(rnd, pool.filter((c) => count(used, key(c)) === least));
}

const KITCHEN_VOCATION_RE = /\b(?:cook|chef|baker|pastry|butcher|restaurant|barista|waiter|server|caterer)\b/i;
const poss = (g: ShotSheet["genderPresentation"]): string => (g === "man" ? "his" : g === "woman" ? "her" : "their");

/** Deal one shot card per sheet. Caps (cast of 15): no place on more than 3, no framing on more than 5, no light on more than 4, a prop on at most 2, eyes on the lens for at most 6. */
export function dealShotCards(sheets: readonly ShotSheet[]): Map<string, ShotCard> {
  const rnd = stream(castSeed(sheets, "shot-cards"));
  const caps = shotCaps(sheets.length);
  const placeUsed = new Map<string, number>(), framingUsed = new Map<string, number>(), lightUsed = new Map<string, number>();
  const momentUsed = new Set<string>();
  let lensGaze = 0, props = 0;
  const out = new Map<string, ShotCard>();
  const order = shuffled(rnd, byId(sheets));
  const buckets = new Map(order.map((s) => [s.id, bucketOf(s, rnd)] as const));
  // About a third of the cast is photographed outdoors (backyard, pool, patio, front steps, driveway, garden).
  const outdoorN = Math.max(Math.min(sheets.length, 4), Math.round(sheets.length / 3));
  const outdoorIds = new Set(order.slice(0, outdoorN).map((s) => s.id));
  for (const s of order) {
    const bucket = buckets.get(s.id)!;
    // place: a cook starts in the kitchen; everyone else is dealt, outdoors for the outdoor third.
    const wantOut = outdoorIds.has(s.id);
    let places = PLACES.filter((p) => p.outdoor === wantOut);
    if (!wantOut && KITCHEN_VOCATION_RE.test(s.vocation ?? "") && count(placeUsed, "kitchen") < 2) places = PLACES.filter((p) => p.id === "kitchen");
    const place = pickCapped(rnd, places, placeUsed, (p) => p.id, caps.place);
    bump(placeUsed, place.id);
    // light: what the place allows.
    const lights = LIGHTS.filter((l) => l.where === "any" || l.where === (place.outdoor ? "out" : "in"));
    const light = pickCapped(rnd, lights, lightUsed, (l) => l.id, caps.light);
    bump(lightUsed, light.id);
    // framing: a seated wide shot needs somewhere to sit.
    const framings = FRAMINGS.filter((f) => !f.needsSeat || place.seat !== undefined);
    const framing = pickCapped(rnd, framings, framingUsed, (f) => f.id, caps.framing);
    bump(framingUsed, framing.id);
    const angle = pickFrom(rnd, ANGLES);
    // moment: from the person's own bucket first, then the nearest others; never twice in a cast; the lens is not always the gaze.
    const fits = (m: Moment): boolean => !momentUsed.has(m.id)
      && (m.needs === "any" || (m.needs === "walk" ? place.walk === true : place[m.needs] !== undefined))
      && !(m.gaze === "lens" && lensGaze >= caps.lensGaze)
      && !(framing.id === "close" && (m.needs === "walk" || m.needs === "perch"));
    const nearer: Record<Bucket, readonly Bucket[]> = {
      expressive: ["expressive", "driven", "easy", "watchful"], watchful: ["watchful", "easy", "driven", "expressive"],
      easy: ["easy", "watchful", "expressive", "driven"], driven: ["driven", "expressive", "watchful", "easy"],
    };
    let moment: Moment | undefined;
    for (const b of nearer[bucket]) {
      const cands = MOMENTS.filter((m) => m.bucket === b && fits(m));
      if (cands.length > 0) { moment = pickFrom(rnd, cands); break; }
    }
    moment ??= pickFrom(rnd, MOMENTS.filter((m) => m.needs === "any" && !momentUsed.has(m.id)));
    momentUsed.add(moment.id);
    if (moment.gaze === "lens") lensGaze++;
    // prop: only when the sheet gives a reason, at most 2 in the cast.
    const prop = props < caps.prop ? propFor(s) : undefined;
    if (prop !== undefined) props++;
    const text = moment.text.replace(/\{perch\}/g, place.perch ?? "").replace(/\{lean\}/g, place.lean ?? "")
      .replace(/\{seat\}/g, place.seat ?? "").replace(/\{poss\}/g, poss(s.genderPresentation));
    out.set(s.id, {
      placeId: place.id, place: place.phrase, outdoor: place.outdoor,
      framingId: framing.id, framing: framing.phrase, angle, lens: framing.lens,
      lightId: light.id, light: light.phrase,
      momentId: moment.id, moment: text, gaze: moment.gaze,
      ...(prop !== undefined ? { prop } : {}), bucket,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------- the face deal

type Axis = keyof FaceCard;
interface FaceValue { v: string; pin?: RegExp }
const AXES: Record<Axis, readonly FaceValue[]> = {
  shape: [
    { v: "a round face with full cheeks", pin: /\bround\b/i }, { v: "an oval face", pin: /\boval\b/i },
    { v: "a long, narrow face", pin: /\b(?:narrow|long|elongated)\b/i }, { v: "a broad, squarish face", pin: /\b(?:broad face|wide face|squarish)\b/i },
    { v: "a heart-shaped face, wide at the brow and narrowing to the chin", pin: /\bheart\b/i },
    { v: "a diamond-shaped face with high, wide cheekbones", pin: /\bcheekbones?\b/i },
    { v: "a longish face with a high forehead", pin: /\bhigh forehead\b/i }, { v: "a soft, rounded-square face" },
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
  jaw: [
    { v: "a square jaw", pin: /\b(?:square|strong|angular) jaw\b|\bangular\b/i }, { v: "a soft, rounded jaw", pin: /\bsoft jaw\b/i },
    { v: "a pointed chin", pin: /\bpointed chin\b/i }, { v: "a cleft chin", pin: /\bcleft\b/i },
    { v: "a small, receding chin", pin: /\bsmall chin\b/i }, { v: "a wide, heavy jaw" },
    { v: "a narrow, tapered jaw" }, { v: "a long, prominent chin" },
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
    { v: "a narrow face that sharpens at the chin when not smiling" }, { v: "a wide forehead with a visible hairline widow's peak" }, { v: "a slight asymmetry between the two sides of the face" },
  ],
};
const AXIS_ORDER: readonly Axis[] = ["shape", "nose", "eyes", "brows", "jaw", "mouth", "quirk"];
/** Quirks about age lines are held back from the young. */
const OLD_QUIRK_RE = /smile lines/i;
/** Two faces must differ on at least this many of the seven axes (relaxed step by step only when the pool runs out). */
export const FACE_MIN_DISTANCE = 4;

/** The values an axis can take: the values themselves (the quirk is never dealt twice in a cast). */
function pinsOf(text: string | undefined): Partial<Record<Axis, string>> {
  const out: Partial<Record<Axis, string>> = {};
  if (!text) return out;
  for (const axis of AXIS_ORDER) {
    if (axis === "quirk") continue;
    const hit = AXES[axis].find((x) => x.pin?.test(text));
    if (hit) out[axis] = hit.v;
  }
  return out;
}

/** Deal one face card per sheet so no two share a combination: at most 3 of the cast on any value, quirks never repeat, any two faces differ on at least 4 of 7 axes. A feature the written face line names is kept as a pin. */
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
    const draw = (): FaceCard => {
      const face = {} as FaceCard;
      for (const axis of AXIS_ORDER) {
        const pinned = pins[axis];
        if (pinned !== undefined) { face[axis] = pinned; continue; }
        let pool = AXES[axis].map((x) => x.v).filter((v) => count(used, key(axis, v)) < (axis === "quirk" ? 1 * k : cap));
        if (axis === "quirk" && s.age < 40) pool = pool.filter((v) => !OLD_QUIRK_RE.test(v));
        if (pool.length === 0) pool = AXES[axis].map((x) => x.v);
        face[axis] = pickFrom(rnd, pool);
      }
      return face;
    };
    let best: FaceCard | undefined;
    for (let want = FACE_MIN_DISTANCE; want >= 1 && best === undefined; want--) {
      for (let t = 0; t < 200; t++) {
        const f = draw();
        if (dealt.every((d) => distance(d, f) >= want)) { best = f; break; }
      }
    }
    const face = best ?? draw();
    for (const axis of AXIS_ORDER) bump(used, key(axis, face[axis]));
    dealt.push(face);
    out.set(s.id, face);
  }
  return out;
}

/** The face line of the prompt: seven concrete features. */
export function faceSentence(f: FaceCard): string {
  return `Face: ${f.shape}, ${f.nose}, ${f.eyes}, ${f.brows}, ${f.jaw}, ${f.mouth}, and ${f.quirk}.`;
}

/** Shot card and face card for every sheet. */
export function dealPortraitPlans(sheets: readonly ShotSheet[]): Map<string, PortraitPlan> {
  const shots = dealShotCards(sheets), faces = dealFaceCards(sheets);
  const out = new Map<string, PortraitPlan>();
  for (const s of sheets) out.set(s.id, { shot: shots.get(s.id)!, face: faces.get(s.id)! });
  return out;
}
