import { describe, it, expect, vi } from "vitest";

// P0 flip: its seeds were selected on the flag-off baseline (#1953). Those layers now default ON, so this file pins them OFF explicitly (hoisted: some adapter consts read env at import). Tests that need a layer ON turn it on through its setter.
vi.hoisted(() => { for (const k of ["ORWELL_ASSURANCES", "ORWELL_VOTE_COUNT", "ORWELL_VETO_MEMORY", "ORWELL_DEAL_NOMS", "ORWELL_CAMPAIGN_MEMORY", "ORWELL_APPROACH_MEMORY", "ORWELL_HC_MEMORY", "ORWELL_MEMORY_PROMISES", "ORWELL_FORGIVENESS", "ORWELL_LOBBYING", "ORWELL_DESIRE_CLOCK", "ORWELL_WANT_MOVEMENT", "ORWELL_MULTI_NIGHT_FATIGUE", "ORWELL_MORNING_APPROACH", "ORWELL_NPC_TELLS", "ORWELL_TELL_REACTIONS", "ORWELL_MOOD_VETO", "ORWELL_MOOD_APPROACH", "ORWELL_MOOD_DEAL", "ORWELL_MOOD_CAMPAIGN", "ORWELL_DRIFT_FIX", "ORWELL_NPC_MEMORY_SPEECH", "ORWELL_DRIVE_DECISIONS", "ORWELL_PHILOSOPHIES"]) process.env[k] = "0"; });
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, GameSession } from "../../src/ports/GameSession";

/**
 * #1800 — The Booth Has Receipts, end to end through the REAL adapter. The audit found the feature hollow:
 * the "target-vote-mismatch" receipt could never fire in a real game (it read a field events don't have and
 * looked for an event type that doesn't exist; only hand-built fixtures passed). Here a real season runs,
 * the player says on the record they'll go after one nominee, then votes to evict the other — and the
 * producer has the receipt. Roles only.
 */

function resolve(s: GameSession, p: NonNullable<AdvanceView["pending"]>, evictVote?: string): void {
  if (p.kind === "nominations") s.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
  else if (p.kind === "veto-decision") s.submitDecision({ kind: "veto-decision", use: false });
  else if (p.kind === "replacement") s.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
  else if (p.kind === "comp-round" || p.kind === "comp-intent") s.submitDecision({ kind: p.kind, intent: "compete" });
  else if (p.kind === "eviction-vote") s.submitDecision({ kind: "eviction-vote", vote: evictVote ?? p.options[0]!.id });
  else if (p.kind === "goodbye-message") s.submitDecision({ kind: "goodbye-message", statement: "bye", vote: p.options[0]?.id });
  else s.submitDecision({ kind: p.kind, vote: p.options?.[0]?.id } as never);
}

describe("#1800 — a real season produces a target-vote-mismatch receipt", () => {
  it("the player says they'll target one nominee, votes to evict the other — the booth has the receipt", () => {
    for (const seed of [5, 8, 13, 21, 34]) { // re-selected 2026-11-03, comp-win threat retune (#1953)
      const reg = new GameSessionRegistry();
      const sb = reg.sandboxFor(`receipts-${seed}`);
      const s = sb.session;
      s.createCharacter({ playerName: "The Player", seed });
      (s as unknown as { setBoothReceiptsEnabled(on: boolean): void }).setBoothReceiptsEnabled(true);

      let voted = false;
      for (let i = 0; i < 600 && !voted; i++) {
        const v = s.advanceGame();
        if (v.finished) break;
        const p = v.pending;
        if (!p) continue;
        if (p.kind === "eviction-vote" && p.options.length >= 2) {
          const [said, cast] = [p.options[0]!, p.options[1]!];
          // On the record, before the vote: the player tells a houseguest who they're going after.
          sb.engine.events.record({
            id: `talk:${sb.engine.events.count()}`, ts: sb.engine.events.count(), type: "conversation",
            initiator: PLAYER, witnessSet: [PLAYER, cast.id], hidden: false,
            content: `I'm going to target ${said.name} this week, trust me.`,
          });
          resolve(s, p, cast.id); // …then votes to evict the OTHER nominee
          voted = true;
          // play on until that eviction's result lands
          for (let k = 0; k < 60; k++) {
            const w = s.advanceGame();
            if (w.pending) resolve(s, w.pending);
            if (w.event?.beat === "eviction-result" || w.finished) break;
          }
          const receipts = (s as unknown as { playerReceipts(): Array<{ kind: string; summary: string }> }).playerReceipts();
          const mismatch = receipts.find((r) => r.kind === "target-vote-mismatch");
          expect(mismatch, "the booth caught the contradiction").toBeDefined();
          expect(mismatch!.summary).toContain(said.name);
          expect(mismatch!.summary).toContain(cast.name);
          expect(mismatch!.summary).not.toMatch(/npc:\d/);
          return;
        }
        resolve(s, p);
      }
    }
    throw new Error("no seed gave the player an eviction vote — test setup");
  });
});
