import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";

/**
 * ORW-1133 (Ryne, 2026-11-28 prod game): "Valerie just introduced herself to me for like the 3rd time in a row". In the staged-entrances flow the premiere prompt printed NO engine line once the circle had
 * closed (the "circle has closed" line lived only on the old no-entrance path), so the fragment's "OVERRIDE once the engine truth reports it DONE" had nothing to trigger on and the narrator kept re-running
 * introductions for the whole social hold. Roles only.
 */
function sandboxAt(stage: "toast" | "done", seed = 5) {
  const sb = new GameSessionRegistry().sandboxFor(`closed-${stage}-${seed}`);
  sb.session.setPremiereEntrancesEnabled(true);
  sb.session.createCharacter({ playerName: "The Player", seed });
  for (let i = 0; i < 60 && sb.session.premiereIntros()?.entrance?.stage !== stage; i++) sb.session.advanceGame();
  return sb;
}

describe("the closed champagne circle is an engine truth in the entrances flow", () => {
  it("once the entrance stage is done the premiere prompt says the circle has closed and introductions are over", () => {
    const sb = sandboxAt("done");
    expect(sb.session.premiereIntros()!.entrance!.stage).toBe("done");
    const prompt = sb.session.getMomentPrompt({ moment: "premiere" }).systemPrompt;
    expect(prompt).toContain("THE CIRCLE HAS CLOSED (engine truth)");
    expect(prompt).toMatch(/Nobody introduces themselves again/);
    expect(prompt).toMatch(/never repeat a line a houseguest has already said/);
  });
  it("while the toast is still running there is no closed-circle line", () => {
    const sb = sandboxAt("toast");
    expect(sb.session.premiereIntros()!.entrance!.stage).toBe("toast");
    const prompt = sb.session.getMomentPrompt({ moment: "premiere" }).systemPrompt;
    expect(prompt).not.toContain("THE CIRCLE HAS CLOSED (engine truth)");
  });
});
