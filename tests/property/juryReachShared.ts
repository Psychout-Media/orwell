import { endHeldNight } from "../support/heldNight";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";

/**
 * D4/E33 — the jury-reach calibration gate, shared spine (shard runner + aggregate).
 *
 * The gate plays {@link SEEDS} passive seeded live seasons and asserts a CALIBRATION property on
 * the DISTRIBUTION over all of them (floor/ceiling reach band, a rare-F2-win ceiling, and an
 * earned-win check). The seasons are independent and per-season seeded, so the play can be SHARDED
 * across CI runners — each shard plays a contiguous seed slice and emits its per-season
 * measurements; an aggregate step recombines ALL shards and runs the one distribution assertion.
 *
 * This module is the single source of truth for BOTH halves: the seed-playing driver
 * ({@link playSeed}/{@link playSeeds}) and the aggregate assertion ({@link assertBand}) over the
 * full set — so a shard and the aggregate can never drift on the methodology or the numbers.
 * The bands/seed-count are UNCHANGED from the pre-shard single-file gate; only WHERE the seeds
 * are played moved. Roles only — no houseguest names.
 */

export const SEEDS = 20; // deterministic seeds 1..SEEDS — one full live season each
export const FLOOR = 3; // ≥ 3/20 (15%): the jury/endgame is structurally reachable for a passive player
export const CEILING = 19; // ≤ 19/20: the loose absurdity guard — a passive player can still lose a season
export const F2_WIN_MAX = 3; // jury wins across the set stay rare (ruling 2026-06-11) …
export const EARNED_WINS = 2; // … and EVERY win must be EARNED: ≥ this many PUBLIC comp wins that season.
//                               A socially-passive comp threat winning is real BB; a 0-comp goat winning is the rigged jury.

interface NamedRef {
  id: string;
  name: string;
}
interface PendingView {
  kind: string;
  options: NamedRef[];
  appeals?: string[];
}
interface AdvanceResult {
  started: boolean;
  finished: boolean;
  pending: PendingView | null;
}
interface StateView {
  player: { status: "active" | "jury" | "evicted" } | null;
}

/** One season's public, Vault-free measurement — the unit a shard emits and the aggregate consumes. */
export interface SeasonResult {
  seed: number;
  /** The PUBLIC 0046 player seat at a finished season. */
  status: "active" | "jury" | "evicted";
  /** True iff the player sat in the Final 2 AND won the jury vote. */
  f2Win: boolean;
  /** The player's PUBLIC (broadcast) competition-win count that season — the earned-win resume. */
  playerCompWins: number;
}

/** The passive policy: first legal option everywhere; compete; veto only ever used on self. */
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
    // The 0046/0037 player-agency pendings (PR #217): tone rides `vote`, free text rides `statement`.
    case "goodbye-message":
      return { kind: "goodbye-message", vote: "respectful" };
    // 0130 — the player-evictee's exit interview (posture rides `vote`, like a goodbye tone).
    case "exit-interview":
      return { kind: "exit-interview", vote: "gracious" };
    case "spectator-choice": // 0133 — an early-evicted player watches the skeleton season
      return { kind: "spectator-choice", vote: "watch" };
    case "secret-veto": // 0025 reactive twists (default ON since 2026-11-03): the player holds the sealed one-time safety and is on the block — every arm HOLDS it (arms stay comparable)
      return { kind: "secret-veto", use: false };
    case "finale-interview":
      return { kind: "finale-interview", vote: "gracious" };
    case "juror-question":
      return { kind: "juror-question", statement: "What was your biggest move?" };
    default:
      throw new Error(`unhandled pending kind: ${p.kind}`);
  }
}

/**
 * Play one passive seeded live season through the production composition (`composeRuntime`, pure
 * turn-driven — the only mode; no wall-clock watcher) and return its public measurement. Per-season seeded,
 * so this is order-independent and runnable in any shard.
 */
export async function playSeed(seed: number): Promise<SeasonResult> {
  process.env.ORWELL_BEDTIME_GATE = "0"; // ORW-116: the sim player turns in directly when a night is held (the bedtime gate is a separate narrator-facing guard; the night HOLD stays fully on)
  const runtime = composeRuntime({
    clock: new FakeClock(),
        seed,
  });
  const resolver = runtime.registry.resolver();
  const mcp = resolver("player", `jury-reach-${seed}`);
  // Pin the player archetype to the historical default ("floater"): #529 stopped fabricating a
  // default archetype (absence ⇒ neutral 0.5 stats), which would shift this seeded calibration band.
  await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });

  let finished = false;
  let winner: { id: string } | null = null;
  let playerCompWins = 0; // PUBLIC broadcast beats only — the player's visible resume
  const countWin = (ev: { beat?: string; content?: string } | null): void => {
    if (ev?.content && /^The Player wins /.test(ev.content) && /competition$/.test(ev.beat ?? "")) playerCompWins++;
  };
  for (let i = 0; i < 5_000 && !finished; i++) {
    const adv = (await mcp.callTool("advanceGame", {})) as AdvanceResult & {
      winner?: { id: string } | null;
      event?: { beat?: string; content?: string } | null;
    };
    finished = adv.finished;
    winner = adv.winner ?? winner;
    countWin(adv.event ?? null);
    if ((adv as { held?: unknown }).held) await endHeldNight((n, a) => mcp.callTool(n, a), `jr${seed}`, undefined, { direct: true }); // ORW-116: a held night is the player's - time passes, then they turn in
    if (adv.pending) {
      const sub = (await mcp.callTool("submitDecision", passiveAnswer(adv.pending))) as AdvanceResult & {
        winner?: { id: string } | null;
        event?: { beat?: string; content?: string } | null;
      };
      finished = sub.finished;
      winner = sub.winner ?? winner;
      countWin(sub.event ?? null);
    }
  }
  if (!finished) throw new Error(`season for seed ${seed} must finish`);
  // The PUBLIC player seat (0046): "evicted" = out pre-jury; "jury" = evicted into the last-9
  // jury; "active" at a finished season = the player sat in the Final 2. Vault-free.
  const state = (await mcp.callTool("getGameState", {})) as StateView;
  const status = state.player!.status;
  return { seed, status, f2Win: status === "active" && winner?.id === PLAYER, playerCompWins };
}

/** Play a contiguous, inclusive-exclusive seed slice `[from, to)` and return its measurements in order. */
export async function playSeeds(from: number, to: number): Promise<SeasonResult[]> {
  const results: SeasonResult[] = [];
  for (let seed = from; seed < to; seed++) results.push(await playSeed(seed));
  return results;
}

/** Compute the contiguous seed range `[from, to)` (1-based seeds 1..SEEDS) for shard `index` of `count`. */
export function shardRange(index: number, count: number): { from: number; to: number } {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count) {
    throw new Error(`invalid shard ${index}/${count}`);
  }
  // Even split with the remainder spread over the first shards, so every seed in 1..SEEDS is
  // covered exactly once and no shard is empty when count <= SEEDS.
  const base = Math.floor(SEEDS / count);
  const extra = SEEDS % count;
  const start = index * base + Math.min(index, extra);
  const len = base + (index < extra ? 1 : 0);
  const from = 1 + start;
  return { from, to: from + len };
}

/**
 * THE aggregate assertion — the SAME band/F2_WIN_MAX/EARNED_WINS the pre-shard single-file gate
 * ran, now computed over the recombined full set. Takes the season results for ALL of seeds
 * 1..SEEDS (in any order); throws (with role-only detail) if the calibration band is violated.
 *
 * `expect` is injected so this module stays test-runner-agnostic (no vitest import at module
 * scope — it is imported by the shard runner too, which already has its own `expect`).
 */
export function assertBand(
  results: readonly SeasonResult[],
  expect: (actual: unknown, message?: string) => {
    toBe(v: unknown): void;
    toBeGreaterThan(v: number): void;
    toBeGreaterThanOrEqual(v: number): void;
    toBeLessThanOrEqual(v: number): void;
  },
): void {
  // Recombine: exactly one result per seed 1..SEEDS, no gaps, no dupes.
  const bySeed = new Map<number, SeasonResult>();
  for (const r of results) bySeed.set(r.seed, r);
  const missing: number[] = [];
  for (let seed = 1; seed <= SEEDS; seed++) if (!bySeed.has(seed)) missing.push(seed);
  expect(missing.length, `aggregate must cover all ${SEEDS} seeds; missing: ${missing.join(", ")}`).toBe(0);
  expect(bySeed.size, `aggregate must hold exactly ${SEEDS} unique seed results, got ${bySeed.size}`).toBe(SEEDS);

  const ordered = Array.from(bySeed.values()).sort((a, b) => a.seed - b.seed);
  const outcomes = ordered.map((r) => r.status);
  let f2Wins = 0;
  for (const r of ordered) {
    if (r.f2Win) {
      f2Wins++;
      // THE TEETH: a crowned passive season must be EARNED on the public record — a real comp
      // resume. A jury crowning a 0-comp, no-social-game goat is the audit's rigged-jury fear.
      expect(
        r.playerCompWins,
        `seed ${r.seed}: the jury crowned a passive player with only ${r.playerCompWins} public comp wins`,
      ).toBeGreaterThanOrEqual(EARNED_WINS);
    }
  }

  const reachedJury = outcomes.filter((s) => s !== "evicted").length;
  const detail = `reached jury/endgame in ${reachedJury}/${SEEDS} passive seasons (${outcomes.join(", ")})`;
  // FLOOR (E33): the endgame content is reachable — passive play is a disadvantage, not a death
  // sentence. CEILING (anti-sycophancy): a social-game-less player is never shepherded to jury.
  expect(reachedJury, detail).toBeGreaterThanOrEqual(FLOOR);
  expect(reachedJury, detail).toBeLessThanOrEqual(CEILING);
  // The player can genuinely lose early (0046): at least one pre-jury eviction across the set —
  // anything else would mean the engine is quietly walking the player past the early weeks.
  expect(outcomes.filter((s) => s === "evicted").length, detail).toBeGreaterThan(0);
  // THE ANTI-SYCOPHANCY TEETH (ruling 2026-06-11): wins stay RARE across the set, and each one
  // was already proven EARNED above (a real public comp resume). A socially-passive player is
  // never handed the crown — when they win, the season record shows why.
  const f2Detail = `passive Final-2 jury wins: ${f2Wins}`;
  expect(f2Wins, f2Detail).toBeLessThanOrEqual(F2_WIN_MAX);
}
