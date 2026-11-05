import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { BASE_GAME_MASTER_PROMPT } from "../../src/engine/momentPrompts";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * A49 (#2017 E1a, flag ORWELL_NPC_TELLS, default OFF) - npcVoice hands the narrator each PRESENT houseguest's observable tells (top 2 from `tellsOf`: kind, band, channel - words only, never a number or a cause).
 * OFF => no `tells` key and the prompt is unchanged; ON => tells only for a houseguest in the player's room and awake. Roles only.
 */
type Internals = {
  presence: Map<EntityId, string>;
  soulObj(id: EntityId): { confidence?: number; distress?: number; emotionalState: number; volatility: number; temperamentDrift?: number } | undefined;
  setNpcTellsEnabled(on: boolean): void;
  npcVoice(id: EntityId): { tells?: Array<{ kind: string; band: string; channel: string }>; mood?: string } | null;
};
const KINDS = new Set(["withdrawn", "tearful", "snapping", "brittle-calm", "giddy", "warm-open", "guarded", "restless"]);
const BANDS = new Set(["faint", "clear", "strong"]);
const CHANNELS = new Set(["body", "voice", "behaviour"]);

function game(seed = 7): { sb: UserSandbox; s: Internals; npc: EntityId; other: EntityId } {
  const sb = new GameSessionRegistry().sandboxFor(`tells-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed });
  const s = sb.session as unknown as Internals;
  const npcs = sb.session.livingIds().filter((i) => i !== PLAYER);
  return { sb, s, npc: npcs[0]!, other: npcs[1]! };
}
/** Put `id` in the player's room and give the soul a distressed, low-confidence carriage (a sure tell). */
function stage(s: Internals, id: EntityId): void {
  const room = s.presence.get(PLAYER)!;
  s.presence.set(id, room);
  const soul = s.soulObj(id)!;
  soul.distress = 0.9; soul.confidence = 0.1; soul.emotionalState = 0.1; soul.volatility = 0.8;
}

describe("npcVoice tells (A49)", () => {
  it("OFF: no tells key at all, and the narrator prompt carries no tells instruction", () => {
    GameSessionAdapter.setTimeOfDayEnabled(null);
    const { sb, s, npc } = game();
    s.setNpcTellsEnabled(false);
    stage(s, npc);
    expect(s.npcVoice(npc)).not.toBeNull();
    expect("tells" in (s.npcVoice(npc) as object)).toBe(false);
    expect(sb.session.getMomentPrompt({}).systemPrompt).not.toContain("`tells`");
    expect(BASE_GAME_MASTER_PROMPT).not.toContain("`tells`");
  });

  it("ON: a PRESENT houseguest carries at most 2 closed-vocabulary tells (words only), and `mood` stays as the coarse fallback", () => {
    const { s, npc } = game();
    s.setNpcTellsEnabled(true);
    stage(s, npc);
    const v = s.npcVoice(npc)!;
    expect(v.tells, "a distressed present houseguest shows a tell").toBeDefined();
    expect(v.tells!.length).toBeGreaterThan(0);
    expect(v.tells!.length).toBeLessThanOrEqual(2);
    for (const t of v.tells!) {
      expect(Object.keys(t).sort()).toEqual(["band", "channel", "kind"]);
      expect(KINDS.has(t.kind) && BANDS.has(t.band) && CHANNELS.has(t.channel), JSON.stringify(t)).toBe(true);
    }
    expect(v.mood, "mood stays as the coarse backdrop").toBeDefined();
  });

  it("ON: the narrator prompt gains the instruction to voice exactly the given tells and never invent a mood", () => {
    const { sb, s } = game();
    s.setNpcTellsEnabled(true);
    const p = sb.session.getMomentPrompt({}).systemPrompt;
    expect(p).toContain("If the voice carries `tells`");
    expect(p).toMatch(/NEVER invent a mood, tell or reaction that is not given/);
  });

  it("ON: an ABSENT houseguest (another room) carries no tells, however distressed", () => {
    const { s, npc } = game();
    s.setNpcTellsEnabled(true);
    stage(s, npc);
    const room = s.presence.get(PLAYER)!;
    s.presence.set(npc, room === "kitchen" ? "bedroom-a" : "kitchen"); // out of the player's room
    expect("tells" in (s.npcVoice(npc) as object)).toBe(false);
  });

  it("ON: a calm present houseguest has no tells (an empty read is omitted, not an empty array)", () => {
    const { s, npc } = game();
    s.setNpcTellsEnabled(true);
    s.presence.set(npc, s.presence.get(PLAYER)!);
    const soul = s.soulObj(npc)!;
    soul.distress = 0.5; soul.confidence = 0.5; soul.emotionalState = 0.5; soul.volatility = 0.2; soul.temperamentDrift = 0;
    expect("tells" in (s.npcVoice(npc) as object)).toBe(false);
  });

  it("Vault wall: no number or hidden-axis value rides the voice's tells", () => {
    const { s, npc } = game();
    s.setNpcTellsEnabled(true);
    stage(s, npc);
    const soul = s.soulObj(npc)!;
    soul.distress = 0.8731; soul.confidence = 0.1297; // sentinel axis values
    const json = JSON.stringify(s.npcVoice(npc)!.tells);
    expect(json).not.toMatch(/\d/);
    expect(json).not.toContain("8731");
    expect(json).not.toContain("1297");
  });
});
