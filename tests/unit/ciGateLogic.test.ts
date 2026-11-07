import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * ORW-218 (two-tier CI): the logic of `ci-gate` (the single required check) is pinned here by running the real script from ci.yml against scenarios.
 * Rules: a failed/cancelled job fails the gate; a SKIPPED job only passes when its path filter says it does not apply (GitHub counts a skipped required
 * check as a pass, so an applicable-but-skipped job must fail); a draft PR without the `full-ci` label (full=false) can NEVER pass; and the tier and filter
 * outputs must be exactly `true`/`false` (an empty value from a broken `changes` job must not make every skip acceptable).
 */
const yml = readFileSync(fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)), "utf8");
const marker = '          set -euo pipefail\n          echo "Needed job results: $RESULTS"';
const start = yml.indexOf(marker);
if (start < 0) throw new Error("ci-gate script not found in ci.yml");
// The `run: |` block ends at the first non-blank line indented less than the script body (10 spaces), so a job added after ci-gate cannot leak in.
const lines = yml.slice(start).split("\n");
const end = lines.findIndex((l) => l.trim() !== "" && !l.startsWith(" ".repeat(10)));
const script = (end < 0 ? lines : lines.slice(0, end)).map((l) => l.replace(/^ {10}/, "")).join("\n");

const JOBS = ["changes", "test", "test-unit", "coverage-shard", "coverage", "smoke", "fe-unit", "fe-browser-tests", "fe-browser", "fe-responsive", "mirror-parity", "heavy-sims", "fe-web"];
const HEAVY_TIER = ["coverage-shard", "coverage", "smoke", "fe-browser-tests", "fe-browser", "fe-responsive", "mirror-parity", "heavy-sims", "fe-web"];

function gate(full: boolean, results: Record<string, string>, filters: Record<string, string> = {}): { rc: number; out: string } {
  const env = {
    ...process.env,
    ENGINE: "true", HEAVY: "true", DEPLOY: "true", FRONTEND: "true", FE_RENDER: "true", WEB: "true", FULL: String(full), ...filters,
    RESULTS: JOBS.map((j) => `${j}=${results[j] ?? "success"}`).join(" "),
  };
  const r = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
  return { rc: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}
const skipHeavy = Object.fromEntries(HEAVY_TIER.map((j) => [j, "skipped"]));
const skipAll = Object.fromEntries(JOBS.filter((j) => j !== "changes").map((j) => [j, "skipped"]));

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
  it("passes a full run where every job was skipped because every filter is false (a docs-only PR)", () =>
    expect(gate(true, skipAll, { ENGINE: "false", HEAVY: "false", DEPLOY: "false", FRONTEND: "false", FE_RENDER: "false", WEB: "false" }).rc).toBe(0));
  it("fails when a filter output is empty or not a boolean, even though every lane was skipped", () => {
    for (const bad of ["", "maybe", "True"]) {
      const r = gate(true, skipAll, { ENGINE: bad, HEAVY: "false", DEPLOY: "false", FRONTEND: "false", FE_RENDER: "false", WEB: "false" });
      expect(r.rc, `ENGINE=${JSON.stringify(bad)}`).toBe(1);
      expect(r.out).toContain("changes output 'engine'");
    }
  });
  it("fails when the tier output is missing (a broken changes job)", () => {
    const r = gate(true, skipAll, { FULL: "", ENGINE: "", HEAVY: "", DEPLOY: "", FRONTEND: "", FE_RENDER: "", WEB: "" });
    expect(r.rc).toBe(1);
    expect(r.out).toContain("changes output 'full'");
  });
  it("the /play lane (fe-web): skipped is fine only when its own filter is false", () => {
    expect(gate(true, { "fe-web": "skipped" }, { WEB: "false" }).rc).toBe(0);
    const r = gate(true, { "fe-web": "skipped" }, { WEB: "true" });
    expect(r.rc).toBe(1);
    expect(r.out).toContain("needed job 'fe-web' was SKIPPED although it applies");
    expect(gate(true, { "fe-web": "failure" }, { WEB: "false" }).rc).toBe(1);
  });
  it("fails when the web filter output is empty or not a boolean", () => {
    const r = gate(true, skipAll, { ENGINE: "false", HEAVY: "false", DEPLOY: "false", FRONTEND: "false", FE_RENDER: "false", WEB: "" });
    expect(r.rc).toBe(1);
    expect(r.out).toContain("changes output 'web'");
  });
  it("a draft with no applicable fast jobs (path filters all false) still fails", () =>
    expect(gate(false, { ...skipHeavy, test: "skipped", "test-unit": "skipped", "fe-unit": "skipped" }, { ENGINE: "false", FRONTEND: "false", HEAVY: "false", DEPLOY: "false", FE_RENDER: "false", WEB: "false" }).rc).toBe(1));
});

describe("ci.yml wiring (two-tier CI)", () => {
  it("every heavy-tier job is gated on the full tier", () => {
    for (const job of ["heavy-sims", "coverage", "coverage-shard", "smoke", "fe-browser-tests", "fe-browser", "fe-responsive", "mirror-parity", "a11y-matrix", "fe-web"]) {
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
  it("the BDD gate and the FE deps it alone needs are full-tier only in the test job", () => {
    const testJob = yml.slice(yml.indexOf("\n  test:\n"), yml.indexOf("\n  test-unit:\n"));
    for (const step of ["uses: actions/setup-python@v5", "run: pip install -r frontend/requirements.lock.txt", "run: npm run test:bdd"]) {
      expect(testJob, step).toMatch(new RegExp(`- if: needs\\.changes\\.outputs\\.full == 'true'\\n\\s+${step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    }
  });
  it("calibration-nightly skips a draft PR unless it carries full-ci, and runs when the draft is marked ready", () => {
    const cal = readFileSync(fileURLToPath(new URL("../../.github/workflows/calibration-nightly.yml", import.meta.url)), "utf8");
    const cond = "github.event_name != 'pull_request' || !github.event.pull_request.draft || contains(github.event.pull_request.labels.*.name, 'full-ci')";
    expect(cal).toContain(`  shards:\n    if: ${cond}\n`);
    expect(cal).toContain(`    if: always() && (${cond})\n`);
    expect(cal).toMatch(/types: \[opened, synchronize, reopened, labeled, ready_for_review\]/);
  });
  it("triggers: PR (incl. ready_for_review), merge_group and main", () => {
    expect(yml).toMatch(/types: \[opened, synchronize, reopened, ready_for_review\]/);
    expect(yml).toMatch(/merge_group:\n    types: \[checks_requested\]/);
    expect(yml).toMatch(/push:\n    branches: \[main\]/);
  });
});
