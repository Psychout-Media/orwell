import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { findQuarantines, quarantineProblems, MAX_QUARANTINE_DAYS } from "../support/quarantine";

/**
 * ORW-229 flaky-test rule (docs/CI.md): every quarantined engine test names a Plane card and an added-on date, and no quarantine is more than 7 days
 * old. The scan reads every test file that imports the quarantine helper; the checker itself is pinned with synthetic sources below.
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const IMPORTS_HELPER = /from\s+["'][./]*(?:[\w-]+\/)*support\/quarantine["']/;

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? testFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("quarantine guard (the real test tree)", () => {
  const found = testFiles(join(ROOT, "tests"))
    .filter((p) => !p.endsWith("support/quarantine.ts") && !p.endsWith("ciQuarantineGuard.test.ts"))
    .flatMap((p) => {
      const src = readFileSync(p, "utf8");
      return IMPORTS_HELPER.test(src) ? findQuarantines(relative(ROOT, p), src) : [];
    });

  it(`every quarantine names a Plane card and an added-on date, and none is older than ${MAX_QUARANTINE_DAYS} days`, () => {
    const problems = found.flatMap((q) => quarantineProblems(q, new Date()));
    expect(problems, problems.join("\n")).toEqual([]);
  });
});

describe("quarantine rule checker", () => {
  const today = new Date("2026-11-10T15:00:00Z");
  const one = (src: string) => findQuarantines("tests/unit/x.test.ts", src);

  it("accepts a literal quarantine with a card and a recent date (7 days is the limit)", () => {
    for (const added of ["2026-11-10", "2026-11-03", "2026-11-11"]) {
      expect(quarantineProblems(one(`quarantine({ card: "ORW-123", added: "${added}" }).it("x", () => {});`)[0]!, today), added).toEqual([]);
    }
  });
  it("reads a call with a space before the parenthesis (#2305 review)", () => {
    expect(one(`quarantine ({ card: "ORW-1", added: "2026-11-09" }).it("x", f);`).map((q) => [q.card, q.added])).toEqual([["ORW-1", "2026-11-09"]]);
  });
  it("finds every call, with its line", () => {
    const qs = one(`a\nquarantine({ card: "ORW-1", added: "2026-11-09" }).it("x", f);\nquarantine({ card: "ORW-2", added: "2026-11-09" }).describe("y", g);\n`);
    expect(qs.map((q) => [q.line, q.card])).toEqual([[2, "ORW-1"], [3, "ORW-2"]]);
  });
  it("fails an aliased import of the helper, which the guard could not follow (#2279 review)", () => {
    const qs = one(`import { describe } from "vitest";\nimport { quarantine as q } from "../support/quarantine";\nq({ card: "ORW-1", added: "2020-01-01" }).it("x", f);\n`);
    const p = qs.flatMap((x) => quarantineProblems(x, today)).join("\n");
    expect(p).toMatch(/tests\/unit\/x\.test\.ts:2: import quarantine without an alias \(`as q`\)/);
  });
  it("fails a quarantine older than 7 days, naming the card", () => {
    const p = quarantineProblems(one(`quarantine({ card: "ORW-123", added: "2026-11-02" })`)[0]!, today);
    expect(p.join()).toMatch(/quarantined 8 days ago \(2026-11-02, ORW-123\); the rule allows 7/);
  });
  it("fails a missing or malformed Plane card", () => {
    for (const card of ["", "#123", "orw-123", "ORW123", "ORW-"]) {
      expect(quarantineProblems(one(`quarantine({ card: "${card}", added: "2026-11-09" })`)[0]!, today).join(), card).toMatch(/not a Plane card id/);
    }
  });
  it("fails a missing, malformed or impossible date, and a date in the future", () => {
    for (const added of ["", "11/09/2026", "2026-13-01", "2026-02-30"]) {
      expect(quarantineProblems(one(`quarantine({ card: "ORW-1", added: "${added}" })`)[0]!, today).join(), added).toMatch(/is not a date/);
    }
    expect(quarantineProblems(one(`quarantine({ card: "ORW-1", added: "2026-11-20" })`)[0]!, today).join()).toMatch(/in the future/);
  });
  it("fails a quarantine that is not written as the literal object (the guard could not check it)", () => {
    for (const src of ["quarantine(q).it('x', f)", 'quarantine({ added: "2026-11-09", card: "ORW-1" })', 'quarantine({ card: "ORW-1" })']) {
      expect(quarantineProblems(one(src)[0]!, today).join(), src).toMatch(/write it as quarantine\(\{ card/);
    }
  });
});

describe("quarantine helper (a real nested vitest run)", () => {
  const helper = fileURLToPath(new URL("../support/quarantine.ts", import.meta.url));
  const reporter = fileURLToPath(new URL("../support/flakyReporter.ts", import.meta.url));
  const vitest = fileURLToPath(new URL("../../node_modules/vitest/vitest.mjs", import.meta.url));
  const today = new Date().toISOString().slice(0, 10);

  function run(env: Record<string, string>, body?: string, status = 0): string {
    const dir = mkdtempSync(join(tmpdir(), "quarantine-run-"));
    writeFileSync(
      join(dir, "parked.test.ts"),
      body ??
        `import { quarantine } from ${JSON.stringify(helper)};\n` +
          `quarantine({ card: "ORW-1", added: "${today}" }).it("parked test", () => { console.log("PARKED-RAN"); });\n` +
          `test("steady", () => {});\n`,
    );
    const r = spawnSync(process.execPath, [vitest, "run", "--root", dir, "--globals", "--reporter=verbose", `--reporter=${reporter}`], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ORWELL_RUN_QUARANTINED: "", GITHUB_STEP_SUMMARY: "", ...env },
      timeout: 60_000,
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(status);
    return r.stdout;
  }

  it("is skipped in a normal run and listed by the flake reporter", () => {
    const out = run({});
    expect(out).not.toContain("PARKED-RAN");
    expect(out).toContain(`parked test [quarantined ORW-1 since ${today}]`);
    expect(out).toContain("1 quarantined and skipped");
  }, 60_000);
  // #2305 review (cubic, greptile): an alias (`const q = quarantine`) or a space before the parenthesis hides a call from the static scan, so the
  // helper checks the rule itself: a quarantine past its 7 days, or without a valid card or date, FAILS in every run, whatever form the call takes.
  it("an aliased, expired quarantine fails the run instead of hiding (the helper checks the rule itself)", () => {
    const body =
      `import { quarantine } from ${JSON.stringify(helper)};\n` +
      `const q = quarantine;\n` +
      `q ({ card: "ORW-1", added: "2020-01-01" }).it("parked test", () => { console.log("PARKED-RAN"); });\n` +
      `test("steady", () => {});\n`;
    for (const env of [{}, { ORWELL_RUN_QUARANTINED: "1" }] as Record<string, string>[]) {
      const out = run(env, body, 1);
      expect(out).not.toContain("PARKED-RAN");
      expect(out).toMatch(/quarantine rule \(docs\/CI\.md\): quarantined \d+ days ago \(2020-01-01, ORW-1\)/);
    }
  }, 120_000);
  it("runs when ORWELL_RUN_QUARANTINED=1 (the nightly workflow)", () => {
    const out = run({ ORWELL_RUN_QUARANTINED: "1" });
    expect(out).toContain("PARKED-RAN");
    expect(out).toContain("0 quarantined and skipped");
  }, 60_000);
});
