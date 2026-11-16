/**
 * ORW-480: print the new photo prompts, ready to send, for a few houseguests of a cast file (no image or model call).
 * The shot and face cards are dealt across the WHOLE cast (so each prompt is exactly what the full cast run would send),
 * and only the named ids are printed.
 *
 *   npx tsx scripts/orw480-three.ts <cards.json> npc:6 npc:3 npc:15
 *   npx tsx scripts/orw480-three.ts <cards.json> --ab npc:3        # realism A/B on ONE person: keys npc_3_a (press kit), npc_3_b (documentary), npc_3_c (minimal)
 *   npx tsx scripts/orw480-three.ts <cards.json> --realism documentary npc:3 npc:6 npc:8   # the whole three with one wording
 *
 * Output: for each prompt a header `--- <key> (<name>)` then the prompt on the next line.
 */
import { readFileSync } from "node:fs";
import { buildCastPortraitPrompts, type RealismVariant } from "../src/engine/portraitPrompts";

const args = process.argv.slice(2);
const cardsPath = args.shift();
const ab = args.includes("--ab");
const ri = args.indexOf("--realism");
const realism = (ri >= 0 ? args[ri + 1] : "press") as RealismVariant;
const ids = args.filter((a, i) => !a.startsWith("--") && i !== ri + 1);
if (!cardsPath || ids.length === 0 || !["press", "documentary", "minimal"].includes(realism)) { console.error("usage: orw480-three.ts <cards.json> [--ab | --realism press|documentary|minimal] <id> [<id> ...]"); process.exit(2); }
const cards = JSON.parse(readFileSync(cardsPath, "utf8")) as Array<Record<string, any>>;
const cast = cards.map((c) => ({
  id: c.id as string, name: c.name as string, appearance: (c.appearance as string) ?? "card", age: c.age as number, presentation: c.presentation as string,
  ...(c.physicalCharacteristics ? { physicalCharacteristics: c.physicalCharacteristics } : {}),
  ...(c.ethnicity ? { ethnicity: c.ethnicity } : {}), ...(c.genderPresentation ? { genderPresentation: c.genderPresentation } : {}),
  ...(c.demeanor ? { demeanor: c.demeanor } : {}), ...(c.identityConcept ? { identityConcept: c.identityConcept } : {}),
  ...(c.vocation ? { vocation: c.vocation } : {}), ...(c.hometown ? { hometown: c.hometown } : {}), ...(c.biography ? { biography: c.biography } : {}), ...(c.castingType ? { castingType: c.castingType } : {}),
  ...(c.voice ? { voiceEnergy: typeof c.voice === "string" ? c.voice : (c.voice.energy ?? "") } : {}),
}));
const variants: Array<[string, RealismVariant]> = ab ? [["_a", "press"], ["_b", "documentary"], ["_c", "minimal"]] : [["", realism]];
for (const [suffix, v] of variants) {
  const all = buildCastPortraitPrompts(cast, "anchor", v);
  for (const id of ids) {
    const p = all.find((x) => x.houseguestId === id);
    console.log(`\n--- ${id.replace(":", ab ? "_" : ":")}${suffix} (${p ? cards.find((c) => c.id === id)?.name : "NOT FOUND"})\n${p?.prompt ?? ""}`);
  }
}
