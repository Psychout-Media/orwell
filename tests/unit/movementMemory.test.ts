import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { MOVEMENT_INTENT, MOVEMENT_MEMORY } from "../../src/engine/presenceConstants";

/** ORW-87: where an NPC goes reads what it REMEMBERS - a favor draws it toward that houseguest, a grudge keeps it away. Played games only. No model, roles only. */
type Pull = { target: string; weight: number; avoid: boolean };
type Live = { playedGame?: boolean; week: number; npcMemory?: Record<string, Record<string, Array<{ kind: string; week: number; severity: number }>>> };
type S = {
  movementIntentFor(id: string): Pull[] | null;
  setNpcMemoryEnabled(on: boolean): void;
  setNpcMemoryStandaloneEnabled(on: boolean): void;
  memoryTiltFor(subject: string, holder: string): number;
  livingIds(): string[];
  createCharacter(r: unknown): unknown;
  advanceGame(): unknown;
  live: Live;
};
function started(): { s: S; holder: string; other: string; live: Live } {
  const s = new GameSessionRegistry().sandboxFor(`mm-${Math.random()}`).session as unknown as S;
  s.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  s.advanceGame(); s.advanceGame();
  const [holder, other] = s.livingIds().filter((i) => i !== PLAYER);
  return { s, holder: holder!, other: other!, live: s.live };
}
const pullOn = (s: S, holder: string, other: string): Pull | undefined => s.movementIntentFor(holder)?.find((p) => p.target === other);

describe("movement reads the NPC memory ledger", () => {
  it("a remembered favor draws the holder toward that houseguest; a grudge makes them avoid; headless (not played) is untouched", () => {
    const { s, holder, other, live } = started();
    s.setNpcMemoryEnabled(true); s.setNpcMemoryStandaloneEnabled(true);
    live.playedGame = false;
    const baseline = JSON.stringify(s.movementIntentFor(holder));
    live.npcMemory = { [holder]: { [other]: [{ kind: "veto-saved", week: live.week, severity: 1 }] } };
    expect(JSON.stringify(s.movementIntentFor(holder)), "headless: ledger ignored").toBe(baseline);
    live.playedGame = true;
    expect(s.memoryTiltFor(other, holder)).toBeLessThan(-MOVEMENT_MEMORY.minTilt);
    const fav = pullOn(s, holder, other);
    expect(fav !== undefined && !fav.avoid && fav.weight >= MOVEMENT_INTENT.minCharge).toBe(true);
    expect(JSON.stringify(s.movementIntentFor(holder))).not.toBe(baseline);
    live.npcMemory = { [holder]: { [other]: [{ kind: "deal-broken", week: live.week, severity: 1 }] } };
    const gr = pullOn(s, holder, other);
    const hadPull = (JSON.parse(baseline) as Pull[] | null)?.find((p) => p.target === other);
    if (!hadPull || hadPull.avoid) expect(gr?.avoid).toBe(true);
    expect(MOVEMENT_MEMORY.gain).toBeGreaterThan(0);
  });
  it("memory layer off => no effect even in a played game", () => {
    const { s, holder, other, live } = started();
    s.setNpcMemoryEnabled(false); live.playedGame = true;
    const baseline = JSON.stringify(s.movementIntentFor(holder));
    live.npcMemory = { [holder]: { [other]: [{ kind: "veto-saved", week: live.week, severity: 1 }] } };
    expect(JSON.stringify(s.movementIntentFor(holder))).toBe(baseline);
  });
});
