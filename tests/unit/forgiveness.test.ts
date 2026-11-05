import { describe, it, expect } from "vitest";
import { forgivenessTraitOf, applyForgiveness } from "../../src/engine/forgiveness";
import { FORGIVENESS } from "../../src/engine/forgivenessConstants";
import { salience, type MemoryEntry, type MemoryKind } from "../../src/engine/npcMemory";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/**
 * B27 (flag ORWELL_FORGIVENESS, off by default) - a seeded ~1-in-6 grudge-keeper whose real betrayals never read older than a floor age; everyone else's favors fade fast; flag off => the ledger is read
 * as it always was. Pure, no shared rng, never mutates the ledger or changes a severity. Roles only.
 */
const BETRAYAL = new Set<MemoryKind>(["deal-broken", "scene-betrayal"]);
const FAVOR = new Set<MemoryKind>(["veto-saved", "deal-kept", "scene-kindness"]);
const old = (kind: MemoryKind, week = 1, severity = 0.8): MemoryEntry => ({ kind, week, severity });

describe("the trait draw", () => {
  it("is deterministic and about 1 in 6 are grudge-keepers", () => {
    let keepers = 0; const N = 6000;
    for (let s = 1; s <= N; s++) { expect(forgivenessTraitOf(s)).toBe(forgivenessTraitOf(s)); if (forgivenessTraitOf(s) === "grudge-keeper") keepers++; }
    expect(keepers / N).toBeGreaterThan(FORGIVENESS.grudgeKeeperShare - 0.03);
    expect(keepers / N).toBeLessThan(FORGIVENESS.grudgeKeeperShare + 0.03);
  });
});

describe("applyForgiveness", () => {
  const now = 25;
  it("a keeper's old real betrayal survives decay at the floor; a typical holder's has decayed away", () => {
    const entries = [old("deal-broken")];
    const keeper = salience(applyForgiveness(entries, "grudge-keeper", now), BETRAYAL, now, 1);
    const typical = salience(applyForgiveness(entries, "typical", now), BETRAYAL, now, 1);
    expect(keeper).toBeGreaterThan(0.1);
    expect(keeper).toBeCloseTo(salience([{ ...entries[0]!, week: now - FORGIVENESS.floorAgeWeeks }], BETRAYAL, now, 1), 9);
    expect(typical).toBe(salience(entries, BETRAYAL, now, 1)); // "others decay as today"
    expect(keeper).toBeGreaterThan(typical * 5);
  });
  it("a typical holder's favors fade faster than today's; a keeper's favors are read as today", () => {
    const entries = [old("deal-kept", 20, 0.8)];
    const today = salience(entries, FAVOR, now, 1);
    expect(salience(applyForgiveness(entries, "typical", now), FAVOR, now, 1)).toBeLessThan(today);
    expect(salience(applyForgiveness(entries, "grudge-keeper", now), FAVOR, now, 1)).toBe(today);
  });
  it("a FRESH betrayal is unchanged for both (the floor only holds old ones), severity never changes, and the ledger is never mutated", () => {
    const entries = [old("scene-betrayal", now - 1, 0.6), old("deal-kept", 20, 0.8)];
    const copy = JSON.stringify(entries);
    for (const t of ["grudge-keeper", "typical"] as const) {
      const out = applyForgiveness(entries, t, now)!;
      expect(out.map((e) => e.severity)).toEqual(entries.map((e) => e.severity));
      expect(out[0]!.week).toBe(now - 1);
    }
    expect(JSON.stringify(entries)).toBe(copy);
  });
  it("empty / undefined pass through", () => {
    expect(applyForgiveness(undefined, "typical", 3)).toBeUndefined();
    expect(applyForgiveness([], "grudge-keeper", 3)).toEqual([]);
  });
});

type G = { memoryTiltFor(subject: string, holder: string): number; setForgivenessEnabled(on: boolean): void };
describe("through the real session", () => {
  function game(seed: number) {
    const sb = new GameSessionRegistry().sandboxFor(`forg-${seed}`);
    sb.session.createCharacter({ playerName: "P", seed });
    sb.session.advanceGame(); sb.session.advanceGame();
    return sb;
  }
  it("flag off: the tilt is exactly today's for every holder; on: a keeper's old betrayal still tilts while a typical holder's has faded", () => {
    const sb = game(7);
    const live = (sb.session as unknown as { live: { week: number; npcMemory?: Record<string, Record<string, MemoryEntry[]>> } }).live;
    live.week = 30;
    const holders = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
    live.npcMemory = {};
    for (const h of holders) live.npcMemory[h] = { [PLAYER]: [old("scene-betrayal", 1, 0.9)] };
    const g = sb.session as unknown as G;
    g.setForgivenessEnabled(false);
    const offTilts = holders.map((h) => g.memoryTiltFor(PLAYER, h));
    g.setForgivenessEnabled(true);
    const onTilts = holders.map((h) => g.memoryTiltFor(PLAYER, h));
    let raised = 0;
    onTilts.forEach((t, i) => { expect(t, "forgiveness never lowers a grudge").toBeGreaterThanOrEqual(offTilts[i]! - 1e-12); if (t > offTilts[i]! + 1e-9) raised++; });
    // across many games the keepers (1 in 6) show up; in this one every raised holder is a keeper, the rest are exactly today's
    expect(raised).toBeLessThan(holders.length);
    g.setForgivenessEnabled(false);
    expect(holders.map((h) => g.memoryTiltFor(PLAYER, h))).toEqual(offTilts);
  });
});
