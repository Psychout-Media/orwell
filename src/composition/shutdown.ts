/**
 * Graceful shutdown with a hard exit deadline (ORW-404). The hard-exit timer is armed BEFORE the flush
 * and is unref'd; the flush itself must be non-blocking (async fsync) so that timer can actually fire
 * when a sync never settles. Idempotent: a second signal while shutting down is ignored.
 *
 * Order: onStart (stop taking NEW work) -> quiesce -> drain (let in-flight work finish) -> flush -> exit.
 * A request accepted during the flush could write a newer save after the flush snapshotted its work, and
 * the exit would discard it; every step before the flush exists to prevent that.
 */
export interface ShutdownOptions {
  /**
   * Called synchronously, first, when shutdown begins (before the timer and the flush): the place to
   * stop accepting NEW work (the transport's "shutting down" flag). Must not throw; if it does it is ignored.
   */
  onStart?: () => void;
  /**
   * Stop taking new work BEFORE the flush (e.g. close a listener). Runs after onStart and before the drain.
   * Bounded by the hard-exit timer; a throw never blocks the flush.
   */
  quiesce?: () => void | Promise<void>;
  /**
   * ORW-404: wait for requests already in flight to finish (bounded by `drainMs`); runs BEFORE the flush
   * so the flush sees every save those requests made. May never settle.
   */
  drain?: () => Promise<void>;
  /** What is still running (tool-call requests and queued jobs); read after the drain so a timed-out drain can say so. */
  pending?: () => { requests: number; jobs: number };
  /** One-line logger for shutdown notices. Default console.error. No player text. */
  log?: (line: string) => void;
  /** Bound on the drain (ms). Default 5 000. */
  drainMs?: number;
  /** Non-blocking flush of un-synced saves; may never settle. */
  flush: () => Promise<void>;
  exit: (code: number) => void;
  /** Hard exit deadline (ms). Default 12 000. */
  hardExitMs?: number;
}

export const DEFAULT_HARD_EXIT_MS = 12_000;
/** In-flight requests normally finish in milliseconds; 5 s is a generous bound that still leaves the flush its share. */
export const DEFAULT_DRAIN_MS = 5_000;
/**
 * The flush's own deadline. The three bounds must fit: DEFAULT_DRAIN_MS + DEFAULT_FLUSH_MS < DEFAULT_HARD_EXIT_MS,
 * so a slow drain can never leave the flush less time than its deadline says before the hard exit cuts it.
 */
export const DEFAULT_FLUSH_MS = 6_000;

export function createShutdown(opts: ShutdownOptions): () => Promise<void> {
  let started: Promise<void> | null = null;
  return () => {
    if (started) return started;
    try { opts.onStart?.(); } catch { /* stopping intake is best-effort; never block exit */ }
    // Exactly one exit: the hard timer and a flush that returns late must not both call it.
    let exited = false;
    const exitOnce = (): void => { if (exited) return; exited = true; opts.exit(0); };
    const timer = setTimeout(exitOnce, opts.hardExitMs ?? DEFAULT_HARD_EXIT_MS);
    if (typeof timer.unref === "function") timer.unref();
    started = (async () => {
      try { await opts.quiesce?.(); } catch { /* quiesce is best-effort: still flush */ }
      if (opts.drain) {
        let t: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            opts.drain(),
            new Promise<void>((r) => { t = setTimeout(r, opts.drainMs ?? DEFAULT_DRAIN_MS); t.unref?.(); }),
          ]);
        } catch { /* never block exit */ }
        if (t) clearTimeout(t);
        // Review of #2768 (M3): a drain that timed out with work still running says so; those saves may be missing.
        try {
          const p = opts.pending?.();
          if (p && (p.requests > 0 || p.jobs > 0)) {
            (opts.log ?? ((l: string) => console.error(l)))(`[orwell] shutdown drain timed out with ${p.jobs} job(s) and ${p.requests} request(s) still in flight; their saves may be missing`);
          }
        } catch { /* a notice never blocks exit */ }
      }
      try { await opts.flush(); } catch { /* never block exit */ }
      clearTimeout(timer);
      exitOnce();
    })();
    return started;
  };
}
