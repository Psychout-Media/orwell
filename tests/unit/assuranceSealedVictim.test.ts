import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { AssuranceLedger } from "../../src/engine/assurances";
import type { BeliefClaim } from "../../src/engine/beliefStore";

/**
 * ORW-686 + B4: a betrayal rumor names its victim only from a betrayal the wronged side could know of. A deal the player broke at the SECRET eviction ballot is never a victim
 * source; neither is an ASSURANCE broken at that same ballot (found on #3200's played games: the deal was skipped, the "safe" assurance to the same houseguest named them).
 * The break is sealed on the ledger; an assurance broken in the open still names its victim. Unit lane: the season state is set through the engine's own calls. Roles only.
 */
type G = {
  recordAssurance(a: unknown): void; setAssurancesEnabled(on: boolean): void; setNpcBeliefsEnabled(on: boolean): void;
  assuranceVotedOut(voter: string, nominee: string, sealedAmong?: readonly string[]): void;
  assuranceNominated(holder: string, nominee: string, sealedAmong?: readonly string[]): void;
  recordHeardAboutMe(h: { teller: string; listeners: string[]; nature: "betrayal" }): void;
  live: { playedGame?: boolean; assurances?: { seq: number; items: unknown[] }; beliefs?: Record<string, BeliefClaim[]> };
};
function started(user: string) {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 4 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as G;
  g.setAssurancesEnabled(true); g.setNpcBeliefsEnabled(true);
  g.live.playedGame = true;
  const npcs = [...sb.session.livingIds()].filter((i) => i !== PLAYER);
  return { g, npcs };
}
const rumorObject = (g: G, listener: string): string | undefined => (g.live.beliefs?.[listener] ?? []).find((c) => c.kind === "heard-rumor" && c.subject === PLAYER)?.object;

describe("a broken assurance names its victim only when the assured could know of the break", () => {
  it("the ledger keeps the seal of a secret-ballot break (and an old item without one reads as open)", () => {
    const l = new AssuranceLedger();
    const a = l.add({ from: PLAYER, to: "npc:1" as never, kind: "safe", week: 1, sincerity: 1, source: "player" });
    const b = l.add({ from: PLAYER, to: "npc:2" as never, kind: "safe", week: 1, sincerity: 1, source: "player" });
    expect(l.resolve(a.id, "broken", { sealed: true })).toBe(true);
    expect(l.resolve(b.id, "broken")).toBe(true);
    const back = AssuranceLedger.fromJSON(JSON.parse(JSON.stringify(l.toJSON())));
    expect(back.all.find((x) => x.id === a.id)!.sealed).toBe(true);
    expect(back.all.find((x) => x.id === b.id)!.sealed).toBeUndefined();
  });

  it("broken at the secret ballot: the rumor about the player names no victim", () => {
    const { g, npcs } = started("asr-sealed-victim");
    const [assured, teller, listener, other] = npcs as [string, string, string, string];
    g.recordAssurance({ from: PLAYER, to: assured, kind: "safe", sincerity: 1, source: "player" });
    g.assuranceVotedOut(PLAYER, assured, [PLAYER, other]);
    g.recordHeardAboutMe({ teller, listeners: [listener], nature: "betrayal" });
    expect(rumorObject(g, listener) ?? "none").toBe("none");
  });

  it("broken in the open (the HOH named them): the rumor names the assured as the one betrayed", () => {
    const { g, npcs } = started("asr-open-victim");
    const [assured, teller, listener] = npcs as [string, string, string];
    g.recordAssurance({ from: PLAYER, to: assured, kind: "safe", sincerity: 1, source: "player" });
    g.assuranceNominated(PLAYER, assured);
    g.recordHeardAboutMe({ teller, listeners: [listener], nature: "betrayal" });
    expect(rumorObject(g, listener)).toBe(assured);
  });
});
