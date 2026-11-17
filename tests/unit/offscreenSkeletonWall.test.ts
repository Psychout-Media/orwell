import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameEvent } from "../../src/domain/event";

// ORW-570 (Fable audit T1-1): `getOffscreenSceneSkeletons` is a PLAYER-channel read. A house-life scene's engine line names who was
// targeted and what the scheme was ("A worked to flip the vote of B about C"); the older off-screen tick kept its base line free of
// targets. The skeleton of a house-life scene must carry only the public people and a plain relationship line, never the target or
// the scheme verb. Roles only.
const ACTOR = "npc:actor", PARTNER = "npc:partner", TARGET = "npc:target";

function sessionWith(events: GameEvent[]) {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor("wall-570");
  sb.session.createCharacter({ playerName: "The Player", seed: 570 });
  sb.session.setRecordProviders({ events: () => events, hidden: () => [] });
  sb.session.notifyOffscreenTick(events.map((e) => e.id));
  return sb.session;
}

function houseLifeScene(kind: string, line: string, type = "strategy"): GameEvent {
  return {
    id: `offscreen:${type}:1:1`, ts: 1, type, initiator: ACTOR, witnessSet: [ACTOR, PARTNER], hidden: true,
    content: line, baseContent: line,
    houseLife: { action: kind, place: "kitchen", manner: "quiet", truthful: true, about: TARGET, stretch: 1 },
  } as unknown as GameEvent;
}

describe("ORW-570: the off-screen skeleton read never carries a house-life scene's target or scheme", () => {
  it("a flip-the-vote scene's skeleton names neither the target nor the scheme", () => {
    const line = `${ACTOR} worked to flip the vote of ${PARTNER} about ${TARGET}`;
    const [sk] = sessionWith([houseLifeScene("flip-a-vote", line)]).getOffscreenSceneSkeletons();
    expect(sk).toBeDefined();
    expect(sk.templateContent).not.toContain(TARGET);
    expect(sk.templateContent).not.toMatch(/flip|vote|frame|campaign|lobb|plant|leak|recruit/i);
    expect(sk.participants.sort()).toEqual([ACTOR, PARTNER].sort());
    expect(sk.templateContent).toContain(ACTOR);
  });

  it("a framing scene and a lobbying scene are covered the same way", () => {
    const frame = houseLifeScene("frame", `${ACTOR} tried to frame someone to ${PARTNER} about ${TARGET}`);
    const lobby = { ...houseLifeScene("lobby-for", `${ACTOR} lobbied ${PARTNER} for ${TARGET}`), id: "offscreen:strategy:2:2" } as GameEvent;
    const sks = sessionWith([frame, lobby]).getOffscreenSceneSkeletons();
    expect(sks).toHaveLength(2);
    for (const sk of sks) {
      expect(sk.templateContent).not.toContain(TARGET);
      expect(sk.templateContent).not.toMatch(/frame|lobb/i);
    }
  });

  it("an older off-screen tick scene (no house-life block) keeps its own Vault-free base line unchanged", () => {
    const base = `${ACTOR} talked strategy with ${PARTNER}`;
    const ev = { id: "offscreen:strategy:3:3", ts: 1, type: "strategy", initiator: ACTOR, witnessSet: [ACTOR, PARTNER], hidden: true, content: `${base} (hidden detail)`, baseContent: base } as unknown as GameEvent;
    const [sk] = sessionWith([ev]).getOffscreenSceneSkeletons();
    expect(sk.templateContent).toBe(base);
  });
});
