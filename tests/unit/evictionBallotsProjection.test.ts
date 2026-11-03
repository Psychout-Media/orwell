import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "../../features/support/answerPending";

/**
 * A-15 (rehearsal 2026-11-03, top priority — the N-14/N-15 ordering class): the narrator aired the eviction ballots and
 * a tally BEFORE the player's eviction-vote card existed, pre-deciding the player's vote. The FE guard that strips that
 * narration needs the engine's TRUTH about how many anonymized ballots have actually been revealed — which the public
 * `getGameState` projection did not carry (only advance did). It now projects `eviction` (the same Vault-free EvictionView
 * advance returns): null until an eviction is staging, and `votesRevealed` is empty until the player has voted.
 * Roles only.
 */
let n = 0;
function atEvictionCard(): GameSessionAdapter {
  for (let seed = 1; seed <= 40; seed++) {
    const s = new GameSessionRegistry().sandboxFor(`evb${n++}`).session;
    s.createCharacter({ playerName: "P", seed });
    for (let i = 0; i < 4000; i++) {
      const v = s.advanceGame();
      if (v.pending?.kind === "eviction-vote") return s;
      if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
      if (v.finished) break;
    }
  }
  throw new Error("no seed put the player at an eviction-vote card");
}

describe("getGameState projects the eviction ballots revealed so far (no voter, no tally)", () => {
  it("while the player's eviction-vote card is open, NO ballot has been revealed", () => {
    const s = atEvictionCard();
    const gs = s.getGameState();
    expect(gs.pending?.kind).toBe("eviction-vote");
    expect(gs.eviction === null || gs.eviction === undefined || gs.eviction.votesRevealed.length === 0).toBe(true);
    expect("eviction" in gs).toBe(true); // the field is projected (null/empty), so the FE can tell "not started" from "unknown"
  });

  it("after the player votes the ballots are revealed one at a time, anonymized (never a voter)", () => {
    const s = atEvictionCard();
    const opt = s.getGameState().pending!.options[0]!.id;
    s.submitDecision({ kind: "eviction-vote", vote: opt });
    let seen = 0;
    for (let i = 0; i < 12; i++) {
      s.advanceGame();
      const e = s.getGameState().eviction;
      if (e) {
        seen = Math.max(seen, e.votesRevealed.length);
        expect(JSON.stringify(e)).not.toMatch(/voter|by"|npc:\d+.*votedBy/i);
        for (const b of e.votesRevealed) expect(Object.keys(b)).toEqual(["votedFor"]);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});
