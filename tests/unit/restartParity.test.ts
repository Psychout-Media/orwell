import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { buildSandbox } from "../support/sandbox";
import { PLAYER } from "../../src/domain/ids";
import { HOUSE_ROOMS } from "../../src/domain/house";

/**
 * ORW-276 - restart parity (Showrunner memory part E). In a played game with a day-ledger entry (authored text), room canon, a
 * crossed week boundary and an open deal, a NEW GameSessionAdapter restored from the snapshot gives byte-identical Show Brief text,
 * day ledger, chapter cursors and canon; and its next turnIn does not re-emit a chapter for an already-surfaced week. Roles only.
 */
afterEach(() => { delete process.env.ORWELL_TIME_OF_DAY; });

type Priv = { live: { timeOfDay: string; week: number; evictionOrder: string[]; chapterWeek?: number; chapterEvictCursor?: number }; deals: { make: (...a: unknown[]) => unknown }; canonLedger: unknown };

function wire(g: GameSessionAdapter, sb: ReturnType<typeof buildSandbox>): void {
  g.setPlayerKnowledgeReader(() => sb.engine.knowledge.knownTo(PLAYER).map((f) => ({ id: f.id, content: f.content, subject: f.subject, factId: f.factId, pathway: f.pathway })));
  g.setRecordProviders({ events: () => sb.engine.events.queryAll(), hidden: () => sb.engine.vault.readHidden() });
}
const night = (g: GameSessionAdapter) => { (g as unknown as Priv).live.timeOfDay = "night"; return g.turnIn(); };

function build(seed: number) {
  process.env.ORWELL_TIME_OF_DAY = "1";
  const sb = buildSandbox(seed);
  const g = new GameSessionAdapter();
  wire(g, sb);
  g.createCharacter({ playerName: "The Player", seed });
  g.noteMessage({ messageId: `m${seed}` });
  const p = g as unknown as Priv;
  // a crossed week boundary: an eviction completed, then the night that closes the week
  const out = g.livingIds().find((id) => id !== PLAYER)!;
  p.live.week = 2;
  p.live.evictionOrder.push(out);
  const first = night(g);
  expect(first.weekChapter).toBeDefined();
  g.recordDaySummary({ day: 1, text: "A quiet night in the house." });
  const roomId = HOUSE_ROOMS.find((r) => r !== "diary-room" && r === g.whereabouts()!.room) ?? g.whereabouts()!.room;
  if (roomId !== "diary-room") expect(g.recordRoomCanon({ roomId, feature: "a scuffed mug sits on the ledge" }).accepted).toBe(true);
  const other = g.livingIds().find((id) => id !== PLAYER && id !== out)!;
  p.deals.make([PLAYER, other], "safety", "terms", undefined, 1, { vague: true });
  return { g, sb, p };
}

describe("restart parity", () => {
  it("the brief, ledger, canon and chapter cursors are identical after snapshot/restore; no chapter is re-emitted", () => {
    const { g, sb, p } = build(61);
    const briefBefore = g.getMomentPrompt({ brief: {} }).showBrief!;
    const ledgerBefore = g.dayLedger();
    expect(ledgerBefore[0]!.text).toBe("A quiet night in the house.");
    expect(briefBefore.text).toContain("OPEN THREADS");
    if (g.whereabouts()!.room !== "diary-room") expect(briefBefore.text).toContain("a scuffed mug sits on the ledge");
    const cursorsBefore = { w: p.live.chapterWeek, c: p.live.chapterEvictCursor };
    expect(cursorsBefore.w).toBe(2);

    const snap = JSON.parse(JSON.stringify(g.snapshot()));
    const fresh = new GameSessionAdapter();
    wire(fresh, sb);
    fresh.restore(snap);
    const fp = fresh as unknown as Priv;

    const briefAfter = fresh.getMomentPrompt({ brief: {} }).showBrief!;
    expect(briefAfter.text).toBe(briefBefore.text);
    expect(briefAfter.sections).toEqual(briefBefore.sections);
    expect(fresh.dayLedger()).toEqual(ledgerBefore);
    expect({ w: fp.live.chapterWeek, c: fp.live.chapterEvictCursor }).toEqual(cursorsBefore);
    expect(JSON.stringify(fp.canonLedger)).toBe(JSON.stringify(p.canonLedger));
    expect(JSON.stringify(fresh.snapshot())).toBe(JSON.stringify(g.snapshot()));

    // the next night on the restored session re-emits no chapter for the already-surfaced week (same as the live one)
    expect(night(fresh).weekChapter).toBeUndefined();
    expect(night(g).weekChapter).toBeUndefined();
    expect(fresh.dayLedger().map((d) => d.day)).toEqual(g.dayLedger().map((d) => d.day));
  });
});
