import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { JURY_MEMORY } from "../../src/engine/juryConstants";
import { DECISION_SOURCES } from "../../src/engine/memorySources";
import type { MemoryEntry } from "../../src/engine/npcMemory";

/**
 * B26 (flag ORWELL_JURY_MEMORY, off by default) - a juror's finale lean also reads their MEMORY of the finalist: a favor raises it, a grudge lowers it, bounded to +-JURY_MEMORY.max; off => 0
 * (no ctx provider, byte-identical); the player is never a memory-juror; registered in the decision x source table. Roles only.
 */
type G = { juryMemoryFor(juror: string, finalist: string): number; setJuryMemoryEnabled(on: boolean): void };
function game() {
  const sb = new GameSessionRegistry().sandboxFor(`jury-mem-${Math.random()}`);
  sb.session.createCharacter({ playerName: "P", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const [juror, finalist] = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
  const live = (sb.session as unknown as { live: { week: number; npcMemory?: Record<string, Record<string, MemoryEntry[]>> } }).live;
  return { sb, g: sb.session as unknown as G, live, juror: juror!, finalist: finalist! };
}
describe("juryMemoryFor", () => {
  it("flag off => 0 even with a remembered grudge", () => {
    const { g, live, juror, finalist } = game();
    live.npcMemory = { [juror]: { [finalist]: [{ kind: "deal-broken", week: live.week, severity: 1 }] } };
    expect(g.juryMemoryFor(juror, finalist)).toBe(0);
  });
  it("on: a grudge lowers the lean, a favor raises it, both bounded", () => {
    const { g, live, juror, finalist } = game();
    g.setJuryMemoryEnabled(true);
    live.npcMemory = { [juror]: { [finalist]: [{ kind: "deal-broken", week: live.week, severity: 1 }] } };
    const grudge = g.juryMemoryFor(juror, finalist);
    expect(grudge).toBeLessThan(0);
    expect(Math.abs(grudge)).toBeLessThanOrEqual(JURY_MEMORY.max);
    live.npcMemory = { [juror]: { [finalist]: [{ kind: "deal-kept", week: live.week, severity: 1 }] } };
    const favor = g.juryMemoryFor(juror, finalist);
    expect(favor).toBeGreaterThan(0);
    expect(favor).toBeLessThanOrEqual(JURY_MEMORY.max);
    live.npcMemory = {};
    expect(g.juryMemoryFor(juror, finalist)).toBe(0);
  });
  it("the player is never a memory-juror, and the table lists the jury decision", () => {
    const { g, finalist } = game();
    g.setJuryMemoryEnabled(true);
    expect(g.juryMemoryFor(PLAYER, finalist)).toBe(0);
    expect(DECISION_SOURCES.juryVote).toEqual(["juryMemoryFor"]);
  });
});
