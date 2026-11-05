import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderInventory, undeclaredReads, declaredNames, envNamesReadInSrc } from "../support/flagInventory";

/**
 * B45 - the flag inventory cannot drift. (1) Every ORWELL_* name `src/` reads is DECLARED somewhere (the /health registry, the deploy defaults, the never-flipped pin, or the operational allow-list);
 * a new raw `process.env.ORWELL_X` read that nothing declares fails here. (2) `docs/FLAG-INVENTORY.md` is exactly what the generator emits now (regenerate with `npx tsx scripts/gen-flag-inventory.ts`).
 */
describe("ORWELL_* flag inventory", () => {
  it("src reads no ORWELL_* name that nothing declares", () => {
    expect(undeclaredReads(), "declare it in featureFlags.ts / orwell-env-defaults.sh / the NEVER_FLIPPED pin, or allow-list it as operational with a reason").toEqual([]);
  });
  it("the gate sees real reads and real declarations (not vacuous)", () => {
    expect(envNamesReadInSrc().length).toBeGreaterThan(40);
    expect(declaredNames().size).toBeGreaterThan(40);
    expect(envNamesReadInSrc()).toContain("ORWELL_ASSURANCES");
  });
  it("docs/FLAG-INVENTORY.md matches the generated table", () => {
    const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "FLAG-INVENTORY.md"), "utf8");
    expect(doc, "stale: run `npx tsx scripts/gen-flag-inventory.ts` and commit").toBe(renderInventory());
  });
});
