import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderInventory, undeclaredReads, declaredNames, envNamesReadInSrc, stripComments } from "../support/flagInventory";
import { FEATURE_FLAGS } from "../../src/featureFlags";

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
  it("a name only MENTIONED in a comment is not a read (but a real read is)", () => {
    const code = ['// ORWELL_ONLY_IN_A_COMMENT is a future flag', '/* ORWELL_IN_A_BLOCK too */', 'const x = process.env.ORWELL_REALLY_READ === "1";'].join("\n");
    const found = [...stripComments(code).matchAll(/ORWELL_[A-Z0-9_]+/g)].map((m) => m[0]);
    expect(found).toEqual(["ORWELL_REALLY_READ"]);
  });
  it("the registry's parser agrees with how the engine actually reads each flag (strict => === \"1\", defaultOn => flagDefaultOn)", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");
    const text = (d: string): string => readdirSync(d, { withFileTypes: true }).map((e) => (e.isDirectory() ? text(join(d, e.name)) : e.name.endsWith(".ts") && !e.name.endsWith("featureFlags.ts") ? stripComments(readFileSync(join(d, e.name), "utf8")) : "")).join("\n");
    const code = text(root);
    const disagree: string[] = [];
    for (const f of FEATURE_FLAGS) {
      if (f.parser === "strict" && !new RegExp(`process\\.env\\.${f.envKey}\\s*===\\s*["']1["']|process\\.env\\[["']${f.envKey}["']\\]\\s*===\\s*["']1["']`).test(code)) disagree.push(`${f.envKey}: registry says strict but no \`=== "1"\` read`);
      if (f.parser === "defaultOn" && !code.includes(`flagDefaultOn("${f.envKey}")`) && !code.includes(`flagDefaultOn('${f.envKey}')`)) disagree.push(`${f.envKey}: registry says defaultOn but no flagDefaultOn read`);
    }
    expect(disagree, "the registry and the adapter must declare the same default").toEqual([]);
  });
});
