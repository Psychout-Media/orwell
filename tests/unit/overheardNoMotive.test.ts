import { describe, it, expect } from "vitest";
import { ACTIONS, actionLine, overheardLine } from "../../src/engine/houseLife";
import type { ActionKind } from "../../src/engine/houseLife";
import { rollOverhears } from "../../src/engine/presence";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { InMemoryKnowledgeService } from "../../src/adapters/inmemory/InMemoryKnowledgeService";
import { PLAYER, npc } from "../../src/domain/ids";
import type { Room } from "../../src/domain/house";
import type { EntityId } from "../../src/domain/ids";

/** ORW-579 (Fable T1-12c): an overheard fragment carries what could be heard, never the engine's motive label. Roles only. */
const SENTINEL = "SENTINEL-MOTIVE-LABEL";

describe("overheard fragments never carry the motive label (ORW-579)", () => {
  it("a hidden goal step is heard as a voice only, whatever its engine label", () => {
    for (const [kind, spec] of Object.entries(ACTIONS) as [ActionKind, (typeof ACTIONS)[ActionKind]][]) {
      if (spec.family === "house-life" || spec.family === "romance" || spec.fold === "conflict") continue;
      const content = actionLine({ actor: npc(1), kind, with: [npc(2)], about: npc(3) } as never);
      expect(overheardLine({ initiator: npc(1), type: "strategy", content, houseLife: { action: kind } }), kind).toBe(npc(1));
    }
  });

  it("a plain house-life act and a clash are heard as themselves, and stay a prefix of the source", () => {
    const content = actionLine({ actor: npc(1), kind: "cook", with: [npc(2)] } as never);
    const line = overheardLine({ initiator: npc(1), type: "bonding", content, houseLife: { action: "cook" } });
    expect(line).toBe(`${npc(1)} cooked with`);
    expect(content.startsWith(line)).toBe(true);
    expect(overheardLine({ initiator: npc(1), type: "conflict", content: `${npc(1)} clashed with ${npc(2)}` })).toBe(`${npc(1)} clashed with`);
  });

  it("a society scene's nature (alliance, betrayal, strategy...) is never heard", () => {
    for (const [type, verb] of [["alliance", "formed an alliance with"], ["betrayal", "quietly turned on"], ["strategy", "talked strategy with"], ["gossip", "gossiped about the house with"]]) {
      expect(overheardLine({ initiator: npc(1), type: type!, content: `${npc(1)} ${verb} ${npc(2)}` })).toBe(npc(1));
    }
  });

  it("sentinel: a planted label in the hidden line never reaches the listener's knowledge; the fragment itself still does", () => {
    const events = new InMemoryEventStore();
    const knowledge = new InMemoryKnowledgeService(events);
    const content = `${npc(1)} ${SENTINEL} ${npc(2)}`;
    events.record({ id: "scene:1", ts: 1, type: "strategy", initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content });
    const occupancy = new Map<EntityId, Room>([[npc(1), "kitchen"], [npc(2), "kitchen"], [PLAYER, "living-room"]]);
    let heard: EntityId[] = [];
    for (let s = 0; s < 80 && heard.length === 0; s++) {
      heard = rollOverhears({
        eventId: "scene:1", room: "kitchen", content, participants: [npc(1), npc(2)], occupancy, knowledge, rng: new SeededRandom(s),
        heard: overheardLine({ initiator: npc(1), type: "strategy", content }),
      });
    }
    expect(heard).toEqual([PLAYER]);
    const fact = knowledge.knownTo(PLAYER).find((f) => f.pathway === "overheard:scene:1")!;
    expect(fact.content).toContain(npc(1)); // positive control: the fragment itself still appears
    expect(fact.content).not.toContain(SENTINEL);
    expect(JSON.stringify(knowledge.knownTo(PLAYER))).not.toContain(SENTINEL);
  });
});
