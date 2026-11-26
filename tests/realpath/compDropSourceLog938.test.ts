import { describe, it, expect, vi } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { answerPending } from "../../features/support/answerPending";

/**
 * ORW-938 (evidence only): a staged competition writes ONE log line on its first drop round saying where the drop wording came from (the drawn library format, whether fiction was stored, whether the drops came
 * from it), so a premise that disagrees with how people go out can be read off the dev journal. No names, no wording. Played through the player channel; nothing set by hand.
 */
describe("a staged comp logs where its drop wording came from, once (played)", () => {
  it("one comp-drops line per comp, with the drawn format, and no houseguest name in it", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const s = new GameSessionRegistry().sandboxFor("comp-drop-log").session as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      s.createCharacter({ playerName: "The Player", seed: 108 });
      let m = 0, sawDrop = false;
      for (let i = 0; i < 6000 && !sawDrop; i++) {
        s.noteMessage({ messageId: `m${m++}` });
        const live = s.snapshot().live, g = s.getGameState();
        if ((g.ceremony?.competition?.out ?? []).length > 0) { sawDrop = true; break; }
        if (g.pending && g.pending.kind !== "ceremony-step") { const r = answerPending(g.pending); if (r) s.submitDecision(r); continue; }
        if (s.milestoneDue() || g.pending) { const v = s.advanceGame(); if (v.held && ["night", "late-night"].includes(live.timeOfDay)) s.turnIn(); continue; }
        if (["night", "late-night"].includes(live.timeOfDay)) s.turnIn();
      }
      expect(sawDrop, "a staged competition dropped someone").toBe(true);
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("comp-drops"));
      expect(lines.length, "one line for this comp, however many rounds it ran").toBe(1);
      expect(lines[0]).toMatch(/libraryFormat=(endurance|puzzle|quiz|skill|crapshoot|social) /);
      expect(lines[0]).toMatch(/dropsFromFiction=(true|false)/);
      const names = (s.getGameState().house as Array<{ name: string }>).map((h) => h.name);
      for (const n of names) expect(lines[0], "no houseguest name in the log").not.toContain(n);
    } finally { warn.mockRestore(); }
  }, 150_000);
});
