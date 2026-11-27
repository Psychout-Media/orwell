import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * ORW-1044: the table test of the path -> lane mapping (ci/path-lanes.sh, called by the `changes` job in ci.yml).
 * Each row is a changed-path set and the EXACT set of lanes that must run. The rule it pins: a skip is allowed only when the mapping proves the lane
 * cannot be affected, so a shared or unknown path (a root config, a new top-level directory, a workflow, a lockfile) runs EVERY lane.
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
type Lane = "engine" | "frontend" | "fe_render" | "deploy" | "heavy";
const ALL: Lane[] = ["engine", "frontend", "fe_render", "deploy", "heavy"];

function raw(input: string, event: string) {
  return spawnSync("bash", ["ci/path-lanes.sh"], {
    cwd: ROOT, encoding: "utf8", input,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", EVENT_NAME: event },
    maxBuffer: 64 * 1024 * 1024,
  });
}

function lanes(paths: string[], event = "pull_request"): Lane[] {
  const r = raw(paths.join("\n") + "\n", event);
  expect(r.status, r.stderr).toBe(0);
  const got = Object.fromEntries(r.stdout.trim().split("\n").map((l) => l.split("=") as [string, string]));
  expect(Object.keys(got).sort()).toEqual([...ALL].sort());
  return ALL.filter((l) => got[l] === "true");
}

const TABLE: Array<{ name: string; paths: string[]; pr: Lane[]; push?: Lane[] }> = [
  { name: "docs only (a dated audit)", paths: ["docs/audits/2026-11-01-x.md"], pr: [] },
  { name: "docs only, several, plus root markdown", paths: ["docs/CI.md", "docs/decisions/0001-x.md", "README.md"], pr: [] },
  { name: "a doc the engine tests read (flag inventory)", paths: ["docs/FLAG-INVENTORY.md"], pr: ["engine"] },
  { name: "a spec doc (whatFired discovers docs/features/NNNN-*.md)", paths: ["docs/features/0100-x.md"], pr: ["engine"] },
  { name: "a Gherkin spec is executable: engine", paths: ["docs/features/0001-x.feature"], pr: ["engine"] },
  { name: "frontend only (a static js file)", paths: ["frontend/static/js/chat.js"], pr: ["frontend", "fe_render", "deploy"] },
  { name: "frontend tests only: pytest lanes, no render lanes, no smoke", paths: ["frontend/tests/test_x.py"], pr: ["frontend"], push: ["frontend", "fe_render", "deploy"] },
  { name: "frontend markdown only", paths: ["frontend/INTEGRATION.md"], pr: ["frontend"], push: ["frontend", "fe_render", "deploy"] },
  { name: "engine only (a domain file the front end does not read)", paths: ["src/domain/competitionOutcome.ts"], pr: ["engine", "deploy", "heavy"] },
  { name: "engine file the front-end tests read", paths: ["src/surfaces/tools/registry.ts"], pr: ["engine", "frontend", "deploy", "heavy"] },
  { name: "engine unit test only: no calibration re-run", paths: ["tests/unit/visibility.test.ts"], pr: ["engine"], push: ["engine", "heavy"] },
  { name: "a heavy-sim test", paths: ["tests/uat/fullGameUatHarness.ts"], pr: ["engine", "heavy"] },
  { name: "deploy script: engine tests read and run it", paths: ["deploy/orwell-update.sh"], pr: ["engine", "frontend", "deploy"] },
  { name: "scripts/: engine tests read it", paths: ["scripts/gen-flag-inventory.ts"], pr: ["engine"] },
  { name: "scripts/live-run: read only by front-end tests, so no engine lanes", paths: ["scripts/live-run/season.sh"], pr: ["frontend"] },
  { name: "scripts/rehearsal-kit: read only by front-end tests", paths: ["scripts/rehearsal-kit/check6.sh"], pr: ["frontend"] },
  { name: "scripts/probes: an engine unit test imports it", paths: ["scripts/probes/worldPoolMeasure.ts"], pr: ["engine"] },
  { name: "workflow file", paths: [".github/workflows/ci.yml"], pr: ALL },
  { name: "any other workflow file", paths: [".github/workflows/ci-nightly.yml"], pr: ALL },
  { name: "ci/ scripts", paths: ["ci/path-lanes.sh"], pr: ALL },
  { name: "composite action", paths: [".github/actions/setup-fe-python/action.yml"], pr: ALL },
  { name: "package.json", paths: ["package.json"], pr: ALL },
  { name: "lockfile", paths: ["package-lock.json"], pr: ALL },
  { name: "unknown root config (.dependency-cruiser.cjs) runs everything", paths: [".dependency-cruiser.cjs"], pr: ALL },
  { name: "unknown root dotfile", paths: [".gitignore"], pr: ALL },
  { name: "unknown top-level directory", paths: ["brand-new-dir/x.txt"], pr: ALL },
  { name: ".claude/ is not proven inert", paths: [".claude/agents/x.md"], pr: ALL },
  { name: "one unknown path among docs runs everything", paths: ["docs/audits/x.md", "mystery.bin"], pr: ALL },
  { name: "mixed: docs + frontend = the frontend lanes", paths: ["docs/audits/x.md", "frontend/static/js/chat.js"], pr: ["frontend", "fe_render", "deploy"] },
  { name: "mixed: engine + frontend = the union", paths: ["src/domain/competitionOutcome.ts", "frontend/static/js/chat.js"], pr: ALL },
  { name: "mixed: engine unit test + frontend test", paths: ["tests/unit/visibility.test.ts", "frontend/tests/test_x.py"], pr: ["engine", "frontend"], push: ALL },
];

describe("ci/path-lanes.sh: changed paths -> lanes (table)", () => {
  for (const row of TABLE) {
    it(`${row.name} (pull_request)`, () => expect(lanes(row.paths)).toEqual(row.pr));
    it(`${row.name} (push to main / merge queue: the broad sets)`, () => expect(lanes(row.paths, "push")).toEqual(row.push ?? row.pr));
  }

  it("an empty change list counts as every file changed: every lane", () => {
    const r = raw("", "pull_request");
    expect(r.status, r.stderr).toBe(0);
    for (const l of ALL) expect(r.stdout).toContain(`${l}=true`);
  });

  it("every tracked file, changed at once, runs every lane", () => {
    const tracked = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout.trim().split("\n");
    expect(lanes(tracked)).toEqual(ALL);
  });
});
