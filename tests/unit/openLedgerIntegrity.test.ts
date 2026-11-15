import { describe, it, expect } from "vitest";
import { openLedgerSuperset, restoreOpenLedger, type OpenLedger, type OpenLedgerEntry } from "../../src/engine/openLedger";

/** Review of #2692 and #2721: the append-only check covers every field; the restore gate checks optional fields. */
const entry = (over: Partial<OpenLedgerEntry> = {}): OpenLedgerEntry => ({
  id: "open:1", text: "I will vote with you", speaker: "player", addressedTo: ["npc:a"], kind: "promise",
  turn: 3, beatSeq: 7, room: "kitchen", witnesses: ["npc:a", "player"], quoteHash: "h1", status: "open", ...over,
});
const led = (...entries: OpenLedgerEntry[]): OpenLedger => ({ nextId: entries.length + 1, entries });

describe("openLedgerSuperset covers the whole entry", () => {
  it("accepts an identical ledger, a new entry, and open to resolved", () => {
    const a = led(entry());
    expect(openLedgerSuperset(a, a)).toBe(true);
    expect(openLedgerSuperset(a, led(entry(), entry({ id: "open:2", quoteHash: "h2" })))).toBe(true);
    expect(openLedgerSuperset(a, led(entry({ status: "kept", note: "he did", resolvedTurn: 5 })))).toBe(true);
  });
  it.each([
    ["speaker", { speaker: "npc:b" }], ["addressedTo", { addressedTo: ["npc:b"] }], ["parties", { parties: ["npc:b"] }],
    ["about", { about: "npc:z" }], ["witnesses", { witnesses: ["player"] }], ["room", { room: "attic" }],
    ["turn", { turn: 99 }], ["quoteHash", { quoteHash: "x" }], ["kind", { kind: "threat" }],
  ])("refuses a rewritten %s", (_k, over) => {
    expect(openLedgerSuperset(led(entry()), led(entry(over as Partial<OpenLedgerEntry>)))).toBe(false);
  });
  it("refuses reopening a resolved entry, changing or erasing its note", () => {
    const done = entry({ status: "broken", note: "he lied", resolvedTurn: 5 });
    expect(openLedgerSuperset(led(done), led(entry()))).toBe(false);
    expect(openLedgerSuperset(led(done), led(entry({ status: "kept", note: "he lied", resolvedTurn: 5 })))).toBe(false);
    expect(openLedgerSuperset(led(done), led(entry({ status: "broken", resolvedTurn: 5 })))).toBe(false);
    expect(openLedgerSuperset(led(done), led(done))).toBe(true);
  });
});

describe("restoreOpenLedger rejects malformed optional fields", () => {
  const raw = (e: unknown) => restoreOpenLedger({ nextId: 2, entries: [e] });
  it.each([["parties {}", { parties: {} }], ["about number", { about: 4 }], ["note number", { note: 1 }], ["status junk", { status: "x" }], ["parties non-string", { parties: [1] }]])(
    "%s", (_n, over) => {
      const r = raw({ ...entry(), ...over });
      expect(r.problems).toBe(1);
      expect(r.ledger.entries).toHaveLength(0);
    });
  it("still loads an old slice-1 entry with no parties, about, note or status", () => {
    const { status: _s, ...old } = entry();
    const r = raw(old);
    expect(r.problems).toBe(0);
    expect(r.ledger.entries[0]).toMatchObject({ id: "open:1", status: "open" });
  });
});
