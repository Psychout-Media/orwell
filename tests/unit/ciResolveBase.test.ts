import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ORW-218: the `changes` job's diff base is chosen per event (ci/resolve-base.sh). The merge-queue deadlock risk: `pull_request.base.sha` is EMPTY in a
 * merge_group run. Each event type is dry-run here against a real throwaway git repo.
 */
const SCRIPT = fileURLToPath(new URL("../../ci/resolve-base.sh", import.meta.url));
let repo = "";
const shas: string[] = [];
const git = (...a: string[]): string => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "resolve-base-"));
  git("init", "-q");
  git("config", "user.email", "ci@example.invalid");
  git("config", "user.name", "ci");
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(repo, "f.txt"), String(i));
    git("add", "-A");
    git("commit", "-q", "-m", `c${i}`);
    shas.push(git("rev-parse", "HEAD"));
  }
});

function base(env: Record<string, string>): string {
  const r = spawnSync("bash", [SCRIPT], { cwd: repo, encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.trim();
}

describe("changes-job diff base, per event", () => {
  it("pull_request uses the PR base sha", () => expect(base({ EVENT_NAME: "pull_request", PR_BASE: shas[0]! })).toBe(shas[0]));
  it("merge_group uses merge_group.base_sha (the PR field is empty there)", () =>
    expect(base({ EVENT_NAME: "merge_group", PR_BASE: "", MG_BASE: shas[1]! })).toBe(shas[1]));
  it("push uses github.event.before", () => expect(base({ EVENT_NAME: "push", PUSH_BEFORE: shas[0]! })).toBe(shas[0]));
  it("push with an all-zero before (new branch) falls back to HEAD~1", () =>
    expect(base({ EVENT_NAME: "push", PUSH_BEFORE: "0".repeat(40) })).toBe(shas[1]));
  it("an empty or unknown base never yields an empty string (falls back to HEAD~1)", () => {
    expect(base({ EVENT_NAME: "merge_group", MG_BASE: "" })).toBe(shas[1]);
    expect(base({ EVENT_NAME: "pull_request", PR_BASE: "f".repeat(40) })).toBe(shas[1]);
    expect(base({})).toBe(shas[1]);
  });
});
