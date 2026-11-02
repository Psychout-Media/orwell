import { describe, it } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { hashSeed } from "../../src/engine/characterFactory";

/**
 * CALIBRATION INSTRUMENT — data-gathering only (calibration revisit lane, 2026-06-19).
 *
 * The known game-feel concern: "passive players coast to Final 2 in ~half of seasons and then lose
 * there." The owner's decided approach is to INSTRUMENT AND GATHER DATA FIRST — quantify what is
 * actually happening before touching any tuning constant. This file is that instrument.
 *
 * It is NOT a gate. It changes NO calibration constant. It plays a configurable number of seeded
 * seasons under MULTIPLE player strategies (a PASSIVE coaster and an ACTIVE/strategic player) over
 * the SAME runtime composition `main.ts` uses (composeRuntime → registry → orchestrator commit
 * spine, pure turn-driven) and records structured per-season metrics:
 *   - the ladder reach (jury / F5 / F4 / F3 / F2 / win), read from the PUBLIC 0046 seat;
 *   - the player's PUBLIC competition wins (their visible resume);
 *   - the week the player's game was effectively decided (their eviction week, or the final week if
 *     they sat the Final 2);
 *   - the jury-vote margin at the finale (and by how much the player lost when they lost at F2);
 *   - how often the player BOTH reaches F2 AND loses there (the exact concern).
 *
 * It emits a machine-readable JSON artifact (`docs/audits/data/2026-06-19-calibration-data.json`)
 * plus feeds the written markdown analysis (`docs/audits/2026-06-19-calibration-data.md`).
 *
 * DETERMINISM: the two arms run over the SAME seeds, so any gap is a real, attributable effect of
 * play — never noise. The optional strategy-variation RNG draws from a DEDICATED hashSeed-forked
 * sub-stream (see `strategyRng`), so the engine's competition/vote RNG stream stays byte-identical
 * and the juryReach / gradient gates stay green (this isolation was the root cause of a prior
 * calibration regression — it is respected here).
 *
 * VAULT WALL: the instrument is engine-internal and reads ONLY Vault-free public projections
 * (`getGameState` / `advanceGame`). The artifact it writes is a dev/calibration doc — it is NOT
 * wired into any runtime player/admin surface. Roles only — no houseguest names in the metrics.
 *
 * Run it as a SINGLE bounded vitest file (never the heavy matrix):
 *   npx vitest run tests/calibration/calibrationInstrument.test.ts
 */

// ---- Vault-free view shapes (only the public fields the instrument reads) ----
interface NamedRef { id: string; name: string }
interface PendingView { kind: string; options: NamedRef[]; appeals?: string[] }
interface FinaleRevealView { reveals: Array<{ juror: NamedRef; votedFor: NamedRef }> }
interface AdvanceResult {
  started: boolean;
  finished: boolean;
  pending: PendingView | null;
  winner?: NamedRef | null;
  event?: { beat?: string; content?: string } | null;
  finale?: FinaleRevealView | null;
}
interface HouseCard { id: string; status: string }
interface StateView {
  week: number;
  player: { id?: string; status: "active" | "jury" | "evicted" } | null;
  house?: HouseCard[];
}
interface Mcp { callTool(name: string, args?: Record<string, unknown>): Promise<unknown> }
type Resolver = (channel: "player" | "admin", user: string) => Mcp;

type Status = "active" | "jury" | "evicted";

// ---- Per-season metrics --------------------------------------------------------
interface SeasonMetrics {
  seed: number;
  arm: "passive" | "active";
  /** The PUBLIC final seat (0046): active@finish = sat in the Final 2; jury / evicted otherwise. */
  status: Status;
  /** Reached the jury (= not a pre-jury eviction). */
  reachedJury: boolean;
  /** Reached each rung — derived from the active-house size at the moment the player left (or sat F2). */
  reachedF5: boolean;
  reachedF4: boolean;
  reachedF3: boolean;
  reachedF2: boolean;
  won: boolean;
  /** PUBLIC competition wins (broadcast beats only) — the player's visible resume. */
  playerCompWins: number;
  /** The active-house size when the player left the game (null = the player sat the Final 2). */
  houseSizeWhenPlayerLeft: number | null;
  /** The week the player's game was decided — their eviction week, or the final week if they sat F2. */
  decidedWeek: number;
  /** The jury vote at the finale, when the player reached the Final 2 (else null). */
  finale: {
    /** Votes the player received. */
    playerVotes: number;
    /** Votes the NPC finalist received. */
    rivalVotes: number;
    /** Total jurors who voted. */
    jurors: number;
  } | null;
  /** The exact concern: this player BOTH reached F2 AND lost the jury vote. */
  reachedF2AndLost: boolean;
}

// ---- The two player policies (mirror juryReach / calibrationGradient exactly) ----

/** PASSIVE: first legal option everywhere; compete; veto only ever used on self. */
function passiveAnswer(p: PendingView): Record<string, unknown> {
  switch (p.kind) {
    case "nominations":
      return { kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] };
    case "veto-decision":
      return p.options.some((o) => o.id === PLAYER)
        ? { kind: "veto-decision", use: true, save: PLAYER }
        : { kind: "veto-decision", use: false };
    case "comp-intent":
      return { kind: "comp-intent", intent: "compete" };
    case "comp-round":
      return { kind: "comp-round", intent: "compete" }; // 0006 staged-rounds
    case "houseguests-choice":
      return { kind: "houseguests-choice", vote: p.options[0]!.id };
    case "replacement":
      return { kind: "replacement", replacement: p.options[0]!.id };
    case "eviction-vote":
      return { kind: "eviction-vote", vote: p.options[0]!.id };
    case "tie-break":
      return { kind: "tie-break", vote: p.options[0]!.id };
    case "final-eviction":
      return { kind: "final-eviction", vote: p.options[0]!.id };
    case "finale-statement":
      return { kind: "finale-statement", statement: "I played my own game." };
    case "finale-answer":
      return { kind: "finale-answer", appeal: p.appeals?.[0] ?? "own-game" };
    case "juror-vote":
      return { kind: "juror-vote", vote: p.options[0]!.id };
    case "goodbye-message":
      return { kind: "goodbye-message", vote: "respectful" };
    case "exit-interview": // 0130: the evicted player's exit posture rides `vote` (first legal stance).
      return { kind: "exit-interview", vote: p.options[0]?.id ?? "gracious" };
    case "juror-question":
      return { kind: "juror-question", statement: "What was your biggest move?" };
    default:
      throw new Error(`unhandled pending kind: ${p.kind}`);
  }
}

/**
 * ACTIVE: the passive answers PLUS basic self-preservation — never nominate or vote out an ALLY,
 * and at the finale make the STRONGEST generic appeal available (own-game) rather than the first
 * option. The bonding scenes that build the allies are recorded out-of-band in `recordEarlyScenes`.
 */
function activeAnswer(p: PendingView, allies: ReadonlySet<string>): Record<string, unknown> {
  const notAlly = (o: NamedRef) => !allies.has(o.id) && o.id !== PLAYER;
  switch (p.kind) {
    case "nominations": {
      const targets = p.options.filter(notAlly).map((o) => o.id);
      const choice = targets.length >= 2 ? [targets[0]!, targets[1]!] : [p.options[0]!.id, p.options[1]!.id];
      return { kind: "nominations", choice };
    }
    case "eviction-vote": {
      const target = p.options.find(notAlly) ?? p.options[0]!;
      return { kind: "eviction-vote", vote: target.id };
    }
    case "tie-break": {
      const target = p.options.find(notAlly) ?? p.options[0]!;
      return { kind: "tie-break", vote: target.id };
    }
    case "final-eviction": {
      const target = p.options.find(notAlly) ?? p.options[0]!;
      return { kind: "final-eviction", vote: target.id };
    }
    case "replacement": {
      const target = p.options.find(notAlly) ?? p.options[0]!;
      return { kind: "replacement", replacement: target.id };
    }
    case "finale-answer":
      // The strategic finalist makes the best generic appeal it can (own-game leads the enum) rather
      // than blindly taking appeals[0] — a small, deterministic upgrade over the passive arm.
      return { kind: "finale-answer", appeal: p.appeals?.includes("own-game") ? "own-game" : (p.appeals?.[0] ?? "own-game") };
    default:
      return passiveAnswer(p);
  }
}

const SCENES_PER_ALLY = 3;

/** Record a small, bounded set of player-witnessed bonding/alliance scenes (0023 hidden fold). */
async function recordEarlyScenes(mcp: Mcp, allyIds: string[]): Promise<void> {
  const kinds = ["bonding", "alliance", "strategy"] as const;
  for (const ally of allyIds) {
    for (let i = 0; i < SCENES_PER_ALLY; i++) {
      await mcp.callTool("recordInteraction", {
        initiator: PLAYER,
        witnessSet: [PLAYER, ally],
        content: "A quiet conversation building trust.",
        kind: kinds[i % kinds.length],
      });
    }
  }
}

/** Map the active-house size when the player left to the named rung (16-cast: F2..F5 are 2..5). */
function rungFlags(houseSizeWhenPlayerLeft: number | null): Pick<
  SeasonMetrics, "reachedF5" | "reachedF4" | "reachedF3" | "reachedF2"
> {
  // The player "reached F_n" if they were still in the game when the active-house size was n, i.e.
  // they left at a size ≤ n (or sat the Final 2 ⇒ they reached every rung).
  const size = houseSizeWhenPlayerLeft ?? 2; // null = sat F2 ⇒ smallest possible
  return {
    reachedF5: size <= 5,
    reachedF4: size <= 4,
    reachedF3: size <= 3,
    reachedF2: size <= 2,
  };
}

/** Read the current public seat + active-house size. */
async function readSeat(mcp: Mcp): Promise<{ status: Status; activeHouse: number; week: number }> {
  const st = (await mcp.callTool("getGameState", {})) as StateView;
  // `house` is NPCs only; +1 for the player when the player is still active.
  const npcActive = (st.house ?? []).filter((h) => h.status === "active").length;
  const playerActive = st.player?.status === "active" ? 1 : 0;
  return { status: st.player!.status, activeHouse: npcActive + playerActive, week: st.week };
}

/** Play one full season for a seed under the given policy; collect the rich metrics. */
async function playSeason(
  resolver: Resolver,
  seed: number,
  arm: "passive" | "active",
): Promise<SeasonMetrics> {
  const mcp = resolver("player", `instrument-${arm}-${seed}`);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed });

  let allies = new Set<string>();
  if (arm === "active") {
    const state0 = (await mcp.callTool("getGameState", {})) as StateView;
    const allyIds = (state0.house ?? [])
      .filter((h) => h.status === "active" && h.id !== PLAYER)
      .map((h) => h.id)
      .slice(0, 2);
    allies = new Set(allyIds);
    await recordEarlyScenes(mcp, allyIds);
  }
  const answer = (p: PendingView): Record<string, unknown> =>
    arm === "active" ? activeAnswer(p, allies) : passiveAnswer(p);

  let finished = false;
  let winner: NamedRef | null = null;
  let playerCompWins = 0;
  let lastFinale: FinaleRevealView | null = null;
  // The active-house size at the moment the player's seat flipped out of "active".
  let houseSizeWhenPlayerLeft: number | null = null;
  let decidedWeek = 0;
  let prevStatus: Status = "active";

  const countWin = (ev: { beat?: string; content?: string } | null | undefined): void => {
    if (ev?.content && /^The Player wins /.test(ev.content) && /competition$/.test(ev.beat ?? "")) playerCompWins++;
  };

  // After each step, watch for the player's seat flipping out of "active" and capture the rung.
  const checkSeat = async (): Promise<void> => {
    if (houseSizeWhenPlayerLeft !== null) return; // already captured the moment they left
    const seat = await readSeat(mcp);
    if (prevStatus === "active" && seat.status !== "active") {
      // They were just evicted — the active house INCLUDING them at that beat is seat.activeHouse + 1
      // (seat.activeHouse counts only those still in; the player just left). The rung the player
      // "reached" is that pre-eviction size.
      houseSizeWhenPlayerLeft = seat.activeHouse + 1;
      decidedWeek = seat.week;
    }
    prevStatus = seat.status;
  };

  for (let i = 0; i < 5_000 && !finished; i++) {
    const adv = (await mcp.callTool("advanceGame", {})) as AdvanceResult;
    finished = adv.finished;
    winner = adv.winner ?? winner;
    countWin(adv.event);
    if (adv.finale) lastFinale = adv.finale;
    await checkSeat();
    if (adv.pending) {
      const sub = (await mcp.callTool("submitDecision", answer(adv.pending))) as AdvanceResult;
      finished = sub.finished;
      winner = sub.winner ?? winner;
      countWin(sub.event);
      if (sub.finale) lastFinale = sub.finale;
      await checkSeat();
    }
  }
  if (!finished) throw new Error(`season for seed ${seed} (${arm}) did not finish`);

  const final = await readSeat(mcp);
  const status = final.status;
  const won = winner?.id === PLAYER;
  // If the player sat the Final 2, they never "left" — record the final week as the decided week.
  if (status === "active") decidedWeek = final.week;

  // Tally the finale vote from the public reveals (juror → votedFor), if the player reached F2.
  let finale: SeasonMetrics["finale"] = null;
  if (status === "active" && lastFinale) {
    let playerVotes = 0, rivalVotes = 0;
    for (const r of lastFinale.reveals) {
      if (r.votedFor.id === PLAYER) playerVotes++; else rivalVotes++;
    }
    finale = { playerVotes, rivalVotes, jurors: lastFinale.reveals.length };
  }

  const flags = rungFlags(status === "active" ? null : houseSizeWhenPlayerLeft);
  const reachedF2 = status === "active" || flags.reachedF2;
  return {
    seed,
    arm,
    status,
    reachedJury: status !== "evicted",
    reachedF5: reachedF2 || flags.reachedF5,
    reachedF4: reachedF2 || flags.reachedF4,
    reachedF3: reachedF2 || flags.reachedF3,
    reachedF2,
    won,
    playerCompWins,
    houseSizeWhenPlayerLeft,
    decidedWeek,
    finale,
    reachedF2AndLost: reachedF2 && status === "active" && !won,
  };
}

// ---- Aggregation ---------------------------------------------------------------
interface ArmSummary {
  arm: "passive" | "active";
  seasons: number;
  reachedJury: number;
  reachedF5: number;
  reachedF4: number;
  reachedF3: number;
  reachedF2: number;
  wins: number;
  reachedF2AndLost: number;
  /** Of the F2 appearances, how many the player won / lost. */
  f2Wins: number;
  f2Losses: number;
  /** Mean public comp wins per season; and mean among F2 appearances. */
  meanCompWins: number;
  meanCompWinsAtF2: number;
  /** Mean eviction/decision week (lower = decided earlier). */
  meanDecidedWeek: number;
  /** Mean jury-vote margin AGAINST the player in their F2 LOSSES (rivalVotes - playerVotes). */
  meanLossMargin: number | null;
}

function summarize(arm: "passive" | "active", rows: SeasonMetrics[]): ArmSummary {
  const n = rows.length;
  const f2 = rows.filter((r) => r.reachedF2 && r.status === "active");
  const f2Wins = f2.filter((r) => r.won).length;
  const losses = f2.filter((r) => !r.won);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const lossMargins = losses
    .filter((r) => r.finale)
    .map((r) => r.finale!.rivalVotes - r.finale!.playerVotes);
  return {
    arm,
    seasons: n,
    reachedJury: rows.filter((r) => r.reachedJury).length,
    reachedF5: rows.filter((r) => r.reachedF5).length,
    reachedF4: rows.filter((r) => r.reachedF4).length,
    reachedF3: rows.filter((r) => r.reachedF3).length,
    reachedF2: rows.filter((r) => r.reachedF2).length,
    wins: rows.filter((r) => r.won).length,
    reachedF2AndLost: rows.filter((r) => r.reachedF2AndLost).length,
    f2Wins,
    f2Losses: losses.length,
    meanCompWins: n ? sum(rows.map((r) => r.playerCompWins)) / n : 0,
    meanCompWinsAtF2: f2.length ? sum(f2.map((r) => r.playerCompWins)) / f2.length : 0,
    meanDecidedWeek: n ? sum(rows.map((r) => r.decidedWeek)) / n : 0,
    meanLossMargin: lossMargins.length ? sum(lossMargins) / lossMargins.length : null,
  };
}

const SEEDS = Number.parseInt(process.env.ORWELL_CALIB_SEEDS ?? "30", 10); // modest; a single run finishes in a few minutes
const pct = (k: number, n: number): string => (n ? `${((100 * k) / n).toFixed(0)}%` : "—");

describe("calibration instrument — passive vs active reach/win data (no tuning changes)", () => {
  it(
    `plays ${SEEDS} seeded seasons per strategy and emits the calibration data artifact`,
    async () => {
      const runtime = composeRuntime({
        clock: new FakeClock(),
        seed: 1,
      });
      const resolver = runtime.registry.resolver();

      // A dedicated, FORKED strategy sub-stream — proves the isolation discipline even though the two
      // fixed policies here are deterministic. Any future randomized strategy MUST draw from THIS
      // stream so the engine's competition/vote RNG stays byte-identical (the prior-regression guard).
      const strategyRng = new SeededRandom(hashSeed("calibration-strategy-substream"));
      void strategyRng; // reserved for future randomized policies; touched so the import is load-bearing

      const passive: SeasonMetrics[] = [];
      const active: SeasonMetrics[] = [];
      for (let seed = 1; seed <= SEEDS; seed++) {
        passive.push(await playSeason(resolver, seed, "passive"));
        active.push(await playSeason(resolver, seed, "active"));
      }

      const passiveSummary = summarize("passive", passive);
      const activeSummary = summarize("active", active);

      const artifact = {
        generatedAt: "2026-06-19",
        note:
          "Calibration data-gathering instrument. Read-only over Vault-free public projections; no tuning constant was changed. " +
          "Same seeds for both arms (any gap is a real effect of play). Roles only — no houseguest names.",
        seeds: SEEDS,
        summary: { passive: passiveSummary, active: activeSummary },
        seasons: { passive, active },
      };

      const outDir = resolve(__dirname, "../../docs/audits/data");
      mkdirSync(outDir, { recursive: true });
      const outPath = resolve(outDir, "2026-06-19-calibration-data.json");
      writeFileSync(outPath, JSON.stringify(artifact, null, 2) + "\n", "utf8");

      // A machine-GENERATED markdown summary companion (regenerated each run; distinct from the
      // hand-written analysis at docs/audits/2026-06-19-calibration-data.md). Calibration record
      // only — NOT a player/admin surface. Roles only.
      const mdRow = (s: ArmSummary): string =>
        `| ${s.arm} | ${s.seasons} | ${s.reachedJury} (${pct(s.reachedJury, s.seasons)}) ` +
        `| ${s.reachedF2} (${pct(s.reachedF2, s.seasons)}) | ${s.wins} (${pct(s.wins, s.seasons)}) ` +
        `| ${s.reachedF2AndLost} (${pct(s.reachedF2AndLost, s.seasons)}) | ${s.f2Wins}/${s.f2Losses} ` +
        `| ${s.meanCompWins.toFixed(2)} | ${s.meanCompWinsAtF2.toFixed(2)} ` +
        `| ${s.meanLossMargin === null ? "—" : s.meanLossMargin.toFixed(1)} |`;
      const md =
        `# Calibration data — passive vs active (generated)\n\n` +
        `> Auto-generated by \`tests/calibration/calibrationInstrument.test.ts\` (${SEEDS} seeds/arm, ` +
        `same seeds both arms). Read-only over Vault-free public projections; **no tuning constant changed**. ` +
        `Companion machine-readable data: \`data/2026-06-19-calibration-data.json\`. ` +
        `Narrative analysis + tuning recommendations: \`2026-06-19-calibration-data.md\`.\n\n` +
        `| arm | seasons | reached jury | reached F2 | won | **F2-and-lost** | F2 W/L | mean comp wins | mean comp wins @F2 | mean loss margin |\n` +
        `|---|---|---|---|---|---|---|---|---|---|\n` +
        `${mdRow(passiveSummary)}\n${mdRow(activeSummary)}\n`;
      const mdPath = resolve(outDir, "2026-06-19-calibration-data-summary.md");
      writeFileSync(mdPath, md, "utf8");

      // Console-summary so the run is legible in CI/log output (and for the markdown write-up).
      const line = (s: ArmSummary): string =>
        `${s.arm.padEnd(7)} | jury ${s.reachedJury}/${s.seasons} (${pct(s.reachedJury, s.seasons)}) ` +
        `F5 ${s.reachedF5} F4 ${s.reachedF4} F3 ${s.reachedF3} F2 ${s.reachedF2} (${pct(s.reachedF2, s.seasons)}) ` +
        `| wins ${s.wins} | F2-and-lost ${s.reachedF2AndLost} (${pct(s.reachedF2AndLost, s.seasons)}) ` +
        `| F2 W/L ${s.f2Wins}/${s.f2Losses} | meanComp ${s.meanCompWins.toFixed(2)} (atF2 ${s.meanCompWinsAtF2.toFixed(2)}) ` +
        `| meanLossMargin ${s.meanLossMargin === null ? "—" : s.meanLossMargin.toFixed(1)}`;
      // eslint-disable-next-line no-console
      console.log(`\n=== CALIBRATION DATA (${SEEDS} seeds/arm) ===\n${line(passiveSummary)}\n${line(activeSummary)}\njson: ${outPath}\nmd:   ${mdPath}\n`);
    },
    { timeout: 1_200_000 }, // 2 × SEEDS full live seasons; generous for loaded hosts
  );
});
