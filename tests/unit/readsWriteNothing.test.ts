import { describe, it, expect } from "vitest";
import { playMixGame } from "../support/houseMixDriver";

/**
 * ORW-684 item 3: a READ writes nothing. A played game (several weeks in) is read through every Vault-free view the session serves, many times and in
 * different orders; the saved snapshot stays byte-identical and each view returns the same answer every time.
 * One read is NOT in this list on purpose, and is pinned on their own below: `socialInitiatives` records who the player was shown (so the next stretch
 * rotates them: a by-design mark, a decision for the owner, not a bug fixed here).
 * Roles only.
 */
type Reader = (s: Record<string, (...a: unknown[]) => unknown>, id: string, other: string) => unknown;
const VIEWS: Record<string, Reader> = {
  getGameState: (s) => s.getGameState!(),
  gameStatus: (s) => s.gameStatus!(),
  seasonRecap: (s) => s.seasonRecap!(),
  dailyRecap: (s) => s.dailyRecap!(),
  seasonRetrospective: (s) => s.seasonRetrospective!(),
  hallOfFame: (s) => s.hallOfFame!(),
  whereabouts: (s) => s.whereabouts!(),
  finaleView: (s) => s.finaleView!(),
  playerTagline: (s) => s.playerTagline!(),
  premiereIntros: (s) => s.premiereIntros!(),
  notorietySummary: (s) => s.notorietySummary!(),
  conspicuousReads: (s) => s.conspicuousReads!(),
  statusRead: (s) => s.statusRead!(),
  npcVoice: (s, id) => s.npcVoice!(id),
  getPortraitPrompt: (s, id) => s.getPortraitPrompt!(id),
  reputationOf: (s, id, other) => s.reputationOf!(id, other),
  credibilityOf: (s, id, other) => s.credibilityOf!(id, other),
};

describe("ORW-684: reads never write", () => {
  it("every view, read repeatedly in forward and reverse order, leaves the snapshot byte-identical and answers the same", async () => {
    let checked = 0;
    await playMixGame(3, 220, {
      advanceEvery: 6, stopAtWeek: 3,
      inspect: (sess) => {
        const s = sess as Record<string, (...a: unknown[]) => unknown> & { house?: { npcs: Array<{ id: string }> } };
        const [a, b] = (s.house?.npcs ?? []).map((n) => n.id);
        expect(a).toBeDefined();
        const snap = (): string => JSON.stringify((s.snapshot as () => unknown)());
        const names = Object.keys(VIEWS);
        const read = (n: string): string => { try { return JSON.stringify(VIEWS[n]!(s, a!, b!)) ?? "undefined"; } catch (e) { return `threw:${String(e).slice(0, 40)}`; } };
        const before = snap();
        const first: Record<string, string> = {};
        for (const n of names) first[n] = read(n);
        expect(snap(), "forward pass changed the save").toBe(before);
        for (const n of [...names].reverse()) expect(read(n), `${n}: answer moved on re-read`).toBe(first[n]);
        for (const n of names) for (let i = 0; i < 3; i++) expect(read(n), `${n}: answer moved on repeat`).toBe(first[n]);
        expect(snap(), "repeated reads changed the save").toBe(before);
        checked = names.length;
      },
    });
    expect(checked).toBeGreaterThan(10);
  }, 240000);

  it("socialInitiatives is the one known read that marks the surface (who was shown): it changes only the approach record, and re-reading is stable", async () => {
    await playMixGame(3, 120, {
      advanceEvery: 6, stopAtWeek: 2,
      inspect: (sess) => {
        const s = sess as { socialInitiatives: () => unknown; snapshot: () => Record<string, unknown> };
        const strip = (o: Record<string, unknown>): string => { const c = { ...o }; delete c.approachShown; delete c.approachCooldown; return JSON.stringify(c); };
        const before = strip(s.snapshot());
        const r1 = JSON.stringify(s.socialInitiatives());
        const mid = JSON.stringify(s.snapshot());
        expect(strip(JSON.parse(mid))).toBe(before);
        expect(JSON.stringify(s.socialInitiatives())).toBe(r1);
        expect(JSON.stringify(s.snapshot())).toBe(mid);
      },
    });
  }, 240000);
});
