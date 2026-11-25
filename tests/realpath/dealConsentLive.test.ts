import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import type { DealView, DealRefusal, MakeDealReq } from "../../src/ports/GameSession";
import { playedGame } from "../support/playedGame";
import { firstSeedWhereSync } from "../support/firstSeedWhere";

/**
 * Engine-side NPC deal consent (`ORWELL_NPC_DEAL_CONSENT`, default ON), REAL PATH. A season is played to its second week through the player's levers only, so each
 * houseguest's read of the player is the one the house formed. The player then asks every houseguest for a safety deal. The ENGINE decides each answer from that
 * houseguest's own read: some agree, some refuse; the warmer the read, the likelier yes. A refusal records no deal and folds nothing (the whole snapshot is unchanged but for
 * the played game's own record of the decision and its stated reason, kept for the post-crown reveal; a
 * replay returns the same refusal); it reaches the tool caller as `{ refused, reason }` with only the stated reason (ORW-608), never the real one. An expensive ASK
 * (the houseguest throws a comp) of someone who would agree to a safety deal is refused for its cost while the player's own OFFER to throw is not. With the flag off,
 * the same seed, the same moment and a houseguest who refused now agrees.
 * The seed is scanned from 5 (ORW-880): each test takes the first seed whose week-2 house holds what it needs (both answers; a houseguest who refuses an ask for its
 * cost; a refuser), then asserts on it. Roles only.
 */
const isRefusal = (r: DealView | DealRefusal | null): r is DealRefusal => !!r && (r as DealRefusal).refused === true;
const req = (npc: string, kind: MakeDealReq["kind"] = "safety"): MakeDealReq => ({ with: npc, kind, terms: "we look out for each other" });
const realOf = (s: unknown, r: unknown): string | undefined => (s as { refusalReal: WeakMap<object, string> }).refusalReal.get(r as object);
// ORW-305 / ORW-656: the decision-why and stated-reason records are metadata about a decision (a refusal is one; a played game keeps it for the post-crown reveal), not game state.
const snapNoWhy = (s: { snapshot(): unknown }): string => JSON.stringify(s.snapshot(), (k, v) => (k === "decisionWhy" || k === "statedReasons" ? undefined : v));

function weekTwo(seed: number, user: string, consent = true) {
  const g = playedGame({ seed, user: user, before: (s) => (s as unknown as { setNpcDealConsentEnabled(on: boolean): void }).setNpcDealConsentEnabled(consent) });
  g.playUntil(() => (g.s.getGameState() as { week?: number }).week! >= 2 && !g.s.getGameState().pending, 5000, "week 2");
  return g;
}
/** The first seed from 5 whose week-2 house satisfies `has` (read with the asks the test itself makes; each asks a fresh game). */
function houseWhere<T>(prefix: string, has: (g: ReturnType<typeof weekTwo>) => T | undefined, what: string, consent = true): { g: ReturnType<typeof weekTwo>; seed: number; got: T } {
  const f = firstSeedWhereSync((seed, sandbox) => { const g = weekTwo(seed, sandbox, consent); const got = has(g); return got === undefined ? undefined : { g, got }; },
    { from: 1, to: 12, hint: 5, sandbox: (s) => `${prefix}-${s}`, what });
  return { g: f.at.g, seed: f.seed, got: f.at.got };
}
type Refused = { npc: string; real: string; r: DealRefusal; before: string; after: string; dealsBefore: number; dealsAfter: number; replay: unknown; afterReplay: string };
/** The player asks every houseguest for a safety deal, recording what each ask did (the test asserts on the record). */
function askEveryone(g: ReturnType<typeof weekTwo>): { yes: string[]; kinds: string[]; no: Refused[] } {
  const yes: string[] = [], kinds: string[] = [], no: Refused[] = [];
  for (const npc of g.s.livingIds().filter((id) => id !== PLAYER)) {
    const before = snapNoWhy(g.s);
    const dealsBefore = g.s.getGameState().deals?.length ?? 0;
    const k = { ...req(npc), idempotencyKey: `ask-${npc}` };
    const r = g.s.makeDeal(k);
    if (!isRefusal(r)) { yes.push(npc); kinds.push((r as DealView).kind); continue; }
    if (r.illegal) continue;
    const after = snapNoWhy(g.s), dealsAfter = g.s.getGameState().deals?.length ?? 0;
    const replay = g.s.makeDeal(k);
    no.push({ npc, real: realOf(g.s, r) ?? "", r, before, after, dealsBefore, dealsAfter, replay, afterReplay: snapNoWhy(g.s) });
  }
  return { yes, kinds, no };
}
const warmth = (g: ReturnType<typeof weekTwo>, npc: string): number => { const e = g.sb.engine.relationships.edge(npc, PLAYER); return e.trust + e.affinity - e.threat; };

describe("NPC deal consent REAL PATH: the engine decides from each houseguest's own read of the player", () => {
  it("some agree and some refuse; refusals fold nothing, replay the same, and cross the tool boundary as a stated reason only", async () => {
    // the precondition: a week-2 house where some agree and some refuse
    const { g, got: { yes, kinds, no } } = houseWhere("dcl-on", (g) => { const a = askEveryone(g); return a.yes.length > 0 && a.no.length > 0 ? a : undefined; }, "a week-2 house where some agree and some refuse");
    for (const k of kinds) expect(k).toBe("safety");
    for (const { r, before, after, dealsBefore, dealsAfter, replay, afterReplay } of no) {
      expect(after, "a refusal folds nothing").toBe(before);
      expect(dealsAfter).toBe(dealsBefore);
      expect(replay, "an at-most-once replay returns the same refusal").toEqual(r);
      expect(afterReplay).toBe(before);
      expect(Object.keys(r).sort()).toEqual(["reason", "refused"]);
      expect(["didnt-trust-you", "nothing-personal", "house-wants-it", "biggest-threat", "came-after-me"]).toContain(r.reason);
      expect(JSON.stringify(r)).not.toMatch(/\d\.\d/);
    }
    for (const n of no) expect(["distrust", "threat", "grudge", "targeted", "opposed", "cost"]).toContain(n.real);
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(mean(yes.map((n) => warmth(g, n))), "the ones who agreed read the player warmer than the ones who refused").toBeGreaterThan(mean(no.map((n) => warmth(g, n.npc))));
    // the tool boundary: one more refusal, asked the way the front end asks
    const refuser = no[0]!.npc;
    const viaTool = (await g.sb.mcp.player.callTool("makeDeal", { with: refuser, kind: "safety", terms: "t" })) as DealRefusal;
    expect(viaTool.refused).toBe(true);
    expect(viaTool.reason).not.toMatch(/^(distrust|threat|targeted|grudge|opposed|cost)$/);
    expect(g.s.makeDeal(req("nobody-here"))).toBeNull();
    expect(g.s.makeDeal(req(PLAYER))).toBeNull();
  }, 300_000);

  it("an expensive ask (the houseguest throws the comp) is refused for its cost; the player's own offer to throw is not", () => {
    // the precondition: someone in the week-2 house turns the ask down for its cost alone
    const { g, got: costly } = houseWhere("dcl-cost", (g) => {
      (g.s as unknown as { setDealDepthEnabled(on: boolean): void }).setDealDepthEnabled(true);
      const costly = g.s.livingIds().filter((id) => id !== PLAYER).filter((npc) => { const r = g.s.makeDeal({ ...req(npc, "comp-throw"), direction: "ask" }); return isRefusal(r) && realOf(g.s, r) === "cost"; });
      return costly.length > 0 ? costly : undefined;
    }, "a houseguest who refuses an expensive ask for its cost");
    const taken = costly.find((npc) => !isRefusal(g.s.makeDeal(req(npc, "comp-throw"))));
    expect(taken, "one of them takes the player's own offer to throw, which costs them nothing").toBeDefined();
  }, 300_000);

  it("flag off: at the same seed and moment, a houseguest who refused now agrees", () => {
    // the precondition: a houseguest who refuses with the flag on
    const { seed, got: refuser } = houseWhere("dcl-a", (on) => on.s.livingIds().filter((id) => id !== PLAYER).find((npc) => { const r = on.s.makeDeal(req(npc)); return isRefusal(r) && !r.illegal; }), "a houseguest who refuses");
    // not as shipped: the control arm, the same seed with consent off, proves consent is what refused
    const off = weekTwo(seed, `dcl-b-${seed}`, false);
    const r = off.s.makeDeal(req(refuser));
    expect(isRefusal(r)).toBe(false);
    expect((r as DealView).kind).toBe("safety");
  }, 300_000);
});
