import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameEvent } from "../../src/domain/event";

// ORW-570 (Fable audit T1-1; the BDD Auditor's ruling): `getOffscreenSceneSkeletons` is a PLAYER-channel read. An NPC-to-NPC scene whose
// witness set excludes the player is Vault-class: its people, its nature and its text alike (a "formed an alliance with" or "quietly turned
// on" line still tells the player-side app who allied with or turned on whom where the player was not). So the read returns NO hidden scene
// at all. Roles only.
const ACTOR = "npc:actor", PARTNER = "npc:partner", TARGET = "npc:target";

function sessionWith(events: GameEvent[]) {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor("wall-570");
  sb.session.createCharacter({ playerName: "The Player", seed: 570 });
  sb.session.setRecordProviders({ events: () => events, hidden: () => [] });
  sb.session.notifyOffscreenTick(events.map((e) => e.id));
  return sb.session;
}

function hiddenScene(id: string, type: string, line: string, houseLife = true): GameEvent {
  return {
    id, ts: 1, type, initiator: ACTOR, witnessSet: [ACTOR, PARTNER], hidden: true, content: line, baseContent: line,
    ...(houseLife ? { houseLife: { action: "flip-a-vote", place: "kitchen", manner: "quiet", truthful: true, about: TARGET, stretch: 1 } } : {}),
  } as unknown as GameEvent;
}

describe("ORW-570: the player-channel skeleton read returns no hidden off-screen scene", () => {
  it("a hidden house-life alliance, betrayal and strategy scene yield an empty read: no participant, nature, room, target or scheme", () => {
    const events = [
      hiddenScene("offscreen:alliance:1:1", "alliance", `${ACTOR} formed an alliance with ${PARTNER}`),
      hiddenScene("offscreen:betrayal:2:2", "betrayal", `${ACTOR} quietly turned on ${PARTNER} about ${TARGET}`),
      hiddenScene("offscreen:strategy:3:3", "strategy", `${ACTOR} worked to flip the vote of ${PARTNER} about ${TARGET}`),
    ];
    const res = sessionWith(events).getOffscreenSceneSkeletons();
    expect(res).toEqual([]);
    const text = JSON.stringify(res);
    for (const leak of [ACTOR, PARTNER, TARGET, "alliance", "betrayal", "strategy", "kitchen", "flip", "turned on"]) expect(text).not.toContain(leak);
  });

  it("an older off-screen tick scene (no house-life block) is just as sealed", () => {
    const ev = hiddenScene("offscreen:gossip:4:4", "gossip", `${ACTOR} gossiped about the house with ${PARTNER}`, false);
    expect(sessionWith([ev]).getOffscreenSceneSkeletons()).toEqual([]);
  });

  it("a voiced texture written back for a hidden scene does not make it readable either", () => {
    const ev = hiddenScene("offscreen:strategy:5:5", "strategy", `${ACTOR} talked strategy with ${PARTNER}`);
    const s = sessionWith([ev]);
    s.recordOffscreenSceneTexture({ eventId: ev.id, content: "a voiced line about the two of them" });
    expect(s.getOffscreenSceneSkeletons()).toEqual([]);
  });

  it("an event the player witnessed would still be returned (the read is not removed, only the hidden scenes)", () => {
    const seen = { ...hiddenScene("offscreen:bonding:6:6", "bonding", `${ACTOR} bonded with ${PARTNER}`, false), hidden: false, witnessSet: [ACTOR, PARTNER, "player"] } as unknown as GameEvent;
    const [sk] = sessionWith([seen]).getOffscreenSceneSkeletons();
    expect(sk?.eventId).toBe("offscreen:bonding:6:6");
  });

  it("the texture write-back gives a hidden scene's id the same receipt as an unknown id, and stores only the hidden one", () => {
    const ev = hiddenScene("offscreen:strategy:7:7", "strategy", `${ACTOR} talked strategy with ${PARTNER}`);
    const s = sessionWith([ev]);
    const hidden = s.recordOffscreenSceneTexture({ eventId: ev.id, content: "voiced line" });
    const unknown = s.recordOffscreenSceneTexture({ eventId: "offscreen:strategy:99:99", content: "voiced line" });
    expect(unknown).toEqual(hidden);
    expect(s.snapshot().textureOverrides?.["offscreen:strategy:99:99"]).toBeUndefined();
    expect(s.snapshot().textureOverrides?.[ev.id]).toBe("voiced line");
  });
});
