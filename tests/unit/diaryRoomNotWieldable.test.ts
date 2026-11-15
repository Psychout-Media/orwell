import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * BDD audit D2 (Diary Room wall): a fact the player holds through the DIARY ROOM is their private booth record. It must
 * never be wielded (exposed / traded / used as leverage) or confronted with, because those levers surface the fact's
 * content into a houseguest's knowledge, a Diary-Room→NPC pathway the Vault Wall forbids. The same fact learned any
 * other way stays wieldable (the positive control). Roles only.
 */
function startedGame(tag: string): ReturnType<GameSessionRegistry["sandboxFor"]> {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(`dr-wall-${tag}`);
  sb.session.createCharacter({ playerName: "The Player", seed: 1 });
  return sb;
}

function seed(sb: ReturnType<GameSessionRegistry["sandboxFor"]>, about: EntityId, factId: string, pathway: string): void {
  sb.engine.knowledge.seedBelief(
    PLAYER,
    { content: `my private read: ${about} is the one to watch`, factId, subject: about, distortion: 0, confidence: 1 },
    pathway,
  );
}

describe("D2 — a Diary Room note is never wieldable or confrontable", () => {
  it("confront with a diary-room fact is refused; the same fact witnessed is accepted (control)", () => {
    const sb = startedGame("confront");
    const npcId = sb.session.snapshot().house!.npcs[0]!.id;
    seed(sb, npcId, "fact:dr-confront", "diary-room");
    expect(sb.session.confront(npcId, "fact:dr-confront")).toBeNull();

    const sb2 = startedGame("confront-control");
    const npc2 = sb2.session.snapshot().house!.npcs[0]!.id;
    seed(sb2, npc2, "fact:w-confront", "witnessed");
    expect(sb2.session.confront(npc2, "fact:w-confront")).not.toBeNull();
  });

  it("exposing a diary-room fact surfaces nothing into any houseguest's knowledge", () => {
    const sb = startedGame("expose");
    const npcs = sb.session.snapshot().house!.npcs.map((n) => n.id);
    const subject = npcs[0]!;
    seed(sb, subject, "fact:dr-expose", "diary-room");
    const before = npcs.map((id) => sb.engine.knowledge.knownTo(id).length);
    const res = sb.session.exposeSecret({ factId: "fact:dr-expose" });
    expect(res).toEqual({ exposed: false, refused: "not-learned" }); // refused: a booth note is not a wieldable secret
    const after = npcs.map((id) => sb.engine.knowledge.knownTo(id).length);
    expect(after).toEqual(before); // nothing surfaced into any houseguest

    // Control: the same claim learned by WITNESSING it is exposable (so the refusal above isn't vacuous).
    const sb2 = startedGame("expose-control");
    const subj2 = sb2.session.snapshot().house!.npcs[0]!.id;
    seed(sb2, subj2, "fact:w-expose", "witnessed");
    expect(sb2.session.exposeSecret({ factId: "fact:w-expose" })).toMatchObject({ exposed: true });
  });
});

/**
 * ORW-286 item 5 (Ryne, BDD cards 30-33): the CASTING path is walled from the house exactly like the Diary Room. What the player tells the producers in the casting interview (the
 * private strategy, the interview notes) is the player's own producer-only material; it has no in-game pathway to any houseguest. Added NEXT TO the diary-room wall above (not
 * replacing it): after a cast, no houseguest's KNOWLEDGE holds it and no houseguest's VOICE carries it, for every houseguest, through the first day's play. The probe is
 * proven live by a positive control: seeding the same sentence into a houseguest's knowledge trips it. Roles only.
 */
describe("ORW-286 item 5 — casting-authored private strategy and interview notes stay off every houseguest's knowledge and voice", () => {
  const PRIVATE = "SENTINEL-CAST-WALL-private-plan-to-flip-the-house-in-week-three";
  const NOTE = "SENTINEL-CAST-WALL-producer-only-self-description-of-the-player";

  function castGame(tag: string): ReturnType<GameSessionRegistry["sandboxFor"]> {
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor(`cast-wall-${tag}`);
    sb.session.createCharacter({ playerName: "The Player", seed: 7, privateStrategy: PRIVATE, interviewNotes: [NOTE] });
    for (let i = 0; i < 6; i++) sb.session.advanceGame();   // a little play, so any lazy copy into the house would have happened
    return sb;
  }

  function leaks(sb: ReturnType<typeof castGame>): string[] {
    const found: string[] = [];
    for (const hg of sb.session.getGameState().house) {
      if (hg.status !== "active") continue;
      const blob = JSON.stringify([sb.engine.knowledge.knownTo(hg.id), sb.session.npcVoice(hg.id)]);
      for (const s of [PRIVATE, NOTE]) if (blob.includes(s)) found.push(`${hg.id} holds ${s}`);
    }
    return found;
  }

  it("no houseguest's knowledge or voice carries the casting private strategy or interview notes", () => {
    const sb = castGame("clean");
    expect(sb.session.getGameState().house.filter((h) => h.status === "active").length).toBeGreaterThan(1); // the sweep is not vacuously empty
    expect(leaks(sb)).toEqual([]);
  });

  it("the probe is live: the same sentence seeded into a houseguest's knowledge is caught (positive control)", () => {
    const sb = castGame("control");
    const npcId = sb.session.snapshot().house!.npcs[0]!.id;
    sb.engine.knowledge.seedBelief(npcId, { content: NOTE, factId: "fact:cast-wall-control", subject: PLAYER, distortion: 0, confidence: 1 }, "witnessed");
    expect(leaks(sb).some((l) => l.includes(npcId) && l.includes(NOTE))).toBe(true);
  });
});
