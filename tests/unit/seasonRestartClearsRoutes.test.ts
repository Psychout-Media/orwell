import { it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
it("a confirmed restart clears the cached disclosure routes (review of ORW-261)", () => {
  const s = new GameSessionAdapter(); s.createCharacter({ playerName: "P", seed: 7 });
  const i = s as unknown as { confideRoutes: Map<string, unknown>; orientationRoutes: Map<string, unknown> };
  i.confideRoutes.set("a:1:x", {}); i.orientationRoutes.set("a:1:x", {});
  s.createCharacter({ playerName: "P", seed: 8, confirmRestart: true } as never);
  expect(i.confideRoutes.size + i.orientationRoutes.size).toBe(0);
});
