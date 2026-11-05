import { describe, it, expect } from "vitest";
import { playSeason } from "../../src/engine/calibration";
import type { SeasonHouseguest } from "../../src/engine/season";
import { resolveCompetition, CompetitionIntents } from "../../src/domain/competitionOutcome";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { GameSessionRegistry } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import type { AdvanceView } from "../../src/ports/GameSession";
import { PLAYER, npc } from "../../src/domain/ids";

/**
 * B69 / test-audit C3 + C6 — the anti-sycophancy and sentinel gates, ON the production loop.
 * Mandate #3: the engine never protects the player; mandate #2: nothing hidden the LIVE loop
 * GENERATES may reach a player surface. Roles only — no fixture names.
 */

const flat = (v: number) => ({ physical: v, mental: v, social: v });

describe("anti-sycophancy on the live loop (C3)", () => {
  it("at identical stats + souls the player wins HOH exactly as often as anyone (no hidden favor)", () => {
    // playSeason DRIVES the live loop (B55): same `advance`, same emotional modifier seam, player
    // pendings auto-answered with the NPC policy — so a sign error or a hidden +bonus anywhere in
    // the LIVE competition path shows up here as a skewed share.
    const roster: SeasonHouseguest[] = [
      { id: PLAYER, stats: flat(0.5) },
      ...Array.from({ length: 15 }, (_, i) => ({ id: npc(i + 1), stats: flat(0.5) })),
    ];
    let playerReigns = 0;
    let totalReigns = 0;
    let playerSeasonWins = 0;
    const SEEDS = 150;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const outcome = playSeason({ seed, houseguests: roster });
      for (const w of outcome.weeks) {
        totalReigns += 1;
        if (w.hoh === PLAYER) playerReigns += 1;
      }
      if (outcome.winner === PLAYER) playerSeasonWins += 1;
    }
    // The cast shrinks weekly, so the fair per-reign share is ~1/(mean active) ≈ 1/9.5 — measure
    // the player's share against the SYMMETRIC expectation: every houseguest is exchangeable, so
    // the player's share of all reigns should be ~1/16 of seasons' total opportunities ≈ the NPC
    // mean. A flat +0.1 hidden bonus more than doubles it; the band catches that and rides noise.
    const playerShare = playerReigns / totalReigns;
    const fairShare = 1 / 16; // exchangeability: each of 16 identical houseguests reigns equally often
    expect(playerShare, `player HOH share ${playerShare.toFixed(4)} vs fair ${fairShare.toFixed(4)}`)
      .toBeGreaterThan(fairShare * 0.7);
    expect(playerShare).toBeLessThan(fairShare * 1.3); // A18: tightened from 0.6-1.6x (measured 1.02x on seeds 1-150; a few-point hidden bonus now fails)
    // Season wins: ~1/16 of 150 ≈ 9.4 (sd ≈ 3) — a generous band that still catches protection.
    expect(playerSeasonWins).toBeGreaterThanOrEqual(2);
    expect(playerSeasonWins).toBeLessThanOrEqual(22);
  });

  it("A18: at identical stats + souls the player wins the VETO exactly as often as anyone (the no-favor proof is not HOH-only)", () => {
    const roster: SeasonHouseguest[] = [
      { id: PLAYER, stats: flat(0.5) },
      ...Array.from({ length: 15 }, (_, i) => ({ id: npc(i + 1), stats: flat(0.5) })),
    ];
    let playerVetoes = 0;
    let totalVetoes = 0;
    for (let seed = 1; seed <= 150; seed++) {
      for (const w of playSeason({ seed, houseguests: roster }).weeks) {
        if (w.vetoHolder === undefined) continue; // the Final-3 week has no veto
        totalVetoes += 1;
        if (w.vetoHolder === PLAYER) playerVetoes += 1;
      }
    }
    const share = playerVetoes / totalVetoes;
    const fair = 1 / 16; // exchangeable houseguests; measured 1.03x on seeds 1-150 (n=1950)
    expect(totalVetoes).toBeGreaterThan(1500);
    expect(share, `player veto share ${share.toFixed(4)} vs fair ${fair.toFixed(4)}`).toBeGreaterThan(fair * 0.7);
    expect(share).toBeLessThan(fair * 1.3);
  });

  it("the LIVE emotional modifier has the right sign for the player too (rattled hurts, never helps)", () => {
    // The same resolveCompetition the live loop calls, WITH the soul modifier wired: identical
    // stats, only the player's emotional state differs. A sign error here would protect a
    // rattled player unseen (the audit's exact fear).
    const rate = (playerEmotional: number): number => {
      let wins = 0;
      const RUNS = 600;
      for (let s = 1; s <= RUNS; s++) {
        const field = [
          { id: PLAYER, stats: flat(0.5), emotionalState: playerEmotional },
          ...[1, 2, 3, 4, 5].map((i) => ({ id: npc(i), stats: flat(0.5), emotionalState: 0.5 })),
        ];
        if (resolveCompetition(field, "endurance", new CompetitionIntents(), new SeededRandom(s)).winner === PLAYER) wins++;
      }
      return wins / RUNS;
    };
    const calm = rate(0.5);
    const rattled = rate(0.15);
    const composed = rate(0.85);
    expect(rattled, `rattled ${rattled} vs calm ${calm}`).toBeLessThan(calm);
    expect(composed, `composed ${composed} vs calm ${calm}`).toBeGreaterThan(calm);
  });
});

describe("live-GENERATED hidden content never reaches a player surface (C6)", () => {
  it("every confessional/scene the loop generates stays off the player channel, verbatim", async () => {
    for (const seed of [2, 6]) {
      const reg = new GameSessionRegistry();
      const user = `gen-sweep-${seed}`;
      const orch = new Orchestrator(reg, { now: () => seed }, { seed });
      const sb = reg.sandboxFor(user);
      sb.session.createCharacter({ playerName: "The Player", seed });
      // Generate real hidden life: off-screen ticks (scenes + confessionals) + a few season beats
      // (nomination-ceremony confessionals, 0040).
      for (let t = 0; t < 12; t++) expect(orch.advance(user, "offscreen-tick").integrity).toBe("ok");
      for (let i = 0; i < 20; i++) {
        const v = sb.session.advanceGame();
        if (v.pending) {
          const p = v.pending as NonNullable<AdvanceView["pending"]>;
          if (p.kind === "nominations") sb.session.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
          else if (p.kind === "veto-decision") sb.session.submitDecision({ kind: "veto-decision", use: false });
          else if (p.kind === "comp-intent") sb.session.submitDecision({ kind: "comp-intent", intent: "compete" });
          else if (p.kind === "comp-round") sb.session.submitDecision({ kind: "comp-round", intent: "compete" }); // 0006 staged-rounds
          else if (p.options[0]) sb.session.submitDecision({ kind: p.kind, vote: p.options[0].id, replacement: p.options[0].id } as never);
        }
      }
      const hidden = sb.engine.events.queryAll().filter((e) => e.hidden && e.content.length > 0).map((e) => e.content);
      expect(hidden.length).toBeGreaterThan(10); // the sweep has real teeth — generated, not planted

      // Every player-channel surface, including the prompt builders the audit named.
      const surfaces: string[] = [
        JSON.stringify(await sb.mcp.player.callTool("getGameState", {})),
        JSON.stringify(await sb.mcp.player.callTool("getVisibleStateFor", {})),
        JSON.stringify(await sb.mcp.player.callTool("getMomentPrompt", { moment: "social" })),
        JSON.stringify(await sb.mcp.player.callTool("getMomentPrompt", { moment: "re-entry" })),
        JSON.stringify(await sb.mcp.player.callTool("renderScene", { mode: "scene" })),
        JSON.stringify(await sb.mcp.player.callTool("socialRead", {})),
        JSON.stringify(await sb.mcp.player.callTool("seasonRecap", {})),
        JSON.stringify(await sb.mcp.player.callTool("whereabouts", {})),
      ].map((s) => s ?? "");
      const all = surfaces.join("\n---\n");
      for (const c of hidden) {
        expect(all.includes(c), `a live-generated hidden line leaked verbatim: ${c.slice(0, 60)}…`).toBe(false);
      }
    }
  });
});
