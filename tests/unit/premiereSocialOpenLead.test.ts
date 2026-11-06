import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";

/** Lead (4) from an automated review: `premiereSocialOpen` treats an undefined `premiereEntrance` as "entrances over", so morning approaches could open before the toast. Probe the real phases. Roles only. */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(false));
type Peek = { premiereSocialOpen(): boolean; setPremiereEntrancesEnabled(on: boolean): void; snapshot(): { live: { premiereEntrance?: { stage: string }; champagneCircle?: string; phase?: string } } };

describe("premiereSocialOpen across the premiere", () => {
  it("is closed at game start and throughout the entrances and the toast, and opens only after the toast", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor(`pso-${Math.random()}`).session as GameSessionAdapter;
    const p = s as unknown as Peek;
    p.setPremiereEntrancesEnabled(process.env.PSO_ENT !== "0");
    s.createCharacter({ playerName: "P", seed: 7 });
    const rows: string[] = [];
    let openBeforeEnd = false;
    for (let i = 0; i < 80; i++) {
      const live = p.snapshot().live;
      const phase = (s.getGameState() as { phase?: string }).phase;
      const open = p.premiereSocialOpen();
      rows.push(`${i}: phase=${phase} stage=${live.premiereEntrance?.stage ?? "undef"} circle=${live.champagneCircle ?? "undef"} open=${open}`);
      if (phase !== "premiere") break;
      if (open && (live.premiereEntrance?.stage !== "done" || live.champagneCircle === "gathered")) openBeforeEnd = true;
      s.advanceGame();
    }
    console.log("PSO\n" + rows.slice(0, 6).join("\n") + "\n...\n" + rows.slice(-4).join("\n"));
    const first = p.snapshot().live;
    expect(first, "snapshot exists").toBeTruthy();
    expect(openBeforeEnd, "never open while an entrance or the circle is still in play").toBe(false);
  });
});
