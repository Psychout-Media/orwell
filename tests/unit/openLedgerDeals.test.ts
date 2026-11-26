import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { AdvanceView } from "../../src/ports/GameSession";
import { sessionCoreSupersetViolation } from "../../src/engine/sessionSnapshot";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import {
  OPEN_LEDGER_MAX_ENTRIES, emptyOpenLedger, openLedgerSuperset, recordDealEntry, recordOpenEntry, restoreOpenLedger, syncOpenLedger,
  type OpenLedger, type OpenLedgerEntry,
} from "../../src/engine/openLedger";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";

/**
 * ORW-456 - a formal deal struck with the player is ALSO an open-ledger line, linked to its deal by id. One line per deal, never
 * doubled; a deal that is only spoken is kept as an unlinked "deal" line and linked (not doubled) when the engine records the deal;
 * the line closes with the deal's PUBLIC ending. Roles only; no names. Nothing here reads or depends on how anyone voted.
 */
type Priv = {
  openLedger: OpenLedger;
  live: { week: number; dayNumber?: number; beat: string; evictionOrder: string[]; playedGame?: boolean; pending?: unknown; finished?: boolean };
  deals: { all: Array<{ id: string; status: string; parties: string[]; sealedBallot?: boolean }> };
  persist(): void;
};
const priv = (g: GameSessionAdapter): Priv => g as unknown as Priv;
const ME = "player";
const SEED = 4001;

function step(g: GameSessionAdapter, v: AdvanceView): AdvanceView {
  const p = v.pending;
  if (!p) return g.advanceGame();
  if (p.kind === "ceremony-step") return g.advanceGame();
  if (p.kind === "nominations") return g.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  if (p.kind === "veto-decision") return g.submitDecision({ kind: "veto-decision", use: false });
  if (p.kind === "replacement") return g.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  if (p.kind === "comp-intent" || p.kind === "comp-round") return g.submitDecision({ kind: p.kind, intent: "compete" });
  // 0150: a season where the player reaches the final two (full-strength beliefs moved the trajectory) - answer the finale too.
  if (p.kind === "finale-statement") return g.submitDecision({ kind: "finale-statement", statement: "I played my own game." });
  if (p.kind === "finale-answer") return g.submitDecision({ kind: "finale-answer", appeal: p.appeals![0]! });
  return g.submitDecision({ kind: p.kind, vote: p.options?.[0]?.id } as never);
}
function startAtNominations(seed = SEED): { g: GameSessionAdapter; view: AdvanceView } {
  const runtime = composeRuntime({ clock: new FakeClock() });
  const g = runtime.registry.sandboxFor(`orw456-${seed}`).session as unknown as GameSessionAdapter;
  g.createCharacter({ playerName: "P", seed });
  let view = g.advanceGame();
  for (let i = 0; i < 400 && !(priv(g).live.beat === "nominations" && !priv(g).live.pending); i++) view = step(g, view);
  priv(g).live.playedGame = true;
  g.setAdvanceGateEnabled(false);
  return { g, view };
}
const npcs = (g: GameSessionAdapter): string[] => g.getGameState().house.map((h) => h.id as string).filter((id) => id !== ME);
const lines = (g: GameSessionAdapter) => priv(g).openLedger.entries;
/** Walk the player to a room with houseguests in it; returns who is there (the ledger only takes people who are present). */
function meet(g: GameSessionAdapter): string[] {
  for (const room of ["living-room", "kitchen", "backyard", "bedroom", "bathroom"]) {
    const here = (g.movePlayer(room)?.present ?? []).map((p) => p.id as string).filter((x) => x !== ME);
    if (here.length >= 2) return here;
  }
  throw new Error("nobody to meet");
}
function strike(g: GameSessionAdapter, who: string, kind = "safety", terms = "a safe week") {
  const made = g.makeDeal({ with: who as never, kind: kind as never, terms });
  if (!made || "refused" in made) throw new Error("the deal was not made");
  return made;
}

describe("a struck deal is ONE linked line in the ledger (real engine)", () => {
  it("makeDeal writes exactly one open line, kind deal, between the player and the partner, linked by the deal id", () => {
    const { g } = startAtNominations();
    const [who] = npcs(g);
    const made = strike(g, who!);
    expect(lines(g)).toHaveLength(1);
    expect(lines(g)[0]).toMatchObject({ kind: "deal", speaker: ME, addressedTo: [who], dealId: made.id, status: "open" });
    expect(lines(g)[0]!.text).toContain("a safe week");
  });
  it("saying the same deal in narration afterwards (kind deal) is a duplicate of that line, not a second one", () => {
    const { g } = startAtNominations();
    const [who] = meet(g);
    strike(g, who!);
    const r = g.recordOpenLedger({ text: "I will keep you safe this week, deal", speaker: who!, addressedTo: [ME], kind: "deal" });
    expect(r).toMatchObject({ accepted: true, duplicate: true, entryId: lines(g)[0]!.id });
    expect(lines(g)).toHaveLength(1);
  });
  it("two different deals are two lines, each linked to its own deal", () => {
    const { g } = startAtNominations();
    const [a, b] = npcs(g);
    const d1 = strike(g, a!); const d2 = strike(g, b!, "vote", "my vote");
    expect(lines(g).map((e) => e.dealId)).toEqual([d1.id, d2.id]);
  });
  it("the line closes with the deal's PUBLIC ending: kept, broken; a sealed-ballot break and a still-open deal leave it open", () => {
    for (const status of ["kept", "broken"] as const) {
      const { g } = startAtNominations();
      const made = strike(g, npcs(g)[0]!);
      const deal = priv(g).deals.all.find((d) => d.id === made.id)!;
      priv(g).persist();
      expect(lines(g)[0]!.status).toBe("open");
      deal.status = status; priv(g).persist();
      expect(lines(g)[0]).toMatchObject({ status, note: `the linked deal ended as ${status}` });
    }
    const { g } = startAtNominations();
    const made = strike(g, npcs(g)[0]!);
    const deal = priv(g).deals.all.find((d) => d.id === made.id)!;
    deal.status = "broken"; deal.sealedBallot = true; priv(g).persist();
    expect(lines(g)[0]!.status).toBe("open");
  });
  it("the line never lapses while its deal stands (30 in-game days on)", () => {
    const { g } = startAtNominations();
    strike(g, npcs(g)[0]!);
    const day = priv(g).live.dayNumber ?? 1;
    priv(g).live.dayNumber = day + 30; priv(g).persist();
    expect(lines(g)[0]!.status).toBe("open");
  });
});

describe("a deal that lapses, a renegotiation, and a late record (real engine)", () => {
  it("a lapsed deal closes its line (no verdict), and a renegotiation leaves ONE open line: the old closes, the new has its own", () => {
    const { g } = startAtNominations();
    const [who] = npcs(g);
    const d1 = strike(g, who!);
    const old = priv(g).deals.all.find((d) => d.id === d1.id)!;
    old.status = "lapsed"; // what a renegotiation does to the deal it replaces
    const d2 = strike(g, who!, "vote", "my vote instead");
    priv(g).persist();
    const open = lines(g).filter((e) => e.status === "open");
    expect(open).toHaveLength(1);
    expect(open[0]!.dealId).toBe(d2.id);
    expect(lines(g).find((e) => e.dealId === d1.id)).toMatchObject({ status: "lapsed", note: "the linked deal lapsed or was replaced" });
  });
  it("a spoken deal is linked to the engine deal recorded LATER the same in-game day (past the 3-beat window), not doubled", () => {
    const { g } = startAtNominations();
    const [who] = meet(g);
    const spoken = g.recordOpenLedger({ text: "Deal: we go to the end together", speaker: ME, addressedTo: [who!], kind: "deal" });
    (g as unknown as { beatSeq: number }).beatSeq += 10; // the belt records the deal many beats later, same day
    strike(g, who!, "final-two", "the end together");
    expect(lines(g)).toHaveLength(1);
    expect(lines(g)[0]).toMatchObject({ id: spoken.entryId });
    expect(lines(g)[0]!.dealId).toBeDefined();
  });
  it("a spoken deal said AFTER the engine line, many beats later the same day, is a duplicate of it", () => {
    const { g } = startAtNominations();
    const [who] = meet(g);
    strike(g, who!);
    (g as unknown as { beatSeq: number }).beatSeq += 10;
    const r = g.recordOpenLedger({ text: "So we have a deal", speaker: ME, addressedTo: [who!], kind: "deal" });
    expect(r).toMatchObject({ accepted: true, duplicate: true });
    expect(lines(g)).toHaveLength(1);
  });
});

describe("a deal that is only spoken is kept, then linked (not doubled) when the engine records it (real engine)", () => {
  it("spoken only: one unlinked open line of kind deal", () => {
    const { g } = startAtNominations();
    const [who] = meet(g);
    const r = g.recordOpenLedger({ text: "Deal: we go to the end together", speaker: ME, addressedTo: [who!], kind: "deal" });
    expect(r).toMatchObject({ accepted: true });
    expect(lines(g)).toHaveLength(1);
    expect(lines(g)[0]).toMatchObject({ kind: "deal", status: "open" });
    expect(lines(g)[0]!.dealId).toBeUndefined();
  });
  it("the deal belt back-fills makeDeal afterwards: the spoken line gets the deal id, no second line, and the save only grew", () => {
    const { g } = startAtNominations();
    const [who] = meet(g);
    const spoken = g.recordOpenLedger({ text: "Deal: we go to the end together", speaker: ME, addressedTo: [who!], kind: "deal" });
    const before = JSON.parse(JSON.stringify(g.snapshot())) as SessionSnapshot;
    const made = strike(g, who!, "final-two", "the end together");
    expect(lines(g)).toHaveLength(1);
    expect(lines(g)[0]).toMatchObject({ id: spoken.entryId, dealId: made.id });
    const after = JSON.parse(JSON.stringify(g.snapshot())) as SessionSnapshot;
    expect(sessionCoreSupersetViolation(after, before)).toBeNull();
    // and it now closes with that deal
    priv(g).deals.all.find((d) => d.id === made.id)!.status = "kept"; priv(g).persist();
    expect(lines(g)[0]).toMatchObject({ status: "kept" });
  });
  it("a spoken deal with a DIFFERENT houseguest is not taken for this deal: two lines", () => {
    const { g } = startAtNominations();
    const [a, b] = meet(g);
    g.recordOpenLedger({ text: "Deal with the other one", speaker: ME, addressedTo: [b!], kind: "deal" });
    strike(g, a!);
    expect(lines(g)).toHaveLength(2);
    expect(lines(g).filter((e) => e.dealId)).toHaveLength(1);
  });
});

describe("pure: recordDealEntry, the deal link and old saves", () => {
  const spokenEntry = (over: Partial<OpenLedgerEntry> = {}): OpenLedgerEntry => ({
    id: "open:1", text: "deal words", speaker: ME, addressedTo: ["npc:a"], kind: "deal", turn: 5, beatSeq: 5, room: "kitchen", witnesses: [ME, "npc:a"], quoteHash: "h", status: "open", ...over,
  });
  const cx = { turn: 6, beatSeq: 6, room: "kitchen", witnesses: [] as string[], day: 2, maxAge: 3 };
  it("is idempotent for one deal id, and a link is not a rewrite of a set link", () => {
    const one = recordDealEntry(emptyOpenLedger(), { dealId: "deal:1", partner: "npc:a", text: "x" }, cx);
    expect(one.outcome).toBe("recorded");
    const two = recordDealEntry(one.ledger, { dealId: "deal:1", partner: "npc:a", text: "x" }, cx);
    expect(two).toMatchObject({ outcome: "duplicate", ledger: one.ledger });
    const rewritten = { ...one.ledger, entries: one.ledger.entries.map((e) => ({ ...e, dealId: "deal:9" })) };
    expect(openLedgerSuperset(one.ledger, rewritten)).toBe(false);
  });
  it("links an open unlinked spoken deal line only inside the window and only for the same two people", () => {
    const base: OpenLedger = { nextId: 2, entries: [spokenEntry()] };
    expect(recordDealEntry(base, { dealId: "deal:1", partner: "npc:a", text: "x" }, cx).outcome).toBe("linked");
    expect(recordDealEntry(base, { dealId: "deal:1", partner: "npc:a", text: "x" }, { ...cx, beatSeq: 20 }).outcome).toBe("recorded");
    expect(recordDealEntry(base, { dealId: "deal:1", partner: "npc:b", text: "x" }, cx).outcome).toBe("recorded");
    const group: OpenLedger = { nextId: 2, entries: [spokenEntry({ parties: ["npc:b"] })] };
    expect(recordDealEntry(group, { dealId: "deal:1", partner: "npc:a", text: "x" }, cx).outcome).toBe("recorded");
    const promise: OpenLedger = { nextId: 2, entries: [spokenEntry({ kind: "promise" })] };
    expect(recordDealEntry(promise, { dealId: "deal:1", partner: "npc:a", text: "x" }, cx).outcome).toBe("recorded");
  });
  it("with a day known the window is the same in-game day, not 3 beats; a lapsed deal closes its line with a fixed note", () => {
    const base: OpenLedger = { nextId: 2, entries: [spokenEntry({ day: 2 })] };
    expect(recordDealEntry(base, { dealId: "deal:1", partner: "npc:a", text: "x" }, { ...cx, beatSeq: 40 }).outcome).toBe("linked");
    expect(recordDealEntry(base, { dealId: "deal:1", partner: "npc:a", text: "x" }, { ...cx, beatSeq: 40, day: 3 }).outcome).toBe("recorded");
    const l = recordDealEntry(emptyOpenLedger(), { dealId: "deal:1", partner: "npc:a", text: "x" }, cx).ledger;
    const out = syncOpenLedger(l, { turn: 9, day: 3, gone: new Set(), dealEnd: () => "lapsed" });
    expect(out.entries[0]).toMatchObject({ status: "lapsed", note: "the linked deal lapsed or was replaced" });
  });
  it("a gaining-a-link change passes the integrity rule only once, and not for an entry already resolved", () => {
    const base: OpenLedger = { nextId: 2, entries: [spokenEntry()] };
    const linked = recordDealEntry(base, { dealId: "deal:1", partner: "npc:a", text: "x" }, cx).ledger;
    expect(openLedgerSuperset(base, linked)).toBe(true);
    const resolved: OpenLedger = { nextId: 2, entries: [spokenEntry({ status: "kept", note: "n", resolvedTurn: 7 })] };
    expect(openLedgerSuperset(resolved, { ...resolved, entries: [{ ...resolved.entries[0]!, dealId: "deal:1" }] })).toBe(false);
  });
  it("the line of a deal whose partner left the house closes as withdrawn", () => {
    const l = recordDealEntry(emptyOpenLedger(), { dealId: "deal:1", partner: "npc:a", text: "x" }, cx).ledger;
    const out = syncOpenLedger(l, { turn: 9, day: 3, gone: new Set(["npc:a"]), dealEnd: () => "open" });
    expect(out.entries[0]).toMatchObject({ status: "withdrawn", note: "left the house" });
  });
  it("a save from before this change (no deal lines, no link) loads and re-saves byte-identically", () => {
    const old: OpenLedger = { nextId: 3, entries: [spokenEntry({ id: "open:1" }), spokenEntry({ id: "open:2", kind: "promise", quoteHash: "g", text: "p" })] };
    const r = restoreOpenLedger(JSON.parse(JSON.stringify(old)));
    expect(r.problems).toBe(0);
    expect(JSON.stringify(r.ledger)).toBe(JSON.stringify(old));
    // a played season on a restored old save keeps working: striking the deal after loading links the spoken line
    const linked = recordDealEntry(r.ledger, { dealId: "deal:1", partner: "npc:a", text: "x" }, cx);
    expect(linked.outcome).toBe("linked");
    expect(openLedgerSuperset(r.ledger, linked.ledger)).toBe(true);
  });
  it("an engine snapshot taken before this change (no ledger at all) restores and a deal then writes its line", () => {
    const { g } = startAtNominations();
    const snap = JSON.parse(JSON.stringify(g.snapshot())) as Record<string, unknown>;
    delete snap.openLedger;
    const runtime = composeRuntime({ clock: new FakeClock() });
    const h = runtime.registry.sandboxFor("orw456-old").session as unknown as GameSessionAdapter;
    (h as unknown as { restore(s: unknown): void }).restore(snap);
    priv(h).live.playedGame = true;
    strike(h, npcs(h)[0]!);
    expect(lines(h)).toHaveLength(1);
  });
});

describe("a simulated season of deals: the open bound is never reached", () => {
  // ORW-955: vitest 2 never enforced the 30 s limit on synchronous tests; this keeps that behaviour explicit
  it("striking deals every day with whoever is here, weekly evictions, no model: open lines stay under the bound; each deal has at most one line", { timeout: 120_000 }, () => {
    const { g, view: v0 } = startAtNominations(4002);
    (g as unknown as { setOwnViewEnabled(on: boolean): void }).setOwnViewEnabled(false); // ORW-574: the own view changes who strikes how many deals; this checks the ledger's bound, not the decisions
    (g as unknown as { setRoutinesEnabled(on: boolean): void }).setRoutinesEnabled(false); // ORW-651: routines move who is where, and so how many deals a season strikes; this checks the ledger's bound, not behaviour
    g.setHouseNormsEnabled(false); // 0180: this checks the open ledger's bound, not trust; the house's norms (shunning, the herd, scapegoats) would only change how many deals land
    let view = v0;
    const rng = new SeededRandom(456);
    let day = -1; let made = 0; let maxOpen = 0; let guard = 0;
    let prev = JSON.parse(JSON.stringify(g.snapshot())) as SessionSnapshot;
    while (!priv(g).live.finished && guard++ < 900) {
      const d = priv(g).live.dayNumber ?? 0;
      if (d !== day) {
        day = d;
        const wa = g.movePlayer(["living-room", "kitchen", "backyard", "bedroom", "bathroom"][rng.int(5)]!);
        const people = (wa?.present ?? []).map((p) => p.id as string).filter((x) => x !== ME);
        for (let k = 0; k < 12 && people.length; k++) { // ORW-727: twelve tries a day, since a repeat of a live deal or an unkeepable vote term is now refused (fewer land)
          const out = g.makeDeal({ with: people[rng.int(people.length)] as never, kind: ["safety", "vote", "final-two"][rng.int(3)] as never, terms: `day ${d} deal ${k}` });
          if (out && !("refused" in out)) made++;
        }
      }
      view = step(g, view);
      maxOpen = Math.max(maxOpen, lines(g).filter((e) => e.status === "open").length);
      if (guard % 6 === 0) {
        const cur = JSON.parse(JSON.stringify(g.snapshot())) as SessionSnapshot;
        expect(sessionCoreSupersetViolation(cur, prev), `step ${guard}`).toBeNull();
        prev = cur;
      }
    }
    expect(made).toBeGreaterThan(20);
    expect(maxOpen).toBeLessThan(OPEN_LEDGER_MAX_ENTRIES);
    const ids = lines(g).map((e) => e.dealId).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length); // never two lines for one deal
    expect(lines(g).length).toBeLessThanOrEqual(made);
  });
});
