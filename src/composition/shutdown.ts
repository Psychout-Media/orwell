/**
 * Graceful shutdown with a hard exit deadline (ORW-404). The hard-exit timer is armed BEFORE the flush
 * and is unref'd; the flush itself must be non-blocking (async fsync) so that timer can actually fire
 * when a sync never settles. Idempotent: a second signal while shutting down is ignored.
 */
export interface ShutdownOptions {
  /** Non-blocking flush of un-synced saves; may never settle. */
  flush: () => Promise<void>;
  exit: (code: number) => void;
  /** Hard exit deadline (ms). Default 12 000. */
  hardExitMs?: number;
}

export const DEFAULT_HARD_EXIT_MS = 12_000;

export function createShutdown(opts: ShutdownOptions): () => Promise<void> {
  let started: Promise<void> | null = null;
  return () => {
    if (started) return started;
    const timer = setTimeout(() => opts.exit(0), opts.hardExitMs ?? DEFAULT_HARD_EXIT_MS);
    if (typeof timer.unref === "function") timer.unref();
    started = (async () => {
      try { await opts.flush(); } catch { /* never block exit */ }
      clearTimeout(timer);
      opts.exit(0);
    })();
    return started;
  };
}
