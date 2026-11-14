import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Goal } from "../../src/engine/agenda";
import { ALLIANCE } from "../../src/engine/alliances";

/**
 * ORW-341 (theme 1, Ryne 2026-11-12: goals include "pull Y into my alliance", with a success test): a "pull them in" goal turns the hours spent pitching into an alliance with
 * its TARGET, through the existing consent (the target must be willing); a last-alliance-standing or run-the-house aim founds one. Played games only; the player is never auto-added.
 * Roles only (holder, target, third).
 */
type S = {
  livingIds(): EntityId[];
  live: { week: number; playedGame?: boolean; pitched?: Record<string, number>; agendas?: Record<string, { goals: Goal[]; history: Goal[] }> };
  alliances: { all(): ReadonlyArray<{ id: string; members: EntityId[]; founder: EntityId }>; add(n: string, f: EntityId, m: EntityId[], b: number): { id: string }; load(rows: readonly never[]): void; removeMember(id: string, who: EntityId): void };
  drives: Map<EntityId, unknown>;
  rel: { edge(a: EntityId, b: EntityId): { trust: number; affinity: number } };
  formNpcAlliances(rng: SeededRandom): void;
};
async function setup(seed = 11) {
  const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
  const user = `pull-in-${seed}-${Math.random()}`;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  await mcp.callTool("noteMessage", { messageId: "first" }); // a played game: agendas seed
  const s = reg.sandboxFor(user).session as unknown as S;
  const [holder, target, third] = s.livingIds().filter((i) => i !== PLAYER) as [EntityId, EntityId, EntityId];
  s.drives = new Map(); // no old-drive founders: only the agenda can found one
  s.alliances.load([]); // the played game may already have named some: start from none
  for (const a of Object.values(s.live.agendas!)) a.goals = []; // and every houseguest holds the one goal this test gives, nothing seeded
  const bond = (a: EntityId, b: EntityId, v: number) => { for (const [x, y] of [[a, b], [b, a]] as const) { s.rel.edge(x, y).trust = v; s.rel.edge(x, y).affinity = v; } };
  for (const a of s.livingIds()) for (const b of s.livingIds()) if (a !== b) bond(a, b, 0.2); // everyone barely knows each other
  const goal = (kind: Goal["kind"], who: EntityId, tgt?: EntityId): Goal => ({ id: `${who}:${kind}:d1`, owner: who, horizon: kind === "pull-them-in" ? "week" : "season", kind, ...(tgt ? { target: tgt } : {}), why: [{ kind: "character", weight: 1 }],
    test: kind === "pull-them-in" ? { kind: "allied-with", who: tgt! } : { kind: "final-two-alliance" }, commitment: 1, status: "active", formedDay: 1, formedWeek: s.live.week });
  const give = (g: Goal) => { s.live.agendas![g.owner]!.goals.push(g); };
  const rng = () => new SeededRandom(7);
  return { s, holder, target, third, bond, goal, give, rng };
}
const allied = (s: S, a: EntityId, b: EntityId) => s.alliances.all().some((x) => x.members.includes(a) && x.members.includes(b));

describe("a pull-them-in goal forms an alliance with its target (ORW-341)", () => {
  it("a willing target joins: an alliance forms with both in it", async () => {
    const { s, holder, target, bond, goal, give, rng } = await setup();
    bond(holder, target, 0.7); give(goal("pull-them-in", holder, target));
    s.formNpcAlliances(rng());
    expect(allied(s, holder, target)).toBe(true);
  });

  it("an unwilling target never joins (the consent holds)", async () => {
    const { s, holder, target, bond, goal, give, rng } = await setup();
    bond(holder, target, 0.3); give(goal("pull-them-in", holder, target));
    s.formNpcAlliances(rng());
    expect(allied(s, holder, target)).toBe(false);
  });

  it("a target pitched this week counts a little warmer; one pitched last week does not", async () => {
    const { s, holder, target, bond, goal, give, rng } = await setup();
    bond(holder, target, ALLIANCE.npcAllyFloor - ALLIANCE.pitchedWarmth / 2); give(goal("pull-them-in", holder, target));
    s.live.pitched = { [`${holder}>${target}`]: s.live.week - 1 };
    s.formNpcAlliances(rng());
    expect(allied(s, holder, target), "pitched last week: just under the floor").toBe(false);
    s.live.pitched = { [`${holder}>${target}`]: s.live.week };
    s.formNpcAlliances(rng());
    expect(allied(s, holder, target), "pitched this week: just over it").toBe(true);
  });

  it("a holder already in an alliance extends it with the target instead of founding a second", async () => {
    const { s, holder, target, third, bond, goal, give, rng } = await setup();
    const a = s.alliances.add("The Pact", holder, [holder, third], 1);
    bond(holder, target, 0.7); give(goal("pull-them-in", holder, target));
    s.formNpcAlliances(rng());
    expect(s.alliances.all().find((x) => x.id === a.id)!.members, "the holder's own alliance grew").toEqual([holder, third, target]);
    expect(s.alliances.all().filter((x) => x.founder === holder).length, "and no second alliance was founded by them").toBe(1);
  });

  it("the player is never auto-added: a goal aimed at the player forms nothing", async () => {
    const { s, holder, bond, goal, give, rng } = await setup();
    bond(holder, PLAYER, 0.9); give(goal("pull-them-in", holder, PLAYER));
    s.formNpcAlliances(rng());
    expect(s.alliances.all().some((x) => x.members.includes(PLAYER))).toBe(false);
  });

  it("a headless (not played) game is untouched", async () => {
    const { s, holder, target, bond, goal, give, rng } = await setup();
    bond(holder, target, 0.7); give(goal("pull-them-in", holder, target));
    s.live.playedGame = false;
    s.formNpcAlliances(rng());
    expect(s.alliances.all().length).toBe(0);
  });
});

describe("an aim to build alliances founds one (ORW-341)", () => {
  it("a last-alliance-standing holder over real bonds founds an alliance; without the aim, or without the bonds, none", async () => {
    const a = await setup(11);
    a.bond(a.holder, a.target, 0.75); a.bond(a.holder, a.third, 0.75);
    a.s.formNpcAlliances(a.rng());
    expect(a.s.alliances.all().length, "no aim, no old drive: nothing forms").toBe(0);
    a.give(a.goal("last-alliance-standing", a.holder));
    a.s.formNpcAlliances(a.rng());
    expect(a.s.alliances.all().some((x) => x.founder === a.holder), "the aim holder founded one").toBe(true);
    const b = await setup(12);
    b.give(b.goal("last-alliance-standing", b.holder)); // the aim, but nobody is bonded enough
    b.s.formNpcAlliances(b.rng());
    expect(b.s.alliances.all().length).toBe(0);
  });
});

describe("the house has room for only so many alliances (the ORW-341 retune)", () => {
  it("with the house full of alliances an agenda goal forms no new one; when one dissolves it can", async () => {
    const { s, holder, target, third, bond, goal, give, rng } = await setup();
    const others = s.livingIds().filter((i) => i !== PLAYER && i !== holder && i !== target && i !== third);
    s.alliances.add("Full One", others[0]!, [others[0]!, others[1]!], 1);
    const second = s.alliances.add("Full Two", others[2]!, [others[2]!, others[3]!], 1);
    expect(s.alliances.all().length).toBe(ALLIANCE.agendaMaxLive);
    bond(holder, target, 0.7); give(goal("pull-them-in", holder, target));
    s.formNpcAlliances(rng());
    expect(allied(s, holder, target), "no room: the goal does not form one").toBe(false);
    s.alliances.removeMember(second.id, others[2]!); // a member leaves: that alliance dissolves
    s.formNpcAlliances(rng());
    expect(allied(s, holder, target), "room again: it does").toBe(true);
  });
});
