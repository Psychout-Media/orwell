import { describe, it, expect, afterEach } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import type { DailyRecapView } from "../../src/ports/GameSession";
import { playUntil, type Stop } from "./playedSeason";

/**
 * ORW-760 (G4-9, ORW-707 came back): the bedtime recap may only cite a scene the player was in (their own witness set) or was told. The check the card asks for, through real played days: for every recap a played season makes,
 * each highlight and each "your day" line is the text of a recorded event that is not hidden AND has the player in its witness set; nothing the houseguests did without the player rides the recap.
 * The season is played by the scripted talking player (ORW-810 harness). Roles only.
 */
afterEach(() => { delete process.env.ORWELL_TIME_OF_DAY; });

describe("every recap line is a scene the player was in (played)", () => {
  for (const seed of [3, 1]) {
    it(`seed ${seed}: highlights and your-day lines each come from an event the player witnessed`, async () => {
      const recaps: Array<{ recap: DailyRecapView; offenders: string[] }> = [];
      await playUntil(seed, async (s: Stop) => {
        const r = s.sess.dailyRecap() as DailyRecapView | null;
        if (r && r.day !== recaps[recaps.length - 1]?.recap.day) {
          const events = s.engine.events.queryAll();
          const seen = (text: string): boolean => events.some((e) => !e.hidden && e.witnessSet.includes(PLAYER) && (String(e.content) === text || String(e.content).trim().slice(0, 200) === text));
          // ORW-1165: a digest line is built from recorded events (aggregated talks, the toast), so it is checked by what it is built from: every source id is a recorded event the player witnessed, none hidden, and
          // a line with no source is the player's own bed. A highlight with no digest entry is still checked by its text, as before.
          const byId = new Map(events.map((e) => [e.id, e]));
          const digestOk = (d: { eventCursor: string[] }): boolean => d.eventCursor.every((id) => { const e = byId.get(id); return !!e && !e.hidden && e.witnessSet.includes(PLAYER); });
          const digestTexts = new Set((r.digest ?? []).map((d) => d.text));
          const lines = [...r.highlights.filter((l) => !digestTexts.has(l)), ...(r.yourDay ?? [])];
          recaps.push({ recap: r, offenders: [...lines.filter((l) => !seen(l)), ...(r.digest ?? []).filter((d) => !digestOk(d)).map((d) => d.text)] });
        }
        return recaps.length >= 4;
      }, { user: `wf-${seed}` });
      expect(recaps.length, "the season made recaps").toBeGreaterThan(0);
      for (const { recap, offenders } of recaps) expect(offenders, `day ${recap.day}: recap lines no witnessed event carries`).toEqual([]);
    }, 400_000);
  }
});
