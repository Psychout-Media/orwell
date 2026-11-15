import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { FakeClock } from "../../src/adapters/time/FakeClock";

/** ORW-369: the look-only write-back for a running season. */
function setup() {
  const store = new FileSaveStore(mkdtempSync(join(tmpdir(), "orwell-369-")));
  const runtime = composeRuntime({ saveStore: store, clock: new FakeClock() });
  const sb = runtime.registry.sandboxFor("u");
  sb.session.createCharacter({ playerName: "Player One", seed: 7 });
  const npc = () => sb.session.snapshot().house!.npcs[0]!;
  return { sb, id: npc().id, npc, store };
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

  it("the accepted write reaches the DURABLE save (the latest file on disk carries wardrobe and onCamera), not only memory", () => {
    const { sb, id, store } = setup();
    expect(sb.session.recordLookExtras({ houseguestId: id, wardrobe: ["a grey cardigan"], onCamera: "Laughs easily in the kitchen." }).accepted).toBe(true);
    const durable = store.loadLatest("u");
    expect(durable, "a save exists for the user").not.toBeNull();
    const saved = durable!.house!.npcs.find((n) => n.id === id)!.character.physicalCharacteristics!;
    expect(saved.wardrobe).toEqual(["a grey cardigan"]);
    expect(saved.onCamera).toBe("Laughs easily in the kitchen.");
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

  it("the closed-facet (ink) guard reverts a tattoo written into onCamera or wardrobe on a no-ink skeleton", () => {
    const { sb } = setup();
    const INK = /\btattoo|\bink(?:ed)?\b|\bblackwork\b|\bbody art\b|\b(?:full|half)[- ]sleeves?/i;
    const npcs = sb.session.snapshot().house!.npcs;
    const clean = npcs.find((n) => !INK.test(JSON.stringify(n.character.physicalCharacteristics)));
    expect(clean, "the seeded cast has at least one houseguest with no ink in the skeleton").toBeDefined();
    const id = clean!.id;
    const bad = sb.session.recordLookExtras({ houseguestId: id, onCamera: "Shows off a tattoo in the kitchen." });
    expect(bad).toMatchObject({ accepted: false, reason: "rejected-by-guard" });
    const bad2 = sb.session.recordLookExtras({ houseguestId: id, wardrobe: ["a tank top, full tattoo sleeve visible", "jeans"], onCamera: "Chats in the kitchen." });
    expect(bad2).toEqual({ accepted: true, fields: ["onCamera"] });
    const p = sb.session.snapshot().house!.npcs.find((n) => n.id === id)!.character.physicalCharacteristics!;
    expect(p.wardrobe).toBeUndefined();
    expect(p.onCamera).toBe("Chats in the kitchen.");
    expect(JSON.stringify(p)).not.toMatch(INK);
  });
});

describe("ORW-380 photoHair", () => {
  it("is stored, clamped to 90 chars with control characters stripped, and changes nothing else", () => {
    const { sb, id, npc } = setup();
    const before = JSON.parse(JSON.stringify(npc().character));
    const r = sb.session.recordLookExtras({ houseguestId: id, photoHair: `sleek neat braid\u0001 ${"x".repeat(200)}` });
    expect(r).toEqual({ accepted: true, fields: ["photoHair"] });
    const after = JSON.parse(JSON.stringify(npc().character));
    expect(after.physicalCharacteristics.photoHair.length).toBeLessThanOrEqual(90);
    expect(after.physicalCharacteristics.photoHair).toMatch(/^sleek neat braid x/);
    delete after.physicalCharacteristics.photoHair;
    expect(after).toEqual(before);
  });

  it("travels with the other two fields and shows on the public card", () => {
    const { sb, id } = setup();
    expect(sb.session.recordLookExtras({ houseguestId: id, wardrobe: ["a grey cardigan", "dark jeans"], onCamera: "She sits in the lounge.", photoHair: "a glossy low bun" }))
      .toEqual({ accepted: true, fields: ["wardrobe", "onCamera", "photoHair"] });
    const card = sb.session.getGameState().house.find((h) => h.id === id)!;
    expect((card.physicalCharacteristics as { photoHair?: string }).photoHair).toBe("a glossy low bun");
  });

  it("the ink guard reverts a tattoo written into photoHair on a no-ink skeleton; empty photoHair alone is nothing-valid", () => {
    const { sb, npc } = setup();
    const INK = /\btattoo|\bink(?:ed)?\b|\bblackwork\b|\bbody art\b|\b(?:full|half)[- ]sleeves?/i;
    const clean = sb.session.snapshot().house!.npcs.find((n) => !INK.test(JSON.stringify(n.character.physicalCharacteristics)))!;
    const r = sb.session.recordLookExtras({ houseguestId: clean.id, photoHair: "a neat bun with a tattoo behind the ear" });
    expect(r.accepted).toBe(false);
    expect(sb.session.snapshot().house!.npcs.find((n) => n.id === clean.id)!.character.physicalCharacteristics!.photoHair).toBeUndefined();
    expect(sb.session.recordLookExtras({ houseguestId: clean.id, photoHair: "  " })).toMatchObject({ accepted: false, reason: "nothing-valid" });
  });
});

describe("ORW-380 recordCastProfile photoHair", () => {
  it("is cleaned and clamped like wardrobe and onCamera", () => {
    const { sb, id } = setup();
    const card = sb.session.getGameState().house.find((h) => h.id === id)!;
    const base = card.physicalCharacteristics!;
    const res = sb.session.recordCastProfile({ houseguestId: id, physicalCharacteristics: { ...base, photoHair: `a neat bun${"!".repeat(200)}` } as never });
    expect(res.accepted).toBe(true);
    const after = sb.session.getGameState().house.find((h) => h.id === id)!.physicalCharacteristics as { photoHair?: string };
    expect(after.photoHair!.length).toBe(90);
  });
});

describe("ORW-380 clear", () => {
  it("removes an old look field the new writer left out, and nothing else", () => {
    const { sb, id, npc } = setup();
    sb.session.recordLookExtras({ houseguestId: id, wardrobe: ["a grey cardigan", "dark jeans"], onCamera: "She sits in the lounge." });
    const r = sb.session.recordLookExtras({ houseguestId: id, photoHair: "a neat low bun", clear: ["onCamera", "bogus"] as never });
    expect(r).toEqual({ accepted: true, fields: ["photoHair"], cleared: ["onCamera"] });
    const p = npc().character.physicalCharacteristics!;
    expect(p.onCamera).toBeUndefined();
    expect(p.wardrobe).toEqual(["a grey cardigan", "dark jeans"]);
    expect(sb.session.recordLookExtras({ houseguestId: id, clear: ["onCamera"] })).toMatchObject({ accepted: false });
  });
});

describe("ORW-437 recordCastProfile keeps what it omits, and renames the prose with the name", () => {
  it("a profile write-back without wardrobe, onCamera and photoHair keeps the stored ones", () => {
    const { sb, id, npc } = setup();
    sb.session.recordLookExtras({ houseguestId: id, wardrobe: ["a grey cardigan", "dark jeans"], onCamera: "She sits in the lounge.", photoHair: "a neat low bun" });
    const base = { ...(npc().character.physicalCharacteristics as object) } as Record<string, unknown>;
    delete base.wardrobe; delete base.onCamera; delete base.photoHair;
    const res = sb.session.recordCastProfile({ houseguestId: id, physicalCharacteristics: base as never });
    expect(res.accepted).toBe(true);
    const p = npc().character.physicalCharacteristics as { wardrobe?: string[]; onCamera?: string; photoHair?: string };
    expect(p.wardrobe).toEqual(["a grey cardigan", "dark jeans"]);
    expect(p.onCamera).toBe("She sits in the lounge.");
    expect(p.photoHair).toBe("a neat low bun");
  });

  it("a name-only profile update on the warmed cast carries into the stored prose and demeanor", () => {
    const sess = new GameSessionAdapter();
    const warm = sess.preSeedCast({ seed: 7 });
    const hg = warm.house[0]!;
    const old = hg.name.split(" ")[0]!;
    const cast = (sess as unknown as { prewarm: { npcs: { id: string; name: string; character: Record<string, unknown> }[] } }).prewarm;
    const n = cast.npcs.find((x) => x.id === hg.id)!;
    n.character.biography = `${old} grew up near the water. ${old} fixes boats.`;
    n.character.demeanor = `${old} stays calm`;
    const res = sess.recordCastProfile({ houseguestId: hg.id, name: "Zephyra Quillon" });
    expect(res.publicFields).toContain("name");
    expect(n.name).toBe("Zephyra Quillon");
    expect(n.character.biography).toBe("Zephyra grew up near the water. Zephyra fixes boats.");
    expect(n.character.demeanor).toBe("Zephyra stays calm");
  });
});
