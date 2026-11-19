import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_FLAGS } from "../../src/featureFlags";
import { discoverFlags, discoverFeatures, commentsByFlag, tagsOf } from "../support/whatFired/discover";
import { firstDifference, restartPoints } from "../support/whatFired/compare";
import { buildSummary, diffSummaries, renderMarkdown, assertClean, GUARD_REFERENCE, LOOP_REPEATS, type Inputs } from "../support/whatFired/report";
import { scrub, type SeasonRecord, type TraceRow } from "../support/whatFired/player";

/** ORW-729: the what-fired tool's own machinery under CI (the nightly itself never runs here). */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const season = (seed: number, over: Partial<SeasonRecord> = {}): SeasonRecord => ({
  seed, finished: true, messages: 100, advances: 10, week: 5, stopped: "finished", eventTypes: { bonding: 4, gossip: 6 }, houseLifeActions: { cook: 3 }, eventFields: {}, stateKeysPopulated: ["live.a"], stateKeysSeen: ["live.a", "live.b"],
  pendingKinds: {}, pendingRepeats: {}, faults: [], crashes: [], refused: {}, noEffect: {}, tried: { makeDeal: 4 }, scenes: [
    { type: "bonding", action: "cook", msg: 1, week: 1, playerOut: false }, { type: "gossip", action: "x", msg: 2, week: 1, playerOut: false }, { type: "strategy", action: "y", msg: 3, week: 2, playerOut: false }, { type: "conflict", action: "z", msg: 4, week: 2, playerOut: true },
  ], trace: [], ...over,
});
const inputs = (over: Partial<Inputs> = {}): Inputs => {
  const flags = discoverFlags();
  return { date: "2026-01-01", seasons: [season(1)], ablations: flags.map((f) => ({ envKey: f.envKey, seed: 1, fired: true, divergedAt: 10, stopped: "diverged", messages: 11 })), restarts: [], determinism: [], flags, features: discoverFeatures(), ...over };
};

describe("flag and feature discovery (no hand list)", () => {
  it("returns EVERY flag in the registry", () => {
    const found = new Set(discoverFlags().map((f) => f.envKey));
    for (const f of FEATURE_FLAGS) expect(found.has(f.envKey), f.envKey).toBe(true);
    expect(found.size).toBeGreaterThanOrEqual(FEATURE_FLAGS.length);
  });
  it("gives each flag the opposite of its default as the ablation", () => {
    for (const f of discoverFlags()) expect(f.ablateTo).toBe(f.defaultOn ? "0" : "1");
  });
  it("reads a spec number, a ticket and a Theme tag out of the comment above an entry", () => {
    const src = ["  // 0181 / ORW-568 (theme 3 slice 4): a thing. Theme 3 core.", "  { envKey: 'ORWELL_X_ONE', key: 'xOne', parser: 'defaultOn' },", "  { envKey: 'ORWELL_X_TWO', key: 'xTwo', parser: 'defaultOn' },"].join("\n");
    const c = commentsByFlag(src);
    expect(tagsOf(c.get("ORWELL_X_ONE")!)).toEqual({ specs: ["0181"], themes: ["3"], tickets: ["ORW-568"] });
    expect(tagsOf(c.get("ORWELL_X_TWO") ?? "").specs).toEqual([]);
  });
  it("finds every feature folder spec (docs/features/NNNN-*.md) and links real flags to specs", () => {
    const feats = discoverFeatures();
    expect(feats.length).toBeGreaterThan(100);
    expect(feats.every((f) => /^\d{4}$/.test(f.id))).toBe(true);
    expect(discoverFlags().some((f) => f.specs.length > 0)).toBe(true);
  });
});

describe("the diff against the last report", () => {
  const flagKey = discoverFlags()[0]!.envKey;
  const zeroed = (k: string): Inputs => { const i = inputs(); return { ...i, ablations: i.ablations.map((a) => (a.envKey === k ? { ...a, fired: false, divergedAt: null, stopped: "finished" } : a)) }; };
  it("flags a NEW zero, and a zero that cleared", () => {
    const prev = buildSummary(inputs()), cur = buildSummary(zeroed(flagKey));
    expect(diffSummaries(prev, cur).newZeros).toEqual([flagKey]);
    expect(diffSummaries(cur, prev).clearedZeros).toEqual([flagKey]);
    expect(diffSummaries(cur, cur).newZeros).toEqual([]);
  });
  it("flags a new fault, a new crash and a new loop, once", () => {
    const prev = buildSummary(inputs());
    const bad = season(1, { faults: [{ kind: "tick-failure", detail: "", firstAt: 5, count: 1 }], crashes: [{ tool: "advanceGame", at: 9, what: "Error: boom", count: 2 }], pendingRepeats: { nominations: LOOP_REPEATS + 1 }, stopped: "cap", finished: false });
    const cur = buildSummary(inputs({ seasons: [bad] }));
    const d = diffSummaries(prev, cur);
    expect(d.newFaults).toEqual(["tick-failure"]);
    expect(d.newCrashes).toEqual(["advanceGame: Error: boom"]);
    expect(d.newLoops.length).toBe(2);
    expect(diffSummaries(cur, cur)).toMatchObject({ newFaults: [], newCrashes: [], newLoops: [] });
  });
  it("does not call a decision re-raised up to the limit a loop", () => {
    expect(buildSummary(inputs({ seasons: [season(1, { pendingRepeats: { nominations: LOOP_REPEATS } })] })).loops).toEqual([]);
  });
});

describe("the save/restart comparer", () => {
  const row = (i: number, over: Partial<TraceRow> = {}): TraceRow => ({ i, ev: i * 2, last: `h${i}`, ...over });
  const base = [row(0), row(1, { st: "s1" }), row(2), row(3, { st: "s3" })];
  it("is silent on identical traces", () => expect(firstDifference(base, base.map((r) => ({ ...r })))).toBeNull());
  it("reports a seeded difference with where and what", () => {
    expect(firstDifference(base, [row(0), row(1, { st: "DIFFERENT" }), row(2), row(3, { st: "s3" })])).toEqual({ at: 1, field: "state" });
    expect(firstDifference(base, [row(0), row(1, { st: "s1" }), row(2, { last: "x" }), row(3)])).toEqual({ at: 2, field: "last-event" });
    expect(firstDifference(base, [row(0), row(1, { st: "s1", ev: 99 }), row(2), row(3)])).toEqual({ at: 1, field: "events" });
    expect(firstDifference(base, base.slice(0, 3))).toEqual({ at: 3, field: "length" });
  });
  it("picks the same restart points for the same seed, inside the season", () => {
    expect(restartPoints(7, 3, 500)).toEqual(restartPoints(7, 3, 500));
    for (const p of restartPoints(7, 5, 500)) { expect(p).toBeGreaterThanOrEqual(1); expect(p).toBeLessThan(500); }
  });
  it("reports a restart difference in the summary and the diff", () => {
    const cur = buildSummary(inputs({ restarts: [{ seed: 1, point: 40, difference: { at: 41, field: "state" }, finished: true }] }));
    expect(diffSummaries(null, cur).newRestartDifferences).toEqual(["seed 1 at 40: state"]);
    expect(renderMarkdown(cur, diffSummaries(null, cur))).toContain("DIFFERS at message 41 (state)");
  });
});

describe("the mix by week", () => {
  it("classifies each week's scenes (bonding / strategy / gossip / conflict), leaving out scenes after the player is out", () => {
    const s = buildSummary(inputs());
    expect(s.mixByWeek).toEqual([
      { week: 1, n: 2, bonding: 50, strategy: 0, gossip: 50, conflict: 0 },
      { week: 2, n: 1, bonding: 0, strategy: 100, gossip: 0, conflict: 0 },
    ]);
  });
  it("prints the guard's own week-1 reference (pinned equal to tests/uat/houseMixGuard.test.ts)", () => {
    const g = readFileSync(join(ROOT, "tests/uat/houseMixGuard.test.ts"), "utf8");
    const m = /REFERENCE = \{ bonding: ([\d.]+), strategy: ([\d.]+), gossip: ([\d.]+), conflict: ([\d.]+) \}/.exec(g)!;
    expect(GUARD_REFERENCE).toEqual({ bonding: +m[1]!, strategy: +m[2]!, gossip: +m[3]!, conflict: +m[4]! });
  });
});

describe("what the report may print", () => {
  it("renders from counts and kinds, and passes its own clean check", () => {
    const md = renderMarkdown(buildSummary(inputs()), diffSummaries(null, buildSummary(inputs())));
    expect(() => assertClean(md)).not.toThrow();
    expect(md).toContain("## 1. What fired");
  });
  it("refuses a raw entity id, an address, a path, an email or a credential", () => {
    for (const bad of ["x npc:12 y", "see http://example.test", "at 10.1.2.3 now", ["", "home", "someone", "x"].join("/"), "a@b.com", "api_key: abc"]) expect(() => assertClean(bad), bad).toThrow();
  });
  it("scrubs ids and names out of an error head", () => {
    expect(scrub("Error: npc:7 and Lily Michael said 12345")).toBe("Error: npc:N and <name> said N");
  });
  it("buckets an odd kind instead of printing it", () => {
    const s = buildSummary(inputs({ seasons: [season(1, { eventTypes: { "a very long hostile string with a name Lily Michael: and punctuation!!": 3 } })] }));
    expect(s.eventTypes.map((e) => e.type)).toEqual(["(other)"]);
  });
});

describe("the nightly wiring", () => {
  const wf = readFileSync(join(ROOT, ".github/workflows/what-fired-nightly.yml"), "utf8");
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  it("runs only on a schedule or by hand: never on a pull request or a push (it must not double PR CI)", () => {
    const on = /\non:\n([\s\S]*?)\npermissions:/.exec(wf)![1]!;
    expect(on).toMatch(/schedule:/);
    expect(on).toMatch(/workflow_dispatch:/);
    expect(on).not.toMatch(/pull_request|push:/);
  });
  it("is non-blocking (every job continue-on-error) and is not part of the required gate", () => {
    const jobs = wf.split(/\n(?=  [a-z]+:\n    (?:name|needs|runs-on))/).filter((j) => /runs-on:/.test(j));
    expect(jobs.length).toBe(3);
    for (const j of jobs) expect(j).toMatch(/continue-on-error: true/);
    expect(ci).not.toMatch(/what-fired/);
  });
  it("calls no model and reads no secret", () => {
    expect(wf).not.toMatch(/secrets\.(?!GITHUB_TOKEN)/);
    expect(wf).not.toMatch(/OPENROUTER|ANTHROPIC|API_KEY/);
  });
});
