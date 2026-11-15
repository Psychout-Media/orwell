import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { validateDossierCoherence, repairDossierCoherence, dropOffendingStorySentences } from "../../src/engine/castingIntake";

// ORW-430: season start must not blank a biography that agrees with the card. The validator flags a biography only
// for a span or grandparent self-reference, and read spans in sentences about other people and things.

type Gender = "man" | "woman" | "nonbinary";
const FIX = JSON.parse(readFileSync(new URL("../fixtures/orw430_correct_biographies.json", import.meta.url), "utf8")) as {
  cases: { name: string; gender: Gender; age: number; vocation: string; biography: string }[];
};

describe("ORW-430 a correct biography is never flagged", () => {
  for (const c of FIX.cases) {
    it(c.name, () => {
      const d = { genderPresentation: c.gender, age: c.age, vocation: c.vocation, biography: c.biography };
      const r = validateDossierCoherence(d);
      expect(r.repairFields).toEqual([]);
      expect(repairDossierCoherence(d).repaired.biography).toBe(c.biography);
    });
  }
});

describe("ORW-430 a real contradiction is mended, not blanked", () => {
  const good = "She waits tables at a Macon diner and knows every regular by their order. ";
  it("keeps the correct sentences and drops only the sentence with the impossible span", () => {
    const bio = `${good}She spent thirty years behind the counter.`;
    const d = { genderPresentation: "woman" as const, age: 22, vocation: "diner server", biography: bio };
    expect(validateDossierCoherence(d).repairFields).toEqual(["biography"]);
    expect(repairDossierCoherence(d).repaired.biography).toBe(good.trim());
  });
  it("a biography that is only the bad sentence is cleared (no text is invented)", () => {
    expect(dropOffendingStorySentences("She spent thirty years behind the counter.", 22, "diner server")).toBeUndefined();
  });
  it("a grandparent self-reference on a 22-year-old is still caught", () => {
    const d = { genderPresentation: "woman" as const, age: 22, biography: `${good}Her grandkids visit on Sundays.` };
    expect(validateDossierCoherence(d).repairFields).toEqual(["biography"]);
  });
  it("a span about the houseguest is still caught when a thing word sits elsewhere in the sentence (review of #2742)", () => {
    for (const bio of [
      "She spent thirty years standing behind the counter.",
      "She has spent thirty years on the job with a long history of regulars.",
      "She spent thirty years operating the grill.",
      "She spent thirty years on the job.",
    ]) {
      const d = { genderPresentation: "woman" as const, age: 25, vocation: "diner server", biography: `${good}${bio}` };
      expect(validateDossierCoherence(d).repairFields, bio).toEqual(["biography"]);
    }
  });
  it("a role-holder around the houseguest is not the houseguest even when the houseguest holds that role", () => {
    const d = { genderPresentation: "woman" as const, age: 25, vocation: "teacher", biography: "She teaches fifth grade. Her teacher spent thirty years at the school." };
    expect(validateDossierCoherence(d).repairFields).toEqual([]);
    const own = { genderPresentation: "woman" as const, age: 25, vocation: "teacher", biography: "She teaches fifth grade. She spent thirty years as a teacher." };
    expect(validateDossierCoherence(own).repairFields).toEqual(["biography"]);
  });
  it("a background with the span is judged as the background, not the biography", () => {
    const d = { genderPresentation: "woman" as const, age: 22, biography: good.trim(), background: "thirty years inside the courthouse machine" };
    expect(validateDossierCoherence(d).repairFields).toEqual(["background"]);
  });
});

import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";

describe("ORW-430 season start (createCharacter adopting a warm cast) keeps the correct biography", () => {
  type Snap = ReturnType<GameSessionAdapter["snapshot"]>;
  // Warm a cast, put a biography on one warmed houseguest through the durable snapshot (the production hand-off), then
  // finalize a live season that ADOPTS the warm: the one production caller of the coherence gate (review of #2742).
  const startWith = (biography: string) => {
    const seed = 7;
    const warm = new GameSessionAdapter();
    warm.preSeedCast({ seed });
    const snap: Snap = warm.snapshot();
    const npc = snap.prewarm!.npcs[0]!;
    npc.character.genderPresentation = "woman";
    npc.character.age = 22;
    npc.character.biography = biography;
    (npc.character as { deepProfileAuthored?: boolean }).deepProfileAuthored = true;
    const s = new GameSessionAdapter();
    s.restore(JSON.parse(JSON.stringify(snap)));
    const view = s.createCharacter({ playerName: "The Player", seed });
    const live = s.snapshot().house!.npcs.find((n) => n.id === npc.id)!.character as { biography?: string; deepProfileAuthored?: boolean };
    return { live, view, id: npc.id };
  };
  const good = "She waits tables at a Macon diner and knows every regular by their order.";

  it("keeps the correct sentences of a biography with one impossible span, and the card stays authored", () => {
    const { live, view, id } = startWith(`${good} She spent thirty years behind the counter.`);
    expect(live.biography).toBe(good);
    expect(live.deepProfileAuthored).toBe(true);
    expect(view.castCoherence?.houseguests.some((h) => h.id === id && h.fields.includes("biography"))).toBe(true);
  });

  it("a biography with nothing left is cleared and the card counts as NOT authored, so the backfill writes it again", () => {
    const { live } = startWith("She spent thirty years behind the counter.");
    expect(live.biography).toBeUndefined();
    expect(live.deepProfileAuthored).toBe(false);
  });

  it("a correct biography is left byte-for-byte and is not reported", () => {
    const bio = "Her father ran the Macon diner where he taught her to carry four plates. Her brother still cooks there and his pancakes are famous.";
    const { live, view, id } = startWith(bio);
    expect(live.biography).toBe(bio);
    expect(view.castCoherence?.houseguests.some((h) => h.id === id)).not.toBe(true);
  });
});
