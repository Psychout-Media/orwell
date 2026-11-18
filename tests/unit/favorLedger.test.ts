import { describe, it, expect } from "vitest";
import { FavorLedger } from "../../src/engine/favors";
import { FAVOR } from "../../src/engine/favorConstants";

/** 0171: the favor ledger (pure). Roles only. */
const mk = (): FavorLedger => { const l = new FavorLedger(); l.owe({ owedBy: "debtor", owedTo: "holder", origin: "deal:1", beat: 1, witnesses: ["witness", "debtor", "holder"] }); return l; };

describe("FavorLedger", () => {
  it("never records a favor a houseguest owes themself, and keeps witnesses to the third parties", () => {
    const l = new FavorLedger();
    expect(l.owe({ owedBy: "a", owedTo: "a", origin: "x", beat: 1 })).toBeUndefined();
    expect(mk().all[0]!.witnesses).toEqual(["witness"]);
  });
  it("is append-only: resolving or passing never removes an entry, and a pass appends a new owed entry for the new holder", () => {
    const l = mk();
    const before = l.all.length;
    const next = l.pass("favor:1", "ally", 2)!;
    expect(l.all.length).toBe(before + 1);
    expect(l.get("favor:1")!.state).toBe("passed");
    expect(next).toMatchObject({ holder: "ally", owedBy: "debtor", owedTo: "holder", passedFrom: "favor:1", state: "owed" });
    expect(l.resolve(next.id, "repaid", 3)).toBe(true);
    expect(l.resolve(next.id, "refused", 4)).toBe(false); // resolves once
    expect(l.all.length).toBe(before + 1);
  });
  it("will not pass a favor to its debtor or to its own holder, nor call one twice", () => {
    const l = mk();
    expect(l.pass("favor:1", "debtor", 2)).toBeUndefined();
    expect(l.pass("favor:1", "holder", 2)).toBeUndefined();
    expect(l.call("favor:1", 2)).toBe(true);
    expect(l.call("favor:1", 3)).toBe(false);
  });
  it("round-trips lossless, recomputes seq from the loaded ids, and a later save never holds fewer", () => {
    const l = mk();
    l.pass("favor:1", "ally", 2);
    l.owe({ owedBy: "x", owedTo: "y", origin: "counter:1", beat: 3 });
    const saved = JSON.parse(JSON.stringify(l.serialize()));
    const back = new FavorLedger();
    back.load(saved);
    expect(back.serialize()).toEqual(l.serialize());
    expect(back.owe({ owedBy: "p", owedTo: "q", origin: "o", beat: 4 })!.id).toBe("favor:4");
    expect(back.serialize().length).toBeGreaterThanOrEqual(saved.length);
  });
  it("reads the debt signed like a bond: + means the other owes the holder, clamped to -1..1", () => {
    const l = mk();
    expect(l.debtBetween("holder", "debtor")).toBe(FAVOR.debtPerFavor);
    expect(l.debtBetween("debtor", "holder")).toBe(-FAVOR.debtPerFavor);
    expect(l.debtBetween("holder", "stranger")).toBe(0);
    for (let i = 0; i < 10; i++) l.owe({ owedBy: "debtor", owedTo: "holder", origin: "d", beat: 1 });
    expect(l.debtBetween("holder", "debtor")).toBe(1);
    expect(l.debtBetween("debtor", "holder")).toBe(-1);
  });
  it("a repaid or refused favor no longer counts as debt, but stays on the ledger", () => {
    const l = mk();
    l.resolve("favor:1", "repaid", 2);
    expect(l.debtBetween("holder", "debtor")).toBe(0);
    expect(l.all.length).toBe(1);
  });
  it("a passed favor's debt moves to the new holder", () => {
    const l = mk();
    l.pass("favor:1", "ally", 2);
    expect(l.debtBetween("holder", "debtor")).toBe(0);
    expect(l.debtBetween("ally", "debtor")).toBe(FAVOR.debtPerFavor);
  });
});
