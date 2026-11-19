import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { InMemoryUserSeasonArchive } from "../../src/adapters/engine/FileUserSeasonArchive";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "../../features/support/answerPending";

/** ORW-690 - a returner is the actual previous houseguest: the authoring write-back never rewrites their public persona. Roles only. */
type Npc = { id: string; name: string; character: Record<string, unknown> };
type Internals = { house: { npcs: Npc[] }; live: { returners?: Record<string, unknown> } };
const inner = (s: GameSessionAdapter) => s as unknown as Internals;

function returnerGame(): { s: GameSessionAdapter; seat: string } {
  for (let seed = 100; seed < 140; seed++) {
    const reg = new GameSessionRegistry(undefined, { seasonArchive: new InMemoryUserSeasonArchive() });
    const sb = reg.sandboxFor(`u-ret-persona-${seed}`);
    sb.session.createCharacter({ playerName: "The Player", seed: 7 });
    sb.session.noteMessage({ messageId: "m1" });
    sb.session.advanceToFinale();
    sb.session.createCharacter({ playerName: "The Player", seed, confirmRestart: true, keepCharacter: true });
    const s = reg.sandboxFor(`u-ret-persona-${seed}`).session as GameSessionAdapter;
    const seat = Object.keys(inner(s).live?.returners ?? {})[0];
    if (seat) return { s, seat };
  }
  throw new Error("no return seed cast a returner");
}
const pub = (s: GameSessionAdapter, id: string) => JSON.stringify(inner(s).house.npcs.find((n) => n.id === id)!.character) + inner(s).house.npcs.find((n) => n.id === id)!.name;

describe("ORW-690: a returner's persona is not overwritten by cast authoring", () => {
  it("recordCastProfile refuses every public facet for a returner and keeps the hidden write; a fresh houseguest is still authored", () => {
    const { s, seat } = returnerGame();
    const fresh = inner(s).house.npcs.find((n) => n.id !== seat)!;
    const before = pub(s, seat);
    const authored = { biography: "A rewritten backstory line for authoring.", identityConcept: "A rewritten identity line.", vocation: "lighthouse keeper", name: "Role Gamma", weakness: "an authored weakness line" };
    const r = s.recordCastProfile({ houseguestId: seat as never, ...authored });
    expect(r.accepted).toBe(true);
    expect(pub(s, seat)).toBe(before);
    for (const f of ["biography", "identityConcept", "vocation", "name", "physicalCharacteristics", "voice"]) expect(r.publicFields).not.toContain(f);
    expect(r.hiddenFields).toContain("weakness");
    const r2 = s.recordCastProfile({ houseguestId: fresh.id as never, biography: authored.biography });
    expect(r2.publicFields).toContain("biography");
  });
  it("a returner's persona is byte-stable through the premiere", () => {
    const { s, seat } = returnerGame();
    s.setPremiereEntrancesEnabled(true);
    const before = pub(s, seat);
    s.noteMessage({ messageId: "m2" });
    for (let i = 0; i < 40; i++) { const v = s.advanceGame(); if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req)); }
    expect(pub(s, seat)).toBe(before);
  });
});
