/**
 * Graceful shutdown with a hard exit deadline (ORW-404). The hard-exit timer is armed BEFORE the flush
 * and is unref'd; the flush itself must be non-blocking (async fsync) so that timer can actually fire
 * when a sync never settles. Idempotent: a second signal while shutting down is ignored.
 */
export interface ShutdownOptions {
  /** Non-blocking flush of un-synced saves; may never settle. */
  flush: () => Promise<void>;
  exit: (code: number) => void;
  /**
   * ORW-404: wait for requests already in flight to finish (bounded by `drainMs`); runs after onStart and
   * BEFORE the flush so the flush sees every save those requests made. May never settle.
   */
  drain?: () => Promise<void>;
  /** Bound on the drain (ms). Default 8 000. */
  drainMs?: number;
  /** Hard exit deadline (ms). Default 12 000. */
  hardExitMs?: number;
  /**
   * Called synchronously, first, when shutdown begins (before the timer and the flush): the place to
   * stop accepting NEW work (the transport's "shutting down" flag). Must not throw; if it does it is ignored.
   */
  onStart?: () => void;
}

export const DEFAULT_HARD_EXIT_MS = 12_000;
export const DEFAULT_DRAIN_MS = 8_000;

export function createShutdown(opts: ShutdownOptions): () => Promise<void> {
  let started: Promise<void> | null = null;
  return () => {
    if (started) return started;
    try { opts.onStart?.(); } catch { /* stopping intake is best-effort; never block exit */ }
    const timer = setTimeout(() => opts.exit(0), opts.hardExitMs ?? DEFAULT_HARD_EXIT_MS);
    if (typeof timer.unref === "function") timer.unref();
    started = (async () => {
      if (opts.drain) {
        let t: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            opts.drain(),
            new Promise<void>((r) => { t = setTimeout(r, opts.drainMs ?? DEFAULT_DRAIN_MS); t.unref?.(); }),
          ]);
        } catch { /* never block exit */ }
        if (t) clearTimeout(t);
      }
      try { await opts.flush(); } catch { /* never block exit */ }
      clearTimeout(timer);
      opts.exit(0);
    })();
    return started;
  };
}
