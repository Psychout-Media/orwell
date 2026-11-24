import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * ORW-866 (leftover of ORW-826): a sandbox user key is part of a played game's identity (the orchestrator seeds its off-screen draws from the seed and the user), so a BDD step that builds its key from Math.random()
 * plays a different season on every run. Steps use fixed keys. The environment hook (features/support/restoreProcessEnv.ts) puts process.env back after every scenario so one scenario's flags never reach the next.
 */
describe("ORW-866: BDD steps are deterministic across runs and scenarios", () => {
  const dir = join(__dirname, "..", "..", "features", "step_definitions");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  it("no step file builds a sandbox or user key from Math.random()", () => {
    const bad = files.filter((f) => /Math\.random\(\)/.test(readFileSync(join(dir, f), "utf8")));
    expect(bad, `step files using Math.random(): ${bad.join(", ")}`).toEqual([]);
  });
  it("the environment is snapshotted before and restored after every scenario", () => {
    const p = join(__dirname, "..", "..", "features", "support", "restoreProcessEnv.ts");
    expect(existsSync(p)).toBe(true);
    const src = readFileSync(p, "utf8");
    expect(src).toMatch(/Before\(/);
    expect(src).toMatch(/After\(/);
  });
});
