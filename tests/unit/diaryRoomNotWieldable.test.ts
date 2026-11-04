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
