import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
// @ts-expect-error - a plain ES module with no type declarations (it runs before `npm ci`, so it has no dependencies and no build step)
import { uncardedLines, markerReason, checkRepo } from "../../ci/check_backlog_whole.mjs";

/**
 * ORW-758: keep the backlog whole. Ryne: "if the backlog has holes, then the code that it's built off of also has holes."
 * Each rule is proven on a planted tree (it fails on the hole and passes once the hole is carded or fixed), and the real repo passes.
 */
type Result = { errors: string[]; warnings: string[] };
const check = checkRepo as (root: string, o?: { prBody?: string; wired?: Set<string>; baseBaseline?: { a1?: string[]; a2?: string[] } }) => Result;

function tree(files: Record<string, string>, baseline = { a1: [] as string[], a2: [] as string[] }, states: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "backlog-"));
  mkdirSync(join(root, "ci"), { recursive: true });
  mkdirSync(join(root, "docs", "features"), { recursive: true });
  writeFileSync(join(root, "ci", "backlog_baseline.json"), JSON.stringify(baseline));
  writeFileSync(join(root, "ci", "board_snapshot.json"), JSON.stringify({ states }));
  const all = { "docs/features/README.md": "| 0001 | [One](./0001-one.md) | unit | Built |\n", "docs/features/0001-one.md": "# One\n", ...files };
  for (const [p, body] of Object.entries(all)) writeFileSync(join(root, p), body);
  return root;
}

describe("A1: a line that says work is left names its card", () => {
  it("finds uncarded left-over lines, passes carded ones, and ignores code fences", () => {
    const lines = (uncardedLines as (t: string) => Array<{ line: number; text: string }>)(
      "Built.\nThe pop-up is not built yet.\nThe pop-up is not built (ORW-12).\nDeferred to a later slice.\nA follow-up card is ORW-9.\n```\nnot built in a fence\n```\n",
    );
    expect(lines.map((l) => l.line)).toEqual([2, 4]);
  });
  it("fails an uncarded doc line, accepts it once listed in the baseline, and fails a baseline entry that is gone", () => {
    const doc = { "docs/features/0001-one.md": "# One\nThe pop-up is not built.\n" };
    expect(check(tree(doc)).errors.join("\n")).toMatch(/A1 docs\/features\/0001-one.md:2/);
    expect(check(tree(doc, { a1: ["docs/features/0001-one.md::The pop-up is not built."], a2: [] })).errors).toEqual([]);
    expect(check(tree({}, { a1: ["docs/features/0001-one.md::The pop-up is not built."], a2: [] })).errors.join("\n")).toMatch(/no longer in the docs/);
  });
  it("the baseline only shrinks: an entry the base commit did not have fails, a removed one is fine", () => {
    const doc = { "docs/features/0001-one.md": "# One\nThe pop-up is not built.\n" };
    const listed = { a1: ["docs/features/0001-one.md::The pop-up is not built."], a2: [] };
    expect(check(tree(doc, listed), { baseBaseline: { a1: [], a2: [] } }).errors.join("\n")).toMatch(/gained an entry/);
    expect(check(tree(doc, listed), { baseBaseline: listed }).errors).toEqual([]);
    expect(check(tree({}), { baseBaseline: listed }).errors).toEqual([]);
  });
  it("skips the review bot's generated summary and HTML comments in the PR body, keeping line numbers", () => {
    const body = "Mine.\n<!-- This is an auto-generated description by cubic. -->\n## Summary by cubic\n- A1: a line saying work is deferred must name a card\n<!-- End of auto-generated description by cubic. -->\n<!-- a note: not built -->\nThe FE half is a follow-up.\n";
    const errs = check(tree({}), { prBody: body }).errors;
    expect(errs).toHaveLength(1);
    expect(errs[0]).toMatch(/PR body line 7/);
  });
  it("ORW-878: reads every doc under docs/, not only the feature specs, except the dated records it exempts", () => {
    const files = { "docs/README.md": "# Docs\nThe export is not built yet.\n" };
    const root = tree(files);
    mkdirSync(join(root, "docs", "audits"), { recursive: true });
    writeFileSync(join(root, "docs", "audits", "2026-01-01-audit.md"), "# Audit\nThe export was not built on this date.\n");
    const errs = check(root).errors.join("\n");
    expect(errs).toMatch(/A1 docs\/README.md:2/);
    expect(errs).not.toMatch(/audits/);
  });
  it("ORW-878: 'deferred' as a technical adjective is not a left-over; as a status it is", () => {
    const f = uncardedLines as (t: string) => Array<{ line: number }>;
    expect(f("the deferred fold lands late\na deferred-retry queue absorbs it\nits deferred listener fires\n")).toEqual([]);
    expect(f("The mobile sheet is deferred.\n(deferred)\nBROAD COALESCING DEFERRED\ndeferred to the next lane\n").map((x) => x.line)).toEqual([1, 2, 3, 4]);
  });
  it("checks the PR body too", () => {
    expect(check(tree({}), { prBody: "Done.\nThe FE half is a follow-up.\n" }).errors.join("\n")).toMatch(/PR body line 2/);
    expect(check(tree({}), { prBody: "The FE half is a follow-up (ORW-77).\n" }).errors).toEqual([]);
  });
});

describe("A2: a spec-only feature says why it does not run", () => {
  const spec = (marker: string) => ({ "docs/features/0001-one.feature": `${marker}\nFeature: one\n` });
  it("reads the cards and the superseding files off a marker", () => {
    expect(markerReason("# spec-only: waits on ORW-5 and ORW-6")).toEqual({ cards: ["ORW-5", "ORW-6"], supersededBy: [], gatedBy: [] });
    expect(markerReason("# spec-only: gated by frontend/tests/test_x.py; verified outside cucumber").gatedBy).toEqual(["frontend/tests/test_x.py"]);
    expect(markerReason("# spec-only: umbrella; superseded by 0001-a.feature, 0001-b.feature").supersededBy).toEqual(["0001-a.feature", "0001-b.feature"]);
  });
  it("fails a marker whose card is Done, passes one whose card is open, and warns on a card missing from the snapshot", () => {
    expect(check(tree(spec("# spec-only: waits on ORW-5"), undefined, { "ORW-5": "Done" })).errors.join("\n")).toMatch(/ORW-5 is Done/);
    expect(check(tree(spec("# spec-only: waits on ORW-5"), undefined, { "ORW-5": "Buildable" })).errors).toEqual([]);
    const r = check(tree(spec("# spec-only: waits on ORW-5")));
    expect(r.errors).toEqual([]);
    expect(r.warnings.join("\n")).toMatch(/not in ci\/board_snapshot.json/);
  });
  it("a superseded marker must name wired files that exist", () => {
    const files = { ...spec("# spec-only: superseded by 0001-a.feature"), "docs/features/0001-a.feature": "Feature: a\n" };
    expect(check(tree(files), { wired: new Set(["docs/features/0001-a.feature"]) }).errors).toEqual([]);
    expect(check(tree(files), { wired: new Set() }).errors.join("\n")).toMatch(/not wired/);
    expect(check(tree(spec("# spec-only: superseded by 0001-gone.feature"))).errors.join("\n")).toMatch(/does not exist/);
  });
  it("a built feature verified outside Cucumber names its gate, and the gate must exist", () => {
    const files = { "docs/features/0001-one.feature": "# spec-only: gated by tests/unit/one.test.ts; verified outside cucumber\nFeature: one\n" };
    expect(check(tree(files)).errors.join("\n")).toMatch(/gated by tests\/unit\/one.test.ts, which does not exist/);
    const root = tree(files); mkdirSync(join(root, "tests", "unit"), { recursive: true }); writeFileSync(join(root, "tests", "unit", "one.test.ts"), "");
    expect(check(root).errors).toEqual([]);
  });
  it("a marker that says neither fails unless it is in the baseline", () => {
    expect(check(tree(spec("# spec-only: later"))).errors.join("\n")).toMatch(/says none of/);
    expect(check(tree(spec("# spec-only: later"), { a1: [], a2: ["0001-one.feature"] })).errors).toEqual([]);
  });
});

describe("A3: the spec index is complete and points at real files", () => {
  it("fails a spec doc with no row and a row with a dead link", () => {
    expect(check(tree({ "docs/features/0002-two.md": "# Two\n" })).errors.join("\n")).toMatch(/0002-two.md: has no row/);
    const dead = { "docs/features/README.md": "| 0001 | [One](./0001-one.md) | x |\n| 0003 | [Gone](./0003-gone.md) | x |\n" };
    expect(check(tree(dead)).errors.join("\n")).toMatch(/0003-gone.md, which does not exist/);
  });
});

describe("the real repo", () => {
  it("passes every backlog-whole check", () => {
    const r = spawnSync(process.execPath, ["ci/check_backlog_whole.mjs"], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PR_BODY: "" } });
    expect(r.stdout + r.stderr).toMatch(/backlog-whole: every left-over line names its card/);
    expect(r.status).toBe(0);
  });
});
