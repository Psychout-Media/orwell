import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** ORW-229 re-shard for 40 parallel jobs: pins the wider critical-path lanes and the cached setup that keeps their runner-minutes flat. */
const read = (p: string): string => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)), "utf8");
const ci = read(".github/workflows/ci.yml");
const action = read(".github/actions/setup-fe-python/action.yml");

function job(name: string): string {
  const start = ci.indexOf(`\n  ${name}:\n`);
  expect(start, name).toBeGreaterThan(0);
  const next = ci.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
  return ci.slice(start, next < 0 ? undefined : start + 1 + next);
}

describe("re-shard wiring", () => {
  it("fe-browser-tests runs five duration-balanced legs", () => {
    const j = job("fe-browser-tests");
    expect(j).toContain("shard: [1, 2, 3, 4, 5]");
    expect(j).toContain("ORWELL_CI_SHARD: ${{ matrix.shard }}/5");
    expect(j).toContain("name: fe-browser-tests (${{ matrix.shard }}/5)");
  });
  it("mirror-parity runs three WebSocket-only jobs (ORW-44 S4d), and each of the three gate steps belongs to exactly one of them", () => {
    const j = job("mirror-parity");
    expect(j).toContain("group: [live-ws, toolturn, hud]");
    const steps = [...j.matchAll(/- name: (mirror-[a-z]+ gate — [^\n]+)\n\s+if: matrix\.group == '([a-z-]+)'/g)].map((m) => `${m[1]} | ${m[2]}`);
    // the exact three gate/group pairs (bot review: a duplicated gate must not be able to stand in for a missing one)
    expect(steps.sort()).toEqual([
      "mirror-hud gate — WebSocket transport (blocking) | hud",
      "mirror-parity gate — WebSocket transport (blocking) | live-ws",
      "mirror-toolturn gate — WebSocket transport (blocking) | toolturn",
    ]);
    expect(j).not.toMatch(/matrix\.group == '(live|rest)'/);
  });
  it("every FE-deps install goes through the cached composite; the mirror venv reuses it", () => {
    expect(ci).not.toContain("pip install -r frontend/requirements.lock.txt");
    expect(ci).not.toContain("uses: actions/setup-python@v5");
    expect(job("mirror-parity")).toContain("run: python3 -m venv --system-site-packages frontend/.venv");
    expect(action).toContain("path: ${{ env.pythonLocation }}");
    expect(action).toContain("key: fe-python-${{ runner.os }}-${{ env.pythonLocation }}-${{ hashFiles('frontend/requirements.lock.txt') }}");
    expect(action).toMatch(/if: steps\.deps\.outputs\.cache-hit != 'true'\n\s+name: install front-end deps \(cache miss\)\n\s+shell: bash\n\s+run: pip install -r frontend\/requirements\.lock\.txt/);
    // restore everywhere, save only on main: a PR never pays the ~1 min compression (every job of the first cold run did)
    expect(action).toContain("uses: actions/cache/restore@v4");
    expect(action).toMatch(/if: steps\.deps\.outputs\.cache-hit != 'true' && github\.ref == 'refs\/heads\/main'\n\s+uses: actions\/cache\/save@v4/);
    expect(action).not.toMatch(/uses: actions\/cache@v4/);
  });
  it("both FE pytest lanes print every test's time, so the shard table can be refreshed from any green run (bot review)", () => {
    expect(job("fe-unit")).toMatch(/run: cd frontend && python3 -m pytest tests\/ -m "not browser" -n 4 .*--durations=0\n/);
    expect(job("fe-browser-tests")).toMatch(/run: cd frontend && python3 -m pytest tests\/ -m browser .*--durations=0\n/);
  });
  it("the new bdd job is a required input of ci-gate", () => {
    const gate = job("ci-gate");
    expect(gate).toMatch(/needs:\n(?:\s+- [\w-]+\n)*\s+- bdd\n/);
    expect(gate).toContain("bdd=${{ needs.bdd.result }}");
    expect(gate).toContain('test|bdd|test-unit|coverage-shard|coverage) echo "$ENGINE" ;;');
  });

  // Bot review (greptile + cubic): the shared composite actions are part of every job that uses them, so a change to ONLY an action must run each
  // of those jobs. Runs the real path-filter script from the `changes` job, for a pull request and for a push to main.
  it("a change to only a shared composite action runs every job that uses it, on a pull request and on main", () => {
    const from = ci.indexOf("          # Helper: does any changed file match the given ERE?");
    const loop = ci.indexOf("          for name in engine frontend fe_render deploy heavy; do", from);
    const to = ci.indexOf("\n          done\n", loop);
    expect(from > 0 && loop > from && to > loop, "the changes job's filter script").toBe(true);
    const script = ci.slice(from, to + "\n          done\n".length).split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
    const filtersFor = (path: string, event: string): Record<string, string> => {
      const dir = mkdtempSync(join(tmpdir(), "ci-filter-"));
      try {
        const out = join(dir, "out");
        const r = spawnSync("bash", ["-c", `set -euo pipefail\n${script}`], { env: { ...process.env, changed: path, EVENT_NAME: event, GITHUB_OUTPUT: out }, encoding: "utf8" });
        expect(r.status, r.stderr).toBe(0);
        return Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((kv) => kv.split("=") as [string, string]));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const actions = readdirSync(fileURLToPath(new URL("../../.github/actions/", import.meta.url)));
    expect(actions.length).toBeGreaterThan(0);
    let checked = 0;
    for (const a of actions) {
      for (const [name, body] of [...ci.matchAll(/\n {2}([a-z][\w-]*):\n((?: {4}.*\n|\s*\n)*)/g)].map((m) => [m[1]!, m[2]!] as const)) {
        if (!body.includes(`uses: ./.github/actions/${a}`)) continue;
        const cond = body.match(/\n {4}if: (.*)\n/)?.[1] ?? "";
        const needed = [...cond.matchAll(/needs\.changes\.outputs\.([a-z_]+) == 'true'/g)].map((m) => m[1]!).filter((f) => f !== "full");
        for (const event of ["pull_request", "push"]) {
          const got = filtersFor(`.github/actions/${a}/action.yml`, event);
          for (const f of needed) expect(got[f], `${event}: a change to .github/actions/${a} must run ${name} (filter ${f})`).toBe("true");
          checked += needed.length;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});
