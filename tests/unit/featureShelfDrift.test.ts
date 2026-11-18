import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// TEST-3 (#628) — the spec-only shelf meta-test. `docs/features/*.feature` files read as executable
// contracts, but only the ones listed in `cucumber.cjs` `paths` actually execute as Gherkin (that
// file is the canonical list of what is wired into the BDD gate). Every OTHER .feature is gated
// elsewhere (FE pytest / unit / CI jobs — see docs/features/README.md) and must SAY so with an
// explicit `# spec-only:` marker at the top, so nobody mistakes an un-executed contract for a gate.
// This test pins the shelf against drift in BOTH directions:
//   1. every cucumber.cjs path exists on disk (no dead BDD-gate entries),
//   2. every wired feature does NOT carry the spec-only marker (a wired contract must not disclaim),
//   3. every unwired feature DOES carry it (a new .feature either joins cucumber.cjs or is shelved
//      explicitly — silently un-executed contracts can no longer accumulate).

const ROOT = process.cwd();
const FEATURES_DIR = join(ROOT, "docs", "features");
const MARKER = "# spec-only:";

function wiredPaths(): string[] {
  // cucumber.cjs DISCOVERS the wired set (every feature without the spec-only marker), so ask it, not its text.
  const r = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify(require('./cucumber.cjs').default.paths))"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ORWELL_BDD_FEATURES: "" } });
  return JSON.parse(r.stdout) as string[];
}

function allFeatureFiles(dir = FEATURES_DIR, prefix = "docs/features"): string[] {
  // Recursive: the contract covers docs/features/**/*.feature, not just the top level.
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...allFeatureFiles(join(dir, entry.name), `${prefix}/${entry.name}`));
    else if (entry.name.endsWith(".feature")) out.push(`${prefix}/${entry.name}`);
  }
  return out;
}

function hasMarker(rel: string): boolean {
  // The marker must be at the very top (first 3 lines), before the Feature: header.
  const head = readFileSync(join(ROOT, rel), "utf8").split("\n").slice(0, 3);
  return head.some((l) => l.startsWith(MARKER));
}

describe("TEST-3 (#628) — the .feature shelf: wired XOR explicitly spec-only", () => {
  it("every cucumber.cjs path points at a real file (no dead BDD-gate entries)", () => {
    const missing = wiredPaths().filter((p) => !existsSync(join(ROOT, p)));
    expect(missing).toEqual([]);
  });

  it("cucumber.cjs lists at least the core invariant features (the extractor is not vacuous)", () => {
    const wired = wiredPaths();
    expect(wired.length).toBeGreaterThan(10);
    expect(wired).toContain("docs/features/0001-vault-wall-isolation.feature");
  });

  it("a feature wired into the BDD gate never carries the spec-only marker", () => {
    const disclaimingWired = wiredPaths().filter((p) => existsSync(join(ROOT, p)) && hasMarker(p));
    expect(disclaimingWired).toEqual([]);
  });

  it("every .feature NOT wired into the BDD gate is explicitly shelved with the spec-only marker", () => {
    const wired = new Set(wiredPaths());
    const unmarkedOrphans = allFeatureFiles().filter((p) => !wired.has(p) && !hasMarker(p));
    // A failure here means a new .feature landed that neither executes as Gherkin nor admits it:
    // either add it to cucumber.cjs `paths` (with step definitions) or prepend the `# spec-only:`
    // shelf marker naming where its real gate lives.
    expect(unmarkedOrphans).toEqual([]);
  });
});
