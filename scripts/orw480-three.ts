/**
 * ORW-480: print the new photo prompts, ready to send, for a few houseguests of a cast file (no image or model call).
 * The shot and face cards are dealt across the WHOLE cast (so each prompt is exactly what the full cast run would send),
 * and only the named ids are printed.
 *
 *   npx tsx scripts/orw480-three.ts <cards.json> npc:6 npc:3 npc:15
 *   npx tsx scripts/orw480-three.ts <cards.json> --ab npc:3        # realism A/B on ONE person: keys npc_3_a (press kit), npc_3_b (documentary), npc_3_c (minimal)
 *   npx tsx scripts/orw480-three.ts <cards.json> --all --json     # the floor prompts as JSON { id: { name, prompt } } (input of an offline brief probe)
 *   npx tsx scripts/orw480-three.ts <cards.json> --all            # every card of the file, in order (a full cast of 15)
 *
 * `<cards.json>`: a flat list of public cards (cards-s3.json, casts/live-*.json, casts/0008-*.json), or the older casts/*.json wrapper
 * `{ "casts": [ { "cards": [...] } ] }` (the first cast, or `--cast N`).
 *
 * Output: for each prompt a header `--- <key> (<name>)` then the prompt on the next line.
 */
import { readFileSync } from "node:fs";
import { buildCastPortraitPrompts, type RealismVariant } from "../src/engine/portraitPrompts";

const args = process.argv.slice(2);
const cardsPath = args.shift();
const ab = args.includes("--ab");
const all = args.includes("--all");
const asJson = args.includes("--json");
const ci = args.indexOf("--cast");
const castN = ci >= 0 ? Number(args[ci + 1]) : 0;
const ri = args.indexOf("--realism");
const realism = (ri >= 0 ? args[ri + 1] : "documentary") as RealismVariant;
let ids = args.filter((a, i) => !a.startsWith("--") && (ri < 0 || i !== ri + 1) && (ci < 0 || i !== ci + 1));
if (!cardsPath || (ids.length === 0 && !all) || !["press", "documentary", "minimal"].includes(realism)) { console.error("usage: orw480-three.ts <cards.json> [--ab | --realism press|documentary|minimal] <id> [<id> ...]"); process.exit(2); }
const raw = JSON.parse(readFileSync(cardsPath, "utf8")) as unknown;
const cards = (Array.isArray(raw) ? raw : (raw as { casts?: Array<{ cards?: unknown[] }> }).casts?.[castN]?.cards ?? []) as Array<Record<string, any>>;
if (cards.length === 0) { console.error("no cards found in " + cardsPath); process.exit(2); }
if (all) ids = cards.map((c) => c.id as string);
const cast = cards.map((c) => ({
  id: c.id as string, name: c.name as string, appearance: (c.appearance as string) ?? "card", age: c.age as number, presentation: c.presentation as string,
  ...(c.physicalCharacteristics ? { physicalCharacteristics: c.physicalCharacteristics } : {}),
  ...(c.ethnicity ? { ethnicity: c.ethnicity } : {}), ...(c.genderPresentation ? { genderPresentation: c.genderPresentation } : {}),
  ...(c.demeanor ? { demeanor: c.demeanor } : {}), ...(c.identityConcept ? { identityConcept: c.identityConcept } : {}),
  ...(c.vocation ? { vocation: c.vocation } : {}), ...(c.hometown ? { hometown: c.hometown } : {}), ...(c.biography ? { biography: c.biography } : {}), ...(c.castingType ? { castingType: c.castingType } : {}),
  ...(c.voice ? { voiceEnergy: typeof c.voice === "string" ? c.voice : (c.voice.energy ?? "") } : {}),
}));
const variants: Array<[string, RealismVariant]> = ab ? [["_a", "press"], ["_b", "documentary"], ["_c", "minimal"]] : [["", realism]];
if (asJson) {
  // machine-readable floor prompts for the photo-brief probe: { "<id>": { name, prompt } }
  const all2 = buildCastPortraitPrompts(cast, "anchor", realism);
  const o: Record<string, { name: string; prompt: string }> = {};
  for (const id of ids) { const p = all2.find((x) => x.houseguestId === id); if (p) o[id] = { name: p.name, prompt: p.prompt }; }
  console.log(JSON.stringify(o, null, 1));
  process.exit(0);
}
for (const [suffix, v] of variants) {
  const all = buildCastPortraitPrompts(cast, "anchor", v);
  for (const id of ids) {
    const p = all.find((x) => x.houseguestId === id);
    console.log(`\n--- ${id.replace(":", ab ? "_" : ":")}${suffix} (${p ? cards.find((c) => c.id === id)?.name : "NOT FOUND"})\n${p?.prompt ?? ""}`);
  }
}
