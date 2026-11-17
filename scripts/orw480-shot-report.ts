/**
 * ORW-480: print the NEW portrait prompts for a cast (a JSON list of public cards) beside the OLD ones, with counts
 * (places, framings, lights, props, gaze, shared sentences) before and after. Makes no image or model call.
 *
 *   npx tsx scripts/orw480-shot-report.ts <cards.json> <old-prompts.json>
 *
 * `cards.json`: [{ id, name, age, presentation, vocation, demeanor, identityConcept, ethnicity, genderPresentation,
 *   castingType: {label, read}, voice (a string or {energy}), physicalCharacteristics }] (the player-visible card fields).
 * `old-prompts.json`: [{ id, prompt }] (the prompts the live game built before this change).
 */
import { readFileSync } from "node:fs";
import { buildCastPortraitPrompts, castSheetOf } from "../src/engine/portraitPrompts";
import { dealPortraitPlans, dealFaceCards, shotCaps, PORTRAIT_FORMAT } from "../src/engine/shotCards";
import { POSTURES, gestureFamily } from "../src/engine/performance";

interface Card {
  id: string; name: string; age: number; presentation: string; vocation?: string; demeanor?: string; identityConcept?: string;
  hometown?: string; biography?: string; ethnicity?: string; genderPresentation?: "man" | "woman" | "nonbinary"; castingType?: { label?: string; read?: string };
  voice?: string | { energy?: string }; physicalCharacteristics?: never; appearance?: string;
}
const [cardsPath, oldPath] = process.argv.slice(2);
if (!cardsPath || !oldPath) { console.error("usage: orw480-shot-report.ts <cards.json> <old-prompts.json>"); process.exit(2); }
const out: string[] = [];
const log = (...a: unknown[]): void => { out.push(a.join(" ")); };
const rawCards = JSON.parse(readFileSync(cardsPath, "utf8")) as unknown;
const cards = (Array.isArray(rawCards) ? rawCards : (rawCards as { casts?: Array<{ cards?: unknown[] }> }).casts?.[0]?.cards ?? []) as Card[];
const old = JSON.parse(readFileSync(oldPath, "utf8")) as { id: string; prompt: string }[];

const cast = cards.map((c) => ({
  id: c.id, name: c.name, appearance: c.appearance ?? "card", age: c.age, presentation: c.presentation,
  ...(c.physicalCharacteristics ? { physicalCharacteristics: c.physicalCharacteristics } : {}),
  ...(c.ethnicity ? { ethnicity: c.ethnicity } : {}), ...(c.genderPresentation ? { genderPresentation: c.genderPresentation } : {}),
  ...(c.demeanor ? { demeanor: c.demeanor } : {}), ...(c.identityConcept ? { identityConcept: c.identityConcept } : {}),
  ...(c.vocation ? { vocation: c.vocation } : {}), ...(c.hometown ? { hometown: c.hometown } : {}), ...(c.biography ? { biography: c.biography } : {}), ...(c.castingType ? { castingType: c.castingType } : {}),
  ...(c.voice ? { voiceEnergy: typeof c.voice === "string" ? c.voice : (c.voice.energy ?? "") } : {}),
}));
const fresh = buildCastPortraitPrompts(cast, "anchor");
const plans = dealPortraitPlans(cast.map((c) => castSheetOf(c)));

const tally = (xs: string[]): string => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} x${n}`).join("; ");
};
const sentences = (p: string): string[] => p.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s !== "");
const shared = (ps: string[], min: number): { s: string; n: number }[] => {
  const m = new Map<string, number>();
  for (const p of ps) for (const s of new Set(sentences(p))) m.set(s, (m.get(s) ?? 0) + 1);
  return [...m].filter(([, n]) => n >= min).map(([s, n]) => ({ s, n })).sort((a, b) => b.n - a.n);
};

for (const c of cards) {
  const o = old.find((x) => x.id === c.id)?.prompt ?? "(none)";
  const n = fresh.find((x) => x.houseguestId === c.id)?.prompt ?? "(none)";
  log(`\n=== ${c.id} ${c.name} (${c.age}, ${c.vocation ?? ""}; ${c.castingType?.label ?? ""})\nOLD: ${o}\nNEW: ${n}`);
}

const oldP = old.map((x) => x.prompt), newP = fresh.map((x) => x.prompt);
const oldPlace = oldP.map((p) => /Setting: (?:the house )?([^,.]+)/.exec(p)?.[1] ?? "?");
const oldLight = oldP.map((p) => /Light: ([^.]+)\./.exec(p)?.[1] ?? "?");
const oldFraming = oldP.map((p) => (/Waist-up portrait/.test(p) ? "waist-up portrait" : "other"));
const oldProp = oldP.map((p) => /\b(mug|cup|clipboard|book|guitar|glass)\b/i.exec(p)?.[1]?.toLowerCase() ?? "none");
const oldGaze = oldP.map((p) => (/(?:into|down|at) the (?:lens|camera)|eyes (?:fixed )?on the camera|looking into the camera/i.test(p) ? "lens" : "other"));
const sh = [...plans.values()].map((x) => x.shot);
log("\n==== COUNTS (before -> after) over", cards.length, "cards ====");
log("places  OLD:", tally(oldPlace), "\n        NEW:", tally(sh.map((s) => s.placeId)));
log("kinds  NEW:", tally(sh.map((s) => s.placeKind)));
log("framing OLD:", tally(oldFraming), "\n        NEW:", tally(sh.map((s) => s.framingId)));
log("light   OLD:", tally(oldLight), "\n        NEW:", tally(sh.map((s) => s.lightId)));
log("props   OLD:", tally(oldProp), "\n        NEW:", tally(sh.map((s) => s.prop ?? "none")));
log("gaze    OLD:", tally(oldGaze), "\n        NEW:", tally(sh.map((s) => s.gaze)));
log("traits  NEW:", tally(sh.map((s) => s.trait)));
log("expressions NEW:", tally(sh.map((s) => s.momentId.split("+")[0]!)), "| smiling:", sh.filter((s) => s.smiles).length, "not smiling:", sh.filter((s) => !s.smiles).length, "closed half-smile:", sh.filter((s) => s.closedHalf).length);
log("postures NEW:", tally(sh.map((s) => s.momentId.split("+")[1]!)));
for (const min of [5, 3]) {
  log(`sentences shared by >= ${min} prompts  OLD: ${shared(oldP, min).length}  NEW: ${shared(newP, min).length}`);
}
log("NEW shared (>=3):"); for (const x of shared(newP, 3)) log(`  x${x.n}  ${x.s}`);
log("OLD shared (>=5):"); for (const x of shared(oldP, 5)) log(`  x${x.n}  ${x.s.slice(0, 110)}`);

// ---- sheet lines -> performance (the trace the owner asked for) ------------------------------------------------------------------
log("\n==== ONE WORD PER PERSON -> EXPRESSION + POSTURE + HANDS (match them blind) ====");
for (const c of cards) {
  const sh = plans.get(c.id)!.shot;
  log(`${c.id} ${c.name.padEnd(24)} ${sh.trait.toUpperCase().padEnd(8)} | ${sh.expression} | ${sh.posture}${sh.hands ? ` | hands: ${sh.hands}` : ""}`
    + `\n    sheet: type "${c.castingType?.label ?? ""}" read "${c.castingType?.read ?? ""}"; demeanor "${c.demeanor ?? ""}"`
    + `\n    place/light: ${sh.placeId} / ${sh.lightId}; from: ${sh.why}`);
}

// ---- near-identical hair lines (the text builder's cast-wide table owns these) -----------------------------------------------
const hairTokens = (c: Card): Set<string> => {
  const pc = (c as unknown as { physicalCharacteristics?: { hair?: string; photoHair?: string } }).physicalCharacteristics;
  return new Set(`${pc?.photoHair ?? ""} ${pc?.hair ?? ""}`.toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !["neat", "neatly", "close", "with", "that", "back", "off", "the", "and", "kept", "left", "just", "past", "even", "tidy", "sharp", "short"].includes(w)) ?? []);
};
log("\n==== NEAR-IDENTICAL HAIR LINES (shared words / union >= 0.4) ====");
for (let i = 0; i < cards.length; i++) for (let j = 0; j < i; j++) {
  const a = hairTokens(cards[i]!), b = hairTokens(cards[j]!);
  const inter = [...a].filter((w) => b.has(w)), union = new Set([...a, ...b]).size;
  if (union > 0 && inter.length / union >= 0.4) log(`${cards[j]!.id} ${cards[j]!.name} / ${cards[i]!.id} ${cards[i]!.name}: ${inter.join(", ")}`);
}

// ---- the checklist (the owner, 2026-11-15): marked per prompt, printed at the top --------------------------------------------------
const faces = dealFaceCards(cast.map((c) => castSheetOf(c)));
const AX = ["shape", "jaw", "brows", "neck", "nose", "eyes", "mouth", "quirk"] as const;
const caps = shotCaps(cards.length);
const cnt = (xs: string[], x: string): number => xs.filter((y) => y === x).length;
const placesAll = [...plans.values()].map((p) => p.shot.placeId), lightsAll = [...plans.values()].map((p) => p.shot.lightId);
const rows: string[] = [];
const placeKindsAll = [...plans.values()].map((p) => p.shot.placeKind);
const CHECK = [
  "R1 the documentary wording (the owner's pick): a plain, honest portrait of a local resident, nothing retouched, an ordinary person not a model; no beautifying or gloss words (best, flattering, groomed, polished, hair and makeup done, well-kept, sharp)",
  "R2 ONE portrait format for the whole cast: the identical framing, lens and angle on every card; nothing about framing is dealt (a sheet of 15 reads as one photographer's series)",
  "R3 personality at a glance: one trait word from the sheet; a full-strength expression, a posture and the hands from the sheet; closed half-smile on <= 3, >= 4 not smiling, no expression or posture on more than 2",
  "R4 a real photograph: real skin and hair, worn everyday clothes, the real place in normal focus, available light, nothing retouched",
  "R5 differs from the others in place, light and pose: place (<=3), light (<=4), a performance nobody else has",
  "R6 a distinct face: differs from every other card on >= 4 of 8 face axes",
  "R7 no repeated props, no work props, nothing held unless the sheet gives a reason",
  "R8 consistent set: the posture fits the place (seat, lean, perch), nothing held with both hands busy",
  "R9 pre-season cast photo on location: the place is from the person's own ordinary day, looks like their region, the reason is traced to their sheet (hometown, biography, type)",
  "R10 the job does not define the photo: at most 3 of 15 near work, none in uniform or work gear, no work props",
  "R11 the person looks like their life: the prompt says 'an ordinary person, not a model: a <age>-year-old <vocation> from <hometown>; grooming, hands, build and clothes fit that life'. A CARD whose own style contradicts the life (designer linen on a line cook) is reported as a card DEFECT, not photographed faithfully",
  "R13 stage direction test: read each dealt moment as a stage direction; fail any a stranger would find odd to see in a framed cast photo (hunched, slumped, elbows on knees, hands dangling, lunging, bared teeth, fists, pointing, flexing, fierce); every posture is upright or leaning lightly on something the place has, and holds the head at the same distance",
  "R12 marks: no tooth gap ever; a mark is a minor detail inside the face sentence, once, never a sentence of its own",
];
const LIFE_MISMATCH = /\b(?:minimalist monochrome|designer|couture|silk|cashmere|linen|glam|runway|tailored|high fashion|luxury)\b/i;
const MANUAL_JOB = /\b(?:cook|chef|trimmer|nurse|paramedic|firefighter|mechanic|welder|electrician|plumber|carpenter|farmer|driver|trucker|cashier|server|waiter|janitor|laborer|coach|roofer|barista|aide|technician)\b/i;
const cardDefects: string[] = [];
let allOk = true;
for (const c of cards) {
  const pr = fresh.find((x) => x.houseguestId === c.id)!.prompt, sh = plans.get(c.id)!.shot, f = faces.get(c.id)!;
  const po = POSTURES.find((x) => x.id === sh.momentId.split("+")[1])!;
  const dist = Math.min(...[...faces].filter(([id]) => id !== c.id).map(([, g]) => AX.filter((a) => g[a] !== f[a]).length));
  const pcAny = (c as unknown as { physicalCharacteristics?: { wardrobe?: string[]; style?: string; distinguishingMark?: string; facialFeatures?: string } }).physicalCharacteristics;
  const clothes = `${(pcAny?.wardrobe ?? []).join(" ; ")} ; ${pcAny?.style ?? ""}`;
  const defect = MANUAL_JOB.test(c.vocation ?? "") && LIFE_MISMATCH.test(clothes);
  if (defect) cardDefects.push(`${c.id} ${c.name} (${c.vocation}): card style/wardrobe "${clothes.slice(0, 120)}" does not fit the life`);
  const gapInCard = /gap-?toothed|gap between|tooth gap/i.test(`${pcAny?.distinguishingMark ?? ""} ${pcAny?.facialFeatures ?? ""}`);
  const r = [
    /^A plain, honest portrait of a local resident by a newspaper documentary photographer/.test(pr) && /nothing retouched/.test(pr) && /not a model/.test(pr) && !/best|flatter|hair and makeup|groomed|polished|well-kept|stunning|professional portrait|high quality|sharp|glossy|sleek|designer|airbrushed|presented well/i.test(pr),
    sh.framingId === PORTRAIT_FORMAT.id && sh.framing === PORTRAIT_FORMAT.phrase && sh.lens === PORTRAIT_FORMAT.lens && sh.angle === PORTRAIT_FORMAT.angle && pr.includes(PORTRAIT_FORMAT.phrase) && pr.includes(PORTRAIT_FORMAT.lens),
    /^trait \w+ from (?:type|read|demeanor|voice)/.test(sh.why) && sh.expression !== "" && sh.posture !== "" && (sh.hands !== "" || po.fixedHands),
    /real skin and hair/.test(pr) && /worn everyday clothes/.test(pr) && /normal focus/.test(pr) && /available light/.test(pr) && !/fine lines|no retouching|flash|tilted, caught|tilted angle/.test(pr),
    cnt(placesAll, sh.placeId) <= caps.place && cnt(lightsAll, sh.lightId) <= caps.light && cnt([...plans.values()].map((p) => p.shot.momentId), sh.momentId) === 1,
    dist >= 4,
    (sh.prop === undefined || /paperback|coffee cup|guitar|camera/.test(sh.prop)) && !/clipboard|glove|keys|dish towel|pencil|\bmug\b/.test(`${sh.prop ?? ""} ${sh.hands} ${sh.moment}`),
    !(sh.prop !== undefined && po.fixedHands),
    /place \S+ \(/.test(sh.why) && /hometown/.test(sh.why) && /where they live/.test(pr) && (c.hometown ? pr.includes(c.hometown.trim()) : true),
    placeKindsAll.filter((x) => x === "work-adjacent").length <= 3 && !/\b(?:scrubs|turnout gear|apron|badge|lanyard|uniform|hard hat|stethoscope)\b/i.test(pr.replace("never a uniform, scrubs, apron, badge or work gear", "")),
    /An ordinary person, not a model/.test(pr) && (!c.vocation || pr.includes(`a ${c.age}-year-old ${c.vocation}`)),
    !/gap/i.test(pr) && !/\.\s+(?:A |An )?(?:light )?(?:freckles|tattoo|dimples|nose stud|stud earring|glasses|beauty mark)/i.test(pr),
  ];
  if (gapInCard) cardDefects.push(`${c.id} ${c.name}: the CARD names a tooth gap (the prompt never passes it): ${pcAny?.distinguishingMark ?? ""} / ${pcAny?.facialFeatures ?? ""}`);
  r.push(!/hunch|slump|sprawl|lung|crouch|elbows on (?:the )?knees|elbow on the knee|between the knees|hanging|behind the head|chin resting|on one fist|\bfists?\b|point\w* at|thumbs up|flex|jazz|snarl|bared|fierce|mugg|comic|disbelief|startled|wiggl|slapping|stretched out|flush/i.test(sh.moment) && (po.needs !== "table" || /table|booth/.test(sh.posture)));
  if (r.includes(false)) allOk = false;
  rows.push(`${c.id} ${c.name.padEnd(24)} ${r.map((x, i) => `R${i + 1}:${x ? "ok" : "NO"}`).join(" ")}  (${sh.trait}, ${sh.momentId.split("+")[0]}, ${sh.momentId.split("+")[1]}, ${sh.placeId}, ${sh.lightId}, face distance ${dist})`);
}
console.log("==== CHECKLIST (the owner 2026-11-15) ====");
for (const x of CHECK) console.log(x);
console.log("\nMarked per prompt (automatic checks on the built prompt and its cards; R3 and R1's tone still need the owner's eye on the photo):");
for (const x of rows) console.log(x);
console.log("Card defects (R11 / R12 NO from the CARD itself: the text builder fixes these at the source):");
for (const d of cardDefects) console.log("  " + d);
console.log("Note: an R10 NO means the CARD's own wardrobe or style names a badge, lanyard or uniform (the text builder owns that: the photo builder only passes it through).");
console.log(allOk ? "ALL 15 PASS R1-R8\n" : "SOME FAIL\n");
{
  const exs = [...plans.values()].map((p) => p.shot.momentId.split("+")[0]!);
  const hs = [...plans.values()].map((p) => p.shot.hands).filter((h) => h !== "");
  const fams = [...plans.values()].flatMap((p) => [p.shot.posture, p.shot.hands].map((t) => gestureFamily(t))).filter((f): f is string => f !== undefined);
  const over = (xs: string[], max: number): string => [...new Set(xs)].filter((x) => xs.filter((y) => y === x).length > max).map((x) => `${x} x${xs.filter((y) => y === x).length}`).join("; ") || "none";
  console.log(`Repeats over 1 per cast: expressions: ${over(exs, 1)} | hands: ${over(hs, 1)} | gesture families: ${over(fams, 1)} | places over 2: ${over(placesAll, 2)} | postures over 1: ${over([...plans.values()].map((p) => p.shot.momentId.split("+")[1]!), 1)}`);
  console.log(`Eyes shut: ${[...plans.values()].filter((p) => /eyes (?:squeezed|crinkled nearly) shut|shut/.test(p.shot.moment)).length} cards`);
  const stripped = [...plans.values()].map((p, i) => p.shot.place.replace(new RegExp((cards[i]!.hometown ?? "@@").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "TOWN"));
  console.log(`Setting sentences with the town removed: ${new Set(stripped).size} distinct of ${stripped.length} (two prompts with the same one would be the same place AND region)`);
  console.log("Stage directions (read each as an instruction to a person being photographed):");
  for (const c of cards) console.log(`  ${c.id} ${plans.get(c.id)!.shot.moment}`);
  console.log("");
}
console.log(out.join("\n"));
