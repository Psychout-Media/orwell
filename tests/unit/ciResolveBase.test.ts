import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ORW-218: the `changes` job's diff base is chosen per event (ci/resolve-base.sh). The merge-queue deadlock risk: `pull_request.base.sha` is EMPTY in a
 * merge_group run. Each event type is dry-run here against a real throwaway git repo. The rule that matters most: NEVER UNDER-DIFF. A missing or unknown
 * base yields the empty tree (every file changed), never HEAD (an empty diff, every lane skipped, a green gate).
 * The second block runs the real `detect changed paths` script from ci.yml on such repos and checks the five filter outputs.
 */
const SCRIPT = fileURLToPath(new URL("../../ci/resolve-base.sh", import.meta.url));
const YML = readFileSync(fileURLToPath(new URL("../../.github/workflows/ci.yml", import.meta.url)), "utf8");
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const gitIn = (cwd: string, ...a: string[]): string => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();

function newRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  gitIn(dir, "init", "-q");
  gitIn(dir, "config", "user.email", "ci@example.invalid");
  gitIn(dir, "config", "user.name", "ci");
  return dir;
}

function commit(dir: string, files: Record<string, string>, msg: string): string {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "--allow-empty", "-m", msg);
  return gitIn(dir, "rev-parse", "HEAD");
}

function base(cwd: string, env: Record<string, string>): string {
  const r = spawnSync("bash", [SCRIPT], { cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
  expect(r.status, r.stderr).toBe(0);
  const out = r.stdout.trim();
  expect(out).toMatch(/^[0-9a-f]{40}$/); // exactly one object name, never empty
  return out;
}

let repo = "";
const shas: string[] = [];
let rootOnly = "";

beforeAll(() => {
  repo = newRepo("resolve-base-");
  for (let i = 0; i < 3; i++) shas.push(commit(repo, { "f.txt": String(i) }, `c${i}`));
  rootOnly = newRepo("resolve-base-root-");
  commit(rootOnly, { "f.txt": "only" }, "root");
});

describe("changes-job diff base, per event", () => {
  it("pull_request uses the PR base sha", () => expect(base(repo, { EVENT_NAME: "pull_request", PR_BASE: shas[0]! })).toBe(shas[0]));
  it("merge_group uses merge_group.base_sha (the PR field is empty there)", () =>
    expect(base(repo, { EVENT_NAME: "merge_group", PR_BASE: "", MG_BASE: shas[1]! })).toBe(shas[1]));
  it("push uses github.event.before", () => expect(base(repo, { EVENT_NAME: "push", PUSH_BEFORE: shas[0]! })).toBe(shas[0]));
  it("push with an all-zero before (new branch) diffs the tip against HEAD~1", () =>
    expect(base(repo, { EVENT_NAME: "push", PUSH_BEFORE: "0".repeat(40) })).toBe(shas[1]));
  it("a new branch whose tip is a root commit diffs against the empty tree", () =>
    expect(base(rootOnly, { EVENT_NAME: "push", PUSH_BEFORE: "0".repeat(40) })).toBe(EMPTY_TREE));
  it("a missing or unknown base yields the empty tree (never HEAD, which would be an empty diff)", () => {
    expect(base(repo, { EVENT_NAME: "merge_group", MG_BASE: "" })).toBe(EMPTY_TREE);
    expect(base(repo, { EVENT_NAME: "pull_request", PR_BASE: "f".repeat(40) })).toBe(EMPTY_TREE);
    expect(base(repo, { EVENT_NAME: "pull_request", PR_BASE: "" })).toBe(EMPTY_TREE);
    expect(base(repo, {})).toBe(EMPTY_TREE);
  });
  it("the empty-tree fallback really lists every tracked file as changed", () =>
    expect(gitIn(repo, "diff", "--name-only", base(repo, { EVENT_NAME: "merge_group" }), "HEAD")).toBe("f.txt"));
});

// ── the real `detect changed paths` script (ci.yml) over a throwaway repo ──────────────────────────────────────────────────────────────────────────
const marker = "          set -euo pipefail\n          # Base per event";
const start = YML.indexOf(marker);
if (start < 0) throw new Error("the changes-job filter script was not found in ci.yml");
const lines = YML.slice(start).split("\n");
const end = lines.findIndex((l) => l.trim() !== "" && !l.startsWith(" ".repeat(10)));
const FILTER = lines.slice(0, end).map((l) => l.replace(/^ {10}/, "")).join("\n");

type Filters = Record<"engine" | "frontend" | "fe_render" | "deploy" | "heavy", string>;

function filters(env: Record<string, string>): Filters {
  const out = join(mkdtempSync(join(tmpdir(), "gh-output-")), "out");
  writeFileSync(out, "");
  const r = spawnSync("bash", ["-c", FILTER], { cwd: fRepo, encoding: "utf8", env: { PATH: process.env.PATH ?? "", GITHUB_OUTPUT: out, ...env } });
  expect(r.status, r.stderr).toBe(0);
  return Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((l) => l.split("="))) as Filters;
}
const ALL_TRUE = { engine: "true", frontend: "true", fe_render: "true", deploy: "true", heavy: "true" };
const ALL_FALSE = { engine: "false", frontend: "false", fe_render: "false", deploy: "false", heavy: "false" };

let fRepo = "";
let fBase = "";
let ciOnly = "";
let docsOnly = "";

beforeAll(() => {
  fRepo = newRepo("changes-filter-");
  mkdirSync(join(fRepo, "ci"));
  copyFileSync(SCRIPT, join(fRepo, "ci", "resolve-base.sh"));
  fBase = commit(fRepo, { "src/a.ts": "a", "frontend/app.py": "a", "docs/notes.md": "a", ".github/workflows/ci.yml": "a" }, "base");
  docsOnly = commit(fRepo, { "docs/notes.md": "b" }, "docs only");
  writeFileSync(join(fRepo, "ci", "resolve-base.sh"), readFileSync(SCRIPT, "utf8") + "# edited\n");
  ciOnly = commit(fRepo, {}, "ci/ only");
});

describe("changes-job path filters (the real script from ci.yml)", () => {
  it("a PR touching only ci/ runs every lane (ci/ counts like the workflow file)", () =>
    expect(filters({ EVENT_NAME: "pull_request", PR_BASE: docsOnly })).toEqual(ALL_TRUE));
  it("a push touching only ci/ runs every lane too", () => expect(filters({ EVENT_NAME: "push", PUSH_BEFORE: docsOnly })).toEqual(ALL_TRUE));
  it("an empty diff (the base is HEAD itself) runs every lane instead of skipping them all", () =>
    expect(filters({ EVENT_NAME: "pull_request", PR_BASE: ciOnly })).toEqual(ALL_TRUE));
  it("an unknown merge_group base runs every lane", () => expect(filters({ EVENT_NAME: "merge_group", MG_BASE: "e".repeat(40) })).toEqual(ALL_TRUE));
  it("a docs-only change still skips every lane", () => {
    gitIn(fRepo, "checkout", "-q", docsOnly);
    try {
      expect(filters({ EVENT_NAME: "pull_request", PR_BASE: fBase })).toEqual(ALL_FALSE);
    } finally {
      gitIn(fRepo, "checkout", "-q", ciOnly);
    }
  });
});
