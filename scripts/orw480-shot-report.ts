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
import { dealPortraitPlans } from "../src/engine/shotCards";

interface Card {
  id: string; name: string; age: number; presentation: string; vocation?: string; demeanor?: string; identityConcept?: string;
  ethnicity?: string; genderPresentation?: "man" | "woman" | "nonbinary"; castingType?: { label?: string; read?: string };
  voice?: string | { energy?: string }; physicalCharacteristics?: never; appearance?: string;
}
const [cardsPath, oldPath] = process.argv.slice(2);
if (!cardsPath || !oldPath) { console.error("usage: orw480-shot-report.ts <cards.json> <old-prompts.json>"); process.exit(2); }
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
  console.log(`\n=== ${c.id} ${c.name} (${c.age}, ${c.vocation ?? ""}; ${c.castingType?.label ?? ""})\nOLD: ${o}\nNEW: ${n}`);
}

const oldP = old.map((x) => x.prompt), newP = fresh.map((x) => x.prompt);
const oldPlace = oldP.map((p) => /Setting: (?:the house )?([^,.]+)/.exec(p)?.[1] ?? "?");
const oldLight = oldP.map((p) => /Light: ([^.]+)\./.exec(p)?.[1] ?? "?");
const oldFraming = oldP.map((p) => (/Waist-up portrait/.test(p) ? "waist-up portrait" : "other"));
const oldProp = oldP.map((p) => /\b(mug|cup|clipboard|book|guitar|glass)\b/i.exec(p)?.[1]?.toLowerCase() ?? "none");
const oldGaze = oldP.map((p) => (/(?:into|down|at) the (?:lens|camera)|eyes (?:fixed )?on the camera|looking into the camera/i.test(p) ? "lens" : "other"));
const sh = [...plans.values()].map((x) => x.shot);
console.log("\n==== COUNTS (before -> after) over", cards.length, "cards ====");
console.log("places  OLD:", tally(oldPlace), "\n        NEW:", tally(sh.map((s) => s.placeId)));
console.log("framing OLD:", tally(oldFraming), "\n        NEW:", tally(sh.map((s) => s.framingId)));
console.log("light   OLD:", tally(oldLight), "\n        NEW:", tally(sh.map((s) => s.lightId)));
console.log("props   OLD:", tally(oldProp), "\n        NEW:", tally(sh.map((s) => s.prop ?? "none")));
console.log("gaze    OLD:", tally(oldGaze), "\n        NEW:", tally(sh.map((s) => s.gaze)));
console.log("moments NEW:", tally(sh.map((s) => s.momentId)));
for (const min of [5, 3]) {
  console.log(`sentences shared by >= ${min} prompts  OLD: ${shared(oldP, min).length}  NEW: ${shared(newP, min).length}`);
}
console.log("NEW shared (>=3):"); for (const x of shared(newP, 3)) console.log(`  x${x.n}  ${x.s}`);
console.log("OLD shared (>=5):"); for (const x of shared(oldP, 5)) console.log(`  x${x.n}  ${x.s.slice(0, 110)}`);
