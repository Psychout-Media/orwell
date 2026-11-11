import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { ASSURANCE, npcAssuranceSincerity } from "../../src/engine/assurances";

/**
 * B4 slice 7 - the ENGINE decides an NPC assurance's sincerity (loyalty + a dedicated seeded roll); the model's proposed sincerity for an NPC speaker is ignored, the player's own stays as recorded.
 * Flag-off (ORWELL_ASSURANCES) nothing is recorded. Roles only.
 */
describe("npcAssuranceSincerity", () => {
  it("is monotone in loyalty for a fixed roll and always sincere or the liar value", () => {
    for (const roll of [0, 0.25, 0.5, 0.75, 0.99]) {
      let prev = -1;
      for (const loyalty of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
        const s = npcAssuranceSincerity(loyalty, roll);
        expect([1, ASSURANCE.liarSincerity]).toContain(s);
        expect(s).toBeGreaterThanOrEqual(prev);
        prev = s;
      }
    }
  });
  it("a fully loyal houseguest is always sincere; the roll decides a disloyal one", () => {
    expect(npcAssuranceSincerity(1, 0.999)).toBe(1);
    expect(npcAssuranceSincerity(0, 0.1)).toBe(1);
    expect(npcAssuranceSincerity(0, 0.9)).toBe(ASSURANCE.liarSincerity);
  });
});

type G = { recordAssurance(a: unknown): void; setAssurancesEnabled(on: boolean): void };
function started() {
  const sb = new GameSessionRegistry().sandboxFor(`asrsinc-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  sb.session.setAssurancesEnabled(true);
  const [speaker] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
  return { sb, g: sb.session as unknown as G, speaker: speaker! };
}
const items = (sb: { session: { snapshot(): { live?: unknown } } }) => ((sb.session.snapshot().live as { assurances?: { items: { sincerity: number; source: string }[] } }).assurances?.items ?? []);

describe("recordAssurance sincerity", () => {
  it("an NPC speaker's recorded sincerity is the engine's (1 or the liar value), whatever was proposed", () => {
    const { sb, g, speaker } = started();
    g.recordAssurance({ from: speaker, to: PLAYER, kind: "safe", sincerity: 0.5, source: "npc" });
    expect([1, ASSURANCE.liarSincerity]).toContain(items(sb)[0]!.sincerity);
  });
  it("the engine's roll uses the speaker's real loyalty: repeated assurances (distinct salted rolls) are not all sincere", () => {
    const { sb, g, speaker } = started();
    for (let i = 0; i < 40; i++) g.recordAssurance({ from: speaker, to: PLAYER, kind: "safe", sincerity: 1, source: "npc" });
    const s = items(sb).map((x) => x.sincerity);
    expect(s).toContain(ASSURANCE.liarSincerity);
    expect(s).toContain(1);
  });
  it("is deterministic: the same game and inputs give the same sincerity", () => {
    const a = started(); const b = started();
    a.g.recordAssurance({ from: a.speaker, to: PLAYER, kind: "vote", sincerity: 1, source: "npc" });
    b.g.recordAssurance({ from: b.speaker, to: PLAYER, kind: "vote", sincerity: 1, source: "npc" });
    expect(items(a.sb)[0]!.sincerity).toBe(items(b.sb)[0]!.sincerity);
  });
  it("the player's own assurance keeps the recorded sincerity", () => {
    const { sb, g, speaker } = started();
    g.recordAssurance({ from: PLAYER, to: speaker, kind: "safe", sincerity: 0.37, source: "player" });
    expect(items(sb)[0]!.sincerity).toBeCloseTo(0.37, 9);
  });
  it("flag off: nothing recorded", () => {
    const { sb, g, speaker } = started();
    g.setAssurancesEnabled(false);
    g.recordAssurance({ from: speaker, to: PLAYER, kind: "safe", sincerity: 1, source: "npc" });
    expect(items(sb).length).toBe(0);
  });
});
