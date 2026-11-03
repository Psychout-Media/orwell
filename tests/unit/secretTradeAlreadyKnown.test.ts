import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { buildSandbox } from "../support/sandbox";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * 0099 — PO ruling 2026-11-03: "once the info is spread, there's no putting the genie back." A held secret cannot be traded
 * to a recipient who ALREADY KNOWS it (witnessed it, or was told — including by an earlier trade). Before the fix only an
 * "exposed" secret was blocked, so the same secret could be traded to the same recipient again and again up to the 5/season cap.
 * Roles only — the player, the subject, a recipient.
 */

function setup(seed: number): { session: GameSessionAdapter; sb: ReturnType<typeof buildSandbox>; subject: EntityId; factId: string; content: string } {
  const sb = buildSandbox(seed);
  const session = new GameSessionAdapter();
  session.setPlayerKnowledgeReader(() =>
    sb.engine.knowledge.knownTo(PLAYER).map((f) => ({ id: f.id, content: f.content, subject: f.subject, factId: f.factId })),
  );
  session.setNpcKnowledgeProviders({
    known: (id) => sb.engine.knowledge.knownTo(id).map((f) => ({ content: f.content, factId: f.factId })),
    suspicions: () => [],
  });
  session.setOnSurfaceToHouseguest((npcId, content, subject, pathway, confidence) => {
    const factId = `secret-power:${npcId}:${sb.engine.events.count()}`;
    sb.engine.knowledge.seedBelief(npcId, { content, originalContent: content, factId, confidence: 0.9, hops: 0, distortion: 0, source: PLAYER }, "origin");
    return sb.engine.knowledge.surfaceInformationTo(npcId, { content, subject, confidence }, pathway) !== null;
  });
  session.createCharacter({ playerName: "The Player", seed });
  const subject = session.livingIds().find((id) => id !== PLAYER)!;
  const content = "a learned secret about them";
  sb.engine.knowledge.seedBelief(subject, { content, originalContent: content, factId: `learned:${subject}`, confidence: 0.9, hops: 0, distortion: 0, source: subject }, "origin");
  sb.engine.knowledge.surfaceInformationTo(PLAYER, { content, subject, confidence: 0.85 }, `told-by:${subject}`);
  const fact = sb.engine.knowledge.knownTo(PLAYER).find((f) => f.subject === subject)!;
  return { session, sb, subject, factId: fact.factId ?? fact.id, content };
}

describe("0099 — a secret cannot be traded to someone who already knows it", () => {
  it("refuses a recipient who was already told it, and still lets a recipient who does not know it be offered the trade", () => {
    const { session, sb, subject, factId, content } = setup(2);
    const [knower, stranger] = session.livingIds().filter((id) => id !== PLAYER && id !== subject) as [EntityId, EntityId];
    // The knower was told it elsewhere in the house (a real, anchored pathway — they now HOLD it).
    sb.engine.knowledge.seedBelief(subject, { content, originalContent: content, factId: `held:${knower}`, confidence: 0.9, hops: 0, distortion: 0, source: subject }, "origin");
    expect(sb.engine.knowledge.surfaceInformationTo(knower, { content, subject, confidence: 0.8 }, `told-by:${subject}`)).not.toBeNull();

    expect(session.tradeSecret({ factId, toNpcId: knower })).toEqual({ accepted: false, refused: "already-spent" });
    const other = session.tradeSecret({ factId, toNpcId: stranger })!;
    expect(other.refused, "a recipient who does not know it is judged on the trade itself").not.toBe("already-spent");
  });

  it("the same secret cannot be traded to the same recipient twice — the first accepted trade is what tells them", () => {
    let proved = false;
    for (let seed = 1; seed <= 40 && !proved; seed++) {
      const { session, sb, subject, factId } = setup(seed);
      const recipient = session.livingIds().find((id) => id !== PLAYER && id !== subject)!;
      // Make the recipient receptive so the first trade lands (the value is the recipient's own reads — see tradeValue).
      const toPlayer = sb.engine.relationships.edge(recipient, PLAYER);
      toPlayer.trust = 0.9; toPlayer.affinity = 0.9; toPlayer.threat = 0.01;
      const toSubject = sb.engine.relationships.edge(recipient, subject);
      toSubject.threat = 0.95; toSubject.affinity = 0.05;
      const first = session.tradeSecret({ factId, toNpcId: recipient })!;
      if (!first.accepted) continue;
      const again = session.tradeSecret({ factId, toNpcId: recipient })!;
      expect(again, `seed ${seed}: the recipient now holds it`).toEqual({ accepted: false, refused: "already-spent" });
      proved = true;
    }
    expect(proved, "some seed in 1..40 accepts the first trade").toBe(true);
  });
});
