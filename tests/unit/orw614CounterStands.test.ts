import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";
import { counterStandsChance, offerStandsAfterRefusedCounter } from "../../src/engine/dealCounterStands";
import { COUNTER_STANDS } from "../../src/engine/npcDealConstants";

/** ORW-614 follow-up: a REFUSED counter - the houseguest's temperament decides whether the original offer still stands. Roles only. */
const grid = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1];
describe("offerStandsAfterRefusedCounter (pure)", () => {
  it("is monotone: a touchier houseguest is less likely to keep the offer, a steadier one more likely", () => {
    for (const st of grid) for (let i = 1; i < grid.length; i++) expect(counterStandsChance({ volatility: grid[i]!, steadiness: st })).toBeLessThanOrEqual(counterStandsChance({ volatility: grid[i - 1]!, steadiness: st }));
    for (const v of grid) for (let i = 1; i < grid.length; i++) expect(counterStandsChance({ volatility: v, steadiness: grid[i]! })).toBeGreaterThanOrEqual(counterStandsChance({ volatility: v, steadiness: grid[i - 1]! }));
  });
  it("is banded away from 0 and 1 and deterministic for one roll", () => {
    for (const v of grid) for (const s of grid) { const c = counterStandsChance({ volatility: v, steadiness: s }); expect(c).toBeGreaterThanOrEqual(COUNTER_STANDS.floor); expect(c).toBeLessThanOrEqual(COUNTER_STANDS.ceiling); }
    const t = { volatility: 0.4, steadiness: 0.6 };
    expect(offerStandsAfterRefusedCounter(t, 0.3)).toBe(offerStandsAfterRefusedCounter(t, 0.3));
  });
  it("a touchy unsteady fixture pulls and a calm steady one keeps, at the same roll; both outcomes occur across rolls", () => {
    expect(offerStandsAfterRefusedCounter({ volatility: 1, steadiness: 0 }, 0.5)).toBe(false);
    expect(offerStandsAfterRefusedCounter({ volatility: 0, steadiness: 1 }, 0.5)).toBe(true);
    const mid = { volatility: 0.5, steadiness: 0.5 };
    const outs = new Set([0.05, 0.95].map((r) => offerStandsAfterRefusedCounter(mid, r)));
    expect(outs.size).toBe(2);
  });
});

function resolveLegally(s: Pick<GameSession, "submitDecision">, p: NonNullable<AdvanceView["pending"]>): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
  else s.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
}
type Priv = { live: { week: number; dealOffer?: { id: string; counterRefused?: true }; evictionOrder: string[] }; house: { npcs: Array<{ id: string; soul: { volatility: number; emotionalState: number } }> }; gameSeed?: number };
function game(user: string, on: boolean, vol: number, steady: number) {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed: 7 });
  sb.session.setNpcDealOffersEnabled(true);
  (sb.session as unknown as { setDealCounterEnabled(on: boolean): void }).setDealCounterEnabled(on);
  sb.session.noteMessage({ messageId: "m1" });
  for (let i = 0; i < 6; i++) { const v = sb.session.advanceGame(); if (v.pending) resolveLegally(sb.session, v.pending); }
  const priv = sb.session as unknown as Priv;
  const hg = priv.house.npcs.find((n) => !priv.live.evictionOrder.includes(n.id))!;
  hg.soul.volatility = vol; hg.soul.emotionalState = steady;
  priv.live.dealOffer = { id: `offer:${priv.live.week}:${hg.id}`, from: hg.id, kind: "safety", terms: "an offer of safety", madeWeek: priv.live.week } as never;
  // The counter is refused: the houseguest's consent read is forced to a refusal so the rule under test always runs.
  sb.session.setNpcDealConsentEnabled(true);
  (sb.session as unknown as { dealConsentRefusal: () => unknown }).dealConsentRefusal = () => ({ refused: true, reason: "distrust" });
  return { sb, priv, from: hg.id, offer: sb.session.getGameState().openDealOffer! };
}
const counter = (g: ReturnType<typeof game>) => g.sb.session.makeDeal({ with: g.from, kind: "veto-save", terms: "my terms", countersOffer: g.offer.id });

describe("a refused counter: the offer's fate follows temperament", () => {
  it("touchy pulls, calm keeps (when the counter is refused); flag off ignores the counter id as before", () => {
    const touchy = game("cs-touchy", true, 1, 0); const calm = game("cs-calm", true, 0, 1); const off = game("cs-off", false, 0, 1);
    const rt = counter(touchy); const rc = counter(calm); const ro = counter(off);
    expect(rt && "refused" in rt && rc && "refused" in rc && ro && "refused" in ro).toBeTruthy();
    expect(touchy.sb.session.getGameState().openDealOffer).toBeUndefined();
    {
      const o = calm.sb.session.getGameState().openDealOffer;
      expect(o?.id).toBe(calm.offer.id);
      expect(o?.counterRefusedStillStands).toBe(true);
      expect(o?.howToVoice).toContain("still stands");
      // standing: can be countered again, and declined
      expect(calm.sb.session.makeDeal({ with: calm.from, kind: "veto-save", terms: "again", countersOffer: calm.offer.id })).not.toBeNull();
      // append-only record survives a save round trip
      const snap = JSON.parse(JSON.stringify(calm.sb.session.snapshot()));
      expect(snap.live?.dealOffer === undefined || snap.live.dealOffer.counterRefused === true).toBe(true);
    }
    expect(off.sb.session.getGameState().openDealOffer?.counterRefusedStillStands).toBeUndefined(); // flag off: countersOffer is ignored, as before
  });
  it("wall sentinel: no trait value reaches the open-offer view, and the positive control sees the trait", () => {
    const g = game("cs-wall", true, 0.8123, 0.2417);
    counter(g);
    const text = JSON.stringify(g.sb.session.getGameState());
    expect(text).not.toContain("0.8123"); expect(text).not.toContain("0.2417");
    expect(JSON.stringify((g.priv as unknown as Priv).house.npcs.map((n) => n.soul))).toContain("0.8123"); // the control: the engine does hold it
  });
});
