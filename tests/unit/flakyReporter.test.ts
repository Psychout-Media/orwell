import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { File } from "vitest";
import { collectFlakes, summaryMarkdown } from "../support/flakyReporter";

/**
 * ORW-229 flaky-test rule: a test that passes only on CI's automatic retry is a flake, and it must show up in the job summary (counted, not hidden).
 * The unit block pins the classification; the last test runs a real nested vitest with `--retry=1` and the reporter over a test that fails once.
 */
const REPORTER = fileURLToPath(new URL("../support/flakyReporter.ts", import.meta.url));
const VITEST = fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url));

function fakeFile(tests: { name: string; state?: "pass" | "fail"; retryCount?: number; mode?: "run" | "skip"; suite?: string }[]): File {
  const file = { type: "suite", name: "tests/unit/x.test.ts", mode: "run", tasks: [] as unknown[] } as unknown as File;
  for (const t of tests) {
    const parent = t.suite ? { type: "suite", name: t.suite, mode: "run", tasks: [], file } : file;
    const test = { type: "test", name: t.name, mode: t.mode ?? "run", file, suite: parent, result: t.state ? { state: t.state, retryCount: t.retryCount ?? 0 } : undefined };
    if (parent !== file) {
      (parent as { suite?: unknown }).suite = file;
      (parent as { tasks: unknown[] }).tasks.push(test);
      (file.tasks as unknown[]).push(parent);
    } else (file.tasks as unknown[]).push(test);
  }
  return file;
}

describe("flaky reporter", () => {
  it("lists a test that passed only on its retry, and one still red after it", () => {
    const r = collectFlakes([
      fakeFile([
        { name: "steady", state: "pass" },
        { name: "wobbly", state: "pass", retryCount: 1, suite: "a suite" },
        { name: "broken", state: "fail", retryCount: 1 },
        { name: "red without retry", state: "fail" },
      ]),
    ]);
    expect(r.flaky).toEqual([{ file: "tests/unit/x.test.ts", test: "a suite > wobbly", retries: 1 }]);
    expect(r.stillRed).toEqual([{ file: "tests/unit/x.test.ts", test: "broken", retries: 1 }]);
    const md = summaryMarkdown(r, "test-unit 2/4");
    expect(md).toContain("### Flaky tests (vitest, test-unit 2/4)");
    expect(md).toContain("**1 test(s) failed, then passed on the automatic retry.**");
    expect(md).toContain("| tests/unit/x.test.ts | a suite > wobbly | 1 |");
    expect(md).toContain("**1 test(s) were still red after the retry**");
  });
  it("lists quarantined tests that were skipped, and writes nothing when there is nothing to report", () => {
    const q = collectFlakes([fakeFile([{ name: "parked [quarantined ORW-12 since 2026-11-06]", mode: "skip" }, { name: "plain skip", mode: "skip" }])]);
    expect(q.quarantined).toEqual([{ file: "tests/unit/x.test.ts", test: "parked [quarantined ORW-12 since 2026-11-06]" }]);
    expect(summaryMarkdown(q, "")).toContain("1 quarantined test(s) skipped here");
    expect(summaryMarkdown(collectFlakes([fakeFile([{ name: "steady", state: "pass" }])]), "")).toBe("");
  });
  it("lists the tests inside a quarantined describe too (the tag is on the suite's name) (#2279 review)", () => {
    const q = collectFlakes([fakeFile([{ name: "inner", mode: "skip", suite: "parked suite [quarantined ORW-12 since 2026-11-06]" }])]);
    expect(q.quarantined).toEqual([{ file: "tests/unit/x.test.ts", test: "parked suite [quarantined ORW-12 since 2026-11-06] > inner" }]);
  });
  it("a real vitest run with --retry=1 reports the test that failed once in the job summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "flaky-run-"));
    const flag = join(dir, "failed-once");
    writeFileSync(
      join(dir, "wobbly.test.mjs"),
      `import { existsSync, writeFileSync } from "node:fs";\n` +
        `test("fails on the first try only", () => { if (!existsSync(${JSON.stringify(flag)})) { writeFileSync(${JSON.stringify(flag)}, "1"); throw new Error("first try"); } });\n` +
        `test("steady", () => {});\n`,
    );
    const summary = join(dir, "summary.md");
    writeFileSync(summary, "");
    const r = spawnSync(process.execPath, [VITEST, "run", "--root", dir, "--globals", "--retry=1", "--reporter=default", `--reporter=${REPORTER}`], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_STEP_SUMMARY: summary, ORWELL_FLAKE_LANE: "nested", CI: "1" },
      timeout: 60_000,
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout).toContain("[flaky-report] 1 passed only on a retry, 0 still red after a retry");
    expect(r.stdout).toContain("::warning title=Flaky test (passed on retry)::wobbly.test.mjs > fails on the first try only");
    const md = readFileSync(summary, "utf8");
    expect(md).toContain("### Flaky tests (vitest, nested)");
    expect(md).toContain("| wobbly.test.mjs | fails on the first try only | 1 |");
  }, 60_000);
});
