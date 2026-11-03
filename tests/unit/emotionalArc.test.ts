import { describe, it, expect } from "vitest";
import { evolveEmotion, arcNote, offscreenEmotion, type EmotionalEvent } from "../../src/engine/emotionalArc";
import { chooseNominations, nominationStrategy } from "../../src/engine/season";
import { RelationshipModel } from "../../src/engine/relationships";
import type { Soul } from "../../src/engine/characterFactory";
import { npc } from "../../src/domain/ids";

/**
 * Feature 0041 — the pure emotional-arc evolution that modulates live behavior. Bounded,
 * mean-reverting, deterministic; the static CHARACTER never appears here (only the SOUL drifts).
 * HARD rule: roles only — no names.
 */
const settled = (): Soul => ({ emotionalBaseline: 0.5, volatility: 0.4, emotionalState: 0.5, emotionalHistory: [], memory: [] });

describe("0041 — emotional evolution (evolveEmotion)", () => {
  it("a blindside shifts the soul toward distress AND volatility", () => {
    const s = settled();
    evolveEmotion(s, "blindside");
    expect(s.emotionalState).toBeLessThan(0.5);      // distress: below the calm baseline
    expect(s.volatility).toBeGreaterThan(0.4);       // more volatile after the shock
    expect(s.emotionalHistory).toHaveLength(1);      // the arc recorded the new level
    expect(s.emotionalHistory[0]).toBe(s.emotionalState);
  });

  it("a competition win / surviving a vote builds confidence (above baseline)", () => {
    const win = settled(); evolveEmotion(win, "comp-win");
    const survive = settled(); evolveEmotion(survive, "survived-vote");
    expect(win.emotionalState).toBeGreaterThan(0.5);
    expect(survive.emotionalState).toBeGreaterThan(0.5);
  });

  it("stays bounded in [0,1] under repeated shocks in either direction", () => {
    const low = settled();
    const high = settled();
    for (let i = 0; i < 50; i++) { evolveEmotion(low, "blindside"); evolveEmotion(high, "comp-win"); }
    for (const s of [low, high]) {
      expect(s.emotionalState).toBeGreaterThanOrEqual(0);
      expect(s.emotionalState).toBeLessThanOrEqual(1);
      expect(s.volatility).toBeGreaterThanOrEqual(0);
      expect(s.volatility).toBeLessThanOrEqual(1);
    }
  });

  it("mean-reverts toward baseline over a calm stretch", () => {
    const s = settled();
    evolveEmotion(s, "blindside");            // spike away from baseline
    const spiked = s.emotionalState;
    const distBefore = Math.abs(spiked - s.emotionalBaseline);
    for (let i = 0; i < 6; i++) evolveEmotion(s, "calm");
    const distAfter = Math.abs(s.emotionalState - s.emotionalBaseline);
    expect(distAfter).toBeLessThan(distBefore);      // settled back toward calm
    expect(s.volatility).toBeLessThan(0.65);         // the calm stretch also cooled volatility
  });

  it("is deterministic — the same sequence reproduces the same arc", () => {
    const seq: EmotionalEvent[] = ["blindside", "comp-win", "calm", "betrayed", "survived-vote", "calm"];
    const a = settled(); const b = settled();
    for (const e of seq) { evolveEmotion(a, e); evolveEmotion(b, e); }
    expect(a.emotionalState).toBe(b.emotionalState);
    expect(a.emotionalHistory).toEqual(b.emotionalHistory);
  });

  it("arc notes are distinct per inflection and recall-friendly", () => {
    expect(arcNote("blindside", 4)).toContain("blindsided");
    expect(arcNote("comp-win", 2)).toContain("won a competition");
    expect(arcNote("blindside", 4)).not.toBe(arcNote("comp-win", 4));
    // Every off-screen scene type maps to an emotional event (no scene leaves the soul untouched).
    for (const t of ["alliance", "gossip", "conflict", "bonding", "strategy", "showmance", "betrayal"] as const) {
      expect(offscreenEmotion(t)).toBeTruthy();
    }
  });
});

describe("0041 — mood-aware nominations (decision leaning)", () => {
  const hoh = npc(1), top = npc(2), trusted = npc(3), distrusted = npc(4);

  function rel(): RelationshipModel {
    const r = new RelationshipModel(0.5);
    const set = (to: ReturnType<typeof npc>, threat: number, trust: number): void => {
      const e = r.edge(hoh, to); e.threat = threat; e.trust = trust;
    };
    set(top, 0.9, 0.5);         // clear top threat
    set(trusted, 0.6, 0.9);     // 2nd by threat, but trusted
    set(distrusted, 0.5, 0.0);  // lower threat, but deeply distrusted
    // 0044 §9: keep the floater read out of this mood test — every candidate has someone in their corner,
    // so only threat + the paranoia term separate them (no tight MUTUAL pairs, so no duo read either).
    // A fifth houseguest is in everyone's corner (one-way, so no mutual pair forms); the HOH trusts them.
    const fan = npc(5);
    for (const c of [top, trusted, distrusted]) { const e = r.edge(fan, c); e.trust = 0.9; e.affinity = 0.9; }
    const h = r.edge(hoh, fan); h.trust = 0.9; h.affinity = 0.9; h.threat = 0;
    return r;
  }
  const active = [hoh, top, trusted, distrusted, npc(5)];

  it("a calm HOH adds no mood term — identical to the mood-free strategic read", () => {
    // 0044 §9 (2026-11-02): the strategic read now also weighs floater / duo reads per the HOH's style,
    // so "calm" is pinned against the SAME read with no mood, not the bare threat-only ranking.
    const r = rel();
    const calm = nominationStrategy(hoh, active, r, { mood: 0.5 });
    expect(calm).toEqual(nominationStrategy(hoh, active, r, {}));
    expect(calm[0]).toBe(top); // the biggest threat still goes up
  });

  it("a rattled HOH nominates measurably differently — paranoia surfaces the distrusted one", () => {
    const r = rel();
    const rattled = nominationStrategy(hoh, active, r, { mood: 0.0 });
    expect(rattled).not.toEqual(nominationStrategy(hoh, active, r, { mood: 0.5 }));
    expect(rattled).toEqual([top, distrusted]);   // the trusted 2nd is displaced by the distrusted one
    // Hard rule still holds: two distinct nominees, the HOH never on their own block.
    expect(new Set(rattled).size).toBe(2);
    expect(rattled).not.toContain(hoh);
  });
});
