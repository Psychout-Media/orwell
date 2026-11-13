import { describe, it, expect } from "vitest";
import { memoryLine, fillSubject, appraiseGoal, mayShareCause } from "../../src/engine/innerLife";
import type { Goal } from "../../src/engine/agenda";
import type { MemoryKind } from "../../src/engine/npcMemory";

/** ORW-253 slice 4 core: memories hold what happened; a settled goal gives a feeling with a cause; the cause is guarded. Roles only. */
const KINDS: MemoryKind[] = ["deal-broken", "nominated-by-friend", "replaced-by-friend", "veto-saved", "veto-withheld", "deal-kept", "scene-betrayal",
  "scene-conflict", "scene-kindness", "secret-exposed", "secret-given", "nominated-by-hoh", "deal-witnessed", "deal-resented"];
const goal = (kind: Goal["kind"], status: Goal["status"], commitment = 0.8, target: string | undefined = "npc:2"): Goal => ({
  id: "g", owner: "npc:1", horizon: "week", kind, ...(target ? { target } : {}), why: [], test: { kind: "survives-week" }, commitment, status, formedDay: 1, formedWeek: 1,
});

describe("memory with content", () => {
  it("every memory kind has a line to the person and a line about them, and the engine text holds no names", () => {
    for (const k of KINDS) {
      const l = memoryLine(k);
      expect(l.toThem.length, k).toBeGreaterThan(8);
      expect(l.aboutThem, k).toMatch(/\{subject\}|I saw/);
      expect(l.toThem, k).not.toMatch(/\{subject\}/);
    }
    expect(memoryLine("veto-withheld").toThem).toBe("you left me on the block when you held the veto");
  });

  it("the narrator seam fills the public name into the 'about them' form", () => {
    expect(fillSubject(memoryLine("deal-broken").aboutThem, "Houseguest")).toBe("Houseguest broke the deal we made");
  });
});

describe("mood with a cause", () => {
  it("a plan that works lifts the mood, with the reason in the holder's own words", () => {
    const a = appraiseGoal(goal("get-them-out", "achieved"));
    expect(a.event).toBe("comp-win");
    expect(a.cause).toMatchObject({ outcome: "worked", about: "npc:2", line: "I got {subject} out, like I planned" });
  });

  it("a plan that falls apart hurts, and losing the person you protect hurts most", () => {
    expect(appraiseGoal(goal("get-them-out", "failed")).event).toBe("comp-loss");
    expect(appraiseGoal(goal("keep-them-safe", "failed")).event).toBe("blindside");
    expect(appraiseGoal(goal("keep-my-secret", "failed", 0.8, undefined)).cause?.line).toBe("everyone knows my secret now");
  });

  it("a goal they barely cared about passes without a feeling; a dropped or replaced one leaves a quiet cause, no event", () => {
    expect(appraiseGoal(goal("get-them-out", "failed", 0.2))).toEqual({ event: undefined, cause: undefined });
    expect(appraiseGoal(goal("get-them-out", "dropped"))).toMatchObject({ event: undefined, cause: { outcome: "gave-up" } });
    expect(appraiseGoal(goal("get-them-out", "replaced"))).toMatchObject({ event: undefined, cause: { outcome: "overtaken" } });
    expect(appraiseGoal(goal("get-them-out", "active"))).toEqual({ event: undefined, cause: undefined });
  });
});

describe("the cause is guarded (Ryne: no motive hints; actions are the evidence)", () => {
  it("a revealing cause is shared only with someone close by someone candid; a harmless one more freely", () => {
    const plot = appraiseGoal(goal("get-them-out", "failed")).cause!;
    const loss = appraiseGoal(goal("win-power", "failed", 0.8, undefined)).cause!;
    expect(mayShareCause(plot, 0.8, 0.5)).toBe(true);
    expect(mayShareCause(plot, 0.5, 0.5)).toBe(false);
    expect(mayShareCause(loss, 0.5, 0.5)).toBe(true);
    expect(mayShareCause(loss, 0.2, 0.3)).toBe(false);
  });
});
