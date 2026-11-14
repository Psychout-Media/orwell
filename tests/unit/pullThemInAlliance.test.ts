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

describe("there is no count cap on alliances (ORW-353, Ryne 2026-11-14: \"if alliances are formed they are formed\")", () => {
  it("with the house already full of alliances an agenda goal still forms one", async () => {
    const { s, holder, target, third, bond, goal, give, rng } = await setup();
    const others = s.livingIds().filter((i) => i !== PLAYER && i !== holder && i !== target && i !== third);
    for (let k = 0; k + 1 < Math.min(others.length, 8); k += 2) s.alliances.add(`Full ${k}`, others[k]!, [others[k]!, others[k + 1]!], 1);
    expect(s.alliances.all().length, "more alliances than the old cap of 2").toBeGreaterThan(2);
    bond(holder, target, 0.7); give(goal("pull-them-in", holder, target));
    s.formNpcAlliances(rng());
    expect(allied(s, holder, target), "no room needed: the goal forms it").toBe(true);
  });
});

describe("an alliance that does not hold fades (ORW-353; the measure is the bloc cohesion)", () => {
  type F = S & { fadeAlliances(): void; live: S["live"] & { dayNumber?: number } };
  const day = (s: F, d: number) => { s.live.dayNumber = d; };
  it("a formed alliance whose members drift apart fades after fadeDays in a row under the floor, not before", async () => {
    const { s, holder, target, bond, goal, give, rng } = await setup();
    const f = s as unknown as F;
    bond(holder, target, 0.7); give(goal("pull-them-in", holder, target));
    day(f, 1); s.formNpcAlliances(rng());
    expect(allied(s, holder, target)).toBe(true);
    day(f, 1); f.fadeAlliances(); // healthy day: baseline
    bond(holder, target, 0.1); // they drift apart
    for (let d = 2; d < 2 + ALLIANCE.fadeDays - 1; d++) { day(f, d); f.fadeAlliances(); expect(allied(s, holder, target), `day ${d}: still holding`).toBe(true); }
    day(f, 2 + ALLIANCE.fadeDays - 1); f.fadeAlliances();
    expect(allied(s, holder, target), "fadeDays in a row under the floor: it dissolves").toBe(false);
  });

  it("a healthy day resets the count: an alliance that recovers does not fade", async () => {
    const { s, holder, target, bond, goal, give, rng } = await setup();
    const f = s as unknown as F;
    bond(holder, target, 0.7); give(goal("pull-them-in", holder, target));
    day(f, 1); s.formNpcAlliances(rng());
    bond(holder, target, 0.1); day(f, 2); f.fadeAlliances(); day(f, 3); f.fadeAlliances();
    bond(holder, target, 0.7); day(f, 4); f.fadeAlliances(); // recovered
    bond(holder, target, 0.1); day(f, 5); f.fadeAlliances(); day(f, 6); f.fadeAlliances();
    expect(allied(s, holder, target), "only two low days since the recovery").toBe(true);
  });

  it("the player's own named pact never fades silently", async () => {
    const { s, holder, bond } = await setup();
    const f = s as unknown as F;
    s.alliances.add("Mine", PLAYER, [PLAYER, holder], 1);
    bond(PLAYER, holder, 0.05);
    for (let d = 1; d <= ALLIANCE.fadeDays + 3; d++) { day(f, d); f.fadeAlliances(); }
    expect(allied(s, PLAYER, holder)).toBe(true);
  });

  it("the alliance's cohesion IS the bloc cohesion: the weakest mutual bond among its members, one shared function", async () => {
    const { cohesionOf } = await import("../../src/engine/blocs");
    const bonds: Record<string, number> = { "a|b": 0.9, "a|c": 0.7, "b|c": 0.45 };
    const bond = (x: string, y: string): number => bonds[[x, y].sort().join("|")] ?? 1;
    expect(cohesionOf(["a", "b", "c"] as never, bond as never)).toBe(0.45);
    expect(cohesionOf(["a"] as never, bond as never)).toBe(1);
  });

  it("the neglect counters survive a save and an older save without them loads clean", async () => {
    const { AllianceStore } = await import("../../src/engine/alliances");
    const st = new AllianceStore();
    const a = st.add("X", "npc:1" as EntityId, ["npc:1", "npc:2"] as EntityId[], 1);
    st.fade(5, () => 0.1, () => false); // checked, one low day
    const rows = JSON.parse(JSON.stringify(st.serialize()));
    expect(rows[0]).toMatchObject({ lowDays: 1, checkedDay: 5 });
    const old = rows.map((r: Record<string, unknown>) => { const { lowDays, checkedDay, ...rest } = r; void lowDays; void checkedDay; return rest; });
    const st2 = new AllianceStore(); st2.load(old);
    expect(st2.all()).toHaveLength(1);
    expect(st2.fade(6, () => 0.9, () => false)).toHaveLength(0);
    void a;
  });
});
