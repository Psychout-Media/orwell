import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedFor } from "../support/fastCheckSeed";

/**
 * ORW-229 review (MEDIUM): CI's one automatic retry must never turn a real property-test counterexample green. tests/support/fastCheckSeed.ts makes
 * every test's fast-check seed a function of the run seed and the test id, so the retry replays the first attempt's cases. The last two tests run a
 * real nested vitest with `--retry=1` over a property that always fails and records the first value fast-check generated on each attempt.
 */
const SETUP = fileURLToPath(new URL("../support/fastCheckSeed.ts", import.meta.url));
const VITEST = fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url));
const FAST_CHECK = fileURLToPath(new URL("../../node_modules/fast-check/lib/esm/fast-check.js", import.meta.url));

function nestedRun(withSetup: boolean): { status: number | null; values: string[]; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "fc-replay-"));
  const log = join(dir, "values.log");
  writeFileSync(log, "");
  // With the setup file, the test uses the instance the hook configures (as every repo test does via "fast-check"); the control imports
  // fast-check directly and loads no setup file.
  if (withSetup) writeFileSync(join(dir, "vitest.config.mjs"), `export default { test: { setupFiles: [${JSON.stringify(SETUP)}] } };\n`);
  writeFileSync(
    join(dir, "prop.test.ts"),
    `import { appendFileSync } from "node:fs";\n` +
      (withSetup ? `import { fc } from ${JSON.stringify(SETUP)};\n` : `import fc from ${JSON.stringify(FAST_CHECK)};\n`) +
      `test("a property that always fails", () => {\n` +
      `  fc.assert(fc.property(fc.noBias(fc.integer({ min: 0, max: 2 ** 30 })), (n) => { appendFileSync(${JSON.stringify(log)}, n + "\\n"); return true; }), { numRuns: 1 });\n` +
      `  throw new Error("fails on every attempt");\n` +
      `});\n`,
  );
  const args = [VITEST, "run", "--root", dir, "--globals", "--retry=1", "--reporter=default"];
  const r = spawnSync(process.execPath, args, { cwd: dir, encoding: "utf8", env: { ...process.env, ORWELL_FC_SEED: "" }, timeout: 60_000 });
  return { status: r.status, values: readFileSync(log, "utf8").trim().split("\n"), out: `${r.stdout}${r.stderr}` };
}

describe("fast-check seed replay across CI's retry", () => {
  it("a test's seed depends only on the run seed and the test id", () => {
    expect(seedFor("file_1_0", 42)).toBe(seedFor("file_1_0", 42));
    expect(seedFor("file_1_0", 42)).not.toBe(seedFor("file_1_1", 42));
    expect(seedFor("file_1_0", 42)).not.toBe(seedFor("file_1_0", 43));
    expect(Number.isInteger(seedFor("x"))).toBe(true);
  });
  it("with the setup file, the retry replays the first attempt's cases, and the failure prints the seed", () => {
    const r = nestedRun(true);
    expect(r.status, r.out).toBe(1); // still red after the retry
    expect(r.values.length, r.out).toBe(2); // two attempts
    expect(r.values[1]).toBe(r.values[0]); // same seed => same generated case
    expect(r.out).toMatch(/\[fast-check\] "a property that always fails" ran with seed -?\d+; replay this run's cases with ORWELL_FC_SEED=\d+/);
  }, 60_000);
  it("without it (the control), the retry draws fresh cases, which is what could have hidden a real counterexample", () => {
    const r = nestedRun(false);
    expect(r.values.length, r.out).toBe(2);
    expect(r.values[1]).not.toBe(r.values[0]);
  }, 60_000);
});
