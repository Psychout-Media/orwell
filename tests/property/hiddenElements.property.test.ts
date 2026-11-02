import { describe, it, expect } from "vitest";
import { startNewGame, HIDDEN_ELEMENT_RANGE } from "../../src/engine/characterFactory";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { TEMPERATURE_CONSTANTS } from "../../src/domain/temperatureConstants";
import { PLAYER } from "../../src/domain/ids";

/**
 * Feature 0050 / B50 (audit D1) — live NPC hidden elements. The PRODUCTION CharacterFactory now mints
 * "tons of hidden elements" per NPC (the mandate / 0003), stored engine-side, surfacing RARELY into the
 * hidden off-screen life — and the player NEVER sees one without an in-game pathway. HARD rule: roles
 * only — no names.
 */

describe("0050/B50 — live NPCs carry seeded hidden elements that surface rarely", () => {
  it("every generated NPC has 3–6 distinct hidden elements; the player has none", () => {
    for (const seed of [1, 7, 42]) {
      const house = startNewGame({ seed, playerName: "P" });
      expect(house.player.character.hiddenElements).toEqual([]); // the player authors their own secrets
      for (const hg of house.npcs) {
        const els = hg.character.hiddenElements;
        expect(els.length).toBeGreaterThanOrEqual(HIDDEN_ELEMENT_RANGE.min);
        expect(els.length).toBeLessThanOrEqual(HIDDEN_ELEMENT_RANGE.max);
        // Distinct (kind+detail) and typed.
        const keys = els.map((e) => `${e.kind}::${e.detail}`);
        expect(new Set(keys).size).toBe(els.length);
        for (const e of els) expect(typeof e.detail).toBe("string");
      }
    }
  });

  it("is seed-reproducible: same seed ⇒ identical elements; a different seed ⇒ a different house", () => {
    const a = startNewGame({ seed: 5, playerName: "P" });
    const b = startNewGame({ seed: 5, playerName: "P" });
    const c = startNewGame({ seed: 6, playerName: "P" });
    const els = (h: typeof a): string => JSON.stringify(h.npcs.map((n) => n.character.hiddenElements));
    expect(els(b)).toBe(els(a));   // deterministic
    expect(els(c)).not.toBe(els(a)); // a different seed mints different secrets
  });

  it("over a season the off-screen life surfaces an element only RARELY, and never to the player", () => {
    const reg = new GameSessionRegistry();
    const user = "u-hidden";
    reg.sandboxFor(user).session.createCharacter({ playerName: "P", seed: 3 });
    const orch = new Orchestrator(reg, new FakeClock(), { seed: 3 });
    for (let i = 0; i < 60; i++) orch.advance(user, "offscreen-tick");

    const sb = reg.sandboxFor(user);
    const offScenes = sb.engine.events.queryAll().filter((e) => e.id.startsWith("offscreen:"));
    // A scene SURFACED a hidden element when it carries one of the NPCs' actual hidden-element details
    // (offscreen.ts appends ` — <who> <detail>`). Matching the bare " — " separator over-counted: other
    // scene clauses use it too (e.g. the opt-in scheme-target "— wants X gone next", #1922).
    const npcDetails = sb.session.snapshot().house!.npcs.flatMap((n) => n.character.hiddenElements.map((e) => e.detail));
    const surfaced = offScenes.filter((e) => npcDetails.some((d) => e.content.includes(d)));
    expect(offScenes.length).toBeGreaterThan(20);
    // RARE: bounded well above the configured rate to absorb variance, but far from common.
    expect(surfaced.length).toBeGreaterThan(0); // the rare-reveal loop DOES fire over a season
    expect(surfaced.length / offScenes.length).toBeLessThanOrEqual(TEMPERATURE_CONSTANTS.hiddenSurfacingRate * 3);

    // The Vault Wall: every NPC hidden-element detail that surfaced stays in the HIDDEN layer — none of
    // it appears among the events the PLAYER witnessed, nor on the player projection.
    const playerWitnessed = sb.engine.events.query({ witnessedBy: PLAYER }).map((e) => e.content).join("\n");
    const projection = JSON.stringify(sb.session.getGameState());
    for (const detail of npcDetails) {
      expect(playerWitnessed.includes(detail)).toBe(false);
      expect(projection.includes(detail)).toBe(false);
    }
    // And the off-screen scenes that surfaced one never list the player as a witness.
    for (const e of surfaced) expect(e.witnessSet.includes(PLAYER)).toBe(false);
  });
});
