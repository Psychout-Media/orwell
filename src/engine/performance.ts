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
  { id: "open-laugh", smiles: true, gaze: "off", text: "a big real laugh, eyes crinkled nearly shut, looking off to one side at someone" },
  { id: "wide-grin", smiles: true, gaze: "lens", text: "a broad, genuine grin, bright eyes, looking straight into the lens" },
  { id: "lopsided-grin", smiles: true, gaze: "lens", text: "a cheeky lopsided grin, one cheek high, looking into the lens" },
  { id: "squint-laugh", smiles: true, gaze: "down", text: "laughing hard, eyes squeezed shut, looking down and away" },
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
  { id: "talking", needs: "any", fixedHands: false, text: "turned toward someone off-camera, caught mid-conversation" },
  { id: "hand-chest", needs: "any", fixedHands: true, text: "one hand pressed to the chest, head tilted" },
  { id: "hair-touch", needs: "any", fixedHands: true, text: "upright, one hand lightly touching the hair" },
  { id: "hand-on-surface", needs: "lean", fixedHands: true, text: "leaning lightly on {lean}, one hand resting on it" },
  { id: "arms-crossed-lean", needs: "lean", fixedHands: true, text: "arms crossed, leaning back against {lean}" },
];

const T: Record<TraitId, TraitDef> = {
  loud: {
    labels: ["life of the party", "loudmouth", "superfan", "cheerleader", "class clown", "sidekick", "good sport", "country kid", "cool relative", "showstopper"],
    words: /\b(?:loud\w*|big laugh|animated|boisterous|shout\w*|bubbly|exuberant|goofy|wide grin|manic|talkative|lit up|chatty|bouncy|explosive|unfiltered)\b/i,
    expressions: ["open-laugh", "wide-grin", "squint-laugh", "lopsided-grin"],
    postures: ["lean-in-table", "talking", "perched", "relaxed-seat", "slight-lean"],
    hands: ["one hand open mid-sentence, the other resting", "both hands open as if mid-sentence"],
  },
  sly: {
    labels: ["schemer", "villain", "mastermind in plain sight", "old school player", "enigma"],
    words: /\b(?:sly|scheming|calculat\w*|knowing|smirk\w*|unreadable|gives nothing away|plan|private smile|flicker)\b/i,
    expressions: ["sly-side", "smirk", "brow-raise", "closed-half"],
    postures: ["turned-shoulder", "shoulder-lean", "arms-crossed-lean", "pockets", "arms-folded-tight"],
    hands: ["one hand resting loosely on the other wrist", "fingers hooked in a pocket"],
  },
  shy: {
    labels: ["wallflower", "underdog", "baby of the house", "showmance seeker", "puzzle head"],
    words: /\b(?:shy|hopeful|tentative|earnest|timid|gentle|sweet|eager|awkward|drawn in)\b/i,
    expressions: ["shy-down", "shy-smile", "thoughtful-away", "serious-calm"],
    postures: ["fidget", "seated-upright", "hand-chest", "turned-shoulder", "hair-touch"],
    hands: ["one hand holding the other wrist", "one hand holding the opposite forearm"],
  },
  intense: {
    labels: ["competitor", "comp beast", "grinder", "hothead", "gym rat", "jock"],
    words: /\b(?:focused|set jaw|intense|ready|competitive|fierce|determined|locked|blunt|coiled|athletic|ready stance|tight jaw)\b/i,
    expressions: ["hard-stare", "confident-half-grin", "focus-off", "flat-stare", "serious-calm"],
    postures: ["slight-lean", "hands-on-hips", "hand-on-surface", "lean-in-table", "arms-folded-tight", "arms-crossed-lean", "upright", "seated-upright"],
    hands: ["hands resting still and relaxed", "fingers laced and still"],
  },
  warm: {
    labels: ["sweetheart", "natural", "parent of the house", "gentle giant", "fan favorite"],
    words: /\b(?:warm|kind|soft|open|gentle|patient|easy|unforced|steady|calm|relaxed|folksy)\b/i,
    expressions: ["warm-smile", "soft-smile-away", "closed-half", "serious-calm"],
    postures: ["relaxed-seat", "shoulder-lean", "hand-on-surface", "relaxed-cross", "pockets", "hand-chest", "hair-touch", "perched"],
    hands: ["one hand open and relaxed, palm up", "hands loosely folded"],
  },
  guarded: {
    labels: ["tough nut", "quiet storm", "brain", "straight shooter", "rebel", "sleeper", "wise head"],
    words: /\b(?:guarded|wary|watchful|reserved|still|composed|measured|clipped|dry|deadpan|cool|stare|observant|private|surgical|unbothered|level)\b/i,
    expressions: ["flat-stare", "brow-raise", "serious-calm", "closed-half", "thoughtful-away"],
    postures: ["arms-folded-tight", "shoulder-lean", "arms-crossed-lean", "seated-upright", "relaxed-cross", "upright"],
    hands: ["one hand rubbing the back of the neck", "hands resting flat and still"],
  },
  cocky: {
    labels: ["trash talker", "influencer", "queen bee", "know it all", "diva", "bombshell", "hustler", "charmer", "firecracker"],
    words: /\b(?:cocky|smug|chin (?:up|lifted|jutted)|polished|practiced|confident|salesman|posed|owns|forward-leaning|assured|sharp)\b/i,
    expressions: ["smirk", "smug", "cool-away", "chin-up-cool", "brow-raise"],
    postures: ["hands-on-hips", "upright", "arms-crossed-lean", "relaxed-seat", "turned-shoulder", "shoulder-lean"],
    hands: ["one hand resting in a pocket", "one hand loosely on the hip"],
  },
  dreamy: {
    labels: ["dreamer", "free spirit", "hopeless romantic", "floater"],
    words: /\b(?:dreamy|drifting|sunny|loose|soft gaze|hopeful|far-off|wandering|unfocused)\b/i,
    expressions: ["dreamy-smile", "thoughtful-away", "soft-smile-away", "warm-smile"],
    postures: ["relaxed-cross", "shoulder-lean", "hair-touch", "hand-chest", "pockets"],
    hands: ["one hand twirling a strand of hair", "fingers trailing idly"],
  },
  playful: {
    labels: ["flirt", "wildcard", "loose cannon", "heartbreaker", "drama magnet"],
    words: /\b(?:playful|flirt\w*|mischief|spark|restless|lopsided|teasing|head tilt|twitchy|unpredictable|wired)\b/i,
    expressions: ["lopsided-grin", "smirk", "squint-laugh", "brow-raise", "wide-grin"],
    postures: ["hair-touch", "shoulder-lean", "turned-shoulder", "lean-in-table", "talking", "perched", "relaxed-seat"],
    hands: ["one hand in a pocket, the other loosely open", "hands loosely clasped in front, a restless shift"],
  },
  poised: {
    labels: ["sophisticate", "elder statesperson", "silver fox"],
    words: /\b(?:poised|regal|distinguished|upright|serene|gracious|elegant|formal)\b/i,
    expressions: ["closed-half", "chin-up-cool", "poised-away", "serious-calm", "warm-smile"],
    postures: ["upright", "turned-shoulder", "arms-crossed-lean", "shoulder-lean", "hand-chest"],
    hands: ["hands clasped lightly at the waist", "one hand resting on the opposite wrist"],
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

export interface PerfCaps { lensGaze: number; closedHalf: number; minNonSmiling: number; perExpression: number; perPosture: number }
/** The caps for a cast of `n`: closed half-smile on at most 3 of 15, at least 4 of 15 not smiling, any one expression or posture on at most 2. */
export function perfCaps(n: number, lensGaze: number): PerfCaps {
  const k = Math.max(1, Math.ceil(n / 15));
  return { lensGaze, closedHalf: 3 * k, minNonSmiling: Math.min(4 * k, Math.floor(n / 3)), perExpression: 2 * k, perPosture: 2 * k };
}

/**
 * Deal a performance to every sheet. `order` is the seeded order; `flags` the place each person is in; `rnd` the seeded stream.
 * The strongest traits are placed first so a loud type gets the loud expression and posture, then the caps and the non-smiling minimum are kept.
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

  const exUsed = new Map<string, number>(), poUsed = new Map<string, number>();
  let closedHalf = 0, lens = 0;
  const out = new Map<string, { trait: TraitId; ex: Expression; po: Posture; score: number; why: string[]; s: PerfSheet }>();
  const exOkSoft = (e: Expression): boolean => count(exUsed, e.id) < caps.perExpression && !(e.closedHalf && closedHalf >= caps.closedHalf);
  const exOk = (e: Expression): boolean => exOkSoft(e) && !(e.gaze === "lens" && lens >= caps.lensGaze);
  const poOk = (p: Posture, s: PerfSheet): boolean => {
    const f = flags.get(s.id) ?? {};
    if (p.needs !== "any" && f[p.needs] === undefined) return false;
    if (s.prop !== undefined && p.fixedHands) return false;                // a held thing leaves a hand free
    return count(poUsed, p.id) < caps.perPosture;
  };
  for (const x of info) {
    const def = T[x.trait];
    // the person's own bank first (the eyes-on-the-lens cap is soft here and enforced afterwards by moving the weakest matches), then any expression within the other caps
    const own = def.expressions.map((id) => byEx.get(id)!);
    const exs = own.filter(exOk).length > 0 ? own.filter(exOk) : own.filter(exOkSoft);
    const cand = exs.length > 0 ? exs.slice(0, 2) : EXPRESSIONS.filter(exOk);
    const ex = cand.length > 0 ? pick(cand) : EXPRESSIONS[0]!;
    const compat = (p: Posture): boolean => {
      const f = flags.get(x.s.id) ?? {};
      return (p.needs === "any" || f[p.needs] !== undefined) && !(x.s.prop !== undefined && p.fixedHands);
    };
    const pos = def.postures.map((id) => byPo.get(id)!).filter((p) => poOk(p, x.s));
    const po = pos.length > 0 ? pick(pos.slice(0, 3)) : pick(POSTURES.filter((p) => poOk(p, x.s)).length > 0 ? POSTURES.filter((p) => poOk(p, x.s)) : POSTURES.filter(compat));
    bump(exUsed, ex.id); bump(poUsed, po.id);
    if (ex.closedHalf) closedHalf++;
    if (ex.gaze === "lens") lens++;
    out.set(x.s.id, { trait: x.trait, ex, po, score: x.score, why: x.why, s: x.s });
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
    const hands = v.s.prop !== undefined ? `${v.s.prop}` : v.po.fixedHands ? "" : pick(T[v.trait].hands);
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
