import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Goal } from "../../src/engine/agenda";
import { DESIRE, desireForAction, goalDriven } from "../../src/engine/desireClock";

/**
 * ORW-340 (theme 1 section 2, Ryne 2026-11-12: "NPCs come to the player because of their goals: an NPC who needs the player's vote seeks them out; one who distrusts them avoids them").
 * An hourly plan made for an NPC's own goal that names the player becomes an approach raised through the desire clock's own path, with its guards. Roles only (holder, voter-player, bystander).
 */
describe("the pure parts", () => {
  it("an action aimed at the player maps to the nearest existing approach desire", () => {
    expect(["beg", "bargain", "call-in-favor", "make-a-promise"].map(desireForAction)).toEqual(["plea", "plea", "plea", "plea"]);
    expect(["pitch", "recruit", "lobby-for"].map(desireForAction)).toEqual(["campaign", "campaign", "campaign"]);
    expect(["count-votes", "flip-a-vote", "campaign-against"].map(desireForAction)).toEqual(["probe", "probe", "probe"]);
    expect(["check-in", "comfort", "tell-stories"].map(desireForAction)).toEqual(["check-in", "check-in", "check-in"]);
  });

  it("the goal-driven approacher is the rested candidate with the strongest tie (lower id on a tie); a cooling-down one is skipped", () => {
    const c = (npc: string, drive: number, hoursSinceApproach?: number) => ({ npc, desire: "plea" as const, drive, hoursSinceApproach });
    expect(goalDriven([c("npc:2", 0.4), c("npc:3", 0.9)])).toMatchObject({ npc: "npc:3" });
    expect(goalDriven([c("npc:3", 0.5), c("npc:2", 0.5)])).toMatchObject({ npc: "npc:2" });
    expect(goalDriven([c("npc:3", 0.9, DESIRE.cooldownHours - 0.5), c("npc:2", 0.1)])).toMatchObject({ npc: "npc:2" });
    expect(goalDriven([c("npc:3", 0.9, DESIRE.cooldownHours - 0.5)])).toBeNull();
    expect(goalDriven([])).toBeNull();
  });
});

type S = {
  livingIds(): EntityId[];
  houseLifeStretch(events: unknown, awakeIds: readonly EntityId[], stretchIndex: number): unknown[];
  getGameState(): unknown;
  getMomentPrompt(a: object): unknown;
  npcVoice(id: EntityId): unknown;
  live: { week: number; nightDepth?: number; hoh?: string; nominees?: string[]; agendas?: Record<string, { goals: Goal[]; history: Goal[] }>; goalApproaches?: Record<string, { desire: string; goalId: string; hour: number }>; desireApproachedAt?: Record<string, number> };
  presence: Map<EntityId, string>;
  rel: { edge(a: EntityId, b: EntityId): { affinity: number; trust: number } };
  absHour(): number;
  desireApproach(ids: EntityId[]): { npc: EntityId; desire: string } | null;
};
async function setup(seed: number) {
  const reg = composeRuntime({ clock: new FakeClock(), seed }).registry as GameSessionRegistry;
  const user = `goal-approach-${seed}-${Math.random()}`;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  await mcp.callTool("noteMessage", { messageId: "first" }); // a played game: agendas seed
  const sb = reg.sandboxFor(user);
  const s = sb.session as unknown as S;
  const [holder, other, hoh, bystander] = s.livingIds().filter((i) => i !== PLAYER) as [EntityId, EntityId, EntityId, EntityId];
  // the holder is on the block with a stay-safe goal and the player is a voter they have reason to trust
  s.live.hoh = hoh; s.live.nominees = [holder, other];
  const goal: Goal = { id: `${holder}:week:stay-safe:d1`, owner: holder, horizon: "week", kind: "stay-safe", why: [{ kind: "character", weight: 1 }], test: { kind: "survives-week" }, commitment: 1, status: "active", formedDay: 1, formedWeek: s.live.week };
  s.live.agendas![holder]!.goals.push(goal);
  for (const id of [...s.presence.keys()]) s.presence.set(id, "backyard");
  s.presence.set(PLAYER, "kitchen");
  s.rel.edge(holder, PLAYER).affinity = 0.95; s.rel.edge(holder, PLAYER).trust = 0.8;
  const awake = [holder, other, hoh, bystander, PLAYER] as EntityId[];
  const stretch = (n = 14): void => { for (let i = 0; i < n && !s.live.goalApproaches?.[holder]; i++) { s.live.nightDepth = (s.live.nightDepth ?? 8) + 1; s.houseLifeStretch(sb.engine.events, awake, i); } }; // the in-game hour moves on between stretches (the rolls are keyed on it)
  return { s, sb, holder, bystander, goal, stretch, awake };
}

describe("a goal brings an NPC to the player (live)", () => {
  it("a nominated houseguest with a stay-safe goal raises a PLEA approach to the player within the day, through the desire clock", async () => {
    const { s, holder, goal, stretch } = await setup(11);
    stretch();
    expect(s.live.goalApproaches![holder]).toMatchObject({ desire: "plea", goalId: goal.id });
    expect(s.desireApproach([holder])).toEqual({ npc: holder, desire: "plea" });
  });

  it("a houseguest with no goal involving the player does not approach for that reason", async () => {
    const { s, bystander, stretch } = await setup(11);
    stretch(14);
    expect(s.live.goalApproaches?.[bystander]).toBeUndefined();
  });

  it("one who distrusts the player does not come: with low trust no approach is raised", async () => {
    const { s, holder, stretch } = await setup(11);
    s.rel.edge(holder, PLAYER).trust = DESIRE.goalMinTrust - 0.1;
    stretch(14);
    expect(s.live.goalApproaches?.[holder]).toBeUndefined();
  });

  it("the guards hold: the cooldown blocks it, a sleeper never comes, and acting on it clears the reason", async () => {
    const { s, holder, stretch } = await setup(11);
    stretch();
    expect(s.live.goalApproaches![holder]).toBeDefined();
    expect(s.desireApproach([])?.npc, "asleep (not among the awake ids) = never").toBeUndefined();
    s.live.desireApproachedAt = { [holder]: s.absHour() };
    expect(s.desireApproach([holder])?.npc, "inside the cooldown").not.toBe(holder);
    s.live.desireApproachedAt = {};
    (s as unknown as { noteApproach(n: EntityId): void }).noteApproach(holder);
    expect(s.live.goalApproaches![holder], "the reason is spent once they have approached").toBeUndefined();
  });

  it("a stale reason lapses: after goalFreshHours it no longer brings anyone", async () => {
    const { s, holder, stretch } = await setup(11);
    stretch();
    s.live.goalApproaches![holder]!.hour = s.absHour() - DESIRE.goalFreshHours - 1;
    expect(s.desireApproach([holder])?.npc).not.toBe(holder);
  });

  it("the goal never reaches a player surface (Vault sentinel): only the NPC and the coarse desire do", async () => {
    const { s, holder, goal, stretch } = await setup(11);
    stretch();
    const surfaces = JSON.stringify([s.getGameState(), s.getMomentPrompt({}), s.npcVoice(holder)]);
    expect(surfaces).not.toContain(goal.id);
    expect(surfaces).not.toContain("goalApproaches");
  });
});
