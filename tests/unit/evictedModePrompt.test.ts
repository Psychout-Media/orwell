import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { EngineCore } from "../../src/composition/engineRoot";
import { npc, PLAYER } from "../../src/domain/ids";
import { resolvePending } from "../../features/support/answerPending";

/**
 * Feature 0133 — BDD AMEND item 8 (Ryne-approved, Sprint 2): the narrator prompt in `evicted` mode carries only
 * PUBLIC information. The evicted player (pre-jury) watches or skips; the narrator then voices ONLY the engine's
 * public `weekDigests` and the finale beats. Two guarantees, proven STRUCTURALLY (the model "cannot leak what it
 * never receives"), not by prompt wording:
 *   (1) no Vault / hidden-layer data and no raw `npc:<id>` reaches the prompt;
 *   (2) house-only events the evictee could not see (an NPC-only scene — hidden or not — after the exit) are never
 *       handed to the narrator, so it cannot voice them.
 * Roles only — no names.
 */
let n = 0;
function evictedPreJury(): { s: GameSessionAdapter; engine: EngineCore } {
  for (let seed = 1; seed <= 60; seed++) {
    const sb = new GameSessionRegistry().sandboxFor(`evp${n++}`);
    const s = sb.session;
    s.createCharacter({ playerName: "P", seed });
    for (let i = 0; i < 8000; i++) {
      const v = s.advanceGame();
      if (v.pending?.kind === "spectator-choice") return { s, engine: sb.engine };
      if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
      if (v.finished) break;
    }
  }
  throw new Error("no seed in 1..60 evicted the player before the jury formed");
}

function promptBlob(s: GameSessionAdapter): { moment: string; blob: string } {
  const view = s.getMomentPrompt({});
  return { moment: view.moment, blob: JSON.stringify(view) };
}

describe("0133 — the evicted-mode narrator prompt is public-only", () => {
  it("is the `evicted` moment, and carries no Vault sentinel, hidden-layer field, or raw npc id", () => {
    const { s, engine } = evictedPreJury();
    const sentinelVault = "SENTINEL-0133-vault-secret";
    const sentinelHidden = "SENTINEL-0133-hidden-offscreen";
    engine.vault.writeHidden({ id: "ev:vault", kind: "confessional", content: sentinelVault });
    engine.events.record({
      id: "ev:hidden", ts: 9_500_000, type: "conversation",
      initiator: npc(1), witnessSet: [npc(1), npc(2)], hidden: true, content: sentinelHidden,
    });
    const { moment, blob } = promptBlob(s);
    expect(moment).toBe("evicted");
    expect(blob).not.toContain(sentinelVault);
    expect(blob).not.toContain(sentinelHidden);
    expect(blob).not.toMatch(/npc:\d+/);                                   // no raw role ids to voice or leak
    expect(blob).not.toMatch(/"(trust|threat|affinity|soul|hiddenElements?)"/i); // no hidden-layer fields/numbers
  });

  it("the narrator is told to voice ONLY the public weekDigests (and not invent private scheming)", () => {
    const { s } = evictedPreJury();
    const { blob } = promptBlob(s);
    expect(blob).toMatch(/ONLY the game's `weekDigests`/);
    expect(blob).toMatch(/never invent a result or any private scheming/);
    expect(blob).toMatch(/hidden story stays SEALED/i);
  });

  it("while evicted the narrator is handed NO event record at all (it voices only the public weekDigests)", () => {
    const { s, engine } = evictedPreJury();
    engine.events.record({
      id: "ev:houseonly0", ts: 9_600_000, type: "conversation",
      initiator: npc(3), witnessSet: [npc(3), npc(4)], hidden: true, content: "SENTINEL-0133-houseonly-evicted",
    });
    const { moment, blob } = promptBlob(s);
    expect(moment).toBe("evicted");
    expect(blob).not.toContain("THE RECORD");                 // no raw-event channel exists in this mode
    expect(blob).not.toContain("SENTINEL-0133-houseonly-evicted");
  });

  it("house-only events the evictee could not see never reach the post-evicted recap record; a witnessed one does (control)", () => {
    const { s, engine } = evictedPreJury();
    s.submitDecision({ kind: "spectator-choice", vote: "watch" });
    for (let i = 0; i < 8000 && !s.getGameState().finished; i++) {
      const v = s.advanceGame();
      if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    }
    expect(s.getGameState().finished).toBe(true);
    // Recorded LAST, so an unfiltered record (window = the most recent events) would surface them.
    // (domain/event.ts refuses an unwitnessed event that is not hidden, so house-only IS hidden.)
    const houseOnly = "SENTINEL-0133-houseonly-scene";
    const witnessed = "SENTINEL-0133-witnessed-control";
    engine.events.record({
      id: "ev:houseonly", ts: 9_700_000, type: "conversation",
      initiator: npc(3), witnessSet: [npc(3), npc(4)], hidden: true, content: houseOnly,
    });
    engine.events.record({
      id: "ev:witnessed", ts: 9_700_001, type: "conversation",
      initiator: npc(5), witnessSet: [npc(5), PLAYER], hidden: false, content: witnessed,
    });
    const blob = JSON.stringify(s.getMomentPrompt({ moment: "post-season" }));
    expect(blob).toContain("THE RECORD");
    expect(blob).toContain(witnessed);                         // control: the channel is live
    expect(blob).not.toContain(houseOnly);                     // the evictee could not see it ⇒ the narrator never gets it
  });
});
