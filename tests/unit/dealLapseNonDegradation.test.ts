import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { DealLedger } from "../../src/engine/deals";
import { sessionCoreIsSuperset } from "../../src/engine/sessionSnapshot";
import { npc } from "../../src/domain/ids";

/**
 * ORW-316 - found live (2026-11-12, real DeepSeek game): after the first eviction the week-roll advance was refused on EVERY attempt ("turn refused - integrity checkpoint failed (degradation)"),
 * freezing the game. Cause: `expireWeekScoped` DELETED an untested conditional / undelivered information deal at the week roll, while the non-degradation checkpoint treats `deals` as append-only by id.
 * Roles only.
 */
describe("a lapsed (untested conditional / undelivered information) deal is never deleted from the saved list", () => {
  const A = npc(1), B = npc(2);
  it("expireWeekScoped marks it lapsed: still in `all` and the serialized list, out of every live accessor", () => {
    const ledger = new DealLedger();
    const cond = ledger.make([A, B], "conditional", "keep each other if on the block", undefined, 1);
    const info = ledger.make([A, B], "information", "tell me what you hear", undefined, 1);
    expect(ledger.expireWeekScoped(2)).toEqual([]);
    expect(cond.status).toBe("lapsed");
    expect(info.status).toBe("lapsed");
    expect(ledger.serialize().map((d) => d.id)).toEqual([cond.id, info.id]); // nothing deleted
    expect(ledger.all).toHaveLength(2);
    expect(ledger.open()).toHaveLength(0);
    expect(ledger.forParty(A)).toHaveLength(0);
    expect(ledger.npcOnly()).toHaveLength(0);
  });
  it("a lapsed deal survives a save / load round trip and stays lapsed", () => {
    const ledger = new DealLedger();
    const d = ledger.make([A, B], "conditional", "x", undefined, 1);
    ledger.expireWeekScoped(2);
    const copy = new DealLedger();
    copy.load(ledger.serialize());
    expect(copy.all.map((x) => [x.id, x.status])).toEqual([[d.id, "lapsed"]]);
    expect(copy.forParty(A)).toHaveLength(0);
  });
  it("the checkpoint's deal append-only rule holds across the lapse (a deleted deal would be a degradation)", () => {
    const dir = mkdtempSync(join(tmpdir(), "orwell-lapse-"));
    const reg = new GameSessionRegistry(new FileSaveStore(dir));
    const s = reg.sandboxFor("u").session as any;
    s.createCharacter({ playerName: "P", seed: 5 });
    const ids = (s.snapshot().deals ?? []).length;
    const before = s.snapshot();
    // a conditional deal (no engine surface needed: seed the ledger directly), then lapse it the way a week roll does
    const ledger = s.deals as DealLedger;
    ledger.make([npc(1), npc(2)], "conditional", "keep each other if on the block", undefined, 1);
    const withDeal = s.snapshot();
    ledger.expireWeekScoped(2);
    const after = s.snapshot();
    expect(ids).toBe(0);
    expect((withDeal.deals ?? []).length).toBe(1);
    expect((after.deals ?? []).length).toBe(1); // lapsed, not deleted
    expect(sessionCoreIsSuperset(after, withDeal)).toBe(true);
    expect(sessionCoreIsSuperset(withDeal, before)).toBe(true);
  });
});
