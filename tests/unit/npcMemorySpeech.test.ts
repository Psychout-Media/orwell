import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { BASE_GAME_MASTER_PROMPT } from "../../src/engine/momentPrompts";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/** A54 (#2017 M5, ORWELL_NPC_MEMORY_SPEECH, default OFF): npcVoice.rememberedAboutYou (top 3, plain words) + an engine-decided, seeded, once-per-day bringUp. Roles only. */
type Mem = { kind: string; week: number; severity: number };
type S = {
  live: { week: number; dayNumber?: number; npcMemory?: Record<string, Record<string, Mem[]>> };
  setNpcMemoryEnabled(on: boolean): void;
  setNpcMemorySpeechEnabled(on: boolean): void;
  npcVoice(id: EntityId): { rememberedAboutYou?: string[]; bringUp?: true } | null;
};
function game() {
  const sb = new GameSessionRegistry().sandboxFor(`mem-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 11 });
  const s = sb.session as unknown as S;
  const [a, b, c] = sb.session.livingIds().filter((i) => i !== PLAYER);
  s.setNpcMemoryEnabled(true);
  s.live.npcMemory = {};
  return { s, a: a!, b: b!, c: c! };
}
const put = (s: S, holder: string, subject: string, e: Mem[]) => { (s.live.npcMemory![holder] ??= {})[subject] = e; };

describe("npcVoice memory in speech (A54)", () => {
  it("OFF: no rememberedAboutYou / bringUp key even with a rich ledger, and the prompt is unchanged", () => {
    const { s, a } = game();
    put(s, a, PLAYER, [{ kind: "scene-betrayal", week: s.live.week, severity: 1 }]);
    s.setNpcMemorySpeechEnabled(false);
    const v = s.npcVoice(a)!;
    expect("rememberedAboutYou" in v).toBe(false);
    expect("bringUp" in v).toBe(false);
  });
  it("ON: top 3 only, strongest first, plain words: no kind slug, no severity, no digit; only memories of the PLAYER", () => {
    const { s, a, b } = game();
    s.setNpcMemorySpeechEnabled(true);
    const w = s.live.week;
    put(s, a, PLAYER, [
      { kind: "scene-kindness", week: w, severity: 0.3 }, { kind: "scene-betrayal", week: w, severity: 0.9 },
      { kind: "deal-broken", week: w, severity: 0.7 }, { kind: "scene-conflict", week: w, severity: 0.5 },
    ]);
    put(s, a, b, [{ kind: "deal-kept", week: w, severity: 1 }]); // about someone else: never handed over
    const r = s.npcVoice(a)!.rememberedAboutYou!;
    expect(r).toHaveLength(3);
    expect(r[0]).toContain("betrayed");
    const blob = JSON.stringify(r);
    expect(blob).not.toMatch(/\d/);
    expect(blob).not.toMatch(/scene-|deal-broken|severity|kept a deal/);
  });
  it("a houseguest who holds no memory of the player gets no key (never a memory they do not hold)", () => {
    const { s, a, b, c } = game();
    s.setNpcMemorySpeechEnabled(true);
    put(s, a, PLAYER, [{ kind: "scene-betrayal", week: s.live.week, severity: 1 }]);
    put(s, b, c, [{ kind: "scene-betrayal", week: s.live.week, severity: 1 }]);
    expect("rememberedAboutYou" in s.npcVoice(b)!).toBe(false);
    expect("rememberedAboutYou" in s.npcVoice(c)!).toBe(false);
  });
  it("bringUp: at most once per houseguest per in-game day, can recur on a later day, never below the salience bar", () => {
    const { s, a, b } = game();
    s.setNpcMemorySpeechEnabled(true);
    put(s, a, PLAYER, [{ kind: "scene-betrayal", week: s.live.week, severity: 1 }]);
    put(s, b, PLAYER, [{ kind: "scene-kindness", week: s.live.week, severity: 0.2 }]);
    let days = 0;
    for (let d = 1; d <= 30; d++) {
      s.live.dayNumber = d;
      const hits = [1, 2, 3, 4].filter(() => s.npcVoice(a)!.bringUp === true).length;
      expect(hits).toBeLessThanOrEqual(1);
      if (hits === 1) days++;
      expect(s.npcVoice(b)!.bringUp).toBeUndefined();
    }
    expect(days).toBeGreaterThan(5); // seeded and not rare for a fresh, severe memory
    expect(days).toBeLessThan(30);   // but a roll, not every day
  });
  it("the narrator instruction rides only the flag (OFF prompt byte-identical; ON names bringUp as the engine's decision)", () => {
    const { s } = game();
    const sess = s as unknown as { getMomentPrompt(a: object): { systemPrompt: string } };
    const off = sess.getMomentPrompt({}).systemPrompt;
    expect(off).not.toContain("rememberedAboutYou");
    expect(BASE_GAME_MASTER_PROMPT).not.toContain("rememberedAboutYou");
    s.setNpcMemorySpeechEnabled(true);
    const on = sess.getMomentPrompt({}).systemPrompt;
    expect(on).toContain("rememberedAboutYou");
    expect(on).toContain("ONLY when `bringUp` is true");
    s.setNpcMemorySpeechEnabled(false);
    expect(sess.getMomentPrompt({}).systemPrompt).toBe(off);
  });
  it("Vault sentinel: a hidden ledger field never crosses (only the plain facts do)", () => {
    const { s, a } = game();
    s.setNpcMemorySpeechEnabled(true);
    put(s, a, PLAYER, [{ kind: "scene-betrayal", week: s.live.week, severity: 0.8777 }]);
    expect(JSON.stringify(s.npcVoice(a))).not.toMatch(/0\.8777|0\.87|"severity"|"kind":\s*"scene/);
  });
});
