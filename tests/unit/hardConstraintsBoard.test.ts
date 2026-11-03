import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "../../features/support/answerPending";

/**
 * A-15 (rehearsal 2026-11-03): the narrator kept inventing ceremony facts (wrong veto winner, wrong evictee, even different
 * NOMINEES in dialogue) because the committed board lived only mid-prompt (GAME CONTEXT's roster tags + ceremony block, deep
 * in a ~50 KB system prompt). The terminal HARD-CONSTRAINTS block — the LAST message, nearest generation — carried occupancy
 * and pronouns but not the board. In ceremony phases it now ends with a short engine-committed BOARD recap (HOH, nominees,
 * veto, ballots revealed), so the facts the model must use are the last thing it reads. Byte-identical outside ceremonies.
 * Roles only.
 */
let n = 0;
function driveTo(pred: (s: GameSessionAdapter, v: ReturnType<GameSessionAdapter["advanceGame"]>) => boolean): GameSessionAdapter {
  for (let seed = 1; seed <= 40; seed++) {
    const s = new GameSessionRegistry().sandboxFor(`hcb${n++}`).session;
    s.createCharacter({ playerName: "P", seed });
    for (let i = 0; i < 4000; i++) {
      const v = s.advanceGame();
      if (pred(s, v)) return s;
      if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
      if (v.finished) break;
    }
  }
  throw new Error("predicate never satisfied");
}
const hc = (s: GameSessionAdapter): string => s.getMomentPrompt({}).hardConstraints ?? "";

describe("the terminal HARD-CONSTRAINTS block ends with the engine-committed board in ceremony phases", () => {
  it("veto phase: HOH, the exact nominees, and 'no winner yet' while the veto is still being played", () => {
    const s = driveTo((ss) => ss.getGameState().phase === "veto-competition" && (ss.getGameState().ceremony.nominees.length === 2));
    const gs = s.getGameState();
    const block = hc(s);
    expect(block).toContain("BOARD");
    expect(block).toContain(gs.ceremony.hoh!.name);
    for (const nm of gs.ceremony.nominees) expect(block).toContain(nm.name);
    expect(block).toMatch(/Veto:[^\n]*(not yet|still being played)[^\n]*name no winner/i);
    expect(block.lastIndexOf("BOARD")).toBeGreaterThan(block.indexOf("HARD CONSTRAINTS"));
  });

  it("eviction card open: states that NO ballot has been read yet and the vote is the player's", () => {
    const s = driveTo((_ss, v) => v.pending?.kind === "eviction-vote");
    expect(s.getGameState().pending?.kind).toBe("eviction-vote");
    expect(hc(s)).toMatch(/no ballot has been read/i);
    expect(hc(s)).toMatch(/card is OPEN|vote card is open/i);
  });

  it("eviction after the player voted: the revealed-ballot count, and nothing beyond it", () => {
    const s = driveTo((_ss, v) => v.pending?.kind === "eviction-vote");
    s.submitDecision({ kind: "eviction-vote", vote: s.getGameState().pending!.options[0]!.id });
    s.advanceGame();
    const ballots = s.getGameState().eviction?.votesRevealed.length ?? 0;
    expect(ballots).toBeGreaterThan(0);
    expect(hc(s)).toContain(`Ballots revealed so far: ${ballots}`);
  });

  it("the HOH competition itself: no winner is decided yet, and the player is never told they won", () => {
    const s = driveTo((ss) => ss.getGameState().phase === "hoh-competition" && !ss.getGameState().ceremony.hoh);
    const block = hc(s);
    expect(block).toContain("BOARD");
    expect(block).toMatch(/HOH is NOT decided yet[^\n]*never tell the player they won/i);
  });

  it("states the PLAYER's own seat flatly (not HOH / not on the block / not the veto holder) — the second-person fiction the third-person facts never stop", () => {
    const s = driveTo((ss) => {
      const g = ss.getGameState();
      return g.phase === "veto-competition" && g.ceremony.nominees.length === 2 && !!g.player && g.ceremony.hoh?.id !== g.player.id
        && !g.ceremony.nominees.some((nm) => nm.id === g.player!.id);
    });
    const block = hc(s);
    expect(block).toMatch(/The player \(you, the second person\) is: [^\n]*NOT the Head of Household[^\n]*NOT on the block/);
  });

  it("outside the ceremonies the block carries no BOARD section (byte-identical)", () => {
    const s = driveTo((ss) => ss.getGameState().phase === "premiere" || ss.getGameState().phase === "setup" || (ss.getGameState().week ?? 0) === 0);
    expect(hc(s)).not.toContain("BOARD");
  });
});
