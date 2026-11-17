/**
 * ORW-480: the PERFORMANCE of a cast photo: who the person is at a glance. Each card gets, derived from the person's own sheet
 * (casting type and its read, demeanor, voice energy):
 *   - one TRAIT word (loud, sly, shy, intense, warm, guarded, cocky, dreamy, playful, poised),
 *   - an EXPRESSION at full strength (a big real laugh, a flat unimpressed stare, a sly sideways look, a shy look down and away, a hard level stare),
 *   - a POSTURE the head can hold at the same distance (seated at the table with the elbows on it, relaxed in the seat with an arm over the back, arms folded tight, standing with a slight lean),
 *   - what the HANDS are doing.
 * The cast is capped: a closed half-smile on at most 3 of 15, at least 4 people not smiling at all, no expression on more than 2, no posture
 * on more than 2, eyes on the lens within the table's gaze cap. Pure and public-only; the same cast always gets the same deal.
 */
export type Gaze = "lens" | "off" | "aside" | "down";

/** The part of a sheet the performance reads. */
export interface PerfSheet {
  id: string;
  castingLabel?: string;
  castingRead?: string;
  demeanor?: string;
  energy?: string;
  genderPresentation?: "man" | "woman" | "nonbinary";
  /** A held prop already dealt for this person (hands are then holding it). */
  prop?: string;
}
/** What the place offers a posture. */
export interface PlaceFlags { perch?: string; lean?: string; seat?: string; table?: string }

export type TraitId = "loud" | "sly" | "shy" | "intense" | "warm" | "guarded" | "cocky" | "dreamy" | "playful" | "poised";
export const TRAITS: readonly TraitId[] = ["loud", "sly", "shy", "intense", "warm", "guarded", "cocky", "dreamy", "playful", "poised"];

interface TraitDef { labels: readonly string[]; words: RegExp; expressions: readonly string[]; postures: readonly string[]; hands: readonly string[] }

interface Expression { id: string; text: string; smiles: boolean; closedHalf?: boolean; gaze: Gaze }
/**
 * Each entry is something a real person does, unprompted, when a staff photographer points a camera at them: a real laugh, a big grin, a level
 * stare, a shy look away. No performed or stock expressions (no snarls, bared teeth, mugging, comic disbelief).
 */
export const EXPRESSIONS: readonly Expression[] = [
  { id: "open-laugh", smiles: true, gaze: "off", text: "a big real laugh, eyes crinkled but open, looking off to one side at someone" },
  { id: "wide-grin", smiles: true, gaze: "lens", text: "a broad, genuine grin, bright eyes, looking straight into the lens" },
  { id: "lopsided-grin", smiles: true, gaze: "lens", text: "a cheeky lopsided grin, one cheek high, looking into the lens" },
  { id: "confident-half-grin", smiles: true, closedHalf: true, gaze: "lens", text: "a tight, confident half-grin, chin slightly down, eyes steady on the lens" },
  { id: "warm-smile", smiles: true, gaze: "lens", text: "a warm, easy smile with crinkled eyes and relaxed brows, looking into the lens" },
  { id: "soft-smile-away", smiles: true, gaze: "off", text: "a soft smile, eyes just past the lens, relaxed" },
  { id: "shy-smile", smiles: true, gaze: "lens", text: "a small shy smile, chin tucked, eyes up at the lens through the brows" },
  { id: "smirk", smiles: true, gaze: "lens", text: "a sly smirk, one corner of the mouth pulled up, one brow lifted, eyes on the lens" },
  { id: "dreamy-smile", smiles: true, closedHalf: true, gaze: "off", text: "an unfocused half-smile, lips closed, eyes drifting past the lens" },
  { id: "closed-half", smiles: true, closedHalf: true, gaze: "lens", text: "a closed-mouth half-smile, calm eyes on the lens" },
  { id: "smug", smiles: true, closedHalf: true, gaze: "lens", text: "a closed-mouth smile, chin slightly raised, eyes half-lidded" },
  { id: "cool-away", smiles: true, gaze: "off", text: "chin lifted, looking away from the camera with a cool, bored smirk" },
  { id: "sly-side", smiles: false, gaze: "aside", text: "a sly sideways look, eyes cut to the side, lips pressed together, a knowing stillness" },
  { id: "flat-stare", smiles: false, gaze: "lens", text: "a flat, unimpressed stare, mouth a straight line, eyes steady on the lens" },
  { id: "hard-stare", smiles: false, gaze: "lens", text: "a hard, level stare, jaw set, mouth firm, eyes steady on the lens" },
  { id: "brow-raise", smiles: false, gaze: "lens", text: "one brow raised, a skeptical look, lips together, no smile" },
  { id: "serious-calm", smiles: false, gaze: "lens", text: "a calm, serious face, lips together, steady eyes on the lens" },
  { id: "thoughtful-away", smiles: false, gaze: "off", text: "a thoughtful far-off look, lips slightly pressed, eyes to one side" },
  { id: "shy-down", smiles: false, gaze: "down", text: "a shy look down and away, lips pressed together" },
  { id: "poised-away", smiles: false, gaze: "off", text: "a serene look off to one side, chin lifted, mouth neutral" },
  { id: "focus-off", smiles: false, gaze: "off", text: "eyes on something off to the side, jaw set, mouth firm" },
  { id: "chin-up-cool", smiles: false, gaze: "lens", text: "chin lifted, a cool level gaze, mouth neutral" },
  { id: "laugh-down", smiles: true, gaze: "down", text: "laughing, looking down and to the side, eyes open" },
  { id: "grin-aside", smiles: true, gaze: "off", text: "a big grin, turned toward someone off-camera" },
  { id: "teasing-grin", smiles: true, gaze: "lens", text: "a teasing grin, head tilted, looking into the lens" },
  { id: "easy-grin", smiles: true, gaze: "lens", text: "an easy, relaxed grin, eyes on the lens" },
  { id: "amused", smiles: true, closedHalf: true, gaze: "lens", text: "a barely held-back smile, lips pressed, amused eyes on the lens" },
  { id: "wry", smiles: true, closedHalf: true, gaze: "lens", text: "a dry, wry half-smile, one brow slightly raised" },
  { id: "kind-smile", smiles: true, gaze: "lens", text: "a kind, gentle smile, head slightly tilted, eyes on the lens" },
  { id: "bright-smile", smiles: true, gaze: "lens", text: "a bright, open smile, eyes on the lens" },
  { id: "nervous-smile", smiles: true, gaze: "off", text: "a small nervous smile, eyes flicking away" },
  { id: "small-private-smile", smiles: true, closedHalf: true, gaze: "down", text: "eyes lowered, a small private smile" },
  { id: "steady-gaze", smiles: false, gaze: "lens", text: "a steady, level gaze, brows slightly lowered, mouth firm" },
  { id: "chin-down-stare", smiles: false, gaze: "lens", text: "chin down, eyes up and steady on the lens, mouth firm" },
  { id: "side-glance", smiles: false, gaze: "off", text: "a glance off to the side, jaw tight, lips pressed" },
  { id: "patient", smiles: false, gaze: "lens", text: "a patient, attentive look, lips together, eyes on the lens" },
  { id: "curious", smiles: false, gaze: "lens", text: "a curious look, head tilted, lips slightly parted" },
  { id: "distant", smiles: false, gaze: "off", text: "a distant, preoccupied look to one side" },
];

type Needs = "any" | "perch" | "lean" | "seat" | "table";
interface Posture { id: string; text: string; needs: Needs; /** the text already says what the hands do */ fixedHands: boolean }
/**
 * Poses a person holds unprompted in a cast photo, with the head staying at the same distance from the camera as in every other photo: seated
 * or standing upright, no lunging toward the lens, no deep hunch. No stock poses (pointing at the camera, thumbs up, flexing, fist bumps, jazz hands).
 * `table` is only dealt where the place has a table.
 */
export const POSTURES: readonly Posture[] = [
  { id: "lean-in-table", needs: "table", fixedHands: false, text: "seated at {table}, forearms resting on it, upright" },
  { id: "relaxed-seat", needs: "seat", fixedHands: false, text: "seated {seat}, upright and relaxed, one arm along the back" },
  { id: "arms-folded-tight", needs: "any", fixedHands: true, text: "arms folded tight across the chest, shoulders squared" },
  { id: "seated-upright", needs: "seat", fixedHands: true, text: "seated {seat}, upright, hands resting in the lap" },
  { id: "hands-on-hips", needs: "any", fixedHands: true, text: "standing square with both hands on the hips, chest open, chin level" },
  { id: "shoulder-lean", needs: "lean", fixedHands: false, text: "one shoulder against {lean}, weight on one hip" },
  { id: "perched", needs: "perch", fixedHands: false, text: "perched on {perch}, sitting upright, hands resting on the edge" },
  { id: "slight-lean", needs: "any", fixedHands: true, text: "standing upright, weight settled, arms relaxed at the sides" },
  { id: "upright", needs: "any", fixedHands: true, text: "standing very upright, shoulders back, chin lifted, hands clasped in front" },
  { id: "turned-shoulder", needs: "any", fixedHands: false, text: "body turned three-quarter away, head turned back to the camera over the shoulder" },
  { id: "relaxed-cross", needs: "seat", fixedHands: false, text: "seated {seat}, shoulders loose, one leg crossed over the other" },
  { id: "pockets", needs: "any", fixedHands: true, text: "standing loose, thumbs hooked in the pockets, weight on one leg" },
  { id: "fidget", needs: "any", fixedHands: true, text: "standing upright, shoulders a little drawn in, one hand holding the other forearm" },
  { id: "talking", needs: "any", fixedHands: true, text: "turned toward someone off-camera, mid-sentence, one hand open" },
  { id: "hand-chest", needs: "any", fixedHands: true, text: "one hand pressed to the chest, head tilted" },
  { id: "hair-touch", needs: "any", fixedHands: true, text: "upright, one hand lightly touching the hair" },
  { id: "clasped-low", needs: "any", fixedHands: true, text: "standing relaxed, hands clasped low in front" },
  { id: "weight-one-leg", needs: "any", fixedHands: true, text: "standing with the weight on one leg, arms loose at the sides" },
  { id: "one-pocket", needs: "any", fixedHands: true, text: "standing easy, one hand in a pocket, the other at the side" },
  { id: "hand-on-surface", needs: "lean", fixedHands: true, text: "leaning lightly on {lean}, one hand resting on it" },
  { id: "arms-crossed-lean", needs: "lean", fixedHands: true, text: "arms crossed, leaning back against {lean}" },
];

const T: Record<TraitId, TraitDef> = {
  loud: {
    labels: ["life of the party", "loudmouth", "superfan", "cheerleader", "class clown", "sidekick", "good sport", "country kid", "cool relative", "showstopper"],
    words: /\b(?:loud\w*|big laugh|animated|boisterous|shout\w*|bubbly|exuberant|goofy|wide grin|manic|talkative|lit up|chatty|bouncy|explosive|unfiltered)\b/i,
    expressions: ["open-laugh", "wide-grin", "lopsided-grin", "grin-aside", "laugh-down", "easy-grin", "teasing-grin"],
    postures: ["lean-in-table", "talking", "perched", "relaxed-seat", "slight-lean", "weight-one-leg"],
    hands: ["hands loosely folded in front", "one hand resting on the other wrist", "fingers hooked in a pocket", "one hand in a pocket, the other relaxed at the side", "thumbs hooked in the belt loops"],
  },
  sly: {
    labels: ["schemer", "villain", "mastermind in plain sight", "old school player", "enigma"],
    words: /\b(?:sly|scheming|calculat\w*|knowing|smirk\w*|unreadable|gives nothing away|plan|private smile|flicker)\b/i,
    expressions: ["sly-side", "smirk", "brow-raise", "wry", "closed-half", "side-glance", "amused"],
    postures: ["turned-shoulder", "shoulder-lean", "arms-crossed-lean", "pockets", "arms-folded-tight", "one-pocket"],
    hands: ["one hand resting loosely on the other wrist", "fingers hooked in a pocket", "fingers loosely laced", "hands resting flat and still"],
  },
  shy: {
    labels: ["wallflower", "underdog", "baby of the house", "showmance seeker", "puzzle head"],
    words: /\b(?:shy|hopeful|tentative|earnest|timid|gentle|sweet|eager|awkward|drawn in)\b/i,
    expressions: ["shy-down", "shy-smile", "thoughtful-away", "nervous-smile", "small-private-smile", "serious-calm", "kind-smile"],
    postures: ["fidget", "seated-upright", "hand-chest", "turned-shoulder", "clasped-low", "hair-touch"],
    hands: ["one hand holding the other wrist", "one hand holding the opposite forearm", "fingers loosely laced", "hands loosely folded in front"],
  },
  intense: {
    labels: ["competitor", "comp beast", "grinder", "hothead", "gym rat", "jock"],
    words: /\b(?:focused|set jaw|intense|ready|competitive|fierce|determined|locked|blunt|coiled|athletic|ready stance|tight jaw)\b/i,
    expressions: ["hard-stare", "confident-half-grin", "focus-off", "flat-stare", "steady-gaze", "chin-down-stare", "side-glance", "serious-calm"],
    postures: ["slight-lean", "hands-on-hips", "hand-on-surface", "lean-in-table", "arms-folded-tight", "arms-crossed-lean", "upright", "seated-upright", "weight-one-leg"],
    hands: ["hands resting still and relaxed", "fingers loosely laced", "arms relaxed at the sides", "one hand resting on the other wrist"],
  },
  warm: {
    labels: ["sweetheart", "natural", "parent of the house", "gentle giant", "fan favorite"],
    words: /\b(?:warm|kind|soft|open|gentle|patient|easy|unforced|steady|calm|relaxed|folksy)\b/i,
    expressions: ["warm-smile", "kind-smile", "soft-smile-away", "bright-smile", "easy-grin", "patient", "closed-half"],
    postures: ["relaxed-seat", "shoulder-lean", "hand-on-surface", "relaxed-cross", "pockets", "hand-chest", "clasped-low", "perched", "one-pocket"],
    hands: ["hands loosely folded in front", "one hand resting on the other wrist", "fingers hooked in a pocket", "hands resting flat and still"],
  },
  guarded: {
    labels: ["tough nut", "quiet storm", "brain", "straight shooter", "rebel", "sleeper", "wise head"],
    words: /\b(?:guarded|wary|watchful|reserved|still|composed|measured|clipped|dry|deadpan|cool|stare|observant|private|surgical|unbothered|level)\b/i,
    expressions: ["flat-stare", "brow-raise", "serious-calm", "closed-half", "thoughtful-away", "curious", "distant", "chin-down-stare", "patient"],
    postures: ["arms-folded-tight", "shoulder-lean", "arms-crossed-lean", "seated-upright", "relaxed-cross", "upright", "weight-one-leg", "one-pocket"],
    hands: ["hands resting flat and still", "one hand resting on the other wrist", "fingers hooked in a pocket", "hands loosely folded in front"],
  },
  cocky: {
    labels: ["trash talker", "influencer", "queen bee", "know it all", "diva", "bombshell", "hustler", "charmer", "firecracker"],
    words: /\b(?:cocky|smug|chin (?:up|lifted|jutted)|polished|practiced|confident|salesman|posed|owns|forward-leaning|assured|sharp)\b/i,
    expressions: ["smirk", "smug", "cool-away", "chin-up-cool", "brow-raise", "wry", "teasing-grin"],
    postures: ["hands-on-hips", "upright", "arms-crossed-lean", "relaxed-seat", "turned-shoulder", "shoulder-lean", "one-pocket"],
    hands: ["one hand resting in a pocket", "thumbs hooked in the belt loops", "one hand in a pocket, the other relaxed at the side"],
  },
  dreamy: {
    labels: ["dreamer", "free spirit", "hopeless romantic", "floater"],
    words: /\b(?:dreamy|drifting|sunny|loose|soft gaze|hopeful|far-off|wandering|unfocused)\b/i,
    expressions: ["dreamy-smile", "thoughtful-away", "soft-smile-away", "warm-smile", "distant", "small-private-smile"],
    postures: ["relaxed-cross", "shoulder-lean", "hair-touch", "hand-chest", "pockets", "clasped-low", "weight-one-leg"],
    hands: ["fingers trailing idly at the side", "hands loosely folded in front", "one hand resting on the other wrist", "fingers hooked in a pocket"],
  },
  playful: {
    labels: ["flirt", "wildcard", "loose cannon", "heartbreaker", "drama magnet"],
    words: /\b(?:playful|flirt\w*|mischief|spark|restless|lopsided|teasing|head tilt|twitchy|unpredictable|wired)\b/i,
    expressions: ["lopsided-grin", "smirk", "teasing-grin", "grin-aside", "laugh-down", "brow-raise", "wide-grin", "curious"],
    postures: ["hair-touch", "shoulder-lean", "turned-shoulder", "lean-in-table", "talking", "perched", "relaxed-seat", "one-pocket"],
    hands: ["one hand in a pocket, the other relaxed at the side", "hands loosely clasped in front", "fingers hooked in a pocket", "thumbs hooked in the belt loops"],
  },
  poised: {
    labels: ["sophisticate", "elder statesperson", "silver fox"],
    words: /\b(?:poised|regal|distinguished|upright|serene|gracious|elegant|formal)\b/i,
    expressions: ["closed-half", "chin-up-cool", "poised-away", "serious-calm", "warm-smile", "patient", "wry"],
    postures: ["upright", "turned-shoulder", "arms-crossed-lean", "shoulder-lean", "hand-chest", "clasped-low"],
    hands: ["hands clasped lightly at the waist", "one hand resting on the opposite wrist", "hands loosely folded in front"],
  },
};

const norm = (l: string | undefined): string => (l ?? "").toLowerCase().replace(/^the\s+/, "").replace(/-/g, " ").trim();

/** Each trait's score for a sheet and which lines said so: the casting type (6), words in the casting read (3 each), the demeanor (2), the voice energy (1). */
export function traitScores(s: PerfSheet): Array<{ trait: TraitId; score: number; why: string[] }> {
  return TRAITS.map((trait) => {
    const def = T[trait];
    const why: string[] = [];
    let score = 0;
    if (def.labels.includes(norm(s.castingLabel))) { score += 6; why.push(`type "${s.castingLabel}"`); }
    const hits = (t: string | undefined): string[] => (t ? (t.match(new RegExp(def.words.source, "gi")) ?? []) : []);
    const names = (xs: string[]): string => [...new Set(xs.map((x) => x.toLowerCase()))].join(", ");
    const r = hits(s.castingRead); if (r.length > 0) { score += 3 * r.length; why.push(`read "${s.castingRead}" (${names(r)})`); }
    const d = hits(s.demeanor); if (d.length > 0) { score += 2 * d.length; why.push(`demeanor (${names(d)})`); }
    const e = hits(s.energy); if (e.length > 0) { score += e.length; why.push(`voice (${names(e)})`); }
    return { trait, score, why };
  });
}

export interface Performance {
  trait: TraitId;
  expressionId: string; postureId: string;
  expression: string; posture: string; hands: string;
  gaze: Gaze; smiles: boolean; closedHalf: boolean;
  /** The one sentence for the prompt: expression; posture; hands. */
  moment: string;
  /** Which sheet lines the trait came from. */
  why: string;
}

const poss = (g: PerfSheet["genderPresentation"]): string => (g === "man" ? "his" : g === "woman" ? "her" : "their");
const count = (m: Map<string, number>, k: string): number => m.get(k) ?? 0;
const bump = (m: Map<string, number>, k: string): void => { m.set(k, count(m, k) + 1); };

export interface PerfCaps { lensGaze: number; closedHalf: number; minNonSmiling: number; perExpression: number; perPosture: number; softEach: number }
/**
 * The caps for a cast of `n`: closed half-smile on at most 3 of 15, at least 4 of 15 not smiling; any one expression, posture, hands entry or
 * gesture family (arms crossed, hand to the hair or neck, hands on hips, open palm ...) on ONE person while the table is big enough (`softEach`),
 * on at most 2 when it is not (`perExpression`, `perPosture`).
 */
export function perfCaps(n: number, lensGaze: number): PerfCaps {
  const k = Math.max(1, Math.ceil(n / 15));
  return { lensGaze, closedHalf: 3 * k, minNonSmiling: Math.min(4 * k, Math.floor(n / 3)), perExpression: 2 * k, perPosture: 2 * k, softEach: k };
}

/** A gesture family: the same kind of gesture counts once however it is worded. */
export function gestureFamily(text: string): string | undefined {
  if (/arms (?:folded|crossed)/i.test(text)) return "arms-crossed";
  if (/(?:back of the neck|the hair)\b/i.test(text)) return "hand-to-head";
  if (/(?:both hands|hand) on the hips?|hand on the hip/i.test(text)) return "hips";
  if (/hand open|palms? (?:up|open)|hands open/i.test(text)) return "open-palm";
  if (/pockets?\b/i.test(text)) return "pockets";
  if (/holding the (?:other|opposite)/i.test(text)) return "hold-arm";
  if (/pressed to the chest/i.test(text)) return "hand-chest";
  if (/hands clasped|hands loosely (?:folded|clasped)|fingers (?:loosely )?laced/i.test(text)) return "clasped";
  return undefined;
}

/**
 * Deal a performance to every sheet. `flags` is the place each person is in; `rnd` the seeded stream.
 * The strongest traits are placed first so a loud type gets the loud expression and posture, then the caps and the non-smiling minimum are kept.
 * An entry nobody has used yet is preferred; a repeat is allowed only when the person's own table has nothing unused.
 */
export function dealPerformances(
  sheets: readonly PerfSheet[], flags: ReadonlyMap<string, PlaceFlags>, rnd: () => number, caps: PerfCaps,
): Map<string, Performance> {
  const byEx = new Map(EXPRESSIONS.map((e) => [e.id, e] as const));
  const byPo = new Map(POSTURES.map((p) => [p.id, p] as const));
  const pick = <X>(xs: readonly X[]): X => xs[Math.floor(rnd() * xs.length) % xs.length]!;
  // the trait of each person
  const info = sheets.map((s) => {
    const scores = traitScores(s);
    const best = Math.max(...scores.map((x) => x.score));
    const top = scores.filter((x) => x.score === best);
    const chosen = best === 0 ? { trait: pick(TRAITS), score: 0, why: ["no line of the sheet matched: dealt"] } : pick(top);
    return { s, trait: chosen.trait, score: chosen.score, why: chosen.why, tie: rnd() };
  }).sort((a, b) => b.score - a.score || a.tie - b.tie);

  const exUsed = new Map<string, number>(), poUsed = new Map<string, number>(), handUsed = new Map<string, number>(), famUsed = new Map<string, number>();
  let closedHalf = 0, lens = 0;
  const out = new Map<string, { trait: TraitId; ex: Expression; po: Posture; hands: string; score: number; why: string[]; s: PerfSheet }>();
  const exOkSoft = (e: Expression): boolean => count(exUsed, e.id) < caps.perExpression && !(e.closedHalf && closedHalf >= caps.closedHalf);
  const exOk = (e: Expression): boolean => exOkSoft(e) && !(e.gaze === "lens" && lens >= caps.lensGaze);
  const compat = (p: Posture, s: PerfSheet): boolean => {
    const f = flags.get(s.id) ?? {};
    return (p.needs === "any" || f[p.needs] !== undefined) && !(s.prop !== undefined && p.fixedHands);
  };
  /** The first `soft` pass takes an entry used by nobody (and, for gestures, a family used by nobody); the second allows the hard cap. */
  const choose = <X>(xs: readonly X[], uses: (x: X) => number, hard: number): X | undefined => {
    for (const lim of [caps.softEach, hard]) { const ok = xs.filter((x) => uses(x) < lim); if (ok.length > 0) return pick(ok.slice(0, 3)); }
    return undefined;
  };
  const famOf = (t: string): number => { const f = gestureFamily(t); return f === undefined ? 0 : count(famUsed, f); };
  for (const x of info) {
    const def = T[x.trait];
    // the person's own bank first (the eyes-on-the-lens cap is soft here and enforced afterwards by moving the weakest matches), then any expression within the other caps
    const own = def.expressions.map((id) => byEx.get(id)!);
    const bank = own.filter(exOk).length > 0 ? own.filter(exOk) : own.filter(exOkSoft);
    const ex = (bank.length > 0 ? choose(bank, (e) => count(exUsed, e.id), caps.perExpression) : undefined)
      ?? choose(EXPRESSIONS.filter(exOk), (e) => count(exUsed, e.id), caps.perExpression) ?? EXPRESSIONS[0]!;
    const bankP = def.postures.map((id) => byPo.get(id)!).filter((p) => compat(p, x.s) && count(poUsed, p.id) < caps.perPosture);
    const rest = POSTURES.filter((p) => compat(p, x.s) && count(poUsed, p.id) < caps.perPosture);
    const uses = (p: Posture): number => Math.max(count(poUsed, p.id), famOf(p.text));
    const po = (bankP.length > 0 ? choose(bankP, uses, caps.perPosture) : undefined) ?? choose(rest, uses, caps.perPosture) ?? pick(POSTURES.filter((p) => compat(p, x.s)));
    // the hands: a held prop, or what the posture says, or an entry of the person's own table nobody (and no gesture family) has used yet
    let hands = "";
    if (x.s.prop !== undefined) hands = x.s.prop;
    else if (!po.fixedHands) {
      const pool = [...def.hands, ...Object.values(T).flatMap((d) => d.hands)].filter((h, i, a) => a.indexOf(h) === i);
      const handUses = (h: string): number => Math.max(count(handUsed, h), famOf(h));
      hands = choose(def.hands, handUses, caps.perPosture) ?? choose(pool, handUses, caps.perPosture) ?? pick(def.hands);
    }
    bump(exUsed, ex.id); bump(poUsed, po.id);
    for (const t of [po.text, hands]) { const f = gestureFamily(t); if (f !== undefined) bump(famUsed, f); }
    if (hands !== "") bump(handUsed, hands);
    if (ex.closedHalf) closedHalf++;
    if (ex.gaze === "lens") lens++;
    out.set(x.s.id, { trait: x.trait, ex, po, hands, score: x.score, why: x.why, s: x.s });
  }
  // eyes on the lens within the cap: the weakest-matched lens-gazers move to a non-lens expression of their own bank
  if (lens > caps.lensGaze) {
    const lensers = [...out.values()].filter((v) => v.ex.gaze === "lens").sort((a, b) => a.score - b.score);
    for (const v of lensers) {
      if (lens <= caps.lensGaze) break;
      const alt = T[v.trait].expressions.map((id) => byEx.get(id)!).find((e) => e.gaze !== "lens" && count(exUsed, e.id) < caps.perExpression && !(e.closedHalf && !v.ex.closedHalf && closedHalf >= caps.closedHalf));
      if (alt === undefined) continue;
      exUsed.set(v.ex.id, count(exUsed, v.ex.id) - 1); bump(exUsed, alt.id);
      if (v.ex.closedHalf) closedHalf--;
      if (alt.closedHalf) closedHalf++;
      lens--; v.ex = alt;
    }
  }
  // at least `minNonSmiling` people not smiling at all: the weakest-matched smilers switch to a non-smiling expression of their own trait (else of any trait)
  const nonSmiling = (): number => [...out.values()].filter((v) => !v.ex.smiles).length;
  if (nonSmiling() < caps.minNonSmiling) {
    const smilers = [...out.values()].filter((v) => v.ex.smiles).sort((a, b) => a.score - b.score);
    for (const v of smilers) {
      if (nonSmiling() >= caps.minNonSmiling) break;
      const own = T[v.trait].expressions.map((id) => byEx.get(id)!).filter((e) => !e.smiles && count(exUsed, e.id) < caps.perExpression && !(e.gaze === "lens" && lens >= caps.lensGaze));
      const any = EXPRESSIONS.filter((e) => !e.smiles && count(exUsed, e.id) < caps.perExpression);
      const next = own[0] ?? any[0];
      if (next === undefined) continue;
      exUsed.set(v.ex.id, count(exUsed, v.ex.id) - 1); bump(exUsed, next.id);
      if (v.ex.closedHalf) closedHalf--;
      if (v.ex.gaze === "lens") lens--;
      if (next.gaze === "lens") lens++;
      v.ex = next;
    }
  }
  const res = new Map<string, Performance>();
  for (const [id, v] of out) {
    const f = flags.get(id) ?? {};
    const fill = (t: string): string => t.replace(/\{perch\}/g, f.perch ?? "").replace(/\{lean\}/g, f.lean ?? "").replace(/\{seat\}/g, f.seat ?? "").replace(/\{table\}/g, f.table ?? "").replace(/\{poss\}/g, poss(v.s.genderPresentation));
    const hands = v.hands;
    const posture = fill(v.po.text);
    res.set(id, {
      trait: v.trait, expressionId: v.ex.id, postureId: v.po.id, expression: v.ex.text, posture, hands,
      gaze: v.ex.gaze, smiles: v.ex.smiles, closedHalf: v.ex.closedHalf === true,
      moment: [v.ex.text, posture, hands].filter((x) => x !== "").join("; "),
      why: `trait ${v.trait} from ${v.why.join("; ")}`,
    });
  }
  return res;
}
