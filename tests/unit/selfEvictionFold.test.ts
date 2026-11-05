import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * A46 / 0061 - the self-eviction FOLD, for real. The old checks only asserted `event.beat === "self-eviction"`, so the hidden consequence (the present house's read of the leaver moves) was untested: dropping
 * the fold left every existing test green. Here two games with the SAME seed and the SAME play are compared: identical up to the quit, then ONE quits and the other is the no-quit control. The present
 * house's hidden read of the player must differ afterwards (threat down as a rival removes itself, warmth down for quitting on them), and the recorded event must be non-hidden with the whole house as witnesses.
 * Roles only; the numbers stay in the hidden layer (read here through the engine-side model, never a player surface).
 */
function play(user: string, seed: number, beats: number): UserSandbox {
  const sb = new GameSessionRegistry().sandboxFor(user);
  sb.session.createCharacter({ playerName: "P", seed });
  for (let i = 0; i < beats; i++) {
    const v = sb.session.advanceGame();
    const p = v.pending as { kind: string; options: Array<{ id: string }> } | null | undefined;
    if (!p) continue;
    if (p.kind === "nominations") sb.session.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
    else if (p.kind === "veto-decision") sb.session.submitDecision({ kind: "veto-decision", use: false });
    else if (p.kind === "replacement") sb.session.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
    else if (p.kind === "comp-intent") sb.session.submitDecision({ kind: "comp-intent", intent: "compete" });
    else sb.session.submitDecision({ kind: p.kind, vote: p.options[0]!.id } as never);
  }
  return sb;
}
const read = (sb: UserSandbox, h: EntityId) => {
  const e = sb.engine.relationships.edge(h, PLAYER);
  return { trust: e.trust, affinity: e.affinity, threat: e.threat };
};
const present = (sb: UserSandbox): EntityId[] => sb.session.getGameState().house.filter((h) => h.status === "active").map((h) => h.id as EntityId);

describe("0061 self-eviction folds the present house's hidden read of the leaver", () => {
  it("after a confirmed quit the present house reads the player differently than in the same-seed no-quit control", () => {
    const quit = play("sef-quit", 3, 8);
    const control = play("sef-control", 3, 8);
    const house = present(quit);
    expect(house.length).toBeGreaterThan(5);
    // precondition: the two games are IDENTICAL up to the moment of the quit (so any difference is the quit's own fold)
    for (const h of house) expect(read(quit, h), `precondition: ${h} reads the same in both games`).toEqual(read(control, h));

    quit.session.requestSelfEviction();
    quit.session.submitDecision({ kind: "self-evict", confirmed: true });
    expect(quit.session.getGameState().player?.status).toBe("evicted");
    expect(control.session.getGameState().player?.status).toBe("active");

    let moved = 0;
    for (const h of house) {
      const a = read(quit, h), b = read(control, h);
      if (a.trust !== b.trust || a.affinity !== b.affinity || a.threat !== b.threat) moved++;
      // the direction: a rival removing themselves is LESS of a threat, and quitting on the house is a slight warmth dip
      expect(a.threat, `${h}: threat toward the leaver falls`).toBeLessThan(b.threat);
      expect(a.affinity, `${h}: warmth toward the leaver dips`).toBeLessThan(b.affinity);
    }
    expect(moved, "every houseguest who was present folded").toBe(house.length);
  });

  it("the recorded self-eviction event is player-witnessed, non-hidden, and witnessed by the whole house", () => {
    const quit = play("sef-witness", 3, 8);
    const house = present(quit);
    quit.session.requestSelfEviction();
    quit.session.submitDecision({ kind: "self-evict", confirmed: true });
    const exits = quit.engine.events.queryAll().filter((e) => /self-evict/i.test(e.content));
    expect(exits.length, "exactly one self-eviction event").toBe(1);
    const ev = exits[0]!;
    expect(ev.hidden).toBe(false);
    expect(ev.witnessSet).toContain(PLAYER);
    for (const h of house) expect(ev.witnessSet, `${h} witnessed the walk-out`).toContain(h);
  });

  it("an UNCONFIRMED request folds nothing (the anti-accident handshake)", () => {
    const quit = play("sef-unconfirmed", 3, 8);
    const control = play("sef-unconfirmed-control", 3, 8);
    quit.session.requestSelfEviction();           // intent only
    quit.session.submitDecision({ kind: "self-evict", confirmed: false });
    for (const h of present(quit)) expect(read(quit, h)).toEqual(read(control, h));
    expect(quit.session.getGameState().player?.status).toBe("active");
  });
});
