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

const JOBS = ["changes", "backlog-whole", "fast-checks", "test", "bdd", "test-unit", "coverage", "smoke", "fe-unit", "fe-coverage", "fe-perf-report", "fe-browser-tests", "fe-browser", "fe-responsive", "mirror-parity", "heavy-sims"];
const HEAVY_TIER = ["bdd", "coverage", "smoke", "fe-browser-tests", "fe-browser", "fe-responsive", "mirror-parity", "heavy-sims"];

function gate(full: boolean, results: Record<string, string>, filters: Record<string, string> = {}): { rc: number; out: string } {
  const env = {
    ...process.env,
    REUSE: "false", PROVED_BY: "",
    ENGINE: "true", HEAVY: "true", DEPLOY: "true", FRONTEND: "true", FE_RENDER: "true", FULL: String(full), ...filters,
    RESULTS: JOBS.map((j) => `${j}=${results[j] ?? "success"}`).join(" "),
  };
  const r = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
  return { rc: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}
const skipHeavy = Object.fromEntries(HEAVY_TIER.map((j) => [j, "skipped"]));
// ORW-758: backlog-whole has no path filter and is never reused, so it is never skipped: it runs (and passes) even on a docs-only PR.
const skipAll = Object.fromEntries(JOBS.filter((j) => j !== "changes" && j !== "backlog-whole").map((j) => [j, "skipped"]));

describe("ci-gate (two-tier CI)", () => {
  it("passes a full run where everything succeeded", () => expect(gate(true, {}).rc).toBe(0));
  it("fails a full run with a failed job", () => expect(gate(true, { "mirror-parity": "failure" }).rc).toBe(1));
  it("fails a full run with a cancelled job", () => expect(gate(true, { "fe-unit": "cancelled" }).rc).toBe(1));
  it("fails a full run where an applicable job was skipped (skipped must not count as a pass)", () =>
    expect(gate(true, { "fe-browser-tests": "skipped" }).rc).toBe(1));
  it("passes a full run where a job was skipped because its path filter is false", () =>
    expect(gate(true, { "fe-browser-tests": "skipped", "fe-unit": "skipped" }, { FRONTEND: "false" }).rc).toBe(0));
  it("a run that was not the full suite (full=false) STILL fails, with the plain message (ORW-413: a draft is now a full run, but the rule stays fail-closed)", () => {
    const r = gate(false, skipHeavy);
    expect(r.rc).toBe(1);
    expect(r.out).toContain("this run was not the full suite");
  });
  it("ORW-758: backlog-whole is a required input that always runs (no path filter, never reused: the PR body differs even when the tree does not), and its failure fails the gate", () => {
    expect(gate(true, { "backlog-whole": "failure" }).rc).toBe(1);
    const j = yml.slice(yml.indexOf("\n  backlog-whole:\n"), yml.indexOf("\n  ci-gate:\n"));
    expect(j).not.toMatch(/\n    if: /);
    expect(j).not.toMatch(/\n    needs: /);
    expect(j).toContain("PR_BODY: ${{ github.event.pull_request.body }}");
    expect(j).toContain("node ci/check_backlog_whole.mjs");
    expect(j).toContain("fetch-depth: 2");
    expect(j).toContain('git show HEAD^1:ci/backlog_baseline.json');
    const gateJob = yml.slice(yml.indexOf("\n  ci-gate:\n"));
    expect(gateJob).toContain("      - backlog-whole\n");
    expect(gateJob).toContain("backlog-whole=${{ needs.backlog-whole.result }}");
  });
  it("fast-checks is a required input: its failure or an applicable skip fails the gate; a skip fails even when both filters are false (docs-only still runs the secrets scan, ORW-1044)", () => {
    expect(gate(true, { "fast-checks": "failure" }).rc).toBe(1);
    expect(gate(true, { "fast-checks": "skipped" }).rc).toBe(1);
    expect(gate(true, { "fast-checks": "skipped" }, { ENGINE: "false", FRONTEND: "false" }).rc).toBe(1); // ORW-1044: always applies (the repo-wide secrets scan)
    expect(gate(true, { "fast-checks": "skipped" }, { ENGINE: "false" }).rc).toBe(1);
  });
  it("a draft fails on a fast-tier failure too, and on a skipped applicable fast job", () => {
    expect(gate(false, { ...skipHeavy, "test-unit": "failure" }).rc).toBe(1);
    expect(gate(false, { ...skipHeavy, "fe-unit": "skipped" }).rc).toBe(1);
  });
  it("passes a full run where every path-filtered job was skipped because every filter is false (a docs-only PR; fast-checks always runs, ORW-1044)", () =>
    expect(gate(true, { ...skipAll, "fast-checks": "success" }, { ENGINE: "false", HEAVY: "false", DEPLOY: "false", FRONTEND: "false", FE_RENDER: "false" }).rc).toBe(0));
  it("fails when a filter output is empty or not a boolean, even though every lane was skipped", () => {
    for (const bad of ["", "maybe", "True"]) {
      const r = gate(true, skipAll, { ENGINE: bad, HEAVY: "false", DEPLOY: "false", FRONTEND: "false", FE_RENDER: "false" });
      expect(r.rc, `ENGINE=${JSON.stringify(bad)}`).toBe(1);
      expect(r.out).toContain("changes output 'engine'");
    }
  });
  it("fails when the tier output is missing (a broken changes job)", () => {
    const r = gate(true, skipAll, { FULL: "", ENGINE: "", HEAVY: "", DEPLOY: "", FRONTEND: "", FE_RENDER: "" });
    expect(r.rc).toBe(1);
    expect(r.out).toContain("changes output 'full'");
  });
  it("a draft with no applicable fast jobs (path filters all false) still fails", () =>
    expect(gate(false, { ...skipHeavy, test: "skipped", "test-unit": "skipped", "fe-unit": "skipped" }, { ENGINE: "false", FRONTEND: "false", HEAVY: "false", DEPLOY: "false", FE_RENDER: "false" }).rc).toBe(1));
});

describe("ci.yml wiring (two-tier CI)", () => {
  it("every heavy-tier job is gated on the full tier", () => {
    for (const job of ["bdd", "heavy-sims", "coverage", "smoke", "fe-browser-tests", "fe-browser", "fe-responsive", "mirror-parity", "a11y-matrix"]) {
      const m = yml.match(new RegExp(`\\n  ${job}:\\n(?:    .*\\n)*?    if: (.*)\\n`));
      expect(m, job).toBeTruthy();
      expect(m![1], job).toContain("needs.changes.outputs.full == 'true'");
    }
  });
  it("the fast-tier jobs are NOT gated on the full tier", () => {
    for (const job of ["fast-checks", "test", "test-unit", "fe-unit"]) {
      const m = yml.match(new RegExp(`\\n  ${job}:\\n(?:    .*\\n)*?    if: (.*)\\n`));
      expect(m![1], job).not.toContain("full");
    }
  });
  it("the BDD gate runs in its own job (three legs, ORW-413); the test job is build + arch only, the typecheck lives in fast-checks (ORW-229 re-shard, ORW-413)", () => {
    const testJob = yml.slice(yml.indexOf("\n  test:\n"), yml.indexOf("\n  bdd:\n"));
    const bddJob = yml.slice(yml.indexOf("\n  bdd:\n"), yml.indexOf("\n  test-unit:\n"));
    expect(testJob).not.toContain("run: npm run typecheck");
    expect(testJob).toContain("run: npm run build");
    expect(yml.slice(yml.indexOf("\n  fast-checks:\n"), yml.indexOf("\n  test:\n"))).toContain("run: npm run ci:fast");
    for (const gone of ["run: npm run test:bdd", "uses: actions/setup-python", "uses: ./.github/actions/setup-fe-python", "run: pip install"]) expect(testJob, gone).not.toContain(gone);
    expect(bddJob).toContain("run: node ci/bdd-shard.mjs ${{ matrix.shard }}/3");
    expect(bddJob).toMatch(/shard:\s*\[1, 2, 3\]/); // a matrix with fewer legs would leave features unrun
    expect(bddJob).toContain("uses: ./.github/actions/setup-fe-python");
  });
  it("calibration-nightly has NO pull_request trigger (ORW-218, Ryne 2026-11-12: balance is not CI); the draft-PR guard stays harmless for dispatch/schedule", () => {
    const cal = readFileSync(fileURLToPath(new URL("../../.github/workflows/calibration-nightly.yml", import.meta.url)), "utf8");
    const cond = "github.event_name != 'pull_request' || !github.event.pull_request.draft || contains(github.event.pull_request.labels.*.name, 'full-ci')";
    expect(cal).toContain(`  shards:\n    if: ${cond}\n`);
    expect(cal).toContain(`    if: always() && (${cond})\n`);
    // deliberate re-pin (ORW-218): the pull_request trigger (and its `types:` list) was removed; only workflow_dispatch remains (the weekly schedule was removed too).
    expect(cal).not.toMatch(/^  pull_request:/m);
    expect(cal).toMatch(/workflow_dispatch:/);
  });
  it("triggers: PR (NOT ready_for_review: one run per PR, ORW-413), merge_group and main", () => {
    expect(yml).toMatch(/types: \[opened, synchronize, reopened\]/);
    expect(yml).not.toContain("ready_for_review]");
    expect(yml).toMatch(/merge_group:\n    types: \[checks_requested\]/);
    expect(yml).toMatch(/push:\n    branches: \[main\]/);
  });
});

describe("result reuse (ORW-413 PR 2)", () => {
  const PROOF = "https://github.com/Psychout-Media/orwell/actions/runs/123456";
  const allSkipped = Object.fromEntries(JOBS.filter((j) => j !== "changes").map((j) => [j, "skipped"]));
  it("a reused run, every other job skipped on purpose, passes and names the run that proved the tree", () => {
    const r = gate(true, allSkipped, { REUSE: "true", PROVED_BY: PROOF });
    expect(r.rc).toBe(0);
    expect(r.out).toContain(`reused: this exact tree already passed the full suite in ${PROOF}`);
  });
  it("a reused run still fails if any job failed or was cancelled (a reuse run cannot hide one)", () => {
    expect(gate(true, { ...allSkipped, "fe-unit": "failure" }, { REUSE: "true", PROVED_BY: PROOF }).rc).toBe(1);
    expect(gate(true, { ...allSkipped, bdd: "cancelled" }, { REUSE: "true", PROVED_BY: PROOF }).rc).toBe(1);
  });
  it("fails closed: skipped jobs with no named proof are NOT accepted, and `changes` must have passed", () => {
    expect(gate(true, allSkipped, { REUSE: "true", PROVED_BY: "" }).rc).toBe(1);
    expect(gate(true, { ...allSkipped, changes: "failure" }, { REUSE: "true", PROVED_BY: PROOF }).rc).toBe(1);
  });
  it("the reuse flag must be exactly true or false", () => {
    const r = gate(true, allSkipped, { REUSE: "", PROVED_BY: PROOF });
    expect(r.rc).toBe(1);
    expect(r.out).toContain("changes output 'reuse'");
  });
  it("the marker is keyed by the tested tree and the workflow hash, read only on pull requests, written only by record-proof after a passing, non-reused run", () => {
    expect(yml).toContain("key=ci-proof-v1-$tree-$wf");
    expect(yml).toContain("tree=\"$(git rev-parse 'HEAD^{tree}')\"");
    expect(yml).toMatch(/name: restore the proof marker \(pull requests only\)\n\s+id: proof\n\s+if: github\.event_name == 'pull_request'\n\s+uses: actions\/cache\/restore@v4/);
    const rp = yml.slice(yml.indexOf("\n  record-proof:\n"));
    expect(rp).toContain("if: needs.ci-gate.result == 'success' && needs.changes.outputs.reuse != 'true' && github.event_name == 'pull_request'");
    expect(rp).toContain("uses: actions/cache/save@v4");
    expect(yml.match(/actions\/cache\/save@v4/g)).toHaveLength(1);
    // the verdict trusts nothing but an exact three-line marker
    expect(yml).toContain('[ "$l2" = "$TREE" ] && [ "$l3" = "$WF" ]');
  });
  it("every heavy job (all but changes and ci-gate) skips when the proof is reused", () => {
    for (const job of ["fast-checks", "test", "bdd", "test-unit", "heavy-sims", "coverage", "smoke", "fe-unit", "fe-coverage", "fe-browser-tests", "fe-browser", "fe-perf-report", "fe-responsive", "mirror-parity", "a11y-matrix"]) {
      const m = yml.match(new RegExp(`\\n  ${job}:\\n(?:    .*\\n)*?    if: (.*)\\n`));
      expect(m![1], job).toContain("needs.changes.outputs.reuse != 'true'");
    }
  });
  it("the heavy-sim legs cache their verdict by the hash of src/ and the sim tests, and save only when the job succeeded", () => {
    const j = yml.slice(yml.indexOf("\n  heavy-sims:\n"), yml.indexOf("\n  coverage:\n"));
    expect(j).toContain("hashFiles('src/**', 'tests/uat/**', 'tests/property/**', 'tests/calibration/**', 'tests/support/**'");
    expect(j).toContain("uses: actions/cache@v4");
    expect(j).not.toContain("actions/cache/save");
  });
});
