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
import { dealPortraitPlans, dealFaceCards, MOMENTS, shotCaps } from "../src/engine/shotCards";

interface Card {
  id: string; name: string; age: number; presentation: string; vocation?: string; demeanor?: string; identityConcept?: string;
  ethnicity?: string; genderPresentation?: "man" | "woman" | "nonbinary"; castingType?: { label?: string; read?: string };
  voice?: string | { energy?: string }; physicalCharacteristics?: never; appearance?: string;
}
const [cardsPath, oldPath] = process.argv.slice(2);
if (!cardsPath || !oldPath) { console.error("usage: orw480-shot-report.ts <cards.json> <old-prompts.json>"); process.exit(2); }
const out: string[] = [];
const log = (...a: unknown[]): void => { out.push(a.join(" ")); };
const cards = JSON.parse(readFileSync(cardsPath, "utf8")) as Card[];
const old = JSON.parse(readFileSync(oldPath, "utf8")) as { id: string; prompt: string }[];

const cast = cards.map((c) => ({
  id: c.id, name: c.name, appearance: c.appearance ?? "card", age: c.age, presentation: c.presentation,
  ...(c.physicalCharacteristics ? { physicalCharacteristics: c.physicalCharacteristics } : {}),
  ...(c.ethnicity ? { ethnicity: c.ethnicity } : {}), ...(c.genderPresentation ? { genderPresentation: c.genderPresentation } : {}),
  ...(c.demeanor ? { demeanor: c.demeanor } : {}), ...(c.identityConcept ? { identityConcept: c.identityConcept } : {}),
  ...(c.vocation ? { vocation: c.vocation } : {}), ...(c.castingType ? { castingType: c.castingType } : {}),
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
log("framing OLD:", tally(oldFraming), "\n        NEW:", tally(sh.map((s) => s.framingId)));
log("light   OLD:", tally(oldLight), "\n        NEW:", tally(sh.map((s) => s.lightId)));
log("props   OLD:", tally(oldProp), "\n        NEW:", tally(sh.map((s) => s.prop ?? "none")));
log("gaze    OLD:", tally(oldGaze), "\n        NEW:", tally(sh.map((s) => s.gaze)));
log("moments NEW:", tally(sh.map((s) => s.momentId)));
for (const min of [5, 3]) {
  log(`sentences shared by >= ${min} prompts  OLD: ${shared(oldP, min).length}  NEW: ${shared(newP, min).length}`);
}
log("NEW shared (>=3):"); for (const x of shared(newP, 3)) log(`  x${x.n}  ${x.s}`);
log("OLD shared (>=5):"); for (const x of shared(oldP, 5)) log(`  x${x.n}  ${x.s.slice(0, 110)}`);

// ---- sheet lines -> moment (the trace Kevin asked for) -------------------------------------------------------------------------
log("\n==== SHEET LINES -> MOMENT ====");
for (const c of cards) {
  const sh = plans.get(c.id)!.shot;
  log(`${c.id} ${c.name}: type "${c.castingType?.label ?? ""}" read "${c.castingType?.read ?? ""}"; demeanor "${c.demeanor ?? ""}"`
    + `\n    -> ${sh.framingId} / ${sh.placeId} / ${sh.lightId} / gaze ${sh.gaze}: ${sh.moment}\n    from: ${sh.why}`);
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

// ---- the checklist (Kevin, 2026-11-15): marked per prompt, printed at the top --------------------------------------------------
const faces = dealFaceCards(cast.map((c) => castSheetOf(c)));
const AX = ["shape", "jaw", "brows", "neck", "nose", "eyes", "mouth", "quirk"] as const;
const caps = shotCaps(cards.length);
const cnt = (xs: string[], x: string): number => xs.filter((y) => y === x).length;
const placesAll = [...plans.values()].map((p) => p.shot.placeId), lightsAll = [...plans.values()].map((p) => p.shot.lightId);
const rows: string[] = [];
const CHECK = [
  "R1 official cast photo by the production's photographer: the person knows and is presented well (not paparazzi, not surveillance)",
  "R2 the face is large and clear: close-up / half-length / three-quarter only, face size stated, clear in a square crop",
  "R3 personality from the person's own sheet: pose, expression and energy traced to casting read, demeanor, voice",
  "R4 a real photograph: real skin, a readable real place, real garments, natural hands",
  "R5 differs from the others: place (<=3), light (<=4), a moment nobody else has",
  "R6 a distinct face: differs from every other card on >= 4 of 8 face axes",
  "R7 no repeated props, no work props, nothing held unless the sheet gives a reason",
  "R8 consistent set: framing, place and moment agree (no body pose in a close-up, nothing held with both hands busy)",
];
let allOk = true;
for (const c of cards) {
  const pr = fresh.find((x) => x.houseguestId === c.id)!.prompt, sh = plans.get(c.id)!.shot, f = faces.get(c.id)!;
  const m = MOMENTS.find((x) => x.id === sh.momentId)!;
  const dist = Math.min(...[...faces].filter(([id]) => id !== c.id).map(([, g]) => AX.filter((a) => g[a] !== f[a]).length));
  const r = [
    /official cast photo/.test(pr) && /presented well/.test(pr) && !/hid|crouch|sneak|whisper|creep/.test(sh.moment),
    ["close", "half", "three-quarter"].includes(sh.framingId) && /face/.test(sh.framing) && /square crop/.test(pr),
    /type|read|demeanor/.test(sh.why) && !/^no line/.test(sh.why),
    /visible pores/.test(pr) && /ordinary real garments/.test(pr) && /readable/.test(pr),
    cnt(placesAll, sh.placeId) <= caps.place && cnt(lightsAll, sh.lightId) <= caps.light && [...plans.values()].filter((p) => p.shot.momentId === sh.momentId).length === 1,
    dist >= 4,
    (sh.prop === undefined || /paperback|coffee cup|guitar|camera/.test(sh.prop)) && !/clipboard|glove|keys|dish towel|pencil|mug/.test(pr),
    !(sh.framingId === "close" && m.body === true) && !(sh.prop !== undefined && m.hands === true),
  ];
  if (r.includes(false)) allOk = false;
  rows.push(`${c.id} ${c.name.padEnd(24)} ${r.map((x, i) => `R${i + 1}:${x ? "ok" : "NO"}`).join(" ")}  (${sh.framingId}, ${sh.placeId}, ${sh.lightId}, ${sh.momentId}, face distance ${dist})`);
}
console.log("==== CHECKLIST (Kevin 2026-11-15) ====");
for (const x of CHECK) console.log(x);
console.log("\nMarked per prompt (automatic checks on the built prompt and its cards; R3 and R1's tone still need Kevin's eye on the photo):");
for (const x of rows) console.log(x);
console.log(allOk ? "ALL 15 PASS R1-R8\n" : "SOME FAIL\n");
console.log(out.join("\n"));
