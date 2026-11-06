import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { DealView, DealRefusal, MakeDealReq } from "../../src/ports/GameSession";

/**
 * ORW-82 - the consent CHAIN, through the real adapter and the real break path (no hand-planted grudge): the player makes a deal with a warm NPC (accepted), the engine's own
 * reconcile path breaks it (the player nominates the protected NPC: `reconcileDeals`, the same call every recorded event goes through), the wronged NPC now remembers the break, and a SECOND
 * proposal to the same NPC is refused. The chain is mutation-checked: dropping the consent check makes the second proposal succeed. Roles only.
 */
type Sess = ReturnType<GameSessionRegistry["sandboxFor"]>["session"];
interface Edge { trust: number; affinity: number; threat: number }
type Priv = { rel: { edge(a: string, b: string): Edge }; reconcileDeals(a: { actor: string; kind: string; targets: string[] }): void };
const isRefusal = (r: DealView | DealRefusal | null): r is DealRefusal => !!r && (r as DealRefusal).refused === true;
const req = (npc: string, kind: MakeDealReq["kind"] = "safety"): MakeDealReq => ({ with: npc, kind, terms: "we look out for each other" });

function setup(seed: number): { s: Sess; npc: string; other: string; p: Priv } {
  const s = new GameSessionRegistry().sandboxFor(`dcc-${seed}-${Math.random()}`).session;
  s.createCharacter({ playerName: "P", seed });
  s.advanceGame(); s.advanceGame();
  const ids = s.livingIds().filter((id) => id !== PLAYER);
  return { s, npc: ids[0]!, other: ids[1]!, p: s as unknown as Priv };
}
/** Moderately warm: enough for a cheap ask to be accepted, not so warm that one betrayal is simply forgiven. */
const warm = (p: Priv, npc: string): void => { Object.assign(p.rel.edge(npc, PLAYER), { trust: 0.5, affinity: 0.45, threat: 0.15 }); };

describe("ORW-82 consent chain: break a deal, then propose to the same NPC", () => {
  it("a warm NPC accepts; the player breaks the deal through the real reconcile path; the SAME NPC then refuses a new proposal and no second deal is recorded", () => {
    const { s, npc, other, p } = setup(5);
    warm(p, npc);
    const first = s.makeDeal(req(npc));
    expect(isRefusal(first), "the warm NPC accepts the first proposal").toBe(false);
    expect(s.getGameState().deals?.length).toBe(1);

    // the real break: the player nominates the very houseguest they promised safety (the engine decides it is a break; nothing is planted by hand)
    p.reconcileDeals({ actor: PLAYER, kind: "nominate", targets: [npc, other] });
    expect(s.getGameState().deals?.find((d) => d.kind === "safety")?.status, "the engine marked it broken").toBe("broken");

    // nothing is reset: the break's own consequences (the betrayal fold on the edge + the remembered grudge) are what the engine now reads
    const second = s.makeDeal(req(npc, "vote"));
    expect(isRefusal(second), "a new proposal to the NPC the player just betrayed is refused").toBe(true);
    expect(isRefusal(second) && ["grudge", "distrust", "threat"].includes(second.reason), "refused for the break's own consequence").toBe(true);
    expect(JSON.stringify(second), "the refusal carries no numbers").not.toMatch(/\d\.\d/);
    expect((s.getGameState().deals ?? []).filter((d) => d.status === "open"), "no new open deal was recorded").toHaveLength(0);
  });

  it("control: an NPC the player did NOT betray still accepts the same second proposal (the refusal is the memory, not the ask)", () => {
    const { s, npc, other, p } = setup(5);
    warm(p, npc); warm(p, other);
    expect(isRefusal(s.makeDeal(req(npc)))).toBe(false);
    p.reconcileDeals({ actor: PLAYER, kind: "nominate", targets: [npc, other] }); // betrays ONLY npc
    warm(p, other);
    expect(isRefusal(s.makeDeal(req(other, "vote"))), "a bystander is unaffected").toBe(false);
  });
});
