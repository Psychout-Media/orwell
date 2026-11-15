import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { FakeClock } from "../../src/adapters/time/FakeClock";

/** ORW-369: the look-only write-back for a running season. */
function setup() {
  const runtime = composeRuntime({ saveStore: new FileSaveStore(mkdtempSync(join(tmpdir(), "orwell-369-"))), clock: new FakeClock() });
  const sb = runtime.registry.sandboxFor("u");
  sb.session.createCharacter({ playerName: "Player One", seed: 7 });
  const npc = () => sb.session.snapshot().house!.npcs[0]!;
  return { sb, id: npc().id, npc };
}

describe("recordLookExtras", () => {
  it("stores only wardrobe and onCamera; every other field and the appearance string are unchanged", () => {
    const { sb, id, npc } = setup();
    const before = JSON.parse(JSON.stringify(npc().character));
    const r = sb.session.recordLookExtras({ houseguestId: id, wardrobe: ["a grey cardigan", "dark jeans"], onCamera: "Laughs easily in the kitchen." });
    expect(r).toEqual({ accepted: true, fields: ["wardrobe", "onCamera"] });
    const after = JSON.parse(JSON.stringify(npc().character));
    expect(after.physicalCharacteristics.wardrobe).toEqual(["a grey cardigan", "dark jeans"]);
    expect(after.physicalCharacteristics.onCamera).toBe("Laughs easily in the kitchen.");
    delete after.physicalCharacteristics.wardrobe; delete after.physicalCharacteristics.onCamera;
    delete before.physicalCharacteristics.wardrobe; delete before.physicalCharacteristics.onCamera;
    expect(after).toEqual(before); // appearance, biography, voice, deepProfileAuthored... all identical
  });

  it("clamps: at most 3 items of 60 chars and 240 chars on camera; control characters stripped", () => {
    const { sb, id, npc } = setup();
    sb.session.recordLookExtras({
      houseguestId: id,
      wardrobe: ["a".repeat(100), "b\u0000c", "d", "e"],
      onCamera: "x\u0001".repeat(400),
    });
    const p = npc().character.physicalCharacteristics!;
    expect(p.wardrobe!.length).toBe(3);
    expect(p.wardrobe![0]!.length).toBe(60);
    expect(p.wardrobe![1]).toBe("b c");
    expect(p.onCamera!.length).toBeLessThanOrEqual(240);
    expect(p.onCamera).not.toMatch(/[\u0000-\u001f]/);
  });

  it("refuses an unknown houseguest, empty input, and the player's name; stores nothing", () => {
    const { sb, id, npc } = setup();
    expect(sb.session.recordLookExtras({ houseguestId: "npc:999", wardrobe: ["a", "b"] }).accepted).toBe(false);
    expect(sb.session.recordLookExtras({ houseguestId: id, wardrobe: [], onCamera: "  " })).toMatchObject({ accepted: false, reason: "nothing-valid" });
    expect(sb.session.recordLookExtras({ houseguestId: id, onCamera: "Whispers about Player One in the lounge." })).toMatchObject({ accepted: false, reason: "mirrors-player" });
    expect(npc().character.physicalCharacteristics!.onCamera).toBeUndefined();
  });

  it("the closed-facet (ink) guard keeps an un-granted dimension out", () => {
    const { sb, id, npc } = setup();
    const grantedInk = /tattoo|ink/i.test(JSON.stringify(npc().character.physicalCharacteristics));
    const r = sb.session.recordLookExtras({ houseguestId: id, wardrobe: ["a sleeveless top showing a full tattoo sleeve", "jeans"], onCamera: "Chats in the kitchen." });
    if (!grantedInk) {
      expect(r.fields).not.toContain("wardrobe");
      expect(npc().character.physicalCharacteristics!.wardrobe).toBeUndefined();
    }
    expect(r.fields).toContain("onCamera");
  });
});
