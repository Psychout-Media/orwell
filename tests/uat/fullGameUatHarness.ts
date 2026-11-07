/**
 * tests/uat/fullGameUatHarness.ts
 *
 * Shared harness for the full-game UAT, extracted verbatim from the former single
 * fullGameUat.test.ts so its three heavy `it` blocks can fan out across separate CI
 * runners (heavy-sims matrix lanes uat-12seed / uat-5seed / uat-decisions) WITHOUT
 * duplicating the driver or weakening any seed/assertion.
 *
 * This module holds NO `it`/`describe` (it is `*.ts`, not `*.test.ts`, so vitest's
 * `include: tests/**\/*.test.ts` never picks it up directly). The three split test
 * files
 * import the driver + invariant checkers from here and each own a disjoint slice
 * of the work:
 *
 *   fullGameUat.12seed.test.ts    — 12 seeds, never-use-veto (direct callTool)
 *   fullGameUat.5seed.test.ts     — 5 seeds, always-use-veto (direct callTool: veto path)
 *   fullGameUat.decisions.test.ts — decision-type coverage over seeds 1-5 (real HTTP)
 *
 * Coverage gaps this UAT fills vs. the existing test suite:
 *   httpServer.test.ts:          onboarding + tool checks only, no full loop over HTTP.
 *   liveProgression.test.ts:     full game but via GameSessionRegistry directly; 2 seeds.
 *   vault-sentinel.property.ts:  checks tools in isolation, not the live-game HTTP flow.
 *
 * Edge cases specifically targeted (across the three split files):
 *   - Veto-use + replacement decision path    (always-use-veto strategy)
 *   - Final-4 veto-revert (no legal replacement → engine reverts; replacement pend absent)
 *   - Player in every role across seeds       (HOH, nominee, veto holder, voter, bystander)
 *   - All 4 player decision types exercised   (nominations, veto-decision, replacement, eviction-vote)
 *   - Raw entity-id leaks in humanised beat content
 *   - Numeric stat / soul / relationship leaks in any player-facing HTTP response
 *   - Game always finishes (no runaway loop)
 *   - Final-2 roster: exactly 1 active NPC in the house when the player survives to finale
 */

import { endHeldNight } from "../support/heldNight";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHttpMcpServer } from "../../src/adapters/mcp/HttpMcpServer";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import type { McpServer } from "../../src/adapters/mcp/McpServer";

// ─── HTTP response shapes ────────────────────────────────────────────────────

export interface NamedRef { id: string; name: string; }

export interface PendingDecision {
  kind: "nominations" | "veto-decision" | "comp-intent" | "comp-round" | "houseguests-choice" | "replacement" | "eviction-vote" | "tie-break" | "final-eviction"
      | "secret-veto" | "goodbye-message" | "exit-interview" | "spectator-choice" | "finale-interview" | "finale-statement" | "finale-answer" | "juror-question" | "juror-vote";
  by: NamedRef;
  options: NamedRef[];
  pick: number;
  /** finale-answer: the legal structured appeals (engine enum values). */
  appeals?: string[];
}

export interface CeremonyStatus {
  week: number;
  phase: string;
  hoh: NamedRef | null;
  nominees: NamedRef[];
  veto: { holder: NamedRef | null; used: boolean };
}

export interface AdvanceResult {
  started: boolean;
  finished: boolean;
  winner: NamedRef | null;
  pending: PendingDecision | null;
  status: CeremonyStatus;
  event: { beat: string; content: string } | null;
}

export interface GameStateResult {
  started: boolean;
  house: { id: string; name: string; status: "active" | "evicted" }[];
}

// ─── Anomaly model ───────────────────────────────────────────────────────────

export type AnomalyKind =
  | "http-error"             // non-200 or JSON parse failure
  | "vault-stat-leak"        // numeric stat / soul / relationship value in player response
  | "missing-winner"         // finished=true but winner=null
  | "stale-loop"             // MAX_ITERATIONS reached without finishing
  | "empty-pending-options"  // pending decision with insufficient options
  | "duplicate-option"       // same id listed twice in pending options
  | "illegal-entity-id"      // raw "npc:" id survived humanisation in event content
  | "decision-rejection"     // submitDecision returned an engine error
  | "ceremony-anomaly"       // nominations phase but no HOH in status
  | "final-roster-anomaly";  // getGameState post-finish shows unexpected active count

export interface Anomaly {
  seed: number;
  strategy: string;
  week: number;
  beat: string;
  kind: AnomalyKind;
  detail: string;
}

// ─── Decision strategies ─────────────────────────────────────────────────────

export type DecisionStrategy = "never-use-veto" | "always-use-veto";

export function autoResolve(p: PendingDecision, strategy: DecisionStrategy): Record<string, unknown> {
  switch (p.kind) {
    case "nominations":
      // Always nominate first two legal options.
      return { kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] };
    case "veto-decision":
      if (strategy === "always-use-veto" && p.options.length > 0) {
        // Save the first nominee; the engine reverts if no legal replacement exists (final-4).
        return { kind: "veto-decision", use: true, save: p.options[0]!.id };
      }
      return { kind: "veto-decision", use: false };
    case "secret-veto": // 0025 reactive: the player holds the sealed one-time safety and is on the block — play it under always-use-veto, hold it otherwise.
      return { kind: "secret-veto", use: strategy === "always-use-veto" };
    case "comp-intent": // B46: declare the player's competition approach (default compete).
      return { kind: "comp-intent", intent: "compete" };
    case "comp-round": // 0006 staged-rounds: declare the per-round approach (default compete).
      return { kind: "comp-round", intent: "compete" };
    case "houseguests-choice": // B45: the player drew the chip — pick the sixth veto player.
      return { kind: "houseguests-choice", vote: p.options[0]!.id };
    case "replacement":
      return { kind: "replacement", replacement: p.options[0]!.id };
    case "eviction-vote":
      return { kind: "eviction-vote", vote: p.options[0]!.id };
    case "tie-break": // B44: the player HOH breaks a tied eviction vote.
      return { kind: "tie-break", vote: p.options[0]!.id };
    case "final-eviction": // Final 3 (0045): the player is the final HOH — evict one of the other two.
      return { kind: "final-eviction", vote: p.options[0]!.id };
    case "goodbye-message": // E34: the player's own goodbye — the tone rides `vote` (first legal tone).
      return { kind: "goodbye-message", vote: p.options[0]!.id, statement: "Take care." };
    case "exit-interview": // 0130: the player-evictee's exit posture rides `vote` (first legal stance).
      return { kind: "exit-interview", vote: p.options[0]!.id, statement: "I gave it everything." };
    case "spectator-choice": // 0133: an early-evicted player — watch the condensed season.
      return { kind: "spectator-choice", vote: "watch" };
    case "finale-interview": // 0133: the post-crowning interview posture rides `vote`.
      return { kind: "finale-interview", vote: p.options[0]!.id, statement: "It was a good season." };
    // --- 0037 interactive finale ---
    case "finale-statement":
      return { kind: "finale-statement", statement: "I played my own game." };
    case "finale-answer":
      return { kind: "finale-answer", appeal: p.appeals?.[0] ?? "own-game" };
    case "juror-question": // E37: the player-juror's scoreless question.
      return { kind: "juror-question", statement: "What was your biggest move?" };
    case "juror-vote":
      return { kind: "juror-vote", vote: p.options[0]!.id };
  }
}

// ─── Invariant checkers ───────────────────────────────────────────────────────

/** Patterns that must never appear in a player-channel HTTP response body. */
export const VAULT_LEAK_PATTERNS: Array<[RegExp, string]> = [
  [/"(physical|mental|social)"\s*:\s*\d+\.\d+/, "numeric competition stat in player response"],
  [/"(trust|affinity|threat)"\s*:\s*\d+\.\d+/,  "raw relationship numeric in player response"],
  [/"soul"\s*:\s*[{[]/,                           '"soul" object/array in player response'],
  [/"hidden"\s*:\s*true/,                         '"hidden":true in player response'],
];

export function checkResponseBody(
  raw: string,
  ctx: { seed: number; strategy: string; week: number; beat: string },
  anomalies: Anomaly[],
): void {
  for (const [re, detail] of VAULT_LEAK_PATTERNS) {
    if (re.test(raw)) {
      anomalies.push({ ...ctx, kind: "vault-stat-leak", detail });
    }
  }
}

export function checkAdvanceResult(
  adv: AdvanceResult,
  ctx: { seed: number; strategy: string },
  anomalies: Anomaly[],
): void {
  const week = adv.status.week;
  const beat = adv.status.phase;
  const loc = { ...ctx, week, beat };

  if (adv.finished && !adv.winner) {
    anomalies.push({ ...loc, kind: "missing-winner", detail: "game finished with no winner" });
  }

  if (adv.event?.content && /\bnpc:\d+\b/.test(adv.event.content)) {
    anomalies.push({ ...loc, kind: "illegal-entity-id", detail: `raw entity id survived humanisation: "${adv.event.content.slice(0, 100)}"` });
  }

  if (beat === "nominations" && !adv.status.hoh) {
    anomalies.push({ ...loc, kind: "ceremony-anomaly", detail: "nominations phase but hoh is null" });
  }

  const p = adv.pending;
  if (p) {
    const minOptions: Record<string, number> = {
      nominations: 2, replacement: 1, "eviction-vote": 1, "veto-decision": 0,
      "finale-statement": 0, "finale-answer": 0, "juror-vote": 1,
    };
    if (p.options.length < (minOptions[p.kind] ?? 0)) {
      anomalies.push({ ...loc, kind: "empty-pending-options", detail: `${p.kind} has ${p.options.length} options (need ${minOptions[p.kind]})` });
    }
    const ids = p.options.map((o) => o.id);
    if (new Set(ids).size < ids.length) {
      anomalies.push({ ...loc, kind: "duplicate-option", detail: `duplicate ids in ${p.kind}: ${ids.join(", ")}` });
    }
  }
}

// ─── Seed sharding ─────────────────────────────────────────────────────────────

/**
 * Split a contiguous seed list across CI runners. The 12-seed UAT asserts only PER-SEED
 * properties (each game finishes, no anomalies, ≥1 week, and — over a non-empty slice — at least
 * one decision was produced); it runs NO cross-seed aggregate. So the seeds can be played on
 * separate runners with each shard asserting INDEPENDENTLY over its own slice — no recombination
 * is needed and no assertion is weakened.
 *
 * Returns shard `index`'s contiguous slice of `seeds` for a `count`-way split, distributing any
 * remainder over the first shards so EVERY seed is covered by EXACTLY ONE shard (a clean partition:
 * the disjoint union of all shards is the original list, in order, no gaps, no dupes). `count===1`
 * (or unset, the local path) returns the whole list unchanged.
 */
export function shardSeeds(seeds: readonly number[], index: number, count: number): number[] {
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count) {
    throw new Error(`invalid UAT shard ${index}/${count}`);
  }
  const n = seeds.length;
  const base = Math.floor(n / count);
  const extra = n % count;
  const start = index * base + Math.min(index, extra);
  const len = base + (index < extra ? 1 : 0);
  return seeds.slice(start, start + len);
}

/**
 * Resolve this process's shard slice of `seeds` from the env (`UAT12_SHARDS` / `UAT12_SHARD`).
 * Unset/`<2` ⇒ the whole list (the local `npm run test:heavy:uat-12seed` path is unchanged).
 * Returns the slice plus a human label for the test name.
 */
export function resolveUatSeedShard(
  seeds: readonly number[],
  env: NodeJS.ProcessEnv = process.env,
): { seeds: number[]; label: string } {
  const count = Number(env.UAT12_SHARDS ?? "0");
  const index = Number(env.UAT12_SHARD ?? "0");
  if (!Number.isInteger(count) || count < 2) {
    return { seeds: [...seeds], label: `${seeds.length} seeds` };
  }
  const slice = shardSeeds(seeds, index, count);
  return { seeds: slice, label: `shard ${index}/${count}: seeds [${slice.join(", ")}]` };
}

// ─── Per-run game driver ──────────────────────────────────────────────────────

export const MAX_ITERATIONS = 5_000;

export interface RunResult {
  seed: number;
  strategy: DecisionStrategy;
  weeksPlayed: number;
  finished: boolean;
  winner: NamedRef | null;
  /** Count of each decision kind resolved by the player. */
  decisionCounts: Partial<Record<PendingDecision["kind"], number>>;
  anomalies: Anomaly[];
}

export async function runFullGame(
  base: string,
  seed: number,
  strategy: DecisionStrategy,
): Promise<RunResult> {
  const user = `uat-${seed}-${strategy}`;
  const anomalies: Anomaly[] = [];
  const decisionCounts: Partial<Record<PendingDecision["kind"], number>> = {};
  let winner: NamedRef | null = null;
  let weeksPlayed = 0;
  let finished = false;

  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T | null> => {
    let raw = "";
    try {
      const res = await fetch(`${base}/player/call`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-orwell-user": user },
        body: JSON.stringify({ name, args }),
      });
      raw = await res.text();
      if (!res.ok) {
        anomalies.push({ seed, strategy, week: weeksPlayed, beat: name, kind: "http-error", detail: `HTTP ${res.status}` });
        return null;
      }
    } catch (e) {
      anomalies.push({ seed, strategy, week: weeksPlayed, beat: name, kind: "http-error", detail: String(e) });
      return null;
    }
    checkResponseBody(raw, { seed, strategy, week: weeksPlayed, beat: name }, anomalies);
    const body = JSON.parse(raw) as { result?: T; error?: string };
    if (body.error) {
      anomalies.push({ seed, strategy, week: weeksPlayed, beat: name, kind: "decision-rejection", detail: body.error });
      return null;
    }
    return body.result ?? null;
  };

  // Start the game.
  await call<unknown>("createCharacter", { playerName: "UAT Player", seed });

  let consecutiveSubmitFailures = 0;

  for (let i = 0; i < MAX_ITERATIONS && !finished; i++) {
    const adv = await call<AdvanceResult>("advanceGame", {});
    if (!adv) break; // HTTP error or body.error — already pushed as http-error anomaly
    if ((adv as { held?: unknown }).held) { await endHeldNight(async (n, a) => call<unknown>(n, a), `uat${seed}`, undefined, { direct: true }); continue; } // ORW-116: a held night is the player's - time passes, then they turn in

    // createCharacter failed silently: game never started → infinite started=false loop without this guard
    if (!adv.started) {
      anomalies.push({ seed, strategy, week: 0, beat: "advanceGame", kind: "stale-loop",
        detail: "advanceGame returned started=false — createCharacter may have failed" });
      break;
    }

    weeksPlayed = adv.status.week;
    finished = adv.finished;
    winner = adv.winner;
    checkAdvanceResult(adv, { seed, strategy }, anomalies);

    if (adv.pending) {
      const p = adv.pending;
      decisionCounts[p.kind] = (decisionCounts[p.kind] ?? 0) + 1;
      // Only submit if we have enough options (anomaly already recorded if not).
      const minOpts: Partial<Record<string, number>> = { nominations: 2, replacement: 1, "eviction-vote": 1, "juror-vote": 1 };
      if (p.options.length >= (minOpts[p.kind] ?? 0)) {
        const subAdv = await call<AdvanceResult>("submitDecision", autoResolve(p, strategy));
        if (subAdv) {
          consecutiveSubmitFailures = 0;
          finished = subAdv.finished;
          winner = subAdv.winner;
          checkAdvanceResult(subAdv, { seed, strategy }, anomalies);
        } else {
          // submitDecision errored → decision not applied → next advanceGame returns same pending.
          // Break after 3 consecutive failures to avoid burning all iterations in a stuck loop.
          consecutiveSubmitFailures++;
          if (consecutiveSubmitFailures >= 3) {
            anomalies.push({ seed, strategy, week: weeksPlayed, beat: p.kind, kind: "stale-loop",
              detail: `submitDecision failed ${consecutiveSubmitFailures}x in a row for '${p.kind}' — stuck loop` });
            break;
          }
        }
      }
    }

    if (!finished && i === MAX_ITERATIONS - 1) {
      anomalies.push({ seed, strategy, week: weeksPlayed, beat: "loop", kind: "stale-loop", detail: `game did not finish within ${MAX_ITERATIONS} iterations` });
    }
  }

  // Post-finish: verify the final-2 roster via getGameState.
  if (finished) {
    const state = await call<GameStateResult>("getGameState", {});
    if (state) {
      const active = state.house.filter((h) => h.status === "active");
      // 15 NPCs: at finale the player is either still in (1 NPC active) or was evicted (2 NPCs active).
      // More than 2 active NPCs post-finish is a bug.
      if (active.length > 2) {
        anomalies.push({ seed, strategy, week: weeksPlayed, beat: "finale", kind: "final-roster-anomaly", detail: `${active.length} NPCs still active at game end (expected ≤ 2)` });
      }
    }
  }

  return { seed, strategy, weeksPlayed, finished, winner, decisionCounts, anomalies };
}

// ─── Direct (non-HTTP) game driver ────────────────────────────────────────────

/**
 * Drives a full game through the McpServer.callTool API directly — no HTTP round-trip.
 * Used for the large completion-oriented test suites (the 12-seed and 5-seed files) where
 * CI's HTTP overhead caused intermittent stale-loop failures that never reproduced locally.
 * Vault-leak invariants are still checked by serialising each result to JSON.
 */
export async function runFullGameDirect(
  resolver: (channel: "player" | "admin", user: string) => McpServer,
  seed: number,
  strategy: DecisionStrategy,
): Promise<RunResult> {
  // Distinct prefix avoids sharing sandbox state with HTTP-based test runs.
  const user = `uat-d-${seed}-${strategy}`;
  const anomalies: Anomaly[] = [];
  const decisionCounts: Partial<Record<PendingDecision["kind"], number>> = {};
  let winner: NamedRef | null = null;
  let weeksPlayed = 0;
  let finished = false;

  const call = async <T>(name: string, args: Record<string, unknown>): Promise<T | null> => {
    let result: unknown;
    try {
      result = await resolver("player", user).callTool(name, args);
    } catch (e) {
      anomalies.push({ seed, strategy, week: weeksPlayed, beat: name, kind: "http-error", detail: String(e) });
      return null;
    }
    // Serialise to catch vault-leak patterns (same regexes, just over JSON rather than HTTP body).
    const raw = JSON.stringify({ result });
    checkResponseBody(raw, { seed, strategy, week: weeksPlayed, beat: name }, anomalies);
    return (result as T) ?? null;
  };

  await call<unknown>("createCharacter", { playerName: "UAT Player", seed });

  let consecutiveSubmitFailures = 0;

  for (let i = 0; i < MAX_ITERATIONS && !finished; i++) {
    const adv = await call<AdvanceResult>("advanceGame", {});
    if (!adv) break;
    if ((adv as { held?: unknown }).held) { await endHeldNight(async (n, a) => call<unknown>(n, a), `uat${seed}`, undefined, { direct: true }); continue; } // ORW-116: see above

    if (!adv.started) {
      anomalies.push({ seed, strategy, week: 0, beat: "advanceGame", kind: "stale-loop",
        detail: "advanceGame returned started=false — createCharacter may have failed" });
      break;
    }

    weeksPlayed = adv.status.week;
    finished = adv.finished;
    winner = adv.winner;
    checkAdvanceResult(adv, { seed, strategy }, anomalies);

    if (adv.pending) {
      const p = adv.pending;
      decisionCounts[p.kind] = (decisionCounts[p.kind] ?? 0) + 1;
      const minOpts: Partial<Record<string, number>> = { nominations: 2, replacement: 1, "eviction-vote": 1, "juror-vote": 1 };
      if (p.options.length >= (minOpts[p.kind] ?? 0)) {
        const subAdv = await call<AdvanceResult>("submitDecision", autoResolve(p, strategy));
        if (subAdv) {
          consecutiveSubmitFailures = 0;
          finished = subAdv.finished;
          winner = subAdv.winner;
          checkAdvanceResult(subAdv, { seed, strategy }, anomalies);
        } else {
          consecutiveSubmitFailures++;
          if (consecutiveSubmitFailures >= 3) {
            anomalies.push({ seed, strategy, week: weeksPlayed, beat: p.kind, kind: "stale-loop",
              detail: `submitDecision failed ${consecutiveSubmitFailures}x in a row for '${p.kind}' — stuck loop` });
            break;
          }
        }
      }
    }

    if (!finished && i === MAX_ITERATIONS - 1) {
      anomalies.push({ seed, strategy, week: weeksPlayed, beat: "loop", kind: "stale-loop",
        detail: `game did not finish within ${MAX_ITERATIONS} iterations` });
    }
  }

  if (finished) {
    const state = await call<GameStateResult>("getGameState", {});
    if (state) {
      const active = state.house.filter((h) => h.status === "active");
      if (active.length > 2) {
        anomalies.push({ seed, strategy, week: weeksPlayed, beat: "finale", kind: "final-roster-anomaly",
          detail: `${active.length} NPCs still active at game end (expected ≤ 2)` });
      }
    }
  }

  return { seed, strategy, weeksPlayed, finished, winner, decisionCounts, anomalies };
}

// ─── Shared runtime harness ────────────────────────────────────────────────────

export interface UatHarness {
  /** Base URL of the live HTTP MCP server (for the real-HTTP decision-coverage file). */
  base: string;
  /** Direct channel resolver (for the completion-oriented 12-seed / 5-seed files). */
  directResolver: (channel: "player" | "admin", user: string) => McpServer;
  /** Tear down the HTTP server. */
  close: () => Promise<void>;
}

/**
 * Stands up the SAME runtime composition as main.ts (registry + orchestrator), exactly as the
 * former single UAT file's beforeAll did. Pure turn-driven — the only mode (real-time purge
 * 2026-07-10: no wall-clock watcher, no real timers). Each split test file calls this in its
 * own beforeAll and tears it down in afterAll — the runtimes are independent, so the files
 * are free to run on separate CI runners.
 */
export async function startUatHarness(): Promise<UatHarness> {
  const clock = new FakeClock();
  process.env.ORWELL_BEDTIME_GATE = "0"; // ORW-116: the HTTP UAT player turns in directly when a night is held (the bedtime gate is a separate narrator-facing guard; the night HOLD stays fully on)
  const runtime = composeRuntime({
    clock,
        seed: 1,
  });
  // Do NOT call runtime.start() — watcher is disabled; wiring is identical to production otherwise.
  const directResolver = runtime.registry.resolver();
  const server: Server = createHttpMcpServer({ resolve: directResolver });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { base, directResolver, close };
}
