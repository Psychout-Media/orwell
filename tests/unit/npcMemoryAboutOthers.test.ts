import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { BASE_GAME_MASTER_PROMPT } from "../../src/engine/momentPrompts";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * ORW-317 (ORW-253 slice 4, Ryne approved the NPC minds design 2026-11-12): a houseguest can bring up what OTHER houseguests did - but
 * only things the whole house saw (the Vault Wall: a private memory must not reach the narrator without the engine's disclosure path).
 * Roles only (holder, other, bystander).
 */
type Mem = { kind: string; week: number; severity: number };
type S = {
  live: { week: number; npcMemory?: Record<string, Record<string, Mem[]>> };
  presence: Map<EntityId, string>;
  setNpcMemoryEnabled(on: boolean): void;
  setNpcMemorySpeechEnabled(on: boolean): void;
  npcVoice(id: EntityId): { rememberedAboutOthers?: string[]; houseguest: { name: string } } | null;
};
function game() {
  const sb = new GameSessionRegistry().sandboxFor(`others-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 11 });
  const s = sb.session as unknown as S;
  const [a, b, c] = sb.session.livingIds().filter((i) => i !== PLAYER);
  s.setNpcMemoryEnabled(true);
  s.setNpcMemorySpeechEnabled(true);
  s.live.npcMemory = {};
  for (const id of [...s.presence.keys()]) s.presence.set(id, "backyard");
  s.presence.set(a!, "kitchen"); s.presence.set(b!, "kitchen"); s.presence.set(PLAYER, "kitchen");
  return { s, a: a!, b: b!, c: c! };
}
const put = (s: S, holder: string, subject: string, e: Mem[]) => { (s.live.npcMemory![holder] ??= {})[subject] = e; };

describe("memories about other houseguests in the room (ORW-317)", () => {
  it("a public-fact memory about someone present becomes a first-person line with their public name, never an id or a number", () => {
    const { s, a, b } = game();
    put(s, a, b, [{ kind: "veto-withheld", week: s.live.week, severity: 0.9 }]);
    const lines = s.npcVoice(a)!.rememberedAboutOthers!;
    const bName = s.npcVoice(b)!.houseguest.name;
    expect(lines).toEqual([`${bName} left me on the block when they held the veto (this week)`]);
    expect(JSON.stringify(lines)).not.toMatch(/npc:|\d/);
  });

  it("a private memory (a deal, an exposed secret) is never handed over, even about someone present (Vault Wall)", () => {
    const { s, a, b } = game();
    put(s, a, b, [{ kind: "deal-broken", week: s.live.week, severity: 1 }, { kind: "deal-resented", week: s.live.week, severity: 1 }, { kind: "secret-exposed", week: s.live.week, severity: 1 }]);
    expect("rememberedAboutOthers" in s.npcVoice(a)!).toBe(false);
  });

  it("only about people in the room; never about the player (that is rememberedAboutYou); off with the flag", () => {
    const { s, a, c } = game();
    put(s, a, c, [{ kind: "nominated-by-hoh", week: s.live.week, severity: 1 }]); // c is out in the backyard
    put(s, a, PLAYER, [{ kind: "nominated-by-hoh", week: s.live.week, severity: 1 }]);
    expect("rememberedAboutOthers" in s.npcVoice(a)!).toBe(false);
    s.presence.set(c, "kitchen");
    expect(s.npcVoice(a)!.rememberedAboutOthers).toHaveLength(1);
    s.setNpcMemorySpeechEnabled(false);
    expect("rememberedAboutOthers" in s.npcVoice(a)!).toBe(false);
  });

  it("the narrator instruction rides the flag: ON it names rememberedAboutOthers as house-seen and forbids inventing more; OFF it is absent", () => {
    const { s } = game();
    const sess = s as unknown as { getMomentPrompt(a: object): { systemPrompt: string } };
    const on = sess.getMomentPrompt({}).systemPrompt;
    expect(on).toContain("rememberedAboutOthers");
    expect(on).toContain("all things the whole house saw");
    expect(on).toContain("never invent another past between them");
    s.setNpcMemorySpeechEnabled(false);
    expect(sess.getMomentPrompt({}).systemPrompt).not.toContain("rememberedAboutOthers");
    expect(BASE_GAME_MASTER_PROMPT).not.toContain("rememberedAboutOthers");
  });
});
