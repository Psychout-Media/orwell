import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefClaim } from "../../src/engine/beliefStore";

/**
 * ORW-594 (Fable T2-13's sibling T2-12): what a houseguest confides to the player is rolled ONCE per part of the day, not again on every player turn (which made
 * "confides rarely" near-certain over a day of turns). Roles only: houseguests, the player.
 */
describe("claims to the player: one roll per houseguest per part of the day", () => {
  it("many player turns in one part of the day tell exactly what the first turn told", () => {
    const sb = new GameSessionRegistry().sandboxFor("ctp-roll");
    sb.session.createCharacter({ playerName: "The Player", seed: 44 });
    const s = sb.session as unknown as {
      live: { playedGame?: boolean; week: number; beliefs?: Record<string, BeliefClaim[]>; claims?: { items: Array<{ speaker: string; listener: string }> } };
      rel: { edge(a: string, b: string): { trust: number } }; disclosureEpoch: number; claimsToPlayerFor(id: string): unknown;
    };
    s.live.playedGame = true;
    const npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
    const [a, b] = npcs;
    s.live.beliefs = Object.fromEntries(npcs.map((h) => [h, [
      { id: `${h}|targets-me|${a}`, holder: h, kind: "targets-me", subject: h === a ? b! : a!, value: true, origin: "told", confidence: 0.9, week: s.live.week } as BeliefClaim,
      { id: `${h}|allied-with|${b}`, holder: h, kind: "allied-with", subject: h === b ? a! : b!, object: npcs[2]!, value: true, origin: "told", confidence: 0.9, week: s.live.week } as BeliefClaim,
    ]]));
    for (const h of npcs) s.rel.edge(h, PLAYER).trust = 0.8;
    const tellers = (): string[] => [...new Set((s.live.claims?.items ?? []).filter((c) => c.listener === PLAYER).map((c) => c.speaker))].sort();
    s.disclosureEpoch += 1;
    for (const h of npcs) s.claimsToPlayerFor(h);
    const first = tellers();
    for (let turn = 0; turn < 25; turn++) { s.disclosureEpoch += 1; for (const h of npcs) s.claimsToPlayerFor(h); }
    expect(tellers()).toEqual(first);
    expect(first.length).toBeLessThan(npcs.length); // "rarely" is not "always"
  });
});
