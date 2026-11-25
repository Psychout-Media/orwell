import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { answerPending } from "../../features/support/answerPending";
import { firstSeedWhereSync } from "../support/firstSeedWhere";

/**
 * ORW-916 (Fable's week-1 run, HOH turn 92 and veto turn 154): the player's own elimination in a staged competition was never told. The round line the narrator is handed named the player by the raw id word
 * ("<name>, player fall behind and are out; 5 remain. player quietly slips out"): the id humanizer left a bare "player" alone after a list comma and at a sentence start (it reads as the dictionary word there),
 * so the one result that was the player's own reached the narrator as lowercase machine text and was dropped from the telling.
 * REAL PATH: a played season through the player channel (a message each turn, every earlier decision answered, advance when due); nothing is set by hand. Every staged round event the engine emits (the same
 * humanized event the registry records and the narrator is handed) is collected; the first seed whose season drops the player in a staged competition is scanned for (ORW-880) and the assertion is on that round's
 * event: it names the player and carries no raw "player" token. Roles only (the player's name here is a placeholder).
 */
const NAME = "Zork Quill";
describe("the player's own elimination reaches the narrator by name (played)", () => {
  it("the round event that drops the player names them and carries no raw id word", () => {
    GameSessionAdapter.setTimeOfDayEnabled(true);
    const found = firstSeedWhereSync<{ content: string }>((seed, sandbox) => {
      const s = new GameSessionRegistry().sandboxFor(sandbox).session as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      s.createCharacter({ playerName: NAME, seed });
      const rounds: string[] = [];
      const prev = s.onEvent; // the registry's own sink: keep it, add a tap
      s.setOnEvent((ev: { beat: string; content: string }) => { if (ev.beat === "comp-elimination") rounds.push(String(ev.content)); prev?.(ev); });
      const mine = (): string | undefined => rounds.find((c) => c.includes(NAME) || /\bplayer\b/.test(c));
      let m = 0;
      for (let i = 0; i < 6000; i++) {
        s.noteMessage({ messageId: `m${m++}` });
        const live = s.snapshot().live, g = s.getGameState();
        if (live.finished) return undefined;
        const hit = mine(); if (hit) return { content: hit };
        if (g.pending && g.pending.kind !== "ceremony-step") { const r = answerPending(g.pending); if (r) s.submitDecision(r); continue; }
        if (s.milestoneDue() || g.pending) {
          const v = s.advanceGame();
          if (v.held && ["night", "late-night"].includes(live.timeOfDay)) s.turnIn();
          continue;
        }
        if (["night", "late-night"].includes(live.timeOfDay)) s.turnIn();
      }
      return undefined;
    }, { from: 1, to: 12, hint: 108, sandbox: (seed) => `drop916-${seed}`, what: "a staged competition round that drops the player" });
    expect(found.at.content, "the round line names the player").toContain(NAME);
    expect(found.at.content, "no raw 'player' id word stands in the round line").not.toMatch(/\bplayer\b/);
  }, 240_000);
});
