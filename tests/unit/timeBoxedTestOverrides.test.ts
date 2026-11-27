import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A TEST-LANE pin of a flag that ships ON is a known, TIME-BOXED divergence (prod and the seeded tests must not run different games for long: ORW-678's lesson). Every such pin is registered here with the card that removes it and
 * a hard expiry (the seven deployed-profile tests also skip it when they source deploy/orwell-env-defaults.sh: `ORWELL_(EMBEDDINGS|EMBED_CACHE)`); the test fails after the expiry, and it fails if a pin appears in tests/support/premiereTestDefault.ts or cucumber.cjs without being registered. Remove the pin and its row together when the card lands.
 */
const REGISTERED: Array<{ flag: string; card: string; expires: string }> = [
  { flag: "ORWELL_COMP_MECHANICS_MORE", card: "ORW-1113", expires: "2026-12-04" }, // the cucumber lane only (cucumber.cjs): 7 seed-pinned scenarios, ORW-1113
];
const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const pinned = (src: string): string[] => [...src.matchAll(/process\.env\.(ORWELL_COMP_MECHANICS_MORE)\s*=\s*"0"/g)].map((m) => m[1]!);

describe("time-boxed test overrides of shipped-on flags", () => {
  it("every pin in the test setup and cucumber config is registered, with its card", () => {
    const found = new Set([...pinned(read("tests/support/premiereTestDefault.ts")), ...pinned(read("cucumber.cjs"))]);
    for (const f of found) expect(REGISTERED.find((r) => r.flag === f), `${f} is pinned off in tests but not registered`).toBeDefined();
  });
  it("no registered override is past its expiry (the card must have landed, or the date is re-ruled here)", () => {
    for (const r of REGISTERED) expect(new Date(r.expires).getTime(), `${r.flag} (${r.card}) expired ${r.expires}`).toBeGreaterThan(Date.now());
  });
});
