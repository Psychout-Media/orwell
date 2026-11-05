import { describe, it, expect } from "vitest";
import { drivePushFor, DRIVE, type Drive } from "../../src/engine/campaigns";
import { nominationPlan } from "../../src/engine/season";
import { RelationshipModel } from "../../src/engine/relationships";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER, npc } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/** B51 (AMEND 3b): the decider's OWN drive feeds nomination + veto-save scores (ORWELL_DRIVE_DECISIONS). Flag-off byte-identical. */
const d = (motivation: Drive["motivation"], target: EntityId | undefined, intensity: number): Drive => ({ owner: npc(1), motivation, target, intensity });

describe("drivePushFor", () => {
  it("target adds, build protects, scaled by intensity; other motivations / other candidates add nothing", () => {
    expect(drivePushFor(d("target", npc(2), 1), npc(2))).toBe(DRIVE.decisionWeight);
    expect(drivePushFor(d("target", npc(2), 0.5), npc(2))).toBeCloseTo(DRIVE.decisionWeight * 0.5, 9);
    expect(drivePushFor(d("build", npc(2), 1), npc(2))).toBe(-DRIVE.decisionWeight);
    expect(drivePushFor(d("lay-low", undefined, 1), npc(2))).toBe(0);
    expect(drivePushFor(d("self-preserve", npc(2), 1), npc(2))).toBe(0);
    expect(drivePushFor(d("target", npc(2), 1), npc(3))).toBe(0);
    expect(drivePushFor(undefined, npc(2))).toBe(0);
  });
  it("the decider's OWN active campaign counts in place of the bare drive (evict adds, protect and build-alliance protect, scaled by progress), once", () => {
    const evict = { goal: "evict" as const, progress: 1 };
    expect(drivePushFor(d("target", npc(2), 1), npc(2), evict)).toBe(DRIVE.ownCampaignWeight);
    expect(drivePushFor(undefined, npc(2), evict)).toBe(DRIVE.ownCampaignWeight);
    expect(drivePushFor(undefined, npc(2), { goal: "evict", progress: 0 })).toBeCloseTo(DRIVE.ownCampaignWeight * 0.5, 9);
    expect(drivePushFor(undefined, npc(2), { goal: "protect", progress: 1 })).toBe(-DRIVE.ownCampaignWeight);
    expect(drivePushFor(undefined, npc(2), { goal: "build-alliance", progress: 1 })).toBe(-DRIVE.ownCampaignWeight);
    expect(drivePushFor(d("target", npc(2), 1), npc(2), { goal: "discredit", progress: 1 })).toBe(DRIVE.decisionWeight); // a goal that names no seat falls back to the drive
    // the campaign replaces the drive, never adds to it
    expect(Math.abs(drivePushFor(d("target", npc(2), 1), npc(2), evict))).toBeLessThanOrEqual(DRIVE.ownCampaignWeight);
  });
  it("bounded below the campaign base", () => {
    expect(DRIVE.decisionWeight).toBeLessThan(0.25);
    expect(DRIVE.ownCampaignWeight).toBeLessThan(0.25);
  });
});

describe("nomination moves", () => {
  it("a HOH with a target drive on a near-tied candidate nominates them; with no drive push the plan is unchanged", () => {
    const rel = new RelationshipModel(0.5);
    const hoh = npc(1), a = npc(2), b = npc(3), c = npc(4), e = npc(5);
    const active = [hoh, a, b, c, e];
    for (const x of [a, b, c, e]) { rel.edge(hoh, x).threat = 0.5; rel.edge(hoh, x).trust = 0.5; }
    rel.edge(hoh, e).threat = 0.46;
    const base = nominationPlan(hoh, active, rel, {});
    const same = nominationPlan(hoh, active, rel, { drivePush: () => 0 });
    expect(same).toEqual(base);
    const pushed = nominationPlan(hoh, active, rel, { drivePush: (t) => (t === e ? 0.3 : 0) });
    expect(JSON.stringify(pushed)).toContain(e);
    expect(JSON.stringify(pushed)).not.toEqual(JSON.stringify(base));
  });
});

type Internals = { campaigns: Array<Record<string, unknown>>; setDriveDecisionsEnabled(on: boolean): void; drivePushForDecider(t: EntityId, d: EntityId): number; drives: Map<EntityId, Drive>; ctx(): { drivePushFor?: unknown } };
function game(on: boolean) {
  const sb = new GameSessionRegistry().sandboxFor(`b51-${Math.random()}`);
  sb.session.createCharacter({ playerName: "P", archetype: "floater", seed: 7 });
  const s = sb.session as unknown as Internals;
  s.setDriveDecisionsEnabled(on);
  const [h, t] = sb.session.livingIds().filter((i) => i !== PLAYER) as [EntityId, EntityId];
  s.drives.set(h, { owner: h, motivation: "target", target: t, intensity: 1 });
  return { s, h, t };
}
describe("adapter wiring", () => {
  it("OFF: no push, no ctx provider; ON: the push and the provider", () => {
    const off = game(false);
    expect(off.s.drivePushForDecider(off.t, off.h)).toBe(0);
    expect(off.s.ctx().drivePushFor).toBeUndefined();
    const on = game(true);
    expect(on.s.drivePushForDecider(on.t, on.h)).toBe(DRIVE.decisionWeight);
    expect(on.s.ctx().drivePushFor).toBeTypeOf("function");
    expect(on.s.drivePushForDecider(on.h, on.h)).toBe(0);
    on.s.campaigns.push({ id: "c", owners: [on.h], goal: "protect", target: on.t, plan: [], progress: 1, horizon: "week", status: "active", knownTo: [], startedBeat: 0, deadlineBeat: 99 });
    expect(on.s.drivePushForDecider(on.t, on.h), "own protect campaign replaces the evict-ward drive").toBe(-DRIVE.ownCampaignWeight);
  });
});

import { readFileSync } from "node:fs";
describe("veto-save wiring (source pin; the bias is inline so the drift gate can scan it)", () => {
  it("the veto holder's own drive enters the save bias NEGATED (a target drive pushes toward evicting, i.e. away from saving)", () => {
    const src = readFileSync("src/engine/liveSeason.ts", "utf8");
    const i = src.indexOf("// NPC veto holder: save self if nominated");
    const slice = src.slice(i, src.indexOf("if (!saved) {", i));
    expect(slice).toContain("- (ctx.drivePushFor?.(n, s.vetoHolder!) ?? 0)");
  });
});
