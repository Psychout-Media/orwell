import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { repairPlayerStrategyStyle } from "../../src/engine/characterFactory";

/** ORW-1075 - a save whose stored player style is not the chosen one is repaired on load, once, and only to a style the archetype allows. */
type Snap = ReturnType<GameSessionRegistry["snapshot"]>;
const playerOf = (snap: Snap) => (snap as unknown as { house: { player: { character: { archetype: string; strategyStyle: string }; persona?: { strategyStyle?: string } } } }).house.player;
const styleOf = (s: GameSessionAdapter) => (s.getGameState() as unknown as { player: { castingCard: { strategyStyle: string } } }).player.castingCard.strategyStyle;

function fixture(): Snap {
  const reg = new GameSessionRegistry();
  const s = reg.sandboxFor("orw1075").session as GameSessionAdapter;
  s.createCharacter({ playerName: "P", seed: 5, archetype: "mastermind", strategyStyle: "under-the-radar", personaStrategyStyle: "under the radar" } as never);
  return JSON.parse(JSON.stringify(reg.snapshot("orw1075"))) as Snap;
}

describe("ORW-1075 save migration: castingCard.strategyStyle follows the chosen style", () => {
  it("repairs a pre-#3247 save, is idempotent, and leaves the card matching the chosen style", () => {
    const snap = fixture();
    const p = playerOf(snap);
    expect(p.character.archetype).toBe("mastermind");
    p.character.strategyStyle = "strategic"; // what the old code stored: the pair's first entry
    p.persona = { ...(p.persona ?? {}), strategyStyle: "Under the radar" };
    const reg = new GameSessionRegistry();
    const s = reg.restore("r1", snap).session as GameSessionAdapter;
    expect(styleOf(s)).toBe("under-the-radar");
    const again = new GameSessionRegistry().restore("r2", JSON.parse(JSON.stringify(reg.snapshot("r1"))) as Snap).session as GameSessionAdapter;
    expect(styleOf(again)).toBe("under-the-radar");
  });
  it("changes nothing when the words are not one of the archetype's pair, or already match", () => {
    const base = { character: { archetype: "mastermind", strategyStyle: "strategic" as const }, persona: { strategyStyle: "emotional" } };
    expect(repairPlayerStrategyStyle(base)).toBeUndefined();
    expect(base.character.strategyStyle).toBe("strategic");
    expect(repairPlayerStrategyStyle({ character: { archetype: "mastermind", strategyStyle: "strategic" }, persona: { strategyStyle: "strategic" } })).toBeUndefined();
    expect(repairPlayerStrategyStyle({ character: { archetype: "mastermind", strategyStyle: "strategic" } })).toBeUndefined();
    expect(repairPlayerStrategyStyle({ character: { archetype: "floater", strategyStyle: "social" }, persona: { strategyStyle: "loyal" }, archetypeDefaulted: true })).toBeUndefined();
  });
});
