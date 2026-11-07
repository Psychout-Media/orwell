import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The `changes` job's path filter (ci.yml), run for real against BIG change lists.
 *
 * The bug this pins: the step runs under `set -o pipefail`, and each filter was tested with `echo "$subject" | grep -qE "$re"`. `grep -q` exits at
 * the first match; once the list is bigger than a pipe buffer (64 KB, about 1,300 paths; `git ls-files` is about 125 KB), `echo` is still
 * writing, dies of SIGPIPE (exit 141), and under pipefail the whole test reads as "no match". The lane is reported as skipped, and `ci-gate`
 * accepts a skip whose filter is false. So the cases that must run EVERY lane (an empty diff, which counts as every tracked file changed; a
 * base that cannot be found, which diffs against the empty tree; a scheduled nightly run) skipped lanes instead. So did any huge PR.
 */
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
const LANES = ["engine", "frontend", "fe_render", "deploy", "heavy"];

/** The `detect changed paths` step's script, exactly as ci.yml has it. */
function stepScript(): string {
  const from = ci.indexOf("      - name: detect changed paths\n");
  const run = ci.indexOf("        run: |\n", from);
  const lines = ci.slice(run + "        run: |\n".length).split("\n");
  const end = lines.findIndex((l) => l.trim() !== "" && !l.startsWith(" ".repeat(10)));
  expect(from > 0 && run > from && end > 10, "the changes job's filter step").toBe(true);
  return lines.slice(0, end).map((l) => l.replace(/^ {10}/, "")).join("\n");
}

/** The filter part only (from the matches() helper to the end of the loop), fed a given change list. */
function filterScript(): string {
  const s = stepScript();
  const from = s.indexOf("# Helper: does any changed file match the given ERE?");
  const to = s.indexOf("\ndone\n", s.indexOf("for name in engine frontend fe_render deploy heavy; do"));
  expect(from >= 0 && to > from, "the filter loop").toBe(true);
  return s.slice(from, to + "\ndone\n".length);
}

function run(script: string, env: Record<string, string>): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "ci-filter-"));
  try {
    const out = join(dir, "out");
    const r = spawnSync("bash", ["-c", `set -euo pipefail\n${script}`], {
      cwd: ROOT,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", GITHUB_OUTPUT: out, ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    return Object.fromEntries(readFileSync(out, "utf8").trim().split("\n").map((kv) => kv.split("=") as [string, string]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const tracked = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout.trim();

describe("the changes job's path filter on big change lists (never a lane skipped by a closed pipe)", () => {
  it("the tracked-file list is bigger than a pipe buffer, so these cases really exercise the bug", () => {
    expect(tracked.length).toBeGreaterThan(64 * 1024);
  });

  for (const event of ["push", "pull_request"]) {
    it(`every tracked file changed (${event}): every lane runs`, () => {
      const got = run(filterScript(), { changed: tracked, EVENT_NAME: event });
      for (const lane of LANES) expect(got[lane], lane).toBe("true");
    });
  }

  it("a huge front-end-only change runs the front-end lanes and still skips the engine ones", () => {
    const fe = Array.from({ length: 3000 }, (_, i) => `frontend/static/vendor/lib-${i}/index.js`).join("\n");
    const got = run(filterScript(), { changed: fe, EVENT_NAME: "pull_request" });
    expect(got.frontend).toBe("true");
    expect(got.fe_render).toBe("true");
    expect(got.engine).toBe("false");
    expect(got.heavy).toBe("false");
  });

  it("an empty diff (the base is HEAD itself) counts as every file changed, and every lane runs: the whole step, end to end", () => {
    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
    const got = run(stepScript(), { EVENT_NAME: "push", PUSH_BEFORE: head });
    for (const lane of LANES) expect(got[lane], lane).toBe("true");
  });
});
