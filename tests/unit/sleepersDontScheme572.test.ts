import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { RelationshipModel } from "../../src/engine/relationships";
import { nextStepFor, type HourView } from "../../src/engine/houseLife";
import type { Goal, AgendaCharacter } from "../../src/engine/agenda";
import type { Room } from "../../src/domain/house";
import type { EntityId } from "../../src/domain/ids";
import { PLAYER } from "../../src/domain/ids";

/**
 * ORW-572 (Fable audit T1-3): sleep means no scheming (Ryne). A house-life step must never name a partner who is not awake and
 * reachable (not in the hour view), and the campaign / alliance / secret-barter ticks must only use awake houseguests. With the
 * in-game clock OFF everyone counts as awake (the existing identity). Roles only.
 */
const HOLDER = "npc:holder", AWAKE = "npc:awake", ASLEEP_HOH = "npc:asleep-hoh", ASLEEP_TARGET = "npc:asleep-target";
const char: AgendaCharacter = { archetype: "analyst", strategyStyle: "social", secretKinds: [] };

function view(awake: EntityId[], over: Partial<HourView> = {}): HourView {
  const room: Room = "living-room";
  return {
    owner: HOLDER, character: char, agenda: undefined, habits: [], emotional: 0.6, room,
    whereabouts: new Map<EntityId, Room>([[HOLDER, room], ...awake.map((a) => [a, room] as const)]),
    affinity: new Map([[AWAKE, 0.6], [ASLEEP_HOH, 0.7], [ASLEEP_TARGET, 0.4]]), threat: new Map(),
    mates: [], nominees: [], timeOfDay: "afternoon", day: 3, hour: 14, inCompetition: false, candor: 0.7, ...over,
  } as HourView;
}
const goal = (kind: Goal["kind"], target?: EntityId): Goal => ({ id: `g:${kind}`, kind, ...(target ? { target } : {}), commitment: 0.9, born: 1 } as unknown as Goal);

describe("ORW-572: a house-life step never names a partner who is not awake", () => {
  const cases: Array<[string, Goal, Partial<HourView>]> = [
    ["stay-safe with an asleep HOH", goal("stay-safe"), { hoh: ASLEEP_HOH }],
    ["keep-them-safe lobbying an asleep HOH", goal("keep-them-safe", ASLEEP_TARGET), { hoh: ASLEEP_HOH }],
    ["get-them-out campaigning to an asleep HOH", goal("get-them-out", ASLEEP_TARGET), { hoh: ASLEEP_HOH }],
    ["protect-my-person with an asleep target", goal("protect-my-person", ASLEEP_TARGET), {}],
    ["long-con with an asleep target", goal("long-con", ASLEEP_TARGET), {}],
    ["pull-them-in with an asleep target", goal("pull-them-in", ASLEEP_TARGET), {}],
  ];
  for (const [label, g, over] of cases) {
    it(label, () => {
      const v = view([AWAKE], over);
      for (let i = 0; i < 200; i++) {
        const step = nextStepFor(g, v, i / 200);
        if (!step) continue;
        for (const p of step.with) expect([AWAKE, HOLDER]).toContain(p);
      }
    });
  }
  it("an awake partner is still used (the fix removes only the asleep)", () => {
    const v = view([AWAKE, ASLEEP_HOH], { hoh: ASLEEP_HOH });
    const g = goal("protect-my-person", AWAKE);
    const steps = Array.from({ length: 50 }, (_, i) => nextStepFor(g, v, i / 50)).filter(Boolean);
    expect(steps.length).toBeGreaterThan(0);
    for (const st of steps) expect(st!.with).toEqual([AWAKE]);
  });
});

interface Pokeable { alliances: { all(): Array<{ members: EntityId[] }> }; awakeNow: () => Set<EntityId> | null; campaigns: Array<{ owners: EntityId[]; status: string }>; campaignTick(): void; }
function started(seed: number): { s: GameSessionAdapter; p: Pokeable; rel: RelationshipModel; ids: EntityId[] } {
  const rel = new RelationshipModel(0.5);
  const s = new GameSessionAdapter(rel);
  s.setCampaignsEnabled(true);
  s.createCharacter({ playerName: "The Player", seed });
  const ids = (s.snapshot().house?.npcs ?? []).map((n) => n.id);
  return { s, p: s as unknown as Pokeable, rel, ids };
}
const warm = (rel: RelationshipModel, a: EntityId, b: EntityId, v = 0.85): void => {
  for (const [x, y] of [[a, b], [b, a]] as const) { const e = rel.edge(x, y); e.trust = v; e.affinity = v; e.threat = 0.1; }
};

describe("ORW-572: the campaign and alliance ticks use only the awake", () => {
  it("a tight trio that is all asleep forms no alliance and owns no campaign; the same trio awake does", () => {
    const awakeRun = started(2026);
    const [a, b, c] = awakeRun.ids;
    warm(awakeRun.rel, a!, b!); warm(awakeRun.rel, a!, c!); warm(awakeRun.rel, b!, c!);
    for (let k = 0; k < 4; k++) awakeRun.p.campaignTick();
    expect(awakeRun.p.alliances.all().length).toBeGreaterThan(0); // control: the existing 0107B behaviour with everyone up

    const sleepRun = started(2026);
    const [x, y, z] = sleepRun.ids;
    warm(sleepRun.rel, x!, y!); warm(sleepRun.rel, x!, z!); warm(sleepRun.rel, y!, z!);
    const asleep = new Set([x!, y!, z!]);
    sleepRun.p.awakeNow = () => new Set<EntityId>([PLAYER, ...sleepRun.ids.filter((i) => !asleep.has(i))]);
    for (let k = 0; k < 4; k++) sleepRun.p.campaignTick();
    for (const al of sleepRun.p.alliances.all()) for (const m of al.members) expect(asleep.has(m)).toBe(false);
    for (const c2 of sleepRun.p.campaigns) if (c2.status === "active") expect(asleep.has(c2.owners[0]!)).toBe(false);
  });
});
