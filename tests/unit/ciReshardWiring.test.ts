import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
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
  it("mirror-parity runs four jobs, and each of the six gate steps belongs to exactly one of them", () => {
    const j = job("mirror-parity");
    expect(j).toContain("group: [live-sse, live-ws, toolturn, hud]");
    const steps = [...j.matchAll(/- name: (mirror-[a-z]+ gate — [^\n]+)\n\s+if: matrix\.group == '([a-z-]+)'/g)].map((m) => [m[1], m[2]]);
    expect(steps.length).toBe(6);
    const groups = new Set(steps.map(([, g]) => g));
    expect([...groups].sort()).toEqual(["hud", "live-sse", "live-ws", "toolturn"]);
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
  it("the new bdd job is a required input of ci-gate", () => {
    const gate = job("ci-gate");
    expect(gate).toMatch(/needs:\n(?:\s+- [\w-]+\n)*\s+- bdd\n/);
    expect(gate).toContain("bdd=${{ needs.bdd.result }}");
    expect(gate).toContain('test|bdd|test-unit|coverage-shard|coverage) echo "$ENGINE" ;;');
  });
});
