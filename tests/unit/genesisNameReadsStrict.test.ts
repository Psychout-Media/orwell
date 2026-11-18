import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { nameGenderOf, nameGenderStrict } from "../../src/engine/data/nameGender";

describe("the strict name read knows names the lexicon does not list", () => {
  it("keeps the lexicon first and leaves the seeded read alone", () => {
    expect(nameGenderStrict("James")).toBe("man");
    expect(nameGenderStrict("Emma")).toBe("woman");
    expect(nameGenderStrict("Jordan")).toBe("unisex");
    expect(nameGenderOf("Beth")).toBe("unisex");      // the seeded read is untouched (its output is pinned)
    expect(nameGenderOf("Eldon")).toBe("unisex");
  });
  it("reads a listed-nowhere name from the public birth counts or the writer-name extras", () => {
    expect(nameGenderStrict("Beth")).toBe("woman");
    expect(nameGenderStrict("Mallory")).toBe("woman");
    expect(nameGenderStrict("Dirk")).toBe("man");
    expect(nameGenderStrict("Eldon")).toBe("man");
    expect(nameGenderStrict("Robert")).toBe("man");
  });
  it("never guesses: a near-even name and a name in no list stay unisex", () => {
    expect(nameGenderStrict("Jamie")).toBe("unisex");
    expect(nameGenderStrict("Dre")).toBe("unisex");
    expect(nameGenderStrict("Zzyzx")).toBe("unisex");
  });
});

describe("recordCastGenesis re-picks a writer-invented name that contradicts the pinned presentation", () => {
  it.each([["man", "Beth"], ["woman", "Eldon"]] as const)("a %s named %s is given a name that fits the pin", (pin, wrongGiven) => {
    const s = new GameSessionAdapter();
    const SEED = 987654;
    const warm = s.preSeedCast({ seed: SEED });
    const target = warm.house.find((c) => c.genderPresentation === pin)!;
    expect(target).toBeTruthy();
    expect(nameGenderOf(wrongGiven)).toBe("unisex"); // the lexicon never saw it: the old coherence step left it alone
    expect(s.recordCastGenesis({ npcs: [{ id: target.id, name: `${wrongGiven} Rivera` }] }).accepted).toBe(true);
    s.createCharacter({ playerName: "The Player", seed: SEED });
    const live = s.getGameState().house.find((h) => h.id === target.id)!;
    expect(live.genderPresentation).toBe(pin);
    expect(nameGenderStrict(live.name.split(" ")[0]!)).not.toBe(pin === "man" ? "woman" : "man");
    expect(live.name.split(" ")[0]).not.toBe(wrongGiven);
  });
  it("a nonbinary pin and a near-even name are left alone", () => {
    const s = new GameSessionAdapter();
    const SEED = 424242;
    const warm = s.preSeedCast({ seed: SEED });
    const target = warm.house.find((c) => c.genderPresentation === "man" || c.genderPresentation === "woman")!;
    expect(s.recordCastGenesis({ npcs: [{ id: target.id, name: "Jamie Rivera" }] }).accepted).toBe(true);
    s.createCharacter({ playerName: "The Player", seed: SEED });
    expect(s.getGameState().house.find((h) => h.id === target.id)!.name).toBe("Jamie Rivera");
  });
});
