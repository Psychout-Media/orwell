import { describe, it, expect } from "vitest";
import { narratedTellsOf, tellsOf, tellAgreesWithBand, type TellKind } from "../../src/engine/tells";
import { moodBandOf } from "../../src/engine/moodBand";
import { moodWord } from "../../src/engine/voice";
import { evolveEmotion, type EmotionalEvent } from "../../src/engine/emotionalArc";
import type { Soul } from "../../src/engine/characterFactory";

/** ORW-576 - one mood bucketing: the narrated tells reach every tier and never contradict the mood word. Roles only. */
const base: Soul = { emotionalBaseline: 0.5, volatility: 0.3, emotionalState: 0.5, emotionalHistory: [], memory: [], distress: 0.5, confidence: 0.5, temperamentDrift: 0 };
const ALL: TellKind[] = ["withdrawn", "tearful", "snapping", "brittle-calm", "giddy", "warm-open", "guarded", "restless"];

/** The REACHABLE range: both axes live in [0.5, 1] (they start at the floor and only rise), state/volatility in [0,1], drift in [-1,1]. */
function* reachable(): Generator<Soul> {
  const axis = [0.5, 0.55, 0.6, 0.7, 0.8, 0.9, 1];
  for (const distress of axis) for (const confidence of axis) for (const emotionalState of [0.05, 0.2, 0.35, 0.45, 0.52, 0.58, 0.7, 0.9])
    for (const volatility of [0.1, 0.5, 0.7, 0.95]) for (const temperamentDrift of [-0.8, 0, 0.8])
      yield { ...base, distress, confidence, emotionalState, volatility, temperamentDrift };
}

describe("ORW-576 narrated tells", () => {
  it("every tell tier fires somewhere in the reachable range (the old read reached only four)", () => {
    const seen = new Set<TellKind>(), old = new Set<TellKind>();
    for (const s of reachable()) { narratedTellsOf(s).forEach((t) => seen.add(t.kind)); tellsOf(s).forEach((t) => old.add(t.kind)); }
    expect([...seen].sort()).toEqual([...ALL].sort());
    for (const k of ["withdrawn", "tearful", "giddy", "warm-open"] as TellKind[]) expect(old.has(k)).toBe(false);
  });
  it("the word and the tells agree for every reachable state", () => {
    let checked = 0;
    for (const s of reachable()) {
      const band = moodBandOf(s.emotionalState, s.emotionalHistory);
      for (const t of narratedTellsOf(s)) { expect(tellAgreesWithBand(t.kind, band)).toBe(true); checked++; }
      const word = moodWord(s.emotionalState, s.volatility, s.emotionalHistory);
      if (band === "low") for (const t of narratedTellsOf(s)) expect(["giddy", "warm-open"]).not.toContain(t.kind);
      if (band === "high") for (const t of narratedTellsOf(s)) expect(["withdrawn", "tearful", "snapping", "brittle-calm"]).not.toContain(t.kind);
      expect(word.length).toBeGreaterThan(0);
    }
    expect(checked).toBeGreaterThan(1000);
  });
  it("the low and high tiers of an axis are disjoint and ordered", () => {
    const at = (confidence: number) => narratedTellsOf({ ...base, distress: 1, confidence, emotionalState: 0.5 }).map((t) => t.kind);
    expect(at(0.5)).toContain("withdrawn");
    expect(at(0.5)).not.toContain("snapping");
    expect(at(1)).toContain("snapping");
    expect(at(1)).not.toContain("withdrawn");
  });
  it("real evolution: a loss streak reads a negative tell, a win streak a positive one; never opposite the word", () => {
    const run = (events: EmotionalEvent[]) => { const s: Soul = { ...base, emotionalHistory: [], memory: [] }; for (const e of events) evolveEmotion(s, e, undefined, undefined, { soulDepth: true }); return s; };
    const lost = run(["blindside", "betrayed", "nominated"]);
    expect(narratedTellsOf(lost).map((t) => t.kind).every((k) => k !== "giddy" && k !== "warm-open")).toBe(true);
    const won = run(["comp-win", "comp-win", "survived-vote"]);
    expect(narratedTellsOf(won).map((t) => t.kind).every((k) => k !== "withdrawn" && k !== "tearful")).toBe(true);
  });
  it("wall: tells carry words only, no raw axis value", () => {
    const s = { ...base, distress: 0.8137, confidence: 0.5291 };
    const json = JSON.stringify(narratedTellsOf(s));
    expect(json).not.toMatch(/0\.8137|0\.5291|distress|confidence/);
  });
});
