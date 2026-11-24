import { describe, it, expect } from "vitest";
import { heldCandidates } from "../../src/engine/heldFacts";
import { SEEK } from "../../src/engine/copresenceSpread";
import { PLAYER } from "../../src/domain/ids";
import { type Stop, firstStop, firstStops, wfScan } from "./playedSeason";

/**
 * B35 (seeking, design B10 S4; flag ORWELL_GOSSIP_COPRESENCE) - a houseguest holding a high-motive fact they have not yet decided to tell someone leans their MOVEMENT toward that
 * listener, through the same pull channel as the A10 want; a telling already decided no longer pulls; the player is never a seek target. ORW-810: in a PLAYED season - the facts the
 * houseguests hold, their bonds and the told ledger are all what play made them (before, the fact and the bond were planted by hand). The stop: a quiet moment of a played week
 * (the HOH is crowned, no decision is open, no event is due) where the state each test needs exists; the test then only flips the layer's switch and reads the movement intent.
 * The pure function and the movement-share check stay in tests/unit/copresenceSeeking.test.ts. Roles only.
 */
type Pull = { target: string; weight: number; avoid: boolean };
const intentOf = (s: Stop, id: string): Pull[] | null => s.sess.movementIntentFor(id) as Pull[] | null;
const w = (arr: Pull[] | null, t: string): number => arr?.find((p) => p.target === t)?.weight ?? 0;
const offOn = (s: Stop, holder: string): { off: Pull[] | null; on: Pull[] | null } => {
  s.sess.setCopresenceEnabled(false); // not as shipped: the off arm of the on/off comparison, switched back on below
  const off = intentOf(s, holder);
  s.sess.setCopresenceEnabled(true);
  return { off, on: intentOf(s, holder) };
};
const quiet = (s: Stop): boolean => {
  const st = s.sess.getGameState() as { daySchedule?: { due: boolean }; pending?: unknown; started?: boolean };
  return !!st.started && !!st.daySchedule && !st.daySchedule.due && !st.pending && s.sess.live?.hoh !== undefined;
};
/** Houseguests in the house and up (who movement is decided for, and who a holder may seek). */
const active = (s: Stop): string[] => (s.sess.presenceActive() as string[]).filter((id) => id !== PLAYER);
/** Pairs where the holder has something the listener lacks that the holder has NOT yet decided about, with a motive above the seeking floor: the session's own seeker names the listener. */
const seeking = (s: Stop): Array<{ holder: string; listener: string }> =>
  active(s).flatMap((h) => (s.sess.heldSeeker(h, active(s).filter((o) => o !== h)) as Array<{ listener: string; motive: number }>)
    .filter((t) => t.motive >= SEEK.minMotive).map((t) => ({ holder: h, listener: t.listener })));
/** Pairs where the holder has something the listener lacks, but has already decided about every one of those tellings (the told ledger, written by play). */
const decided = (s: Stop): Array<{ holder: string; listener: string }> => {
  const ledger = s.sess.copresenceToldLedger();
  const out: Array<{ holder: string; listener: string }> = [];
  for (const h of active(s)) for (const l of active(s)) {
    if (h === l) continue;
    const cands = heldCandidates(s.engine.knowledge.knownTo(h), s.engine.knowledge.knownTo(l));
    if (cands.length > 0 && cands.every((c) => ledger.decided(h, c.factId, l))) out.push({ holder: h, listener: l });
  }
  return out;
};

describe("seeking in a played season", () => {
  it("layer OFF: the holder's intent has no seeking term; ON: the pull toward the listener rises and no pull is lowered (two seeds)", async () => {
    for (const at of await firstStops(2, (s) => quiet(s) && seeking(s).length > 0, wfScan([3, 11], "a quiet moment with a seeking holder"))) {
      const seed = at.seed;
      let checked = 0;
      for (const { holder, listener } of seeking(at)) {
        const { off, on } = offOn(at, holder);
        expect(w(on, listener), `seed ${seed}: the pull toward the listener`).toBeGreaterThan(w(off, listener));
        for (const p of off ?? []) expect(w(on, p.target), "a held fact never lowers a pull").toBeGreaterThanOrEqual(p.weight - 1e-12);
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    }
  }, 120_000);

  it("a telling the holder has already decided about no longer pulls: the layer adds nothing toward that listener", async () => {
    const at = await firstStop((s) => quiet(s) && decided(s).length > 0 && seeking(s).length > 0, wfScan(3));
    for (const { holder, listener } of decided(at)) {
      expect(seeking(at).some((p) => p.holder === holder && p.listener === listener), "the seeker no longer names a decided listener").toBe(false);
      const { off, on } = offOn(at, holder);
      expect(w(on, listener)).toBe(w(off, listener));
    }
  }, 120_000);

  it("the player is never a seek target (off-screen spreads exclude them)", async () => {
    const at = await firstStop((s) => quiet(s) && seeking(s).length > 0, wfScan(3));
    for (const holder of new Set(seeking(at).map((p) => p.holder))) {
      const { off, on } = offOn(at, holder);
      expect(w(on, PLAYER)).toBe(w(off, PLAYER));
    }
  }, 120_000);
});
