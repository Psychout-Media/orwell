import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { answerPending } from "../../features/support/answerPending";

/**
 * ORW-937 (Fable's week-2 veto): two houseguests went out in earlier replies and the narrator staged both going out again. The context now names the exits an earlier reply already voiced, and never
 * names one that went out since. Played through the player channel (a message each turn, every decision answered, advance when due); nothing is set by hand. Roles only.
 */
describe("a staged competition's earlier exits are marked already voiced (played)", () => {
  it("an exit in the last message's view is named as already voiced; one that went out since is not", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const s = new GameSessionRegistry().sandboxFor("comp-voiced-once").session as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    s.createCharacter({ playerName: "The Player", seed: 108 });
    const ctx = (): string => String(s.getMomentPrompt({ moment: "hoh-competition" }).systemPrompt);
    const outNow = (): string[] => (s.getGameState().ceremony.competition?.out ?? []).map((p: { name: string }) => p.name);
    let m = 0, prev: string[] = [], checked = 0, sawNew = false;
    for (let i = 0; i < 6000 && !(checked >= 1 && sawNew); i++) {
      s.noteMessage({ messageId: `m${m++}` });
      const out = outNow();
      if (out.length) {
        const line = ctx().split("\n").find((l) => l.includes("ALREADY VOICED")) ?? "";
        const voiced = prev.filter((n) => out.includes(n));
        if (voiced.length) { for (const n of voiced) expect(line, `${n} went out in an earlier reply`).toContain(n); checked++; }
        else expect(line, "nothing was out at the last message").toBe("");
        const fresh = out.filter((n) => !prev.includes(n));
        for (const n of fresh) { expect(line, `${n} went out since the last message`).not.toContain(n); sawNew = true; }
      }
      prev = out;
      const live = s.snapshot().live, g = s.getGameState();
      if (g.pending && g.pending.kind !== "ceremony-step") { const r = answerPending(g.pending); if (r) s.submitDecision(r); continue; }
      if (s.milestoneDue() || g.pending) {
        const v = s.advanceGame();
        if (v.held && ["night", "late-night"].includes(live.timeOfDay)) s.turnIn();
        continue;
      }
      if (["night", "late-night"].includes(live.timeOfDay)) s.turnIn();
    }
    expect(checked, "a message with an earlier voiced exit was checked").toBeGreaterThanOrEqual(1);
    expect(sawNew, "a fresh exit was seen not named as voiced").toBe(true);
  }, 150_000);
});
