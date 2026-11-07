import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * ORW-229 nightly split (docs/CI.md "Nightly"): what left the per-push path still runs every night, and nothing was dropped.
 * The nightly (ci-nightly.yml) calls ci.yml itself with `nightly: true`, so the suite is defined once.
 */
const read = (p: string): string => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");
const ci = read(".github/workflows/ci.yml");
const nightly = read(".github/workflows/ci-nightly.yml");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

function job(name: string): string {
  const start = ci.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(0);
  const next = ci.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
  return ci.slice(start, next < 0 ? undefined : start + 1 + next);
}
const scriptsIn = (block: string): string[] => [...block.matchAll(/scripts: "([^"]+)"/g), ...block.matchAll(/SCRIPTS: "([^"]+)"/g)].flatMap((m) => m[1]!.split(" "));

describe("nightly split wiring", () => {
  const perPush = scriptsIn(job("heavy-sims"));
  const nightlyOnly = scriptsIn(job("heavy-sims-nightly"));
  const reweight = ["jury-reweight", "gradient-reweight", "uat-reweight"];

  it("every heavy script CI ran before still runs, exactly once, per push or nightly", () => {
    const all = [...perPush, ...nightlyOnly].sort();
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual(["gradient", "gradient-reweight", "jury", "jury-reweight", "uat-12seed-a", "uat-12seed-b", "uat-12seed-c", "uat-5seed", "uat-decisions", "uat-reweight"]);
    for (const s of all) expect(pkg.scripts[`test:heavy:${s}`], s).toBeTruthy();
  });
  it("only the SHOWRUNNER_REWEIGHT variants left the per-push path, and they run only in the nightly call", () => {
    expect(nightlyOnly.sort()).toEqual([...reweight].sort());
    for (const s of reweight) expect(perPush).not.toContain(s);
    expect(job("heavy-sims-nightly")).toMatch(/\n {4}if: inputs\.nightly\n/);
    expect(job("heavy-sims-nightly")).toContain("runs-on: ubuntu-24.04");
  });
  it("the nightly calls ci.yml itself with nightly: true, on schedule and on demand", () => {
    expect(ci).toMatch(/\n {2}workflow_call:\n {4}inputs:\n {6}nightly:\n(?: {8}.*\n)*? {8}type: boolean\n/);
    expect(nightly).toMatch(/\n {2}full-suite:\n {4}if: github\.event_name != 'pull_request'\n {4}uses: \.\/\.github\/workflows\/ci\.yml\n {4}with:\n {6}nightly: true\n/);
    expect(nightly).toMatch(/schedule:\n {4}- cron: /);
    expect(nightly).toContain("workflow_dispatch:");
    expect(nightly).toMatch(/needs: \[quarantined, full-suite\]/);
    expect(nightly).toContain("ORW-234");
  });
  it("a scheduled or manual nightly run has no diff base, so it diffs against the empty tree and every lane runs", () => {
    for (const event of ["schedule", "workflow_dispatch"]) {
      const r = spawnSync("bash", [fileURLToPath(new URL("../../ci/resolve-base.sh", import.meta.url))], {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", EVENT_NAME: event },
      });
      expect(r.stdout.trim(), event).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
    }
  });
});
