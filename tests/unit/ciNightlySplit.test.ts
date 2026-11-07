import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";
import { COVERAGE_NIGHTLY_ONLY, HEAVY_SIM_FILES } from "../../vitest.config";

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
    // no `if:`: a PR that edits ci-nightly.yml runs the full suite in nightly mode too, so nightly-only wiring is proven before it merges (#2305 review)
    expect(nightly).toMatch(/\n {2}full-suite:\n {4}uses: \.\/\.github\/workflows\/ci\.yml\n {4}with:\n {6}nightly: true\n/);
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
  it("the coverage files skipped per push still run in test-unit on every push, and the nightly call measures them", () => {
    expect(COVERAGE_NIGHTLY_ONLY.length).toBeGreaterThan(0);
    const fast = pkg.scripts["test:unit:fast"]!;
    for (const f of COVERAGE_NIGHTLY_ONLY) {
      if (f.includes("*")) {
        // a glob: it must match at least one test file
        const [dir, pattern] = [f.slice(0, f.lastIndexOf("/")), f.slice(f.lastIndexOf("/") + 1)];
        const re = new RegExp(`^${pattern.replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`);
        expect(readdirSync(fileURLToPath(new URL(`../../${dir}`, import.meta.url))).some((n) => re.test(n)), f).toBe(true);
      } else expect(existsSync(fileURLToPath(new URL(`../../${f}`, import.meta.url))), f).toBe(true);
      expect(fast, f).not.toContain(f); // not excluded from test-unit by name...
      // ...nor by any --exclude glob of test:unit:fast (#2305 review: a glob such as tests/unit/** would drop it from every push)
      const excludes = [...fast.matchAll(/--exclude '([^']+)'/g)].map((m) => m[1]!);
      expect(excludes.length).toBeGreaterThan(3);
      const dir = f.slice(0, f.lastIndexOf("/"));
      const files = readdirSync(fileURLToPath(new URL(`../../${dir}`, import.meta.url))).map((n) => `${dir}/${n}`).filter((p) => matchesGlob(p, f));
      expect(files.length, f).toBeGreaterThan(0);
      for (const file of files) for (const g of excludes) expect(matchesGlob(file, g), `${file} is excluded from test-unit by ${g}`).toBe(false);
      expect(HEAVY_SIM_FILES, f).not.toContain(f);
    }
    expect(job("coverage-shard")).toContain("ORWELL_COVERAGE_FULL: ${{ inputs.nightly && '1' || '' }}");
    expect(read("vitest.shard.config.ts")).toContain('process.env.ORWELL_COVERAGE_FULL === "1" ? configDefaults.exclude : [...configDefaults.exclude, ...COVERAGE_NIGHTLY_ONLY]');
  });
});

describe("ci-nightly quarantined job (#2279 review)", () => {
  // greptile: a failing engine quarantine skipped every later step (their `if:` implied success()), so one red lane hid the front-end quarantines
  // and the front-end guard. Every step after the first test step must run whatever happened before it.
  it("every step after the first test step runs even when an earlier step failed (!cancelled())", () => {
    const start = nightly.indexOf("\n  quarantined:\n");
    const end = nightly.indexOf("\n  full-suite:\n");
    expect(start > 0 && end > start).toBe(true);
    const steps = nightly.slice(start, end).split("\n      - ").slice(1);
    const first = steps.findIndex((st) => st.includes("name: quarantine guard (engine)"));
    expect(first).toBeGreaterThan(0);
    const later = steps.slice(first);
    expect(later.length).toBeGreaterThanOrEqual(7);
    for (const st of later) {
      const cond = st.match(/(?:^|\n\s+)if: (.*)/)?.[1] ?? "";
      // it must START with !cancelled() and never ask for success() (#2305 review: `success() && !cancelled()` would still skip after a failure)
      expect(cond, st.split("\n")[0]).toMatch(/^\$\{\{ !cancelled\(\)( && [^}]+)? \}\}$/);
      expect(cond, st.split("\n")[0]).not.toMatch(/success\(\)|failure\(\)/);
    }
  });
});

describe("a nightly call runs everything, whatever event started it (#2305 review)", () => {
  // A PR that edits ci-nightly.yml runs the full suite in nightly mode, and a pull_request event would otherwise path-filter the called ci.yml and
  // could pick the draft fast tier. So `nightly` forces the full tier and every lane.
  const block = (from: string, to: string): string => {
    const a = ci.indexOf(from);
    const b = ci.indexOf(to, a);
    expect(a > 0 && b > a, from).toBe(true);
    return ci.slice(a, b).split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
  };
  const tier = (): string => block("          if [ -z \"${NIGHTLY:-}\" ] && [ \"$EVENT_NAME\" = \"pull_request\" ]", "      - name: detect changed paths");
  const filter = (): string => block("          # ORW-229: a nightly call (ci-nightly.yml, `nightly: true`) runs every lane", "\n          done\n") + "\ndone\n";
  const out = (script: string, env: Record<string, string>): Record<string, string> => {
    const dir = mkdtempSync(join(tmpdir(), "ci-nightly-"));
    try {
      const file = join(dir, "out");
      const r = spawnSync("bash", ["-c", `set -euo pipefail\n${script}`], {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: file, ...env },
      });
      expect(r.status, r.stderr).toBe(0);
      return Object.fromEntries(readFileSync(file, "utf8").trim().split("\n").map((kv) => kv.split("=") as [string, string]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const draft = { EVENT_NAME: "pull_request", IS_DRAFT: "true", HAS_LABEL: "false" };
  it("the full tier, even for a draft pull request", () => {
    expect(out(tier(), { ...draft, NIGHTLY: "1" }).full).toBe("true");
    expect(out(tier(), { ...draft, NIGHTLY: "" }).full).toBe("false");
  });
  it("every lane, even when the event's own diff touches only docs", () => {
    const lanes = ["engine", "frontend", "fe_render", "deploy", "heavy"];
    const nightlyRun = out(filter(), { EVENT_NAME: "pull_request", changed: "docs/CI.md", NIGHTLY: "1" });
    for (const l of lanes) expect(nightlyRun[l], l).toBe("true");
    const prRun = out(filter(), { EVENT_NAME: "pull_request", changed: "docs/CI.md", NIGHTLY: "" });
    for (const l of lanes) expect(prRun[l], l).toBe("false");
  });
});
