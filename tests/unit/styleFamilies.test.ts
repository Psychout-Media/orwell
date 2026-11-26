import { describe, it, expect } from "vitest";
import { STYLE_FAMILIES, STYLE_FAMILY_LABELS, familyForLabel, familiesMentioned } from "../../src/domain/styleFamilies";
import { cleanWardrobe, cleanOnCamera, cleanPhotoHair } from "../../src/domain/physicalCharacteristics";
import { generateHouse } from "../../src/engine/characterFactory";
import { generateCastDeepLayer } from "../../src/engine/deepProfile";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { physicalFacetToAppearance } from "../../src/engine/portraitPrompts";
import { applyClosedFacetGuard } from "../../src/engine/facetDiff";
import { serialize, deserialize } from "../../src/domain/saveState";

// ORW-360: one style list, one authority; dealt once; two new optional look fields.

describe("ORW-360 style families — the one list", () => {
  it("has 30 families with unique ids, labels and samples", () => {
    expect(STYLE_FAMILIES.length).toBe(30);
    expect(new Set(STYLE_FAMILIES.map((f) => f.id)).size).toBe(30);
    expect(new Set(STYLE_FAMILY_LABELS).size).toBe(30);
    expect(new Set(STYLE_FAMILIES.map((f) => f.sample)).size).toBe(30);
  });

  it("every family has 3-6 keywords and no keyword is shared, repeated or nested across families", () => {
    const all: { k: string; id: string }[] = [];
    for (const f of STYLE_FAMILIES) {
      expect(f.keywords.length).toBeGreaterThanOrEqual(3);
      expect(f.keywords.length).toBeLessThanOrEqual(6);
      for (const k of f.keywords) all.push({ k: k.toLowerCase(), id: f.id });
    }
    expect(new Set(all.map((a) => a.k)).size).toBe(all.length);
    for (const a of all) for (const b of all) {
      if (a.id !== b.id) expect(b.k.includes(a.k), `${a.k} (${a.id}) inside ${b.k} (${b.id})`).toBe(false);
    }
  });

  it("each family's own sample reads as that family and no other", () => {
    for (const f of STYLE_FAMILIES) {
      const hit = familiesMentioned(`${f.label} ${f.sample}`);
      expect(hit, f.id).toContain(f.id);
      expect(hit.filter((h) => h !== f.id), f.id).toEqual([]);
    }
  });

  it("over 40 seeds every 15-cast has 15 different presentation families and the seeded style is its sample", () => {
    for (let i = 0; i < 40; i++) {
      const seed = 11 + i * 131;
      const { npcs } = generateHouse(new SeededRandom(seed));
      const labels = npcs.map((n) => n.character.presentation);
      expect(new Set(labels).size).toBe(labels.length);
      const layer = generateCastDeepLayer(seed, npcs);
      for (const n of npcs) {
        const fam = familyForLabel(n.character.presentation)!;
        expect(fam).toBeDefined();
        expect(layer.public[n.id]!.physicalCharacteristics.style.startsWith(`${fam.sample}, `)).toBe(true); // the sample plus one accent (ORW-508)
      }
    }
  });
});

describe("ORW-360 wardrobe / onCamera cleaning", () => {
  it("clamps items to 60 chars and 3 items, strips control chars, drops empties", () => {
    const w = cleanWardrobe(["  a\u0007 b ", "x".repeat(100), "", "third", "fourth"])!;
    expect(w.length).toBe(3);
    expect(w[0]).toBe("a b");
    expect(w[1]!.length).toBe(60);
    expect(cleanWardrobe("nope")).toBeUndefined();
    expect(cleanWardrobe([" ", ""])).toBeUndefined();
  });
  it("ORW-437: C1 controls are stripped, and fewer than two wardrobe items is not a facet", () => {
    expect(cleanWardrobe(["a\u0085b", "c\u009fd"])).toEqual(["a b", "c d"]);
    expect(cleanWardrobe(["only one piece"])).toBeUndefined();
    expect(cleanWardrobe(["one", " "])).toBeUndefined();
    expect(cleanOnCamera("a\u0085b")).toBe("a b");
  });
  it("ORW-437: photoHair clamps to 90 chars, strips controls and drops an empty line", () => {
    expect(cleanPhotoHair("h".repeat(300))!.length).toBe(90);
    expect(cleanPhotoHair("a\u0000b\u0085c")).toBe("a b c");
    expect(cleanPhotoHair("  ")).toBeUndefined();
  });
  it("clamps onCamera to 240 chars and strips control characters", () => {
    expect(cleanOnCamera("y".repeat(500))!.length).toBe(240);
    expect(cleanOnCamera("a\u0000b\nc")).toBe("a b c");
    expect(cleanOnCamera("   ")).toBeUndefined();
  });
});

const facet = () => ({
  heightBuild: "tall and lean", skinTone: "warm tan complexion", hair: "short dark hair",
  facialFeatures: "a square jaw", distinguishingMark: "none notable",
  ageLook: "fresh-faced, late-twenties look", style: "sporty and laid-back",
});

describe("ORW-360 recordCastProfile carries wardrobe and onCamera", () => {
  it("stores, clamps and projects both; the narrator appearance string is unchanged", () => {
    const s = new GameSessionAdapter();
    const warm = s.preSeedCast({ seed: 5 });
    const id = warm.house[0]!.id;
    const base = facet();
    const res = s.recordCastProfile({
      houseguestId: id,
      physicalCharacteristics: {
        ...base, wardrobe: ["a canvas jacket", "x".repeat(90), "work boots", "extra"],
        onCamera: `leans in, steady gaze; at the kitchen counter.${"!".repeat(300)}`,
      },
    });
    expect(res.accepted).toBe(true);
    const card = s.preSeedCast({ seed: 5 }).house.find((h) => h.id === id)! as unknown as {
      physicalCharacteristics?: Record<string, unknown>;
    };
    const pc = card.physicalCharacteristics as unknown as { wardrobe: string[]; onCamera: string } & typeof base;
    expect(pc.wardrobe.length).toBe(3);
    expect(pc.wardrobe[1]!.length).toBe(60);
    expect(pc.onCamera.length).toBe(240);
    // L29: the narrator's appearance string ignores both new fields.
    expect(physicalFacetToAppearance(pc)).toBe(physicalFacetToAppearance({ ...pc, wardrobe: undefined, onCamera: undefined }));
    expect(physicalFacetToAppearance(pc)).not.toContain("canvas");
  });

  it("the ink guard reverts a tattoo written into onCamera or wardrobe on a no-ink skeleton", () => {
    const prior = facet();
    const r1 = applyClosedFacetGuard(prior as Record<string, unknown>, { ...prior, onCamera: "a full sleeve tattoo on show, at the kitchen counter" }, undefined);
    expect(r1.conflicts).toEqual(["visible-ink"]);
    expect((r1.physicalCharacteristics as Record<string, unknown>).onCamera).toBeUndefined();
    const r2 = applyClosedFacetGuard(prior as Record<string, unknown>, { ...prior, wardrobe: ["tank top", "tattoo sleeves"] }, undefined);
    expect(r2.conflicts).toEqual(["visible-ink"]);
    expect((r2.physicalCharacteristics as Record<string, unknown>).wardrobe).toBeUndefined();
    const ok = applyClosedFacetGuard(prior as Record<string, unknown>, { ...prior, wardrobe: ["tank top", "boots"], onCamera: "calm; lounge." }, undefined);
    expect(ok.conflicts).toEqual([]);
  });

  it("a pre-change save (no wardrobe / onCamera) round-trips unchanged", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "The Player", seed: 21 });
    const state = s.getGameState();
    const back = deserialize(serialize(state as never));
    expect(JSON.stringify(back)).toBe(JSON.stringify(state));
    for (const h of state.house) {
      const pc = (h as unknown as { physicalCharacteristics?: Record<string, unknown> }).physicalCharacteristics;
      if (pc) { expect("wardrobe" in pc).toBe(false); expect("onCamera" in pc).toBe(false); }
    }
  });
});
