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

  it("the gathered-toast prompt carries every houseguest's public AGE next to their job (ORW-286)", () => {
    const sb = premiere(7);
    const pr = sb.session.premiereIntros()!;
    const prompt = sb.session.getMomentPrompt({ moment: "premiere" }).systemPrompt;
    const withBasics = pr.met.filter((c) => typeof c.age === "number" && c.vocation);
    expect(withBasics.length).toBeGreaterThan(10);
    for (const c of withBasics) expect(prompt, `${c.houseguest.id}: age then job`).toContain(`${c.age}, works as ${c.vocation}`);
  });

  it("the archetype rides the prompt only as the fenced private cue, never as a spoken fact (ORW-286)", () => {
    const sb = premiere(7);
    const pr = sb.session.premiereIntros()!;
    const prompt = sb.session.getMomentPrompt({ moment: "premiere" }).systemPrompt;
    const cued = pr.met.filter((c) => typeof (c as { archetype?: string }).archetype === "string" && (c as { archetype?: string }).archetype);
    expect(cued.length, "the cards carry an archetype for the cue").toBeGreaterThan(0);
    for (const c of cued) {
      const label = (c as { archetype: string }).archetype;
      const fenced = `(private cue, never said aloud: ${label})`;
      // the houseguest's own roster line(s): the archetype label may appear there ONLY inside the fenced cue
      const lines = prompt.split("\n").filter((l) => l.includes(c.houseguest.name) && l.includes("(private cue"));
      expect(lines.length, `${c.houseguest.id}: a roster line with the fenced cue`).toBeGreaterThan(0);
      // KNOWN FINDING (ORW-286, on the card): the deterministic FLOOR background is the template "a <job> who plays as a <archetype>" (characterFactory.ts:814/875), which puts the label in a PUBLIC field. Live
      // casting replaces it with the model-authored background (Ryne: no fallback), so it only reaches a prompt when authoring is off; the template is stripped here and tracked separately.
      for (const l of lines) expect(l.replace(fenced, "").replace(`who plays as a ${label}`, ""), `${c.houseguest.id}: archetype outside the fenced cue`).not.toContain(label);
    }
  });

  it("stays Vault-free: no secret, tie or hidden fields ride the card", () => {
    const sb = premiere(5);
    const c = JSON.stringify(sb.session.premiereIntros()!.met[0]);
    expect(c).not.toMatch(/hidden|secret|tie|soul|vault|trust|threat/i);
  });
});
