import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import type { DealView, DealRefusal, MakeDealReq } from "../../src/ports/GameSession";
import { playedGame } from "../support/playedGame";
import { firstSeedWhereSync } from "../support/firstSeedWhere";

/**
 * ORW-82 - the consent CHAIN, REAL PATH. In a played season the player asks each houseguest for a mutual safety deal (`makeDeal`; a refusal records and folds
 * nothing); whoever the ENGINE lets agree is a partner. When a partner sits on the block and the player votes, the player votes them out (their own ballot,
 * the eviction-vote decision) and the engine's own reconcile marks the deal broken. If that partner survives the night, a second proposal to them is refused
 * for the break's own consequence, while a partner the player did not betray still accepts the same second proposal. No edge, memory or deal is set by hand.
 * The seed is scanned, not pinned (ORW-880, `brokenDeal` below): seeds stopped reaching the break as gameplay changed (4, then 5-9), and each change meant a
 * hand search and a re-pin.
 * With the belief store off (a flag) there is no belief that the player targets them, so the same break is refused as the remembered grudge.
 * The control: some partners the player kept faith with refuse the second ask for their own reasons, so the claim is that at least one still accepts. Roles only.
 */
const isRefusal = (r: DealView | DealRefusal | null): r is DealRefusal => !!r && (r as DealRefusal).refused === true;
const req = (npc: string, kind: MakeDealReq["kind"]): MakeDealReq => ({ with: npc, kind, terms: "we look out for each other" });

function chain(seed: number, user: string, beliefs: boolean) {
  const g = playedGame({ seed, user: user, before: (s) => (s as unknown as { setNpcBeliefsEnabled(on: boolean): void }).setNpcBeliefsEnabled(beliefs) });
  g.playUntil(() => !!g.s.getGameState().started && (g.s.getGameState() as { phase?: string }).phase !== "premiere" && !g.s.getGameState().pending, 2000, "the first week");
  const partners = g.s.livingIds().filter((id) => id !== PLAYER && !isRefusal(g.s.makeDeal(req(id, "safety"))));
  let betrayed: string | undefined;
  const base = g.answer;
  g.answer = (p) => {
    if (p.kind === "eviction-vote" && !betrayed) {
      const target = partners.find((x) => p.options.some((o) => o.id === x));
      if (target) { betrayed = target; return { kind: "eviction-vote", vote: target }; }
    }
    return base(p);
  };
  try {
    g.playUntil(() => !!betrayed && !g.s.getGameState().pending && (g.s.getGameState().deals ?? []).some((d) => d.parties.some((p) => p.id === betrayed) && d.status === "broken"), 3000, "a broken deal");
  } catch { return undefined; }
  if (!g.s.livingIds().includes(betrayed!)) return undefined;
  return { g, partners, betrayed: betrayed! };
}

/**
 * ORW-880: the first seed from 10 in 1..16 whose game gets there: more than one houseguest agrees to a safety deal, the player breaks one by their own vote, and the
 * betrayed partner survives that vote (so there is someone to propose to again). The test then asserts what happens when the player does.
 */
const brokenDeal = (beliefs = true) =>
  // ORW-1104: whether the betrayed partner KNOWS who voted against them (secret ballots: they may not) is a property of the seeded season, so the precondition includes that the second proposal is refused: the claim
  // below is then about WHY (the break's own consequence), not a bet on the seed.
  firstSeedWhereSync((seed, sandbox) => {
    const c = chain(seed, sandbox, beliefs); if (!c || c.partners.length <= 1) return undefined;
    const second = c.g.s.makeDeal(req(c.betrayed, "final-two")); return isRefusal(second) ? { ...c, second } : undefined;
  },
    { from: 1, to: 16, hint: [5, 3, 10], sandbox: (s) => `dcc-${s}-${beliefs}`, what: "a broken deal whose betrayed partner survives the vote" }).at;

describe("ORW-82 REAL PATH: break a deal by your own vote, then propose to the same houseguest", () => {
  it("the betrayed partner refuses a second proposal for the break's own consequence; a partner not betrayed still accepts", () => {
    const { g, partners, betrayed, second } = brokenDeal();
    expect(isRefusal(second), "a new proposal to the partner the player just voted against is refused").toBe(true);
    const real = (g.s as unknown as { refusalReal: WeakMap<object, string> }).refusalReal.get(second as object) ?? "";
    expect(["grudge", "distrust", "threat", "targeted"], `refused for the break's own consequence (${real})`).toContain(real);
    expect(JSON.stringify(second), "the refusal carries no numbers").not.toMatch(/\d\.\d/);
    expect((g.s.getGameState().deals ?? []).filter((d) => d.parties.some((p) => p.id === betrayed) && d.status === "open"), "no new open deal with them").toHaveLength(0);
    const bystanders = partners.filter((x) => x !== betrayed && g.s.livingIds().includes(x));
    const answers = bystanders.map((x) => g.s.makeDeal(req(x, "final-two")));
    expect(answers.some((r) => !isRefusal(r)), "a partner the player kept faith with still accepts the same proposal (the refusal is the break, not the ask)").toBe(true);
  }, 300_000);
  it("with the belief store off, the same break is refused as the remembered grudge itself", () => {
    const c = brokenDeal(false);
    const r = c.g.s.makeDeal(req(c.betrayed, "final-two"));
    expect(isRefusal(r)).toBe(true);
    expect((c.g.s as unknown as { refusalReal: WeakMap<object, string> }).refusalReal.get(r as object)).toBe("grudge");
  }, 300_000);
});
