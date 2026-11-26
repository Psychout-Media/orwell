import { describe, expect, it } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefStore } from "../../src/engine/beliefStore";
import { tellClaim, sameClaimKey, type ClaimContext, type ClaimLog } from "../../src/engine/spokenClaims";
import { renderGameContext } from "../../src/engine/momentPrompts";
import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * ORW-931 (Fable W2-7): "X's been talking about you" reached the narrator again after the player had already been told, from another houseguest, and read as new. Parity with an NPC listener
 * (ORW-591): the SAME speaker saying the same thing again is no new telling; a DIFFERENT speaker is corroboration and is told, marked `alreadyHeard` so the narrator voices it as confirming
 * what the player heard, never as news. Roles only.
 */
const [A, B, X] = ["npc:a", "npc:b", "npc:x"];
const living = [PLAYER, A, B, X];
const ctx: ClaimContext = { week: 2, day: 6, living, trustOf: () => 0.7 };
const fresh = (): { log: ClaimLog; beliefs: BeliefStore } => ({ log: { seq: 0, items: [] }, beliefs: {} });
const talking = (speaker: string, listener: string) => ({ speaker, listener, kind: "talking-about" as const, subject: X, object: listener, isTrue: true, intent: "warn" as const });

describe("ORW-931 - a claim the player already heard is never new", () => {
  it("the same speaker telling the player the same thing again is not told: nothing logged, nothing to voice", () => {
    const { log, beliefs } = fresh();
    expect(tellClaim(log, beliefs, talking(A, PLAYER), ctx)).toBeDefined();
    expect(tellClaim(log, beliefs, talking(A, PLAYER), ctx), "a same-speaker repeat").toBeUndefined();
    expect(log.items).toHaveLength(1);
    expect(log.seq).toBe(1);
  });
  it("a different speaker saying it is corroboration: told (logged), and recognisably the same claim", () => {
    const { log, beliefs } = fresh();
    const first = tellClaim(log, beliefs, talking(A, PLAYER), ctx)!;
    const second = tellClaim(log, beliefs, talking(B, PLAYER), ctx)!;
    expect(second).toBeDefined();
    expect(sameClaimKey(first, second)).toBe(true);
    expect(log.items).toHaveLength(2);
  });
  it("parity: an NPC told the same thing twice by the same speaker folds into one belief (ORW-591, unchanged); another speaker plants its own", () => {
    const { log, beliefs } = fresh();
    tellClaim(log, beliefs, { ...talking(A, B), object: B }, ctx);
    tellClaim(log, beliefs, { ...talking(A, B), object: B }, ctx);
    expect((beliefs[B] ?? []).filter((b) => b.value && !b.refuted)).toHaveLength(1);
    expect(log.items, "an NPC listener's repeat is still logged (the fold keeps its id for a caught lie)").toHaveLength(2);
  });
  it("the narrator voices a corroborating telling as confirmation, never as news", () => {
    const sb = new GameSessionRegistry().sandboxFor("orw931-render");
    sb.session.createCharacter({ playerName: "The Player", seed: 7 });
    const base = sb.session.getGameState();
    const line = (alreadyHeard?: true) => renderGameContext({ ...base, presentKnowledge: [{ id: B, name: "Role B", knows: [], suspects: [],
      tellsYou: { kind: "talking-about", subject: "Role X", object: "the player", certainty: "sure", ...(alreadyHeard ? { alreadyHeard } : {}) } }] } as never);
    expect(line(true)).toMatch(/already heard this from someone else/);
    expect(line()).not.toMatch(/already heard this/);
  });
});
