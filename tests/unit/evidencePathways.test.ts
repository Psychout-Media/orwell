import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { recordClaim, type BeliefStore } from "../../src/engine/beliefStore";
import { CONVICTION, testRef } from "../../src/engine/beliefConviction";

/**
 * ORW-585 (Fable T2): the overnight evidence never reads the hidden truth. A doubted "they voted against me" belief must NOT drift toward the sealed ballot:
 * with nothing new heard it fades whatever the ballot says, and a second source moves it whatever the ballot says. Roles only. TEST-ONLY seams: the live
 * season (beliefs, agendas, the ballot record, the day), the adapter's overnight step.
 */
type Live = { playedGame?: boolean; week: number; dayNumber?: number; beliefs?: BeliefStore; agendas?: Record<string, { goals: unknown[] }>; voteRecord?: unknown[] };
type Seam = { live: Live; weighEvidenceOvernight(): void; agendaRecheck(t: string, only: string[]): void };
function setup(votedAgainst: boolean, secondSource: boolean) {
  const sb = new GameSessionRegistry().sandboxFor(`evidence-${Math.random()}`);
  sb.session.setNpcBeliefsEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed: 12 });
  const s = sb.session as unknown as Seam;
  s.live.playedGame = true;
  const [holder, voter, teller, other, evictee] = sb.session.livingIds().filter((id) => id !== PLAYER) as [string, string, string, string, string];
  // the SEALED ballot: whether `voter` really voted to evict the holder
  s.live.voteRecord = [{ week: s.live.week, evictee, voteOf: { [voter]: votedAgainst ? holder : evictee } }];
  const store = (s.live.beliefs ??= {});
  recordClaim(store, { id: "doubt", holder, kind: "voted-against-me", subject: voter, value: true, origin: "told", source: teller, confidence: 0.45, week: s.live.week });
  if (secondSource) recordClaim(store, { id: "doubt-2", holder, kind: "voted-against-me", subject: voter, value: true, origin: "told", source: other, confidence: 0.4, week: s.live.week });
  s.agendaRecheck("week-start", [holder]);
  return { s, holder };
}
const conviction = (s: Seam, holder: string) => (s.live.beliefs?.[holder] ?? []).find((c) => c.id === "doubt")!;
const night = (s: Seam) => { s.live.dayNumber = (s.live.dayNumber ?? 1) + 1; s.weighEvidenceOvernight(); };

describe("ORW-585: overnight evidence comes from pathways, never the sealed ballot", () => {
  for (const votedAgainst of [true, false]) {
    it(`with nothing new heard, the doubt fades (the ballot says ${votedAgainst ? "it is true" : "it is false"})`, () => {
      const { s, holder } = setup(votedAgainst, false);
      const tested = (s.live.agendas?.[holder]?.goals ?? []).some((g) => (g as { test?: { ref?: string } }).test?.ref === testRef({ id: "doubt" }));
      expect(tested || !CONVICTION.askAround, "the doubt is not under test").toBe(true);
      const before = conviction(s, holder).confidence;
      night(s);
      expect(conviction(s, holder).confidence).toBeCloseTo(before - CONVICTION.fade, 12);
    });
    it(`a second source makes it grow (the ballot says ${votedAgainst ? "it is true" : "it is false"})`, () => {
      const { s, holder } = setup(votedAgainst, true);
      const before = conviction(s, holder).confidence;
      night(s);
      expect(conviction(s, holder).confidence).toBeCloseTo(before + CONVICTION.step, 12);
    });
  }
});
