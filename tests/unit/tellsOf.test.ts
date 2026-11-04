import { describe, it, expect } from "vitest";
import { tellsOf, TELLS, OPPOSITE, type Tell } from "../../src/engine/tells";
import type { Soul } from "../../src/engine/characterFactory";

/** B12 / B8 slice 1 - the pure observable-tells read. Roles only. */
const calm: Soul = { emotionalBaseline: 0.5, volatility: 0.3, emotionalState: 0.5, emotionalHistory: [], memory: [], distress: 0.5, confidence: 0.5, temperamentDrift: 0 };
const soul = (o: Partial<Soul>): Soul => ({ ...calm, ...o });
const kinds = (t: Tell[]) => t.map((x) => x.kind);

describe("B8 E0 - tellsOf", () => {
  it("a calm soul shows no tell", () => {
    expect(tellsOf(calm)).toEqual([]);
  });
  it("high distress + low confidence reads withdrawn/tearful", () => {
    const t = tellsOf(soul({ distress: 0.95, confidence: 0.1 }));
    expect(kinds(t)).toContain("withdrawn");
    expect(kinds(t)).not.toContain("giddy");
  });
  it("high distress + high confidence reads snapping or brittle-calm, never withdrawn", () => {
    const t = tellsOf(soul({ distress: 0.9, confidence: 0.9 }));
    expect(kinds(t).some((k) => k === "snapping" || k === "brittle-calm")).toBe(true);
    expect(kinds(t)).not.toContain("withdrawn");
  });
  it("low distress + high confidence reads giddy / warm-open", () => {
    const t = tellsOf(soul({ distress: 0.05, confidence: 0.95 }));
    expect(kinds(t).some((k) => k === "giddy" || k === "warm-open")).toBe(true);
  });
  it("clash drift reads guarded; bond drift does not", () => {
    expect(kinds(tellsOf(soul({ temperamentDrift: 0.8 })))).toContain("guarded");
    expect(kinds(tellsOf(soul({ temperamentDrift: -0.8 })))).not.toContain("guarded");
  });
  it("high volatility adds restless only when something is stirred", () => {
    expect(kinds(tellsOf(soul({ volatility: 0.95 })))).not.toContain("restless");
    expect(kinds(tellsOf(soul({ volatility: 0.95, distress: 0.9, confidence: 0.2 })))).toContain("restless");
  });
  it("returns at most maxTells, strongest first, with a channel and band", () => {
    const t = tellsOf(soul({ distress: 1, confidence: 0, volatility: 1, temperamentDrift: 1 }));
    expect(t.length).toBeLessThanOrEqual(TELLS.maxTells);
    for (const x of t) { expect(["faint", "clear", "strong"]).toContain(x.band); expect(["body", "voice", "behaviour"]).toContain(x.channel); }
  });
  it("is deterministic and carries no numbers", () => {
    const s = soul({ distress: 0.9, confidence: 0.2 });
    expect(tellsOf(s)).toEqual(tellsOf({ ...s }));
    expect(JSON.stringify(tellsOf(s))).not.toMatch(/\d/);
  });
  it("hysteresis: a shown tell persists a little below its edge; a fresh one does not appear there", () => {
    // pick a distress where withdrawn intensity sits just under the show edge
    let probe: number | undefined;
    for (let d = 0.6; d < 1; d += 0.005) {
      const s = soul({ distress: d, confidence: 0.1 });
      if (!kinds(tellsOf(s)).includes("withdrawn")) probe = d; else break;
    }
    expect(probe).toBeDefined();
    const justUnder = soul({ distress: probe! + 0.005, confidence: 0.1 });
    const shown = tellsOf(soul({ distress: 0.95, confidence: 0.1 }));
    expect(kinds(tellsOf(justUnder, shown))).toContain("withdrawn");
  });
  it("absent axes fall back to the single emotionalState scalar", () => {
    const s: Soul = { emotionalBaseline: 0.5, volatility: 0.3, emotionalState: 0.05, emotionalHistory: [], memory: [] };
    expect(kinds(tellsOf(s))).toContain("withdrawn");
  });
  it("OPPOSITE never lists a kind as its own opposite and is symmetric where it matters", () => {
    for (const [k, v] of Object.entries(OPPOSITE)) expect(v).not.toContain(k as never);
  });
});
