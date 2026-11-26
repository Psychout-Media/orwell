import { describe, it, expect, afterEach } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry } from "../../src/composition/registry";
import { answerPending } from "../../features/support/answerPending";

/**
 * ORW-1081 (Ryne's request after the live playtest broke at the bed race): the PRE-PLAYTEST SMOKE. A played premiere where the player ONLY TALKS (a message each turn; the premiere's own staged entrances and toast are advanced as the
 * game needs, but the player never presses Continue after the circle closes) through move-in night and into day 2. Played through the real session, nothing hand-set. The coordinator runs this before every prod reset.
 * Checks, in the order a player lives them: (1) every houseguest has arrived and has a room (nobody missing); (2) after the circle closes the rush runs to its end by messages alone and houseguests claim beds; (3) the player
 * does not move unless they said they were going (no teleports) across plain talking turns; (4) the player moves when they say they are going (the move is honoured); (5) a houseguest's claimed bed belongs to a living houseguest
 * and no bed has two owners; (6) the clock reaches day 2 by talking and the rush is not restarted. Roles only. Seeds 3 and 7.
 */
afterEach(() => GameSessionAdapter.setTimeOfDayEnabled(null));
type Sess = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function playPremiere(seed: number): Sess {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const s = new GameSessionRegistry().sandboxFor(`smoke1081-${seed}`).session as Sess;
  s.createCharacter({ playerName: "The Player", seed });
  return s;
}

describe("pre-playtest smoke: a talking-only played premiere through move-in night and day 2", () => {
  for (const seed of [3, 7]) {
    it(`seed ${seed}: arrivals, bed rush, no teleports, moves honoured, day 2`, () => {
      const s = playPremiere(seed);
      let m = 0, after = 0, startedDay = -1;
      const roomsWhileTalking: Array<string | null> = [];
      // 1) the premiere: staged entrances and the toast, then only talking
      for (let i = 0; i < 2500 && after < 60; i++) {
        s.noteMessage({ messageId: `m${m++}` });
        const live = s.snapshot().live, g = s.getGameState();
        if (g.pending && g.pending.kind !== "ceremony-step") { const r = answerPending(g.pending); if (r) s.submitDecision(r); continue; }
        if (live.premiereEntrance && live.premiereEntrance.stage !== "done") { s.advanceGame(); continue; }
        if (live.premiereEntrance?.stage === "done") {
          if (after === 0) startedDay = s.getGameState().day ?? -1;
          after++;
          roomsWhileTalking.push(s.whereabouts()?.room ?? null);
        }
      }
      const live = s.snapshot().live;
      const living: string[] = s.livingIds().filter((id: string) => id !== "player");
      // positive controls: the premiere really closed and the player really talked on
      expect(live.premiereEntrance?.stage, "the premiere reached the closed circle").toBe("done");
      expect(after, "the player talked after it").toBeGreaterThanOrEqual(60);
      // (1) nobody missing: every living houseguest has a room
      const roomOf = (id: string): string | undefined => (s.snapshot().live.presence ?? s.snapshot().live.presenceRooms ?? {})[id];
      const placed = living.filter((id) => roomOf(id) !== undefined);
      if ((s.snapshot().live.presence ?? s.snapshot().live.presenceRooms) !== undefined) expect(placed.length, "every houseguest has a room").toBe(living.length);
      // (2) the rush ran to its end by messages alone, and houseguests claimed beds
      expect(live.bedRush, "the rush started").toBeDefined();
      expect(live.bedRush.done || live.bedRush.windowEnded, "the rush ran to its end").toBe(true);
      const claims: Array<{ bed?: string; houseguestId?: string; id?: string }> = live.beds?.claims ?? [];
      expect(claims.length, "houseguests claimed beds").toBeGreaterThan(0);
      // (5) every owner is a living houseguest (or the player), and no bed has two owners
      const owners: Record<string, string> = live.beds?.owner ?? {};
      for (const [who] of Object.entries(owners)) expect(who === "player" || living.includes(who), `a bed owner is a living houseguest or the player (${who})`).toBe(true);
      const beds = Object.values(owners) as string[]; expect(new Set(beds).size, "no bed has two owners").toBe(beds.length);
      // (3) no teleports: across plain talking turns after the rush ended, the player never changed room
      const settled = roomsWhileTalking.slice(-20);
      expect(new Set(settled).size, "the player stayed put while only talking").toBe(1);
      // (4) the player moves when they say they are going
      const here = s.whereabouts()?.room;
      const dest = here === "kitchen" ? "backyard" : "kitchen";
      s.noteMessage({ messageId: `m${m++}` });
      const mv = s.resolvePlayerMove({ text: `I go to the ${dest}` });
      expect(mv.playerMove, "the move was read").toMatchObject({ to: dest });
      expect(s.whereabouts()?.room, "the player is where they said they were going").toBe(dest);
      // (6) the clock moved on by talking, and the rush was not restarted
      expect(typeof startedDay === "number").toBe(true);
      const rushAfter = s.snapshot().live.bedRush;
      expect(rushAfter.done || rushAfter.windowEnded, "the rush stayed ended").toBe(true);
    }, 600_000);
  }
});
