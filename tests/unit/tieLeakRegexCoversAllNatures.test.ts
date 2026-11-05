import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * AMEND 3a #2 - the 0095 Gherkin leak check listed only the original five tie natures, so a leak of any of the seven newer ones (#1909) would pass unnoticed. Pin the regex in the step file to
 * the TieNature union in src: every nature must be caught (hyphenated ones by name, the single-word ones as a serialized `nature` field). Roles only.
 */
const NATURES = ["casting-callback", "mutual-friend", "shared-hometown", "old-acquaintance", "prior-romance", "family", "ex", "old-friend", "rival", "former-teammate", "online-acquaintance"];

describe("the 0095 tie leak regex covers every TieNature", () => {
  const steps = readFileSync("features/step_definitions/pre_show_tie_reveal.steps.ts", "utf8");
  const src = readFileSync("src/engine/seededRelationships.ts", "utf8");
  const m = steps.match(/const tieRegex = (\/.*\/);/)!;
  const rx = new RegExp(m[1]!.slice(1, -1));

  it("the list here matches the union in src (a new nature fails this until the regex is extended)", () => {
    const union = src.slice(src.indexOf("export type TieNature"), src.indexOf("/** A showmance's arc"));
    const found = [...union.matchAll(/"([a-z-]+)"/g)].map((x) => x[1]!).sort();
    expect(found).toEqual([...NATURES].sort());
  });

  for (const n of NATURES) {
    it(`catches a leaked '${n}'`, () => {
      expect(rx.test(JSON.stringify({ x: { nature: n } })) || rx.test(`they are ${n} acquaintances`)).toBe(true);
    });
  }

  it("does not flag ordinary words that contain a short nature", () => {
    expect(rx.test("The house is exposed and the family photo is on the wall; a rival bakery opened.")).toBe(false);
  });
});
