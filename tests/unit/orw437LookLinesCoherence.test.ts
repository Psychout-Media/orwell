import { describe, it, expect } from "vitest";
import { validateDossierCoherence, repairDossierCoherence } from "../../src/engine/castingIntake";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

// Review of #2665: the shoot-day look lines (photoHair, onCamera) reach the portrait prompt, so a pronoun that
// contradicts the pinned gender in them is a cast-coherence contradiction like the one in `hair`.
describe("ORW-437 look lines are scanned for a wrong-gender pronoun", () => {
  it("flags and clears a photoHair line that calls a woman 'his'", () => {
    const d = { genderPresentation: "woman" as const, physicalCharacteristics: { hair: "long black hair", photoHair: "swept back off his face" } };
    expect(validateDossierCoherence(d).repairFields).toEqual(["physicalCharacteristics.photoHair"]);
    expect(repairDossierCoherence(d).repaired.physicalCharacteristics?.photoHair).toBeUndefined();
  });
  it("flags an onCamera line with the other gender's pronoun, and leaves matching and neutral lines alone", () => {
    const bad = { genderPresentation: "man" as const, physicalCharacteristics: { onCamera: "she leans on the counter, arms folded" } };
    expect(validateDossierCoherence(bad).repairFields).toEqual(["physicalCharacteristics.onCamera"]);
    for (const ok of ["his arms folded, leaning on the counter", "arms folded, leaning on the counter"]) {
      expect(validateDossierCoherence({ genderPresentation: "man" as const, physicalCharacteristics: { onCamera: ok, photoHair: ok } }).repairFields).toEqual([]);
    }
  });
  it("season start clears the bad photoHair on the real card and keeps the rest of the look", () => {
    const s = new GameSessionAdapter();
    s.createCharacter({ playerName: "The Player", seed: 7 });
    type Npc = { character: { genderPresentation?: string; physicalCharacteristics?: Record<string, unknown> } };
    const npc = (s as unknown as { house: { npcs: Npc[] } }).house.npcs[0]!;
    npc.character.genderPresentation = "woman";
    npc.character.physicalCharacteristics = { hair: "long black hair", photoHair: "swept back off his face", onCamera: "arms folded" };
    (s as unknown as { enforceCastCoherence: () => unknown }).enforceCastCoherence();
    expect(npc.character.physicalCharacteristics!.photoHair).toBeUndefined();
    expect(npc.character.physicalCharacteristics!.onCamera).toBe("arms folded");
    expect(npc.character.physicalCharacteristics!.hair).toBe("long black hair");
  });
});
