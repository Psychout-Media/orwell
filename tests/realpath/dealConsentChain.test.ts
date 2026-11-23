import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import type { DealView, DealRefusal, MakeDealReq } from "../../src/ports/GameSession";
import { playedGame } from "../support/playedGame";

/**
 * ORW-82 - the consent CHAIN, REAL PATH. In a played season the player asks each houseguest for a mutual safety deal (`makeDeal`; a refusal records and folds
 * nothing); whoever the ENGINE lets agree is a partner. When a partner sits on the block and the player votes, the player votes them out (their own ballot,
 * the eviction-vote decision) and the engine's own reconcile marks the deal broken. If that partner survives the night, a second proposal to them is refused
 * for the break's own consequence, while a partner the player did not betray still accepts the same second proposal. No edge, memory or deal is set by hand.
 * Seed 4: the first seed from 1 up where the player's betrayed partner survives the vote (in seeds 1-3 no betrayed partner was left in the house to ask again; searched once, then pinned).
 * With the belief store off (a flag) there is no belief that the player targets them, so the same break is refused as the remembered grudge.
 * The control: some partners the player kept faith with refuse the second ask for their own reasons, so the claim is that at least one still accepts. Roles only.
 */
const isRefusal = (r: DealView | DealRefusal | null): r is DealRefusal => !!r && (r as DealRefusal).refused === true;
const SEED = 4;
const req = (npc: string, kind: MakeDealReq["kind"]): MakeDealReq => ({ with: npc, kind, terms: "we look out for each other" });

function chain(seed: number, beliefs = true) {
  const g = playedGame({ seed, user: `dcc-${seed}-${beliefs}`, before: (s) => (s as unknown as { setNpcBeliefsEnabled(on: boolean): void }).setNpcBeliefsEnabled(beliefs) });
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

describe("ORW-82 REAL PATH: break a deal by your own vote, then propose to the same houseguest", () => {
  it("the betrayed partner refuses a second proposal for the break's own consequence; a partner not betrayed still accepts", () => {
    const c = chain(SEED);
    expect(c, "the seed's betrayed partner survives the vote").toBeDefined();
    const { g, partners, betrayed } = c!;
    expect(partners.length, "the engine let more than one houseguest agree").toBeGreaterThan(1);
    const second = g.s.makeDeal(req(betrayed, "final-two"));
    expect(isRefusal(second), "a new proposal to the partner the player just voted against is refused").toBe(true);
    const real = (g.s as unknown as { refusalReal: WeakMap<object, string> }).refusalReal.get(second as object) ?? "";
    expect(["grudge", "distrust", "threat", "targeted"], `refused for the break's own consequence (${real})`).toContain(real);
    expect(JSON.stringify(second), "the refusal carries no numbers").not.toMatch(/\d\.\d/);
    expect((g.s.getGameState().deals ?? []).filter((d) => d.parties.some((p) => p.id === betrayed) && d.status === "open"), "no new open deal with them").toHaveLength(0);
    const bystanders = partners.filter((x) => x !== betrayed && g.s.livingIds().includes(x));
    const answers = bystanders.map((x) => g.s.makeDeal(req(x, "final-two")));
    expect(answers.some((r) => !isRefusal(r)), "a partner the player kept faith with still accepts the same proposal (the refusal is the break, not the ask)").toBe(true);
  });
  it("with the belief store off, the same break is refused as the remembered grudge itself", () => {
    const c = chain(SEED, false);
    expect(c, "the seed's betrayed partner survives the vote").toBeDefined();
    const r = c!.g.s.makeDeal(req(c!.betrayed, "final-two"));
    expect(isRefusal(r)).toBe(true);
    expect((c!.g.s as unknown as { refusalReal: WeakMap<object, string> }).refusalReal.get(r as object)).toBe("grudge");
  });
});
