import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { LiveSeasonState } from "../../src/engine/liveSeason";
import { goodbyeRecordLines } from "../../src/engine/productionHost";
import { renderHostBlock } from "../../src/engine/momentPrompts";
import { plantLiveSentinels } from "../support/liveSentinelPlanting";

/**
 * ORW-719: the PLAYER is voted out on a played game. (1) The two cards the player owes (their exit interview, then the watch-or-skip choice) each
 * appear exactly once, in that order, survive a save/restore, and the night ends (bounded). (2) The houseguests' goodbyes are voiced from the
 * speaker's REAL public record with the player (handed as facts), never from invented history, and no hidden state rides with them. UNIT: the board is set by hand (the HOH chosen, the
 * player put on the block) and sentinels are planted (ORW-813: the played version is tests/uat/realPathPlayerEvicted.test.ts, the heavy lane). Roles only.
 */
type Any = Record<string, any>;

function boot(seed: number): { reg: GameSessionRegistry; s: Any } {
  const reg = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "orwell-719-"))));
  const s = reg.sandboxFor("u").session as unknown as Any;
  s.createCharacter({ playerName: "P", seed });
  s.noteMessage({ messageId: "m1" }); // a person is playing
  s.scheduleGateBypass = true;
  return { reg, s };
}

/** Play (through the real advance/submit path) to the eviction night, with the player on the block (the board is set the way hostEvictionNight.test.ts sets it). */
function toEvictionWithPlayerOnBlock(s: Any): void {
  for (let i = 0; i < 300; i++) {
    const live = s.live as LiveSeasonState;
    if (live.beat === "eviction" && !live.pending && !live.ceremony && !live.eviction) break;
    const p = s.advanceGame().pending;
    if (!p) continue;
    if (p.kind === "comp-round") s.submitDecision({ kind: "comp-round", intent: "compete" });
    else if (p.kind === "comp-intent") s.submitDecision({ kind: "comp-intent", intent: "compete" });
    else if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0].id, p.options[1].id] });
    else if (p.kind === "houseguests-choice") s.submitDecision({ kind: "houseguests-choice", pick: p.options[0].id });
    else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  }
  const live = s.live as LiveSeasonState;
  const others = live.active.filter((h) => h !== PLAYER);
  live.hoh = others[0]!;
  live.finalNominees = [PLAYER, others[1]!];
  live.nominees = [...live.finalNominees];
  live.preEvictionNightPassed = true;
}

/** Advance until the player is the evictee and the house's goodbyes are being staged; returns once the stage is `goodbye`. */
function toPlayerGoodbyes(s: Any): void {
  for (let i = 0; i < 80; i++) {
    const p = (s.live as LiveSeasonState).pending as Any | undefined;
    const ev = s.getGameState().eviction;
    if (ev?.stage === "goodbye" && ev.evictee?.id === PLAYER) return;
    if (p?.kind === "eviction-vote") s.submitDecision({ kind: "eviction-vote", vote: p.nominees.find((n: string) => n !== PLAYER) ?? p.nominees[0] });
    else if (p?.kind === "tie-break") s.submitDecision({ kind: "tie-break", vote: PLAYER });
    else s.advanceGame();
  }
  throw new Error("the player was never voted out");
}

/**
 * Find a seed where the voted-out player's night plays; every seed here is the same real path, so the first normally serves. The house rarely evicts the player from this hand-set board, so the
 * seeds known to do it are tried first, then 1..60 (ORW-779 moved them: of seeds 1..240, 70, 116 and 131 are the first that evict the player).
 */
const SEEDS = [70, 116, 131, ...Array.from({ length: 60 }, (_, i) => i + 1)];
function evictedPlayer(withSentinels = false): { s: Any; sentinels: string[] } {
  for (const seed of SEEDS) {
    const { reg, s } = boot(seed);
    const sentinels = withSentinels ? plantLiveSentinels(reg, "u", seed) : [];
    try {
      toEvictionWithPlayerOnBlock(s);
      toPlayerGoodbyes(s);
      return { s, sentinels };
    } catch { /* the player was spared on this seed: try the next */ }
  }
  throw new Error(`no seed of ${SEEDS.join(",")} voted the player out`);
}

describe("ORW-719 - the evicted player's own cards (unit: the board set by hand)", () => {
  it("raises the exit interview then the watch-or-skip choice, each exactly once, surviving save/restore, and the night ends", () => {
    const { s } = evictedPlayer();
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) {
      const v = s.advanceGame();
      if (v.pending) {
        seen.push(v.pending.kind);
        // a save/restore at the card: the card is the same one, not a second
        const snap = JSON.parse(JSON.stringify(s.snapshot()));
        s.restore(snap);
        expect(s.getGameState().pending?.kind).toBe(v.pending.kind);
        if (v.pending.kind === "exit-interview") s.submitDecision({ kind: "exit-interview", vote: v.pending.stances[0] });
        else if (v.pending.kind === "spectator-choice") { s.submitDecision({ kind: "spectator-choice", vote: "skip" }); break; }
        else throw new Error(`unexpected card ${v.pending.kind}`);
      }
    }
    expect(seen).toEqual(["exit-interview", "spectator-choice"]);
    // skip jumps ahead: the season finishes in a bounded number of advances with no further card for the player's eviction
    for (let i = 0; i < 8000 && !s.getGameState().finished; i++) {
      const p = s.advanceGame().pending;
      if (p) { expect(p.kind).not.toBe("spectator-choice"); expect(p.kind).not.toBe("exit-interview"); if (p.kind === "finale-interview") s.submitDecision({ kind: "finale-interview", vote: "gracious", statement: "x" }); else s.submitDecision({ kind: p.kind, vote: p.options?.[0]?.id }); }
    }
    expect(s.getGameState().finished).toBe(true);
  }, 120_000);
});

describe("ORW-719 - the goodbyes are voiced from the speaker's real record with the player (unit: the board set by hand, sentinels planted)", () => {
  it("hands each speaker's public record (facts only), the rule rides the eviction moment, and no hidden state is in it", () => {
    const { s, sentinels } = evictedPlayer(true);
    const ev = s.getGameState().eviction;
    const goodbyes = ev.host.goodbyes as Array<{ speaker: string; record: string[] }>;
    expect(goodbyes.length).toBeGreaterThan(0);
    for (const g of goodbyes) {
      expect(g.record.length).toBeGreaterThan(0);
      expect(g.speaker).not.toMatch(/npc:/);
    }
    const block = renderHostBlock(s.getGameState()).join("\n");
    expect(block).toContain("The house's goodbyes to the player");
    for (const g of goodbyes) expect(block).toContain(g.speaker);
    const moment = JSON.stringify(s.getMomentPrompt({}));
    for (const x of sentinels) { expect(JSON.stringify(ev.host)).not.toContain(x); expect(moment).not.toContain(x); }
    expect(moment).toContain("GOODBYES TO THE PLAYER");
  }, 120_000);

  it("states the real answered/unanswered record and says so when nothing is on file", () => {
    expect(goodbyeRecordLines({ approach: { week: 2, answered: false }, playerScenes: 0, speakerScenes: 0, putOnBlockByPlayerWeeks: [] }).join(" ")).toContain("has not answered");
    expect(goodbyeRecordLines({ approach: { week: 2, answered: true }, playerScenes: 0, speakerScenes: 0, putOnBlockByPlayerWeeks: [] }).join(" ")).toContain("the player answered");
    expect(goodbyeRecordLines({ playerScenes: 2, speakerScenes: 1, putOnBlockByPlayerWeeks: [1] })).toEqual([
      "the player went to them in 2 scenes the house saw", "they went to the player in 1 scene the house saw", "the player, as Head of Household, put them on the block in week 1"]);
    expect(goodbyeRecordLines({ playerScenes: 0, speakerScenes: 0, putOnBlockByPlayerWeeks: [] })).toEqual(["no scene, question or act between the two is on record"]);
  });
});
