import { expect, it } from "vitest";
import { auditSeason } from "../support/activeInHouseAudit";

/**
 * ORW-1084 / ORW-1085 / ORW-1086 (audit A7). REAL PATH: whole seasons are played through the player's levers (the scripted talking player), and the engine's own recorded events are READ.
 * One status gate, "active in the house" (src/engine/inHouse.ts): a juror, a pre-jury evictee and an evicted or finished-season player neither act nor witness in the house.
 * Seed 10 (the card's seed): before the gate a pre-jury evictee kept turning up as the one who acted or a witness in deals and betrayals, and an evicted juror in a reason said aloud.
 * Heavy lane (tests/realpath): each season plays a few minutes, so run it on a runner. Roles only.
 */
/** One whole season audited (ORW-410: one season per test file, so the shards can split them). */
export function seasonCase(seed: number): void {
  it(`seed ${seed}: no pre-jury evictee, no juror with an active houseguest, no evicted player in a house scene (finale night and the broadcast record excepted)`, async () => {
    const row = await auditSeason(seed);
    expect(row.finished, "the season was played to its crown").toBe(true);
    expect(row.overRefusals, "a finished season: the house levers refuse with the reason").toHaveLength(3);
    for (const m of row.overRefusals) expect(m).toMatch(/season-over/);
    const detail = row.hits.slice(0, 6).map((h) => `${h.kind} ${h.type} ${h.id} ${h.content}`);
    expect({ preJury: row.preJuryEvictee, jurorWithActive: row.jurorWithActive, outPlayer: row.outPlayer, detail }).toEqual({ preJury: 0, jurorWithActive: 0, outPlayer: 0, detail: [] });
  }, 900_000);
}
