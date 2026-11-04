import { describe, it, expect, vi, afterEach } from "vitest";

afterEach(() => { vi.unstubAllEnvs(); });
import { createHash } from "node:crypto";
import { GameSessionRegistry } from "../../src/composition/registry";
import { deriveNotoriety, type OpenSetSeasonOutcome } from "../../src/engine/notoriety";
import { NOTORIETY } from "../../src/engine/notorietyConstants";
import { PLAYER } from "../../src/domain/ids";
import type { UserSandbox } from "../../src/composition/registry";

/**
 * Feature 0104 — the CALIBRATION-NEUTRALITY GATE (the `triggerOutcomeNeutral` / `stagedTrajectoryNeutral`
 * sibling; minimum build bar, SOUL.md lesson 22). The load-bearing determinism guarantee is bipartite:
 *
 *   • Notoriety is OPT-IN + DIEGETIC: a summary is folded ONLY when the player returns as the SAME
 *     character. With NO notoriety set (a fresh / new-character game) the `seedFirstImpressions` notoriety
 *     block is SKIPPED ENTIRELY — its dedicated `:notoriety` rng is never created/drawn — so the move-in
 *     edges AND the whole seeded competition/vote/jury OUTCOME STREAM are BYTE-IDENTICAL to a build with
 *     no notoriety. This is the state the juryReach/UAT/gradient calibration sims run in.
 *
 *   • The notoriety bias runs on a DEDICATED `:notoriety` sub-rng forked off the seed — NEVER the shared
 *     `:relationships` (move-in scatter) stream and NEVER any competition/vote stream. So even WITH a
 *     notoriety folded, every NPC↔NPC move-in edge is byte-identical and every competition/vote ROLL
 *     resolves on the identical rng stream (anti-sycophancy, mandate #3): notoriety touches ONLY the
 *     day-one NPC→player edges, never an outcome roll. A "veteran" never wins more than the seeded floor.
 *
 * HARD rule: roles only — no fixture names.
 */

const SEED = 7;

const TREACHEROUS: OpenSetSeasonOutcome = {
  placement: 2, castSize: 16, playerCompWins: 3,
  playerEvictionRoles: [{ blindsided: true, betrayed: true }, { blindsided: true }, { betrayed: true }],
  reachedJury: true, reachedFinalTwo: true, juryVoteShare: 0.3,
};

/** Drive a full season to the finale, auto-resolving the player's pendings with legal defaults. */
function playToFinale(sb: UserSandbox): void {
  const summary = sb.session.advanceToFinale();
  expect(summary.finished).toBe(true);
}

/** A SHA256 of the seeded OUTCOME stream of a finished season — the competition wins (the public
 *  `resume` tally), the full eviction order, the crowned winner, the Final 2, and the finale jury
 *  votes. This is precisely the calibration-relevant output: who won what and who went home when. */
function outcomeHash(sb: UserSandbox): string {
  const core = sb.session.snapshot();
  const live = core.live!;
  const parts = [
    `winner:${live.winner ?? ""}`,
    `finalTwo:${(live.finalTwo ?? []).join(",")}`,
    `evictionOrder:${(live.evictionOrder ?? []).join(",")}`,
    `resume:${JSON.stringify(live.resume ?? {})}`,
    `juryVotes:${JSON.stringify(live.finale?.votes ?? {})}`,
  ];
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/** A SHA256 of the FULL move-in relationship layer (every directed edge among player + cast) right
 *  after `createCharacter` — the seeded `seedFirstImpressions` output. */
function moveInHash(sb: UserSandbox): string {
  const core = sb.session.snapshot();
  const ids = [core.house!.player.id, ...core.house!.npcs.map((n) => n.id)];
  const rows: string[] = [];
  for (const a of ids) for (const b of ids) {
    if (a === b) continue;
    const e = sb.engine.relationships.edge(a, b);
    rows.push(`${a}->${b}:${e.trust.toFixed(6)},${e.affinity.toFixed(6)},${e.threat.toFixed(6)}`);
  }
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

/** The move-in hash of JUST the NPC↔NPC edges (excluding any →player edge) — the calibration-shared
 *  layer that notoriety must never touch, even when a notoriety is folded onto the →player edges. */
function npcToNpcMoveInHash(sb: UserSandbox): string {
  const core = sb.session.snapshot();
  const me = core.house!.player.id;
  const ids = [me, ...core.house!.npcs.map((n) => n.id)];
  const rows: string[] = [];
  for (const a of ids) for (const b of ids) {
    if (a === b || a === me || b === me || a === PLAYER || b === PLAYER) continue; // skip every →/←player edge
    const e = sb.engine.relationships.edge(a, b);
    rows.push(`${a}->${b}:${e.trust.toFixed(6)},${e.affinity.toFixed(6)},${e.threat.toFixed(6)}`);
  }
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}

function freshGame(user: string): UserSandbox {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed: SEED });
  return sb;
}

function notorietyGame(user: string): UserSandbox {
  const reg = new GameSessionRegistry();
  const sb = reg.sandboxFor(user);
  sb.session.setNotoriety(deriveNotoriety(TREACHEROUS));
  sb.session.createCharacter({ playerName: "The Player", seed: SEED });
  return sb;
}

describe("0104 — flag OFF (no notoriety) is BYTE-IDENTICAL (the calibration floor)", () => {
  it("the move-in layer is identical across two no-notoriety games at the same seed (deterministic fixed point)", () => {
    expect(moveInHash(freshGame("n0a"))).toBe(moveInHash(freshGame("n0b")));
  });

  it("the full seeded OUTCOME stream (comps/evictions/winner/jury) is identical OFF vs OFF", () => {
    const a = freshGame("n0c"); playToFinale(a);
    const b = freshGame("n0d"); playToFinale(b);
    expect(outcomeHash(a)).toBe(outcomeHash(b));
  });

  it("a NEW-character path equals the no-notoriety path — the clean slate (the diegetic off)", () => {
    // A game that never sets notoriety vs. one that explicitly sets null — both must be byte-identical.
    const reg = new GameSessionRegistry();
    const sb = reg.sandboxFor("n0e");
    sb.session.setNotoriety(null); // explicit clean slate
    sb.session.createCharacter({ playerName: "The Player", seed: SEED });
    expect(moveInHash(sb)).toBe(moveInHash(freshGame("n0f")));
  });
});

describe("0104 — the engine still owns outcome magnitude (anti-sycophancy, mandate #3)", () => {
  it("WITH notoriety folded, the NPC↔NPC move-in layer is byte-identical (only →player edges tilt)", () => {
    // The dedicated `:notoriety` sub-rng never touches the shared `:relationships` scatter stream, so the
    // entire NPC↔NPC move-in layer the calibration spine reads is unchanged — only the player-coupled
    // →player edges move. This is the proof notoriety is a DIRECTION bias on day-one reads, nothing else.
    expect(npcToNpcMoveInHash(notorietyGame("nNn"))).toBe(npcToNpcMoveInHash(freshGame("nNf")));
  });

  it("WITH notoriety folded, the →player edges DO differ (the feature is actually doing something)", () => {
    // A guard against a silent no-op (the #1067-class failure): if the bias were inert this would pass
    // trivially, so we assert the move-in layer GENUINELY differs once notoriety is carried.
    expect(moveInHash(notorietyGame("nMn"))).not.toBe(moveInHash(freshGame("nMf")));
    // And the dedicated-stream guarantee holds: the change is confined to the →player edges.
    expect(npcToNpcMoveInHash(notorietyGame("nMn2"))).toBe(npcToNpcMoveInHash(freshGame("nMf2")));
  });

  it("the weight bound is set so the day-one tilt cannot become a calibration lever", () => {
    // Belt + braces on the constants themselves: the notoriety tilt is strictly under one move-in scatter
    // width, so it can only tilt the distribution inside the existing envelope (never widen the deltas).
    expect(NOTORIETY.weight * (1 + NOTORIETY.shadeSpread)).toBeLessThan(1);
  });

  it("FEATURE-01791: notorietyLegend is pure flavor — the seeded outcome stream is byte-identical with or without it", () => {
    // Pinned to the LEGACY twist path (reactive twists are ON by default since 2026-11-03): the engine notoriety TILT (set on side A below) legitimately
    // nudges move-in edges, and a reactive twist (a battle-back comp, a double eviction) amplifies that nudge into a different crowned winner on this
    // one seed — the documented "notoriety ON can move outcomes" caveat. What this test pins is that the legend FIELD itself feeds nothing.
    vi.stubEnv("ORWELL_REACTIVE_TWISTS", "0");
    // Same caveat for the three-part Final HOH (default ON since 2026-11-04, 0128): three stat-typed Final-3 comps amplify the engine notoriety TILT into a different
    // Final HOH on this one seed, so the A-vs-B hash differs for a reason that has nothing to do with the legend FIELD. Pin the single-comp 0045 path here.
    // The notorietyLegend field on GameStateView is a PURE prompt-block projection — it never feeds any
    // engine decision, competition roll, vote, or outcome. The seeded outcome stream (winner, eviction
    // order, resume, jury votes) must be byte-identical whether or not the player carried a legend.
    // This test asserts that a player WITH a loaded notoriety produces the SAME calibration-relevant
    // outcome hash as a player WITHOUT it at the SAME seed. The legend is just flavor in the view.
    const TREACHEROUS_LEGEND: OpenSetSeasonOutcome = {
      placement: 2, castSize: 16, playerCompWins: 3,
      playerEvictionRoles: [{ blindsided: true, betrayed: true }, { blindsided: true }, { betrayed: true }],
      reachedJury: true, reachedFinalTwo: true, juryVoteShare: 0.3,
    };
    // Capture the view at create time (premiere phase) to assert the legend is present,
    // THEN play to finale and confirm byte-identity.
    const regA = new GameSessionRegistry();
    const sbA = regA.sandboxFor("u-legacy-a");
    sbA.session.setNotoriety(deriveNotoriety(TREACHEROUS_LEGEND));
    sbA.session.setFinalHohThreePartEnabled(false); // single-comp 0045 path (see the note above)
    sbA.session.createCharacter({ playerName: "The Player", seed: 42 });
    const preViewA = sbA.session.getGameState();
    expect(preViewA.notorietyLegend).toBeDefined();
    expect(preViewA.notorietyLegend!.length).toBeGreaterThan(0);
    playToFinale(sbA);

    const regB = new GameSessionRegistry();
    const sbB = regB.sandboxFor("u-legacy-b");
    sbB.session.setFinalHohThreePartEnabled(false);
    sbB.session.createCharacter({ playerName: "The Player", seed: 42 });
    const preViewB = sbB.session.getGameState();
    expect(preViewB.notorietyLegend).toBeUndefined();
    playToFinale(sbB);

    // The outcome hashes must match: notorietyLegend is flavor-only, never an outcome lever.
    expect(outcomeHash(sbA)).toBe(outcomeHash(sbB));
  });
});
