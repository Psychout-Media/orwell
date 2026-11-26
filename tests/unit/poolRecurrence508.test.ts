import { describe, it, expect } from "vitest";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { generateHouse } from "../../src/engine/characterFactory";
import { generateCastDeepLayer } from "../../src/engine/deepProfile";
import { generateDiversityLayer } from "../../src/engine/diversity";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import table from "../../src/domain/poolRecurrence.json";

// ORW-508 ratchet: how much does each player-facing card field repeat inside a cast and from one season to the
// next? Over 200 seeded casts of 15, every field in src/domain/poolRecurrence.json must be no worse than its
// recorded ceiling. A fix that widens a field lowers its ceiling in the same PR; nothing may creep back.
// distinguishingMark counts named marks only ("none notable" is the plain majority by design).

export const SEEDS = Array.from({ length: table.casts }, (_, i) => 1000 + i * 7919);
type Cast = Record<string, string[]>;

export function castOf(seed: number): Cast {
  const { npcs } = generateHouse(new SeededRandom(seed));
  const layer = generateCastDeepLayer(seed, npcs);
  const div = generateDiversityLayer(seed, npcs);
  const c: Cast = {};
  const push = (k: string, v: unknown): void => { if (v !== undefined && v !== null && v !== "") (c[k] ??= []).push(String(v)); };
  for (const n of npcs) {
    const ch = n.character; const pub = layer.public[n.id]!; const pc = pub.physicalCharacteristics; const hid = layer.hidden[n.id]!;
    const [given, ...rest] = n.name.split(" ");
    push("name.given", given); push("name.surname", rest.join(" "));
    push("vocation", ch.vocation); push("hometown", ch.hometown); push("hometown.state", String(ch.hometown).split(", ").pop());
    push("demeanor", ch.demeanor); push("age", ch.age);
    if (!/^none\b/i.test(String(pc.distinguishingMark))) push("phys.distinguishingMark", pc.distinguishingMark); push("phys.facialFeatures", pc.facialFeatures); push("phys.style", pc.style);
    push("castingType.read", pub.castingType.read);
    push("phys.skinTone", pc.skinTone); push("phys.heightBuild", pc.heightBuild); push("phys.hair", pc.hair); push("phys.ageLook", pc.ageLook);
    const m = pub.biography.match(/^Outside the house, they are (.*?) who (.*?) (and .*?)\. (.*)$/);
    if (m) { push("bio.root", m[2]); push("bio.drive", m[3]); push("bio.closer", m[4]); }
    push("castingType.label", pub.castingType.label);
    const v = ch.voice;
    if (v) { for (const k of ["register", "rhythm", "energy", "directness", "humor", "stressTell", "signature"] as const) push(`voice.${k}`, v[k]); for (const l of v.lexicon ?? []) push("voice.lexicon", l); }
    push("hidden.dayOnePerception", hid.dayOnePerception?.read);
    for (const h of ch.hiddenElements ?? []) push("hiddenElement.detail", h.detail);
    const d = div.public[n.id]; if (d) push("ethnicity", (d as unknown as { ethnicity?: unknown }).ethnicity);
  }
  return c;
}

export function measure(casts: Cast[], field: string) {
  const per = casts.map((c) => c[field] ?? []);
  const all = per.flat();
  const counts = new Map<string, number>();
  for (const v of all) counts.set(v, (counts.get(v) ?? 0) + 1);
  const inCasts = new Map<string, number>();
  for (const vs of per) for (const v of new Set(vs)) inCasts.set(v, (inCasts.get(v) ?? 0) + 1);
  let shared = 0;
  for (let i = 0; i + 1 < per.length; i++) { const b = new Set(per[i + 1]); for (const v of new Set(per[i])) if (b.has(v)) shared++; }
  return {
    distinct: counts.size,
    topShare: Math.max(...counts.values()) / all.length,
    castPresenceMax: Math.max(...inCasts.values()) / per.length,
    sharedConsecutive: shared / (per.length - 1),
  };
}

describe("ORW-508 recurrence ratchet (200 seeded casts)", () => {
  const casts = SEEDS.map(castOf);
  for (const [field, t] of Object.entries(table.fields)) {
    it(`${field}: no worse than its ceiling (measured ${t.measured.distinct} distinct, top ${(t.measured.topShare * 100).toFixed(1)}%)`, () => {
      const m = measure(casts, field);
      expect(m.distinct, "distinct values").toBeGreaterThanOrEqual(t.floorDistinct);
      expect(m.topShare, "most common value's share").toBeLessThanOrEqual(t.maxTopShare);
      expect(m.castPresenceMax, "share of casts holding the most common value").toBeLessThanOrEqual(t.maxCastPresence);
      expect(m.sharedConsecutive, "values shared by two consecutive casts").toBeLessThanOrEqual(t.maxSharedConsecutive);
    });
  }
  it("the table records a target no looser than its ceiling and the before numbers", () => {
    for (const [f, t] of Object.entries(table.fields)) {
      expect(t.target.distinct, f).toBeGreaterThanOrEqual(t.floorDistinct);
      expect(t.before.distinct, f).toBeGreaterThan(0);
    }
  });
});

describe("ORW-508 recurrence ratchet, unseeded played-season casts (the real name, town and job tables)", () => {
  const played = table.played;
  const casts: Cast[] = Array.from({ length: played.casts }, () => {
    const house = new GameSessionAdapter().preSeedCast({}).house as unknown as Array<{ name: string; vocation?: string; hometown?: string }>;
    return {
      "name.given": house.map((h) => h.name.split(" ")[0]!),
      "name.surname": house.map((h) => h.name.split(" ").slice(1).join(" ")),
      hometown: house.map((h) => h.hometown!),
      vocation: house.map((h) => h.vocation!),
    };
  });
  for (const [field, t] of Object.entries(played.fields)) {
    it(`${field}: no worse than its ceiling on ${played.casts} unseeded casts (before: ${t.before.distinct} distinct)`, () => {
      const m = measure(casts, field);
      expect(m.distinct, "distinct values").toBeGreaterThanOrEqual(t.floorDistinct);
      expect(m.topShare, "most common value's share").toBeLessThanOrEqual(t.maxTopShare);
      expect(m.castPresenceMax, "share of casts holding the most common value").toBeLessThanOrEqual(t.maxCastPresence);
      expect(m.sharedConsecutive, "values shared by two consecutive casts").toBeLessThanOrEqual(t.maxSharedConsecutive);
    });
  }
});
