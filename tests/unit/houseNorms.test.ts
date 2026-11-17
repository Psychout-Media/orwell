import { describe, it, expect } from "vitest";
import { NORMS, knownBreaches, normStrength, shunMove } from "../../src/engine/houseNorms";
import type { BeliefClaim } from "../../src/engine/beliefStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";

/** Feature 0180 part 1 - house norms: the house shuns a houseguest it KNOWS broke their word. Roles only: an observer (o), a promise-breaker (x), the people they lied to (v1, v2). */
const claim = (c: Partial<BeliefClaim> & Pick<BeliefClaim, "kind" | "subject">): BeliefClaim =>
  ({ id: `${c.kind}|${c.subject}|${c.object ?? ""}`, holder: "o", value: true, origin: "told", confidence: 0.8, week: 1, ...c }) as BeliefClaim;

describe("house norms (houseNorms.ts)", () => {
  it("counts what the observer HOLDS: their own lied-to-me and each person they heard the subject lied to, once each", () => {
    const held = [
      claim({ kind: "lied-to-me", subject: "x" }),
      claim({ kind: "heard-rumor", nature: "lying", subject: "x", object: "v1" }),
      claim({ kind: "heard-rumor", nature: "lying", subject: "x", object: "v1" }), // the same victim twice counts once
      claim({ kind: "heard-rumor", nature: "lying", subject: "x", object: "v2", refuted: true }), // refuted: not held
      claim({ kind: "heard-rumor", nature: "gossip", subject: "x", object: "v2" }), // not about lying
      claim({ kind: "lied-to-me", subject: "y" }), // someone else
    ];
    expect(knownBreaches(held, "o", "x")).toBe(2);
    expect(knownBreaches(held, "o", "o")).toBe(0);
  });
  it("one known incident is gossip; the threshold starts the shunning, and each further incident deepens it, bounded", () => {
    expect(shunMove(NORMS.threshold - 1, 0, 1).incidents).toBe(0);
    const at = shunMove(NORMS.threshold, 0, 1);
    expect(at.incidents).toBe(1);
    expect(at.affinity).toBeCloseTo(NORMS.affinityPerIncident, 12);
    expect(shunMove(NORMS.threshold + 1, 1, 1).incidents).toBe(1); // only what is new since the last fold
    expect(shunMove(NORMS.threshold, 1, 1).incidents).toBe(0); // idempotent
    expect(shunMove(NORMS.maxIncidents, 0, 1).incidents).toBe(NORMS.maxIncidents - NORMS.threshold + 1);
  });
  it("the culture moves it: an honest, loyal house shuns harder; a house of liars barely notices", () => {
    expect(normStrength(1.5, 0.5)).toBeGreaterThan(normStrength(1, 1));
    expect(normStrength(0.5, 1.5)).toBeLessThan(normStrength(1, 1));
    expect(normStrength(0, 3)).toBe(0);
  });

  // The player in both directions (standing rule, 2026-11-17): the player is shunned like anyone when the house knows they broke their word.
  it("the player as the promise-breaker: a houseguest who holds two of the player's broken words shuns the player, overnight, once", () => {
    const sb = new GameSessionRegistry().sandboxFor("norms-player");
    sb.session.setHouseNormsEnabled(true);
    sb.session.createCharacter({ playerName: "The Player", seed: 17 });
    const seam = sb.session as unknown as {
      live: { playedGame?: boolean; week: number; beliefs?: Record<string, BeliefClaim[]> };
      rel: { edge(a: string, b: string): { trust: number; affinity: number } };
      foldNormsOvernight(): void;
    };
    seam.live.playedGame = true;
    const [observer, victim] = sb.session.livingIds().filter((id) => id !== PLAYER);
    const before = { ...seam.rel.edge(observer!, PLAYER) };
    seam.live.beliefs = { ...(seam.live.beliefs ?? {}), [observer!]: [
      claim({ holder: observer!, kind: "lied-to-me", subject: PLAYER }),
      claim({ holder: observer!, kind: "heard-rumor", nature: "lying", subject: PLAYER, object: victim! }),
    ] };
    seam.foldNormsOvernight();
    const after = { ...seam.rel.edge(observer!, PLAYER) };
    expect(after.affinity).toBeLessThan(before.affinity);
    expect(after.trust).toBeLessThan(before.trust);
    seam.foldNormsOvernight(); // the same knowledge the next night moves nothing more
    expect(seam.rel.edge(observer!, PLAYER).affinity).toBeCloseTo(after.affinity, 12);
  });
});
