import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * ORW-338 (theme 1 section 4, Ryne approved 2026-11-12): a houseguest's mood cause and what they remember about others in the room reach the narrator
 * in the per-turn present-houseguest block, not only through the under-called `npcVoice`. Same gates as npcVoice. Roles only (holder, other).
 */
type Mem = { kind: string; week: number; severity: number };
type S = {
  live: { week: number; npcMemory?: Record<string, Record<string, Mem[]>>; moodCauses?: Record<string, unknown> };
  presence: Map<EntityId, string>;
  livingIds(): EntityId[];
  setNpcMemoryEnabled(on: boolean): void;
  setNpcMemorySpeechEnabled(on: boolean): void;
  rel: { edge(a: EntityId, b: EntityId): { affinity: number } };
  npcVoice(id: EntityId): { houseguest: { name: string } } | null;
  getMomentPrompt(a: object): { systemPrompt: string };
};
async function game(seed: number) {
  const reg = new GameSessionRegistry();
  const user = `mind-block-${seed}-${Math.random()}`;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
  await mcp.callTool("noteMessage", { messageId: "first" }); // a played game
  const s = reg.sandboxFor(user).session as unknown as S;
  const [holder, other, outsider] = s.livingIds().filter((i) => i !== PLAYER) as [EntityId, EntityId, EntityId];
  s.setNpcMemoryEnabled(true);
  s.setNpcMemorySpeechEnabled(true);
  s.live.npcMemory = {};
  for (const id of [...s.presence.keys()]) s.presence.set(id, "backyard");
  for (const id of [holder, other, PLAYER]) s.presence.set(id, "kitchen");
  return { s, holder, other, outsider };
}
const plantCause = (s: S, holder: string) => { s.live.moodCauses = { [holder]: { goalKind: "win-power", outcome: "fell-apart", line: "I needed that win and didn't get it", week: s.live.week } }; };
const plantMemory = (s: S, holder: string, other: string, kind: string) => { (s.live.npcMemory![holder] ??= {})[other] = [{ kind, week: s.live.week, severity: 0.9 }]; };
const blockFor = (prompt: string, name: string): string => {
  const at = prompt.indexOf(`· ${name}:`);
  expect(at, `the present block names ${name}`).toBeGreaterThan(-1);
  const rest = prompt.slice(at + 1);
  const next = rest.search(/\n {4}· /);
  return next === -1 ? rest : rest.slice(0, next);
};

describe("the present block carries the mood cause and the memories about others (ORW-338)", () => {
  it("a planted public memory and a sharable mood cause show under that houseguest, with public names", async () => {
    const { s, holder, other } = await game(11);
    plantCause(s, holder);
    plantMemory(s, holder, other, "veto-withheld");
    s.rel.edge(holder, PLAYER).affinity = 0.95;
    const prompt = s.getMomentPrompt({}).systemPrompt;
    const mine = blockFor(prompt, s.npcVoice(holder)!.houseguest.name);
    expect(mine).toContain('moodCause (');
    expect(mine).toContain("I needed that win and didn't get it");
    expect(mine).toContain("rememberedAboutOthers (");
    expect(mine).toContain(`${s.npcVoice(other)!.houseguest.name} left me on the block when they held the veto`);
    expect(mine).not.toMatch(/npc:|\{subject\}/);
  });

  it("with low trust the cause is absent (the memory, which is public, still shows)", async () => {
    const { s, holder, other } = await game(11);
    plantCause(s, holder);
    plantMemory(s, holder, other, "veto-withheld");
    s.rel.edge(holder, PLAYER).affinity = 0.05;
    const mine = blockFor(s.getMomentPrompt({}).systemPrompt, s.npcVoice(holder)!.houseguest.name);
    expect(mine).not.toContain("moodCause (");
    expect(mine).not.toContain("I needed that win");
    expect(mine).toContain("rememberedAboutOthers (");
  });

  it("a private memory (a deal, an exposed secret) never reaches the prompt, even about someone present (Vault sentinel)", async () => {
    const { s, holder, other } = await game(11);
    for (const kind of ["deal-broken", "deal-resented", "secret-exposed"]) plantMemory(s, holder, other, kind);
    const prompt = s.getMomentPrompt({}).systemPrompt;
    expect(prompt).not.toMatch(/broke the deal we made|told everyone what I trusted|rememberedAboutOthers \(/);
  });

  it("the new lines sit in the per-turn tail: everything before the present block is byte-identical with and without them (the #2570 cache prefix)", async () => {
    const { s, holder, other } = await game(11);
    const base = s.getMomentPrompt({}).systemPrompt;
    plantCause(s, holder);
    plantMemory(s, holder, other, "veto-withheld");
    s.rel.edge(holder, PLAYER).affinity = 0.95;
    const withMind = s.getMomentPrompt({}).systemPrompt;
    expect(withMind).not.toBe(base);
    const header = "WHAT EACH HOUSEGUEST IN THE ROOM LEGITIMATELY KNOWS";
    const cut = withMind.indexOf(header) === -1 ? Math.min(base.length, withMind.length) : withMind.indexOf(header);
    expect(withMind.slice(0, cut)).toBe(base.slice(0, cut));
  });
});
