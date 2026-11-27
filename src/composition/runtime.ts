import { GameSessionRegistry } from "./registry";
import { Orchestrator } from "./orchestrator";
import { LogicalClock } from "../adapters/time/LogicalClock";
import { FileSaveStore } from "../adapters/engine/FileSaveStore";
import { SqliteSaveStore } from "../adapters/sqlite/SqliteSaveStore";
import { FileUserNotorietyStore } from "../adapters/engine/FileUserNotorietyStore";
import { FileUserHallOfFameStore } from "../adapters/engine/FileUserHallOfFameStore";
import { FileUserSeasonArchive } from "../adapters/engine/FileUserSeasonArchive";
import { GameSessionAdapter } from "../adapters/engine/GameSessionAdapter";
import type { Clock } from "../ports/Clock";
import type { UserSaveStore, SaveDurability } from "../ports/UserSaveStore";

// ── the play-clock (real-time purge 2026-07-10, PO ruling) ──────────────────────────
//
// The orchestrator's per-turn tick seeds derived rng streams and recency windows with
// `clock.now()` (`confessional-recent/-phrasing:${clockNow}`, `orch:day:${clockNow}` ids). This is
// a pure `LogicalClock`: it starts at a FIXED epoch and advances ONLY on committed mutations (one
// in-house minute per commit) — so nothing in the game reads wall time, the house lives only on the
// player's play-clock, and identical commit sequences ⇒ identical clock sequences ⇒ identical tick
// behavior at any pacing. Reads never advance it (read counts are wall-clock-paced — the driver's
// quiesce polls — and must stay clock-neutral). This makes 0108's golden record/replay deterministic
// for free, and — the PO ruling — guarantees no version can ever run the house in real time: the old
// wall-clock `SystemClock` + background `GameWatcher` were DELETED, not disabled.

/** 2026-01-01T00:00:00Z — an arbitrary fixed epoch so logical timestamps read plausibly. */
const LOGICAL_CLOCK_EPOCH_MS = 1_767_225_600_000;
/** One committed mutation ≈ one in-house minute — keeps recency windows meaningful. */
const LOGICAL_CLOCK_STEP_MS = 60_000;

/**
 * Live engine runtime composition (feature 0031; real-time purge 2026-07-10, PO ruling). Wires the
 * per-user `GameSessionRegistry` (0021) and the 0031 `Orchestrator` — the commit/integrity spine.
 *
 * **There is no real-world clock and no background watcher.** The house does NOT live while the
 * player is away, and NOTHING advances the game on wall-clock time (NPCs can't leave the house but
 * the player can — background scheming during an absence is a structural unfairness the game must
 * never have). The house lives ONLY on the player's play-clock: the orchestrator fires ONE bounded
 * off-screen tick per committed player turn (`maybeTurnDrivenTick`), and the in-game time-of-day
 * (0066) advances only as the player plays. The deleted `GameWatcher`/`SystemClock`/`Scheduler` were
 * the only real-time surface; they are gone so no version can ever run the house in real time. This
 * module carries no game logic — it only assembles.
 */
export interface RuntimeOptions {
  /** Durable store (0030). Omit for a purely in-memory runtime. */
  saveStore?: UserSaveStore;
  /**
   * Compose the default disk-backed store (B59/audit E7): the entrypoint asks for durability and
   * the COMPOSITION layer constructs it, so `main.ts` never imports an engine-only adapter (it now
   * sits inside the dependency-cruiser OUTWARD set). Ignored when `saveStore` is given.
   */
  durable?: boolean;
  /**
   * The clock the orchestrator stamps with. Default: a fresh `LogicalClock` at the fixed epoch,
   * advanced one step per committed mutation (never wall time). A test may inject its own clock —
   * the runtime then leaves it to the test to drive (it only steps the clock it created).
   */
  clock?: Clock;
  /** Deterministic off-screen RNG seed for the orchestrator. */
  seed?: number;
  /** Resident-sandbox LRU cap (audit R4); env `ORWELL_MAX_RESIDENT_SANDBOXES` otherwise. */
  maxResidentSandboxes?: number;
  /**
   * Skip the eager boot-time resume of saved users (default: resume eagerly, as always). The
   * entrypoint sets this so it can bind the HTTP server + warm the embedder FIRST, then call
   * `resumeSaved()` — so a cold/blocked embedding model can never delay `/health`, and resumed
   * souls still capture the real embedder once it is warm (prod incident 2026-06-19).
   */
  deferResume?: boolean;
}

export interface Runtime {
  registry: GameSessionRegistry;
  orchestrator: Orchestrator;
  clock: Clock;
  /** Is this a KNOWN user (live sandbox or durable save)? The network boundary's gate (B34). */
  knownUser(user: string): boolean;
  /** Resume saved users from disk (the boot preload). Called automatically unless `deferResume`
   *  was set, in which case the entrypoint calls it after binding HTTP + warming the embedder. */
  resumeSaved(): void;
  /**
   * ORW-406 slice 3: the same resume as `resumeSaved`, but yielding to the event loop between users so a
   * request arriving mid-warm-up is served at once (it builds its own sandbox through the same
   * `registry.sandboxFor`, which caches per user, so no save is loaded twice). Resolves when every saved
   * game has been loaded once (with more saved games than `maxResidentSandboxes`, idle ones are unloaded again as later ones load, so `warmed` means the pass finished, not that every game is still resident). A save-store enumeration error rejects: the entrypoint catches and logs it. `warmStatus` reports readiness for `/health`.
   */
  warmSaved(): Promise<void>;
  warmStatus(): { warmed: boolean; warmMs: number | null };
  /** ORW-404: the save-fsync backlog for `/health` (all zero when the store has none). */
  saveDurability(): SaveDurability;
  /** ORW-404: mark the process as shutting down (one-way). The transport then refuses NEW tool calls with a retryable 503. */
  beginShutdown(): void;
  /** ORW-404: true once `beginShutdown` ran; read by the transport per request. */
  isShuttingDown(): boolean;
  /** ORW-404: non-blocking shutdown flush; resolves by `timeoutMs` even if a sync never settles. Never rejects. */
  flushSavesAsync(timeoutMs?: number): Promise<void>;
  /** The in-game clock's LIVE state (runtime FE flip, else the env default) — reported on `/health`. */
  timeOfDayStatus(): boolean;
}

/** The default disk store, told what is already on disk so `/health` is truthful from boot (ORW-1092). */
function seededFileSaveStore(): FileSaveStore {
  const store = new FileSaveStore();
  store.seedDurabilityFromDisk();
  return store;
}

/**
 * The durable save store the entrypoint composes when `durable` is set (B59/audit E7: the composition
 * layer constructs the engine-only adapter, so `main.ts` never imports one). E63: `ORWELL_STORE=sqlite`
 * selects the relational `SqliteSaveStore` (same versioned-blob, never-overwrite, lossless semantics);
 * DEFAULT unset ⇒ the file-backed `FileSaveStore` (today's behavior — unchanged).
 */
function buildDurableStore(env: Record<string, string | undefined> = process.env): UserSaveStore {
  return (env.ORWELL_STORE ?? "").trim().toLowerCase() === "sqlite"
    ? new SqliteSaveStore()
    : seededFileSaveStore();
}

export function composeRuntime(opts: RuntimeOptions = {}): Runtime {
  // The play-clock: a fixed-epoch `LogicalClock` advanced one step per committed mutation (never wall
  // time). An injected clock (tests) always wins — and the runtime then leaves it to the test to
  // drive, only ever stepping the clock IT created (`ownedClock`).
  const clock: Clock = opts.clock ?? new LogicalClock(LOGICAL_CLOCK_EPOCH_MS);
  const ownedClock = opts.clock ? null : (clock as LogicalClock);
  const saveStore = opts.saveStore ?? (opts.durable ? buildDurableStore() : undefined);
  const envResident = parseInt((process.env.ORWELL_MAX_RESIDENT_SANDBOXES ?? "").trim(), 10);
  const maxResident = opts.maxResidentSandboxes
    ?? (Number.isFinite(envResident) && envResident > 0 ? envResident : undefined);
  // 0104 — when the runtime is durable, persist account-level NOTORIETY to disk too (a SEPARATE subtree
  // from the per-season saves, so the season-restart rotation never touches it — account reputation
  // survives the cutover). In-memory otherwise (the registry defaults to an in-memory store).
  const notorietyStore = saveStore ? new FileUserNotorietyStore() : undefined;
  const hallStore = saveStore ? new FileUserHallOfFameStore() : undefined; // 0208 B3: its own subtree, like notoriety
  const seasonArchive = saveStore ? new FileUserSeasonArchive() : undefined; // 0208 (B1): the same separate-subtree durability
  const registry = new GameSessionRegistry(saveStore, {
    ...(hallStore ? { hallStore } : {}),
    ...(maxResident !== undefined ? { maxResident } : {}),
    ...(notorietyStore ? { notorietyStore } : {}),
    ...(seasonArchive ? { seasonArchive } : {}),
  });
  // The house lives ONLY on the player's play-clock: `turnDriven` fires one bounded off-screen tick
  // per player turn (there is no wall-clock watcher — deleted by design). `auxTicksNever` (0108/M0-9):
  // under the logical clock every commit is a full time step, so the wall-time aux debounce can never
  // absorb — aux commits (an interaction, a DR entry) must never tick; only progressed BEAT commits
  // tick, which replay identically (per-turn commit counts vary with the model's live round pacing).
  const orchestrator = new Orchestrator(registry, clock, {
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    turnDriven: true,
    auxTicksNever: true,
  });
  // The orchestrator becomes the real spine (B41/audit E3): every player-channel mutation now commits
  // through the fail-closed integrity checkpoint (+ touch + one turn-driven off-screen tick), not a
  // blind save. Time advances HERE — once per committed mutation, before the commit runs, so the tick
  // this commit fires sees the new minute. Reads never advance the clock.
  registry.setCommit((user) => {
    if (ownedClock) ownedClock.advance(LOGICAL_CLOCK_STEP_MS);
    try {
      orchestrator.commitPlayerTurn(user);
    } catch (e) {
      // A REFUSED commit (TurnRefused / PersistFailure) rolled the sandbox back — roll the minute
      // back too, so a retry of the same turn sees the same clock-derived tick seeds and recency
      // windows (an advanced clock on a failed commit would fork the retry). Refusals are
      // deterministic, so record and replay roll back alike.
      if (ownedClock) ownedClock.advance(-LOGICAL_CLOCK_STEP_MS);
      throw e;
    }
  });
  // The ONE restart door is COMPLETE (audit E1/D1/R1): when a season resets — admin reset or the
  // player channel's confirmed restart, both via registry.resetUser — the orchestrator forgets the
  // dead season's baseline/faults/rng, so season 2's first commit is a first commit, never a
  // "degradation" against a finished season.
  registry.setOnReset((user) => orchestrator.forgetUser(user));
  // #1067 — a fail-soft background enrichment (the season-start cast-authoring upgrade) replaced live
  // state outside the commit seam; re-seed the non-degradation baseline to the freshly-saved state so the
  // next player-turn commit isn't refused as a "degradation" against the stale floor baseline (the same
  // seedBaseline discipline a resume-from-disk uses — audit E6).
  registry.setOnBackgroundCommit((user) => orchestrator.seedBaseline(user));
  // Every from-disk rebuild (boot warm-up, a request that arrives first, a resume after an LRU unload) re-baselines
  // unconditionally: a baseline kept from a previous in-memory object graph is the stale case `seedBaseline`
  // documents (review of #2747). The unload drops it, so an idle user pins no snapshot.
  registry.setOnResume((user) => {
    // ORW-730: the play-clock picks up where the save left it (tick seeds and recency windows are keyed on it), so a restart does not re-key every later draw.
    const saved = registry.resumedTickState(user)?.clock;
    if (ownedClock && saved !== undefined) ownedClock.raiseTo(saved);
    orchestrator.seedBaseline(user);
  });
  registry.setOnUnload((user) => orchestrator.dropBaseline(user));
  // God Mode can SEE sandbox health (B58/audit E5+E6): integrity, faults, the circuit state.
  registry.setHealthProvider((user) => orchestrator.sandboxHealth(user));
  // Preload saved users at boot (B60/audit E11): without this, every deploy froze each house until
  // that user's NEXT request — resume them now so the turn loop can see them immediately.
  // A user whose save fails to resolve is skipped (B35's tolerant-load handles the quarantine).
  // Each resumed game also SEEDS the non-degradation baseline (audit E6): the first commit after an
  // engine restart used to be checkpoint-blind — the guard's hole sat exactly at resume-from-disk.
  const resumeSaved = (): void => {
    for (const user of saveStore?.listUsers?.() ?? []) {
      try {
        registry.sandboxFor(user);
        orchestrator.seedBaselineIfAbsent(user); // the resume hook seeded it; do not export the save twice
      } catch { /* skip an unresumable save; the rest still boot */ }
    }
  };
  // Pending only when the entrypoint deferred the resume AND a save exists; everything else is warm already.
  const warmPending = !!opts.deferResume && (saveStore?.listUsers?.().length ?? 0) > 0;
  let warmStart: number | null = null;
  let warmMs: number | null = null;
  const warmSaved = async (): Promise<void> => {
    warmStart = performance.now();
    try {
      for (const user of saveStore?.listUsers?.() ?? []) {
        await new Promise<void>((r) => setImmediate(r));
        try {
          registry.sandboxFor(user);
          orchestrator.seedBaselineIfAbsent(user); // the resume hook seeded it; do not export the save twice
        } catch { /* skip an unresumable save; the rest still warm */ }
      }
    } finally {
      warmMs = Math.round(performance.now() - warmStart);
    }
  };
  // Default: resume eagerly (tests + every non-entrypoint caller keep the original behavior). The
  // entrypoint passes deferResume so it can bind /health + warm the embedder before resuming.
  if (!opts.deferResume) resumeSaved();
  let shuttingDown = false;
  return {
    registry,
    orchestrator,
    clock,
    beginShutdown: () => { shuttingDown = true; },
    isShuttingDown: () => shuttingDown,
    // A user with filed hall-of-fame seasons is known even with no save (0208 B3: the hall lives outside any game, so after a season is reset the player must still be able to read it); an unknown user still mints nothing.
    knownUser: (user) => registry.usernames().includes(user) || (saveStore?.hasSave(user) ?? false) || (hallStore?.read(user).length ?? 0) > 0,
    resumeSaved,
    warmSaved,
    warmStatus: () => ({ warmed: !warmPending || warmMs !== null, warmMs }),
    timeOfDayStatus: () => GameSessionAdapter.timeOfDayEffective(),
    saveDurability: () => saveStore?.durability?.()
      ?? { saveLatestVersion: 0, saveDurableVersion: 0, saveOldestUnsyncedAgeMs: 0, saveUnsyncedUsers: 0, saveDurabilityPending: false },
    flushSavesAsync: async (timeoutMs) => { try { await saveStore?.flushDurableAsync?.(timeoutMs); } catch { /* never block exit */ } },
  };
}

// ORW-404: the entrypoint composes the runtime only (audit E18), so the shutdown helper is re-exported here.
export { createShutdown, DEFAULT_HARD_EXIT_MS, DEFAULT_DRAIN_MS, DEFAULT_FLUSH_MS } from "./shutdown";
