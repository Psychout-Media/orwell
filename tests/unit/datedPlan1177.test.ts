import { describe, it, expect } from "vitest";
import { emptyOpenLedger, openLedgerProposal, openLedgerSection, recordOpenEntry, restoreOpenLedger, openLedgerPlanDue } from "../../src/engine/openLedger";

const known = new Set(["npc:1", "npc:2", "npc:3", "npc:4", "npc:5"]);
const req = (extra: object = {}) => ({ text: "Ice breakers tomorrow morning, I'll make the coffee", speaker: "player", addressedTo: ["npc:1", "npc:2"], kind: "plan", parties: ["npc:1", "npc:2", "npc:3", "npc:4", "npc:5"], ...extra });
const ctx = (day: number) => ({ turn: 5, beatSeq: 5, room: "kitchen", witnesses: [...known], day });
const rec = (extra: object, day = 3) => {
  const p = openLedgerProposal(req(extra), known);
  if (typeof p === "string") throw new Error(p);
  const out = recordOpenEntry(emptyOpenLedger(), p, ctx(day));
  expect(out.outcome).toBe("recorded");
  return out.ledger;
};
const name = (id: string) => id;

describe("ORW-1177: a dated plan in the open ledger", () => {
  it("accepts a due day and part and stamps the absolute day (tomorrow morning -> next day, morning)", () => {
    const l = rec({ due: { day: "tomorrow", part: "morning" } });
    expect(l.entries[0]).toMatchObject({ dueDay: 4, duePart: "morning", status: "open" });
    expect(l.entries[0]!.parties).toHaveLength(5);
  });
  it("rejects a malformed due as bad-shape", () => {
    expect(openLedgerProposal(req({ due: { day: "someday" } }), known)).toBe("bad-shape");
    expect(openLedgerProposal(req({ due: { day: "today", part: "noon" } }), known)).toBe("bad-shape");
    expect(openLedgerProposal(req({ due: { day: "today", extra: 1 } }), known)).toBe("bad-shape");
  });
  it("an undated entry has no due day and is never due (negative control)", () => {
    const l = rec({});
    expect(l.entries[0]!.dueDay).toBeUndefined();
    expect(openLedgerPlanDue(l.entries[0]!, { day: 9, part: "morning" })).toBe(false);
  });
  it("the evening before the plan reads as planned, not due", () => {
    const l = rec({ due: { day: "tomorrow", part: "morning" } });
    const s = openLedgerSection(l, ["npc:1"], name, 6, { day: 3, part: "evening" })!;
    expect(s).toContain("planned for tomorrow morning");
    expect(s).not.toContain("PLAN DUE NOW");
  });
  it("the next morning's brief carries the due plan and asks for it to be voiced or broken", () => {
    const l = rec({ due: { day: "tomorrow", part: "morning" } });
    const s = openLedgerSection(l, ["npc:1"], name, 6, { day: 4, part: "morning" })!;
    expect(s).toContain("PLAN DUE NOW");
    expect(s).toContain("Ice breakers");
    expect(s).toContain("voice it as happening, or say outright that it is broken or put off");
  });
  it("a plan for the afternoon is not due in the morning, and is due later that day or the next day", () => {
    const e = rec({ due: { day: "tomorrow", part: "afternoon" } }).entries[0]!;
    expect(openLedgerPlanDue(e, { day: 4, part: "morning" })).toBe(false);
    expect(openLedgerPlanDue(e, { day: 4, part: "evening" })).toBe(true);
    expect(openLedgerPlanDue(e, { day: 5, part: "morning" })).toBe(true);
  });
  it("a due plan is shown even when the brief is already full of other entries", () => {
    let l = rec({ due: { day: "tomorrow", part: "morning" } });
    for (let i = 0; i < 8; i++) {
      const p = openLedgerProposal({ text: `a claim number ${i}`, speaker: "npc:1", addressedTo: ["player"], kind: "claim", about: `thing ${i}` }, known) as never;
      l = recordOpenEntry(l, p, ctx(3)).ledger;
    }
    expect(openLedgerSection(l, ["npc:1", "npc:2", "npc:3"], name, 20, { day: 4, part: "morning" })!).toContain("PLAN DUE NOW");
  });
  it("survives a save and load; a malformed saved date is dropped, the entry stays", () => {
    const l = rec({ due: { day: "tomorrow", part: "morning" } });
    expect(restoreOpenLedger(JSON.parse(JSON.stringify(l))).ledger.entries[0]).toMatchObject({ dueDay: 4, duePart: "morning" });
    const bad = JSON.parse(JSON.stringify(l));
    bad.entries[0].duePart = "teatime";
    const r = restoreOpenLedger(bad);
    expect(r.problems).toBe(0);
    expect(r.ledger.entries[0]!.dueDay).toBeUndefined();
  });
});
