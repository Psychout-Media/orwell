import { describe, it, expect } from "vitest";
import { startNewGame } from "../../src/engine/characterFactory";
import { generateDiversityLayer, orientationFits, orientationFromAxes } from "../../src/engine/diversity";
import { MIN_QUEER } from "../../src/engine/diversityConstants";
import type { Orientation } from "../../src/engine/diversityConstants";
import type { GenderPresentation } from "../../src/engine/diversityConstants";

/**
 * ORW-893 - the seeded orientation is read off independent continuous attractions against the houseguest's OWN gender presentation, so a label always fits it ("lesbian" is a woman's, "gay" a man's), and the
 * draw is realistic (about a tenth of a cast with a meaningful same-gender attraction, the floor of MIN_QUEER repairing a small cast up) instead of uniform over the labels (about 5 in 6 queer). Roles only.
 */
const layerOf = (seed: number) => { const house = startNewGame({ seed, playerName: "The Player" }); return { house, layer: generateDiversityLayer(seed, house.npcs) }; };
const orientationOf = (layer: ReturnType<typeof generateDiversityLayer>, id: string): Orientation | undefined => layer.public[id]!.outOrientation ?? layer.privateOrientations[id];

describe("orientation is a relation to one's own presentation", () => {
  it("every label read off the axes fits the presentation, for any attractions", () => {
    for (const g of ["man", "woman", "nonbinary"] as GenderPresentation[]) for (let i = 0; i < 400; i++) {
      const a = { same: (i * 0.618) % 1, other: (i * 0.377) % 1, genderBlind: (i * 0.911) % 1, selfLabel: (i * 0.529) % 1 };
      for (const force of [false, true]) expect(orientationFits(orientationFromAxes(a, g, force), g), `${g} ${i} ${force}`).toBe(true);
    }
  });
  it("same-only is gay for a man, lesbian for a woman, queer for a nonbinary houseguest; both is bi, pan or queer; neither is straight", () => {
    const base = { genderBlind: 0, selfLabel: 0 };
    expect(orientationFromAxes({ ...base, same: 0.9, other: 0 }, "man")).toBe("gay");
    expect(orientationFromAxes({ ...base, same: 0.9, other: 0 }, "woman")).toBe("lesbian");
    expect(orientationFromAxes({ ...base, same: 0.9, other: 0 }, "nonbinary")).toBe("queer");
    expect(orientationFromAxes({ ...base, same: 0.9, other: 0.9 }, "man")).toBe("bisexual");
    expect(orientationFromAxes({ same: 0.9, other: 0.9, genderBlind: 0.9, selfLabel: 0 }, "woman")).toBe("pansexual");
    expect(orientationFromAxes({ same: 0.9, other: 0.9, genderBlind: 0, selfLabel: 0.95 }, "woman")).toBe("queer");
    expect(orientationFromAxes({ ...base, same: 0.05, other: 0.9 }, "woman")).toBe("straight");
    expect(orientationFromAxes({ ...base, same: 0.05, other: 0.05 }, "man")).toBe("straight");
  });
});

describe("the seeded cast (the no-model floor), over 200 seeds", () => {
  const seeds = Array.from({ length: 200 }, (_, i) => i + 1);
  const casts = seeds.map((s) => layerOf(s));
  it("no houseguest carries a label that does not fit their final presentation", () => {
    for (const [i, { house, layer }] of casts.entries()) for (const n of house.npcs) {
      const o = orientationOf(layer, n.id);
      if (o === undefined) continue; // straight: carried by neither the out facet nor the private map
      expect(orientationFits(o, layer.public[n.id]!.genderPresentation), `seed ${seeds[i]} ${n.id}`).toBe(true);
    }
  });
  it("a cast is mostly straight (the share with a non-straight orientation is realistic) and the floor still holds", () => {
    let queerOrientation = 0, total = 0;
    for (const { house, layer } of casts) {
      const queer = house.npcs.filter((n) => orientationOf(layer, n.id) !== undefined || layer.public[n.id]!.genderPresentation === "nonbinary").length;
      expect(queer).toBeGreaterThanOrEqual(MIN_QUEER);
      queerOrientation += house.npcs.filter((n) => orientationOf(layer, n.id) !== undefined).length; total += house.npcs.length;
    }
    const share = queerOrientation / total;
    expect(share, `non-straight share ${share.toFixed(3)}`).toBeGreaterThan(0.05);
    expect(share, `non-straight share ${share.toFixed(3)}`).toBeLessThan(0.2); // was about 0.83 (a uniform draw over 5 queer labels of 6)
  });
  it("the whole set of labels still occurs (the draw is open, the labels are only what it reads out as)", () => {
    const seen = new Set<string>();
    for (const { house, layer } of casts) for (const n of house.npcs) { const o = orientationOf(layer, n.id); if (o) seen.add(o); }
    for (const label of ["gay", "lesbian", "bisexual", "queer", "pansexual"]) expect(seen.has(label), label).toBe(true);
  });
  it("a PROPOSED orientation is kept when it fits the final presentation and dropped to the drawn one when it does not", () => {
    const { house } = layerOf(3);
    const man = house.npcs.find((n) => generateDiversityLayer(3, house.npcs).public[n.id]!.genderPresentation === "man")!;
    const asked = generateDiversityLayer(3, house.npcs, { [man.id]: { orientation: "lesbian" } });
    const o = orientationOf(asked, man.id);
    expect(o === undefined || orientationFits(o, asked.public[man.id]!.genderPresentation)).toBe(true);
    expect(o).not.toBe("lesbian");
    const woman = house.npcs.find((n) => generateDiversityLayer(3, house.npcs).public[n.id]!.genderPresentation === "woman")!;
    const fits = generateDiversityLayer(3, house.npcs, { [woman.id]: { orientation: "lesbian", out: true } });
    expect(orientationOf(fits, woman.id)).toBe("lesbian");
  });
});
