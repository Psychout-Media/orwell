import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { claimPhrase } from "../../src/engine/claimSource";

/**
 * ORW-1102 (audit 11-27 A9): claimPhrase had duplicate `case "voted-against"` / `"voted-to-keep"` clauses; the first pair (with `${obj}`) shadowed the second (the object-less fallback), so a claim with no object read
 * "... voted to evict undefined" in the engine line handed to the narrator. One clause each now; and the build fails on a duplicate case (esbuild `--log-override:duplicate-case=error`). Roles only.
 */
const nameOf = (id: string): string => `name-${id}`;
describe("ORW-1102 claimPhrase", () => {
  it("a vote claim with no object falls back to the player, never the word undefined", () => {
    for (const kind of ["voted-against", "voted-to-keep"] as const) {
      const text = claimPhrase({ kind, subject: "a" } as never, nameOf, "the player");
      expect(text).not.toMatch(/undefined/);
      expect(text).toContain("the player");
    }
  });
  it("with an object it names the object", () => {
    expect(claimPhrase({ kind: "voted-against", subject: "a", object: "b" } as never, nameOf, "the player")).toBe("name-a voted to evict name-b");
    expect(claimPhrase({ kind: "voted-to-keep", subject: "a", object: "b" } as never, nameOf, "the player")).toBe("name-a voted to keep name-b");
  });
  it("no kind has two case clauses in claimPhrase (the source), and the build turns a duplicate case into an error", () => {
    const src = readFileSync(new URL("../../src/engine/claimSource.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export function claimPhrase"));
    const cases = [...body.slice(0, body.indexOf("\n}\n")).matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]!);
    expect(new Set(cases).size, `duplicate case clauses: ${cases.filter((c, i) => cases.indexOf(c) !== i)}`).toBe(cases.length);
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: { build: string } };
    expect(pkg.scripts.build.match(/esbuild src\//g)!.length).toBe(pkg.scripts.build.match(/--log-override:duplicate-case=error/g)!.length);
  });
});
