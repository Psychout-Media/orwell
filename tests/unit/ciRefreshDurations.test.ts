import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** ORW-437 (review of #2746): `--replace` rebuilds the duration table from one report, so a report with no results must be refused, not written as an empty table. */
const script = fileURLToPath(new URL("../../ci/refresh-test-durations.mjs", import.meta.url));
const table = fileURLToPath(new URL("../../ci/test-durations.json", import.meta.url));

function run(report: unknown): { status: number | null; stderr: string; before: string; after: string } {
  const dir = mkdtempSync(join(tmpdir(), "refresh-durations-"));
  try {
    const file = join(dir, "report.json");
    writeFileSync(file, JSON.stringify(report));
    const before = readFileSync(table, "utf8");
    const r = spawnSync(process.execPath, [script, "--replace", "--json", file], { encoding: "utf8" });
    return { status: r.status, stderr: r.stderr, before, after: readFileSync(table, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("ci/refresh-test-durations.mjs --replace", () => {
  it.each([
    ["an empty report", { success: true, testResults: [] }],
    ["a report with no testResults", { success: true }],
    ["a failed run", { success: false, testResults: [{ name: "/x/tests/unit/a.test.ts", status: "passed", startTime: 0, endTime: 5 }] }],
    ["a run with a failed file", { success: true, testResults: [{ name: "/x/tests/unit/a.test.ts", status: "failed", startTime: 0, endTime: 5 }] }],
  ])("refuses %s and leaves the table untouched", (_n, report) => {
    const r = run(report);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refusing --replace");
    expect(r.after).toBe(r.before);
  });
});
