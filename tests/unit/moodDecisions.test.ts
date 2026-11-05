import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { RelationshipModel } from "../../src/engine/relationships";
import { moodVetoTerm, moodApproachTerm, MOOD_TERMS } from "../../src/engine/tellReactions";
import { npc } from "../../src/domain/ids";

/** B30 (#2017 15.6 E4a): emotion reaches the veto save (ORWELL_MOOD_VETO) and who seeks the player out (ORWELL_MOOD_APPROACH), each its own flag, bounded, off => nothing. Roles only. */
describe("pure terms", () => {
  it("veto: a rattled holder rescues the nominee they are close to (scaled by the bond); a snapping holder is less forgiving; nothing else moves it", () => {
    expect(moodVetoTerm([{ kind: "withdrawn" }], 1)).toBe(MOOD_TERMS.vetoRescue);
    expect(moodVetoTerm([{ kind: "tearful" }], 0.5)).toBeCloseTo(MOOD_TERMS.vetoRescue * 0.5, 9);
    expect(moodVetoTerm([{ kind: "withdrawn" }], 0)).toBe(0);
    expect(moodVetoTerm([{ kind: "snapping" }], 0.9)).toBe(-MOOD_TERMS.vetoSnap);
    expect(moodVetoTerm([{ kind: "giddy" }], 1)).toBe(0);
    expect(moodVetoTerm([], 1)).toBe(0);
    expect(moodVetoTerm(undefined, 1)).toBe(0);
  });
  it("approach: withdrawn/tearful seek the player less, snapping a little less, giddy/warm-open more", () => {
    expect(moodApproachTerm([{ kind: "withdrawn" }])).toBe(MOOD_TERMS.approachWithdrawn);
    expect(moodApproachTerm([{ kind: "snapping" }])).toBe(MOOD_TERMS.approachSnapping);
    expect(moodApproachTerm([{ kind: "giddy" }])).toBe(MOOD_TERMS.approachUp);
    expect(moodApproachTerm([{ kind: "restless" }])).toBe(0);
    expect(moodApproachTerm(undefined)).toBe(0);
  });
  it("the veto bias is enough to flip a narrow save between two nominees (a rattled-holder control moves the decision)", () => {
    const rel = new RelationshipModel(0.5);
    const holder = npc(5), a = npc(1), b = npc(2);
    rel.edge(holder, a).trust = 0.6; rel.edge(holder, b).trust = 0.6; rel.edge(holder, a).affinity = 0.6; rel.edge(holder, b).affinity = 0.595;
    const plain = rel.chooseVetoSave(holder, [a, b], undefined);
    const rattled = rel.chooseVetoSave(holder, [a, b], (n) => (n === b ? MOOD_TERMS.vetoRescue : 0));
    expect(rattled).toBe(b);
    expect([plain, rattled].some((x) => x === b)).toBe(true);
  });
});

type Internals = { soulObj(id: EntityId): { tells?: Array<{ kind: string; since: number; band: string }> } | undefined; setNpcTellsEnabled(on: boolean): void;
  setMoodVetoEnabled(on: boolean): void; setMoodApproachEnabled(on: boolean): void; moodVetoFor(n: EntityId, h: EntityId): number; moodApproachFor(n: EntityId): number; ctx(): { moodVetoFor?: unknown } };
function game(o: { tells: boolean; veto: boolean; approach: boolean }) {
  const sb = new GameSessionRegistry().sandboxFor(`b30-${Math.random()}`);
  sb.session.createCharacter({ playerName: "P", archetype: "floater", seed: 7 });
  const s = sb.session as unknown as Internals;
  s.setNpcTellsEnabled(o.tells); s.setMoodVetoEnabled(o.veto); s.setMoodApproachEnabled(o.approach);
  const [holder, nominee] = sb.session.livingIds().filter((i) => i !== PLAYER) as [EntityId, EntityId];
  s.soulObj(holder)!.tells = [{ kind: "withdrawn", since: 1, band: "strong" }];
  return { s, holder, nominee };
}
describe("adapter providers", () => {
  it("OFF (each flag alone, and tells off): the providers return 0 and the ctx registers no veto provider", () => {
    const a = game({ tells: true, veto: false, approach: false });
    expect(a.s.moodVetoFor(a.nominee, a.holder)).toBe(0);
    expect(a.s.moodApproachFor(a.holder)).toBe(0);
    expect(a.s.ctx().moodVetoFor).toBeUndefined();
    const b = game({ tells: false, veto: true, approach: true });
    expect(b.s.moodVetoFor(b.nominee, b.holder)).toBe(0);
    expect(b.s.moodApproachFor(b.holder)).toBe(0);
    expect(b.s.ctx().moodVetoFor).toBeUndefined();
  });
  it("ON: the rattled holder's veto bias is positive toward a nominee they are bonded to, and their approach drive is suppressed; the flags are independent", () => {
    const g = game({ tells: true, veto: true, approach: false });
    expect(g.s.moodVetoFor(g.nominee, g.holder)).toBeGreaterThanOrEqual(0);
    expect(g.s.moodVetoFor(g.nominee, g.holder)).toBeLessThanOrEqual(MOOD_TERMS.vetoRescue);
    expect(g.s.ctx().moodVetoFor).toBeTypeOf("function");
    expect(g.s.moodApproachFor(g.holder), "approach flag off: no approach term").toBe(0);
    const h = game({ tells: true, veto: false, approach: true });
    expect(h.s.moodApproachFor(h.holder)).toBe(MOOD_TERMS.approachWithdrawn);
    expect(h.s.moodVetoFor(h.nominee, h.holder), "veto flag off: no veto term").toBe(0);
  });
});
