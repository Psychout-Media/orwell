import { Worker } from "node:worker_threads";
import type { EmbeddingProvider } from "../../ports/EmbeddingProvider";
import { DeterministicEmbedding } from "./DeterministicEmbedding";
import { PINNED_MODEL } from "./fastembedWorker";
import { CachedEmbedding } from "./PersistentEmbedCache";

/**
 * ENGINE-ONLY real embedding provider (ADR 0004 / audit E86a): fastembed, local ONNX,
 * version-pinned — behind the same `EmbeddingProvider` port as the deterministic fake.
 *
 * Shape constraints this design honors:
 * - `SoulStore`'s embed seam is SYNCHRONOUS and must stay so (an `await` inside a
 *   mutating tool reopens the masked sandbox-swap race) → real inference runs in a
 *   worker thread and `embed()` blocks on Atomics with a bounded timeout.
 * - Vector SPACES must never mix inside an index → the provider is chosen ONCE per
 *   process lifetime (boot warm-up via `createFastembedEmbedding`; on failure the
 *   process composes the deterministic provider instead). Vectors are derived state —
 *   `rebuildSoulIndex` re-embeds every soul from `hg.soul.memory` on restore — so a
 *   restart re-derives all indexes in whichever space the process committed to.
 * - The game NEVER breaks on embedding trouble: if the worker dies mid-process, the
 *   provider degrades PERMANENTLY (for this process) to the deterministic fallback and
 *   logs loudly. Recall quality in already-written BGE-space indexes degrades until the
 *   next restart re-derives them — the documented, bounded worst case.
 */
export interface FastembedOptions {
  /** The built worker artifact (production: `new URL("./embedWorker.js", import.meta.url)`). */
  workerUrl: URL | string;
  /** Model cache dir (deploy prefetches into it; offline thereafter). */
  cacheDir: string;
  model?: string;
  /** Per-call budget once warm (default 5000ms — warm BGE-small is ~5–30ms). */
  embedTimeoutMs?: number;
  /** Warm-up budget (default 120s — covers a first-ever model download; prefetched installs take ~seconds). */
  initTimeoutMs?: number;
  fallback?: EmbeddingProvider & { embed(text: string): number[] };
}

const PAYLOAD_FLOATS = 2048; // 16 KiB — BGE-small is 384-dim; headroom for bigger pins.

export class FastembedEmbedding implements EmbeddingProvider {
  /** True once the worker has failed and the provider has permanently fallen back. */
  degraded = false;

  private constructor(
    private worker: Worker,
    private readonly ctl: Int32Array,
    private readonly payload: Float64Array,
    readonly dim: number,
    private readonly embedTimeoutMs: number,
    private readonly fallback: { embed(text: string): number[] },
  ) {}

  /** Synchronous real embedding via the worker bridge; deterministic fallback once degraded. */
  embed(text: string): number[] {
    if (this.degraded) return this.fallback.embed(text);
    try {
      Atomics.store(this.ctl, 0, 0);
      this.worker.postMessage({ text });
      const waited = Atomics.wait(this.ctl, 0, 0, this.embedTimeoutMs);
      if (waited === "timed-out") throw new Error(`embed timed out after ${this.embedTimeoutMs}ms`);
      const state = Atomics.load(this.ctl, 0);
      if (state !== 1) throw new Error("worker reported an embed error");
      const len = this.ctl[1]!;
      return Array.from(this.payload.subarray(0, len));
    } catch (e) {
      // Fail once, fail for the process: per-call flip-flopping would interleave vector
      // spaces inside an index. Loud, permanent (until restart), and the game plays on.
      this.degraded = true;
      console.error(
        `[orwell] fastembed degraded permanently for this process (${e instanceof Error ? e.message : String(e)}); ` +
          `semantic recall falls back to deterministic embeddings — a restart re-derives all soul indexes.`,
      );
      void this.worker.terminate();
      return this.fallback.embed(text);
    }
  }

  /** Test/shutdown hook. */
  async dispose(): Promise<void> {
    this.degraded = true;
    await this.worker.terminate();
  }

  /**
   * Boot-time warm-up: spins the worker, loads the pinned model (downloading into the
   * cache dir only if the deploy prefetch never ran), and proves one embed. Throws on
   * failure — the caller (main.ts) then composes the deterministic provider instead,
   * committing the whole process to one vector space either way.
   */
  static async create(opts: FastembedOptions): Promise<FastembedEmbedding> {
    const sab = new SharedArrayBuffer(8 + PAYLOAD_FLOATS * 8);
    const ctl = new Int32Array(sab, 0, 2);
    const payload = new Float64Array(sab, 8);
    const worker = new Worker(opts.workerUrl, {
      workerData: { sab, cacheDir: opts.cacheDir, model: opts.model ?? PINNED_MODEL },
    });
    worker.unref(); // never the reason the process stays alive

    const dim = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => fail(new Error(`fastembed warm-up timed out after ${opts.initTimeoutMs ?? 120_000}ms`)),
        opts.initTimeoutMs ?? 120_000,
      );
      const fail = (err: Error): void => {
        clearTimeout(timer);
        void worker.terminate();
        reject(err);
      };
      worker.once("message", (msg: { type: string; dim?: number; error?: string }) => {
        clearTimeout(timer);
        if (msg.type === "ready" && typeof msg.dim === "number") resolve(msg.dim);
        else fail(new Error(msg.error ?? "fastembed worker failed to initialise"));
      });
      worker.once("error", (e) => fail(e instanceof Error ? e : new Error(String(e))));
      worker.once("exit", (code) => fail(new Error(`fastembed worker exited during warm-up (code ${code})`)));
    });

    worker.removeAllListeners("exit");
    worker.removeAllListeners("error");
    return new FastembedEmbedding(worker, ctl, payload, dim, opts.embedTimeoutMs ?? 5000, opts.fallback ?? new DeterministicEmbedding());
  }
}

export const createFastembedEmbedding = FastembedEmbedding.create.bind(FastembedEmbedding);

/**
 * The provider the engine actually runs on: the worker wrapped in the persistent text->vector cache (so a restart re-derives every soul index from the saved notes
 * without re-embedding a whole mid-season save). The file name carries the pinned model + dim so a model change starts a fresh cache (vector spaces never mix).
 */
export function withPersistentCache(provider: FastembedEmbedding, dataDir: string): CachedEmbedding {
  const model = PINNED_MODEL.replace(/[^A-Za-z0-9._-]/g, "_");
  return new CachedEmbedding(provider, `${dataDir.replace(/\/$/, "")}/embed-cache-${model}-${provider.dim}.jsonl`);
}
