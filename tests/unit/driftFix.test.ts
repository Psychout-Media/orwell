import { describe, it, expect } from "vitest";
import { evolveEmotion, effectiveDisposition, type EmotionalEvent } from "../../src/engine/emotionalArc";
import type { Soul } from "../../src/engine/characterFactory";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/** B32 (#2017 15.7 E5, ORWELL_DRIFT_FIX): chat scenes feed the arc, and a negativity bias makes hardening reachable. Flag-off is byte-identical. */
const fresh = (): Soul => ({ emotionalBaseline: 0.5, volatility: 0.4, emotionalState: 0.5, emotionalHistory: [], memory: [] });
const play = (evs: EmotionalEvent[], o: { negativityBias?: boolean; driftScale?: number }) => { const s = fresh(); for (const e of evs) evolveEmotion(s, e, undefined, undefined, { soulDepth: true, ...o }); return s; };

describe("pure drift", () => {
  it("opts absent => byte-identical (no bias, scale 1)", () => {
    const evs: EmotionalEvent[] = ["betrayed", "bond", "nominated", "calm", "comp-win"];
    expect(play(evs, {}).temperamentDrift).toBe(play(evs, { negativityBias: false, driftScale: 1 }).temperamentDrift);
  });
  it("negativity bias: hardening x1.5, softening x0.75", () => {
    expect(play(["betrayed"], { negativityBias: true }).temperamentDrift).toBeCloseTo(0.28 * 1.5, 9);
    expect(play(["bond"], { negativityBias: true }).temperamentDrift).toBeCloseTo(-0.28 * 0.75, 9);
  });
  it("a repeatedly-burned NPC reaches clash with the bias but not without, under the weekly pattern that cancelled it before (betrayal, then routine bond/comp-win/survived beats)", () => {
    const week: EmotionalEvent[] = ["betrayed", "survived-vote", "bond", "betrayed", "comp-win"];
    const evs = [...week, ...week, ...week];
    expect(effectiveDisposition("neutral", play(evs, {}))).not.toBe("clash");
    expect(effectiveDisposition("neutral", play(evs, { negativityBias: true }))).toBe("clash");
  });
  it("severity scale shrinks the nudge", () => {
    expect(play(["betrayed"], { negativityBias: true, driftScale: 0.5 }).temperamentDrift).toBeCloseTo(0.28 * 1.5 * 0.5, 9);
  });
});

type Internals = { soulObj(id: EntityId): Soul | undefined; setDriftFixEnabled(on: boolean): void; rememberPlayerScene(h: readonly EntityId[], k: string): void };
function game(on: boolean) {
  const sb = new GameSessionRegistry().sandboxFor(`b32-${Math.random()}`);
  sb.session.createCharacter({ playerName: "P", archetype: "floater", seed: 7 });
  const s = sb.session as unknown as Internals;
  s.setDriftFixEnabled(on);
  const who = sb.session.livingIds().filter((i) => i !== PLAYER)[0]!;
  return { s, who };
}
describe("chat scenes feed the arc", () => {
  it("OFF: a recorded betrayal leaves temperament untouched (the #2104 finding); ON: it hardens, and kindness softens", () => {
    const off = game(false);
    off.s.rememberPlayerScene([off.who], "betrayal");
    expect(off.s.soulObj(off.who)!.temperamentDrift ?? 0).toBe(0);
    const on = game(true);
    on.s.rememberPlayerScene([on.who], "betrayal");
    expect(on.s.soulObj(on.who)!.temperamentDrift ?? 0).toBeGreaterThan(0.2);
    const kind = game(true);
    kind.s.rememberPlayerScene([kind.who], "bonding");
    expect(kind.s.soulObj(kind.who)!.temperamentDrift ?? 0).toBeLessThan(0);
    const other = game(true);
    other.s.rememberPlayerScene([other.who], "unknown-kind");
    expect(other.s.soulObj(other.who)!.temperamentDrift ?? 0).toBe(0);
  });
  it("repeated betrayals take an NPC to clash", () => {
    const g = game(true);
    for (let i = 0; i < 3; i++) g.s.rememberPlayerScene([g.who], "betrayal");
    expect(effectiveDisposition("neutral", g.s.soulObj(g.who)!)).toBe("clash");
  });
});

describe("the bond floor (a run of good beats cannot pin the temperament where betrayals can never reach clash)", () => {
  const run = (evs: EmotionalEvent[], o: { negativityBias?: boolean }) => { const s = fresh(); for (const e of evs) evolveEmotion(s, e, undefined, undefined, { soulDepth: true, ...o }); return s; };
  const goodRun: EmotionalEvent[] = Array.from({ length: 12 }, () => "bond");
  it("with the fix, many good beats bottom out at the floor, and three betrayals then reach clash; without it they pin at -1 and three betrayals do not", () => {
    const withFix = run([...goodRun, "betrayed", "betrayed", "betrayed"], { negativityBias: true });
    const without = run([...goodRun, "betrayed", "betrayed", "betrayed"], {});
    expect(run(goodRun, { negativityBias: true }).temperamentDrift).toBeCloseTo(-0.7, 9);
    expect(run(goodRun, {}).temperamentDrift).toBe(-1);
    expect(effectiveDisposition("neutral", withFix)).toBe("clash");
    expect(effectiveDisposition("neutral", without)).not.toBe("clash");
  });
});
