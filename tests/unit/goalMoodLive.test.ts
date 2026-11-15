import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { Goal } from "../../src/engine/agenda";

/**
 * ORW-317 mood half (ORW-253 slice 4, Ryne approved the NPC minds design 2026-11-12; motives: "no hints ... their actions are visible"):
 * a settled goal the houseguest cared about moves their mood and becomes their latest mood cause; they TELL the player that cause only
 * with enough trust and candor. Roles only (holder, target).
 */
type S = {
  live: { week: number; active: EntityId[]; evictionOrder: EntityId[]; agendas?: Record<string, { goals: Goal[]; history: Goal[] }>; moodCauses?: Record<string, { outcome: string; line: string }> };
  agendaRecheck(trigger: string): void;
  setGoalMoodEnabled(on: boolean): void;
  npcVoice(id: EntityId): { moodCause?: string } | null;
  soulObj(id: EntityId): { emotionalState: number; emotionalHistory: unknown[] } | undefined;
  rel: { setEdge?: unknown; edge(a: EntityId, b: EntityId): { affinity: number; trust: number } };
  getMomentPrompt(a: object): { systemPrompt: string };
};

async function setup(seed: number) {
  const reg = new GameSessionRegistry();
  const user = `goal-mood-${seed}-${Math.random()}`;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  await mcp.callTool("noteMessage", { messageId: "first" }); // a played game: agendas seed
  const s = reg.sandboxFor(user).session as unknown as S;
  const [holder, target] = s.live.active.filter((x) => x !== PLAYER);
  const goal: Goal = { id: `${holder}:week:get-them-out:${target}:d1`, owner: holder!, horizon: "week", kind: "get-them-out", target: target!, why: [{ kind: "threat-read", about: target!, weight: 0.9 }],
    test: { kind: "evicted", who: target! }, commitment: 0.9, status: "active", formedDay: 1, formedWeek: s.live.week };
  s.live.agendas![holder!]!.goals.push(goal);
  return { s, holder: holder!, target: target! };
}
const evict = (s: S, who: EntityId) => { s.live.evictionOrder.push(who); s.live.active = s.live.active.filter((x) => x !== who); };

describe("a settled goal moves the mood and leaves a cause (ORW-317)", () => {
  it("the plan worked: the holder's soul gets the event and the cause is recorded, in their own words", async () => {
    const { s, holder, target } = await setup(11);
    const before = s.soulObj(holder)!.emotionalHistory.length;
    evict(s, target);
    s.agendaRecheck("eviction");
    expect(s.soulObj(holder)!.emotionalHistory.length).toBeGreaterThan(before);
    expect(s.live.moodCauses![holder]).toMatchObject({ outcome: "worked", line: "I got {subject} out, like I planned" });
  });

  it("with the flag off nothing moves", async () => {
    const { s, holder, target } = await setup(12);
    s.setGoalMoodEnabled(false);
    const before = s.soulObj(holder)!.emotionalHistory.length;
    evict(s, target);
    s.agendaRecheck("eviction");
    expect(s.soulObj(holder)!.emotionalHistory.length).toBe(before);
    expect(s.live.moodCauses?.[holder]).toBeUndefined();
  });
});

describe("the cause is theirs to share (Ryne: no motive hints)", () => {
  it("a revealing cause reaches the player's view of them only with high trust; with low trust the mood shows but the cause does not", async () => {
    const { s, holder } = await setup(13);
    s.live.moodCauses = { [holder]: { goalKind: "get-them-out", outcome: "worked", about: s.live.active.find((x) => x !== holder && x !== PLAYER), line: "I got {subject} out, like I planned", week: s.live.week } as never };
    const rel = s.rel as unknown as { edge(a: EntityId, b: EntityId): { affinity: number } };
    rel.edge(holder, PLAYER).affinity = 0.1;
    expect(s.npcVoice(holder)!.moodCause).toBeUndefined();
    rel.edge(holder, PLAYER).affinity = 0.95;
    const said = s.npcVoice(holder)!.moodCause;
    expect(said).toMatch(/^I got .+ out, like I planned$/);
    expect(said).not.toMatch(/npc:|\{subject\}/);
  });

  it("an old cause (a previous week) is not voiced; the narrator instruction rides the flag", async () => {
    const { s, holder } = await setup(14);
    s.live.moodCauses = { [holder]: { goalKind: "win-power", outcome: "fell-apart", line: "I needed that win and didn't get it", week: s.live.week - 1 } as never };
    (s.rel as unknown as { edge(a: EntityId, b: EntityId): { affinity: number } }).edge(holder, PLAYER).affinity = 0.95;
    expect(s.npcVoice(holder)!.moodCause).toBeUndefined();
    expect(s.getMomentPrompt({}).systemPrompt).toContain("moodCause");
    s.setGoalMoodEnabled(false);
    expect(s.getMomentPrompt({}).systemPrompt).not.toContain("moodCause");
  });
});
