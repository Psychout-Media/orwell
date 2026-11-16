import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/** ORW-481 (review of ORW-131): the memory a houseguest is told to bring up is always among the facts the narrator receives, even when the three strongest were raised lately. Roles only. */
type Mem = { kind: string; week: number; severity: number };
type S = {
  live: { week: number; dayNumber?: number; npcMemory?: Record<string, Record<string, Mem[]>> };
  house: { npcs: { id: string; character: { stats: { social: number } }; soul: { volatility: number } }[] };
  bringUp: Map<string, { recent: { key: string; day: number }[] }>;
  setNpcMemoryEnabled(on: boolean): void;
  setNpcMemorySpeechEnabled(on: boolean): void;
  npcVoice(id: EntityId): { rememberedAboutYou?: string[]; bringUp?: true } | null;
};

describe("the memory chosen to raise reaches the narrator", () => {
  it("a fourth memory chosen after the strongest three were raised is among the facts", () => {
    const sb = new GameSessionRegistry().sandboxFor("lead-reaches");
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 11 });
    const s = sb.session as unknown as S;
    const talker = sb.session.livingIds().filter((i) => i !== PLAYER)[0]!;
    s.setNpcMemoryEnabled(true); s.setNpcMemorySpeechEnabled(true);
    const n = s.house.npcs.find((q) => q.id === talker)!; n.character.stats.social = 0.95; n.soul.volatility = 0.9;
    const w = s.live.week;
    s.live.npcMemory = { [talker]: { [PLAYER]: ["scene-betrayal", "deal-broken", "secret-exposed", "scene-conflict", "veto-saved"].map((kind, i) => ({ kind, week: w, severity: 1 - i * 0.02 })) } };
    const phrase = (GameSessionAdapter as unknown as { MEMORY_ABOUT_YOU: Record<string, string> }).MEMORY_ABOUT_YOU;
    const topThree = ["scene-betrayal", "deal-broken", "secret-exposed"].map((k) => phrase[k]!);
    let lowerRaised = 0;
    for (let d = 1; d <= 3; d++) {
      s.live.dayNumber = d;
      for (let call = 0; call < 8; call++) {
        const v = s.npcVoice(talker)!;
        if (v.bringUp !== true) continue;
        const raised = s.bringUp.get(talker)!.recent.at(-1)!.key.split(":")[0]!;
        expect(v.rememberedAboutYou!.some((f) => f.startsWith(phrase[raised]!)), `the raised memory (${raised}) is in the facts`).toBe(true);
        if (!topThree.includes(phrase[raised]!)) lowerRaised++;
      }
    }
    expect(lowerRaised, "a memory below the strongest three was chosen at least once").toBeGreaterThan(0);
  });
});

describe("building the narrator's prompt does not spend a houseguest's speech state", () => {
  it("getMomentPrompt reads leave the daily allowance and the raised-lately record untouched", () => {
    const sb = new GameSessionRegistry().sandboxFor("prompt-peek");
    sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 11 });
    const s = sb.session as unknown as S;
    s.setNpcMemoryEnabled(true); s.setNpcMemorySpeechEnabled(true);
    const w = s.live.week;
    const ids = sb.session.livingIds().filter((i) => i !== PLAYER);
    for (const id of ids) { const n = s.house.npcs.find((q) => q.id === id)!; n.character.stats.social = 0.95; n.soul.volatility = 0.9; }
    s.live.npcMemory = Object.fromEntries(ids.map((id) => [id, { [PLAYER]: [{ kind: "scene-betrayal", week: w, severity: 1 }] }]));
    s.live.dayNumber = 1;
    for (let i = 0; i < 30; i++) sb.session.getMomentPrompt({ moment: "social" });
    expect(s.bringUp.size, "prompt builds spent nobody's allowance").toBe(0);
  });
});
