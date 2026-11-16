/**
 * ORW-480: print the new photo prompts, ready to send, for a few houseguests of a cast file (no image or model call).
 * The shot and face cards are dealt across the WHOLE cast (so each prompt is exactly what the full cast run would send),
 * and only the named ids are printed.
 *
 *   npx tsx scripts/orw480-three.ts <cards.json> npc:6 npc:9 npc:14
 */
import { readFileSync } from "node:fs";
import { buildCastPortraitPrompts } from "../src/engine/portraitPrompts";

const [cardsPath, ...ids] = process.argv.slice(2);
if (!cardsPath || ids.length === 0) { console.error("usage: orw480-three.ts <cards.json> <id> [<id> ...]"); process.exit(2); }
const cards = JSON.parse(readFileSync(cardsPath, "utf8")) as Array<Record<string, any>>;
const cast = cards.map((c) => ({
  id: c.id as string, name: c.name as string, appearance: (c.appearance as string) ?? "card", age: c.age as number, presentation: c.presentation as string,
  ...(c.physicalCharacteristics ? { physicalCharacteristics: c.physicalCharacteristics } : {}),
  ...(c.ethnicity ? { ethnicity: c.ethnicity } : {}), ...(c.genderPresentation ? { genderPresentation: c.genderPresentation } : {}),
  ...(c.demeanor ? { demeanor: c.demeanor } : {}), ...(c.identityConcept ? { identityConcept: c.identityConcept } : {}),
  ...(c.vocation ? { vocation: c.vocation } : {}), ...(c.hometown ? { hometown: c.hometown } : {}), ...(c.biography ? { biography: c.biography } : {}), ...(c.castingType ? { castingType: c.castingType } : {}),
  ...(c.voice ? { voiceEnergy: typeof c.voice === "string" ? c.voice : (c.voice.energy ?? "") } : {}),
}));
const all = buildCastPortraitPrompts(cast, "anchor");
for (const id of ids) {
  const p = all.find((x) => x.houseguestId === id);
  console.log(`\n--- ${id} (${p ? cards.find((c) => c.id === id)?.name : "NOT FOUND"})\n${p?.prompt ?? ""}`);
}
