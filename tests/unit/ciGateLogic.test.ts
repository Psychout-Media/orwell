import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * ORW-218 (two-tier CI): the logic of `ci-gate` (the single required check) is pinned here by running the real script from ci.yml against scenarios.
 * Rules: a failed/cancelled job fails the gate; a SKIPPED job only passes when its path filter says it does not apply (GitHub counts a skipped required
 * check as a pass, so an applicable-but-skipped job must fail); a draft PR without the `full-ci` label (full=false) can NEVER pass.
 */
const yml = readFileSync(fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)), "utf8");
const marker = '          set -euo pipefail\n          echo "Needed job results: $RESULTS"';
const start = yml.indexOf(marker);
if (start < 0) throw new Error("ci-gate script not found in ci.yml (it must stay the last job)");
const script = yml
  .slice(start)
  .split("\n")
  .map((l) => l.replace(/^ {10}/, ""))
  .join("\n");

const JOBS = ["changes", "test", "test-unit", "coverage-shard", "coverage", "smoke", "fe-unit", "fe-browser-tests", "fe-browser", "fe-responsive", "mirror-parity", "heavy-sims"];
const HEAVY_TIER = ["coverage-shard", "coverage", "smoke", "fe-browser-tests", "fe-browser", "fe-responsive", "mirror-parity", "heavy-sims"];

function gate(full: boolean, results: Record<string, string>, filters: Record<string, string> = {}): { rc: number; out: string } {
  const env = {
    ...process.env,
    ENGINE: "true", HEAVY: "true", DEPLOY: "true", FRONTEND: "true", FE_RENDER: "true", ...filters,
    FULL: String(full),
    RESULTS: JOBS.map((j) => `${j}=${results[j] ?? "success"}`).join(" "),
  };
  const r = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
  return { rc: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}
const skipHeavy = Object.fromEntries(HEAVY_TIER.map((j) => [j, "skipped"]));

describe("ci-gate (two-tier CI)", () => {
  it("passes a full run where everything succeeded", () => expect(gate(true, {}).rc).toBe(0));
  it("fails a full run with a failed job", () => expect(gate(true, { "mirror-parity": "failure" }).rc).toBe(1));
  it("fails a full run with a cancelled job", () => expect(gate(true, { "fe-unit": "cancelled" }).rc).toBe(1));
  it("fails a full run where an applicable job was skipped (skipped must not count as a pass)", () =>
    expect(gate(true, { "fe-browser-tests": "skipped" }).rc).toBe(1));
  it("passes a full run where a job was skipped because its path filter is false", () =>
    expect(gate(true, { "fe-browser-tests": "skipped", "fe-unit": "skipped" }, { FRONTEND: "false" }).rc).toBe(0));
  it("a draft with an all-green fast tier STILL fails, with the plain message", () => {
    const r = gate(false, skipHeavy);
    expect(r.rc).toBe(1);
    expect(r.out).toContain("draft: fast checks only — mark ready for the full suite");
  });
  it("a draft fails on a fast-tier failure too, and on a skipped applicable fast job", () => {
    expect(gate(false, { ...skipHeavy, "test-unit": "failure" }).rc).toBe(1);
    expect(gate(false, { ...skipHeavy, "fe-unit": "skipped" }).rc).toBe(1);
  });
  it("a draft with no applicable fast jobs (path filters all false) still fails", () =>
    expect(gate(false, { ...skipHeavy, test: "skipped", "test-unit": "skipped", "fe-unit": "skipped" }, { ENGINE: "false", FRONTEND: "false", HEAVY: "false", DEPLOY: "false", FE_RENDER: "false" }).rc).toBe(1));
});

describe("ci.yml wiring (two-tier CI)", () => {
  it("every heavy-tier job is gated on the full tier", () => {
    for (const job of ["heavy-sims", "coverage", "coverage-shard", "smoke", "fe-browser-tests", "fe-browser", "fe-responsive", "mirror-parity", "a11y-matrix"]) {
      const m = yml.match(new RegExp(`\\n  ${job}:\\n(?:    .*\\n)*?    if: (.*)\\n`));
      expect(m, job).toBeTruthy();
      expect(m![1], job).toContain("needs.changes.outputs.full == 'true'");
    }
  });
  it("the fast-tier jobs are NOT gated on the full tier", () => {
    for (const job of ["test", "test-unit", "fe-unit"]) {
      const m = yml.match(new RegExp(`\\n  ${job}:\\n(?:    .*\\n)*?    if: (.*)\\n`));
      expect(m![1], job).not.toContain("full");
    }
  });
  it("triggers: PR (incl. ready_for_review), merge_group and main", () => {
    expect(yml).toMatch(/types: \[opened, synchronize, reopened, ready_for_review\]/);
    expect(yml).toMatch(/merge_group:\n    types: \[checks_requested\]/);
    expect(yml).toMatch(/push:\n    branches: \[main\]/);
  });
});
