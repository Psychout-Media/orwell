import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * ORW-194 (Ryne 2026-11-06): "the champagne toast should include some more basic info since this is my first impressions of people. We have the photo but that's about it."
 * Each houseguest's toast card carries the PUBLIC basics - name, age, hometown, job, and how they come across - and the gathered-toast prompt tells the narrator to weave them in (narrated, not a data dump).
 * Public facets only: no archetype label spoken, no secrets, no numbers. Roles only.
 */
function premiere(seed: number) {
  const sb = new GameSessionRegistry().sandboxFor(`toast-${seed}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return sb;
}

describe("the champagne toast gives real first impressions", () => {
  it("every met houseguest card carries the public job and hometown", () => {
    const sb = premiere(4);
    const pr = sb.session.premiereIntros()!;
    expect(pr.met.length).toBe(15);
    for (const c of pr.met) {
      expect(typeof c.age, `${c.houseguest.id} age`).toBe("number");
      expect(c.vocation, `${c.houseguest.id} vocation`).toBeTruthy();
      expect(c.hometown, `${c.houseguest.id} hometown`).toBeTruthy();
    }
  });

  it("the gathered-toast prompt lists each houseguest's job and hometown and asks for a woven-in first impression", () => {
    const sb = premiere(7);
    const pr = sb.session.premiereIntros()!;
    const prompt = sb.session.getMomentPrompt({ moment: "premiere" }).systemPrompt;
    const sample = pr.met[0]!;
    expect(prompt).toContain(`works as ${sample.vocation}`);
    expect(prompt).toContain(`from ${sample.hometown}`);
    expect(prompt).toMatch(/real first impression/i);
    expect(prompt).toMatch(/never a data dump/i);
  });

  it("stays Vault-free: no secret, tie or hidden fields ride the card", () => {
    const sb = premiere(5);
    const c = JSON.stringify(sb.session.premiereIntros()!.met[0]);
    expect(c).not.toMatch(/hidden|secret|tie|soul|vault|trust|threat/i);
  });
});
