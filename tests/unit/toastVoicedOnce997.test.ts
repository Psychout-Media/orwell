import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * ORW-997: when the front end reports that an earlier reply already voiced the latest staged-premiere release (`entranceVoiced`), the moment prompt marks it so: the batch (or the arrival) is not handed over as
 * something to voice, no speaker facts ride along, and no later speaker is named. Without the flag the prompt is as it was. Roles only.
 */
let n = 0;
function circle(seed: number) {
  const sb = new GameSessionRegistry().sandboxFor(`tv997-${n++}`);
  sb.session.setPremiereEntrancesEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed });
  for (let i = 0; i < 40 && sb.session.premiereIntros()?.entrance?.stage === "entrances"; i++) sb.session.advanceGame();
  return sb;
}

describe("a toast batch already voiced is marked so in the moment prompt", () => {
  it("unflagged, the batch lists its speakers and their facts; flagged, it lists none and names nobody to come", () => {
    const sb = circle(41);
    sb.session.advanceGame();
    sb.session.advanceGame(); // a batch with a houseguest speaker is on the board
    const e = sb.session.premiereIntros()!.entrance!;
    const names = (e.speakers ?? []).filter((x) => !x.host && !x.isPlayer).map((x) => x.name);
    expect(names.length).toBeGreaterThan(0);
    const plain = sb.session.getMomentPrompt({ moment: "premiere" }).systemPrompt;
    const voiced = sb.session.getMomentPrompt({ moment: "premiere", entranceVoiced: true }).systemPrompt;
    const line = (p: string) => p.split("\n").filter((l) => l.includes("THE TOAST")).join("\n");
    for (const nm of names) expect(plain).toContain(`${nm}'s facts`);
    expect(line(voiced)).toMatch(/ALREADY BEEN VOICED/);
    expect(line(voiced)).toMatch(/NOT been committed/);
    for (const nm of names) {
      expect(line(voiced), `${nm} is not listed as a speaker`).not.toContain(nm);
      expect(voiced, `${nm}'s facts are not handed over`).not.toContain(`${nm}'s facts`);
    }
    expect(line(voiced)).not.toMatch(/Call advanceGame for the next batch/);
    expect(line(plain)).not.toMatch(/ALREADY BEEN VOICED/);
  });

  it("a flagged entrance says the latest arrival was voiced and carries no just-arrived vignette", () => {
    const sb = new GameSessionRegistry().sandboxFor(`tv997-${n++}`);
    sb.session.setPremiereEntrancesEnabled(true);
    sb.session.createCharacter({ playerName: "The Player", seed: 42 });
    for (let i = 0; i < 8; i++) sb.session.advanceGame();
    const e = sb.session.premiereIntros()!.entrance!;
    expect(e.stage).toBe("entrances");
    const plain = sb.session.getMomentPrompt({ moment: "premiere" }).systemPrompt;
    const voiced = sb.session.getMomentPrompt({ moment: "premiere", entranceVoiced: true }).systemPrompt;
    expect(plain).toContain("JUST ARRIVED");
    expect(voiced).not.toContain("JUST ARRIVED");
    expect(voiced).toMatch(/LATEST ARRIVAL[^\n]*ALREADY BEEN VOICED/);
  });

  it("the flag never reaches the HUD view", () => {
    const sb = circle(43);
    sb.session.advanceGame();
    sb.session.getMomentPrompt({ moment: "premiere", entranceVoiced: true });
    expect((sb.session.premiereIntros()!.entrance as { voiced?: boolean }).voiced).toBeUndefined();
  });
});
