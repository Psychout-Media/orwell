/**
 * ENGINE-ONLY fastembed worker (ADR 0004 / audit E86a). Runs the pinned fastembed
 * (local ONNX, BGE-small-en-v1.5) off the main thread and serves SYNCHRONOUS embed
 * calls to `FastembedEmbedding` over a SharedArrayBuffer + Atomics protocol — the
 * engine's soul/recall seam is synchronous by design (an `await` inside a mutating
 * tool would reopen the sandbox-swap race the sync contract masks).
 *
 * Protocol (one in-flight request at a time — the main thread blocks):
 *   shared memory = Int32Array ctl[2] | Float64Array payload
 *     ctl[0] state: 0 = pending, 1 = ok (payload holds the vector), 2 = error
 *     ctl[1] vector length (floats)
 *   main: ctl[0]=0 → postMessage({ text }) → Atomics.wait(ctl, 0, 0, timeout)
 *   worker: embed → write payload + ctl[1] → Atomics.store(ctl[0], 1|2) → notify
 *
 * Doubles as the deploy-time prefetch CLI (offline-friendly thereafter — ADR 0004):
 *   node dist/embedWorker.js --prefetch [--cache-dir <dir>] [--model <name>]
 */
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

// The PIN (ADR 0004): library version is exact in package.json; the model is pinned
// here — changing either is a deliberate, versioned recall migration, never drift.
export const PINNED_MODEL = "fast-bge-small-en-v1.5";

/**
 * The pinned model's files, fetched from Qdrant's HuggingFace mirror at an IMMUTABLE revision and
 * verified by sha256. fastembed 2.1.0 downloads `fast-bge-small-en-v1.5.tar.gz` from the public
 * `storage.googleapis.com/qdrant-fastembed` bucket, which now refuses anonymous reads (403
 * AccessDenied — saved as the "archive", then `TAR_BAD_ARCHIVE`), so every fresh install/update ran
 * semantic recall permanently degraded. Qdrant publishes the same model (fastembed's own registry
 * lists it as this model's HF source) at `Qdrant/bge-small-en-v1.5-onnx-Q`. fastembed skips its own
 * download whenever `<cacheDir>/<model>/` exists, so we populate that directory first.
 */
export const MODEL_MIRROR: Readonly<Record<string, { base: string; files: Readonly<Record<string, string>> }>> = {
  [PINNED_MODEL]: {
    base: "https://huggingface.co/Qdrant/bge-small-en-v1.5-onnx-Q/resolve/aa8f8b060edb00e03bfdd08813a2949946c8ba55",
    files: {
      "model_optimized.onnx": "51f1bd0addd6e859e42c2c8021a5e5461385bb676a649f4b269aa445449f2431",
      "tokenizer.json": "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
      "config.json": "13582bcf2effc85b7bf3d3f5532e686bc1c9ce86bb009d10f0ec33cbe92299dd",
      "tokenizer_config.json": "0b29c7bfc889e53b36d9dd3e686dd4300f6525110eaa98c76a5dafceb2029f53",
      "special_tokens_map.json": "5d5b662e421ea9fac075174bb0688ee0d9431699900b90662acd44b2a350503a",
    },
  },
};

type FetchBytes = (url: string) => Promise<Uint8Array>;

const defaultFetchBytes: FetchBytes = async (url) => {
  const res = await fetch(url, { redirect: "follow" });
  // "model download failed" is a deploy-classifier keyword (smoke_embeddings.sh): a fetch problem is
  // reported as a download/network failure, never misdiagnosed as a fastembed import crash.
  if (!res.ok) throw new Error(`model download failed: ${url} → HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
};

/**
 * Ensure `<cacheDir>/<model>/` holds the pinned model files. A complete directory is left alone (an
 * existing box keeps its cache — no re-download, no recall migration). Otherwise every file is
 * fetched into a temp directory, sha256-verified, and only then renamed into place: fastembed trusts
 * the directory's mere EXISTENCE, so a partial download must never land at the final path. A model
 * with no mirror entry is left to fastembed's own download.
 */
export async function ensureModelFiles(
  cacheDir: string,
  model: string,
  opts: { fetchBytes?: FetchBytes; mirror?: typeof MODEL_MIRROR } = {},
): Promise<void> {
  const entry = (opts.mirror ?? MODEL_MIRROR)[model];
  if (!entry) return;
  const modelDir = join(cacheDir, model);
  const names = Object.keys(entry.files);
  if (existsSync(modelDir) && names.every((n) => existsSync(join(modelDir, n)))) return;
  const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
  // A FIXED temp name: a download killed mid-flight (warm-up timeout → worker.terminate() skips the
  // catch) leaves one stale `.partial`, which the next attempt clears — never one per pid, accumulating.
  const tmp = `${modelDir}.partial`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    for (const [name, sha] of Object.entries(entry.files)) {
      const bytes = await fetchBytes(`${entry.base}/${name}`);
      const got = createHash("sha256").update(bytes).digest("hex");
      // NOT "download failed": a checksum mismatch is deterministic (a wrong pin or tampered bytes) and
      // re-downloading cannot fix it, so the deploy classifier must FAIL on it, never skip it as a network
      // blip (smoke_embeddings.sh matches "integrity check failed" explicitly).
      if (got !== sha) throw new Error(`model integrity check failed: ${name} sha256 mismatch (got ${got})`);
      writeFileSync(join(tmp, name), bytes);
    }
    rmSync(modelDir, { recursive: true, force: true }); // an incomplete prior dir is replaced whole
    renameSync(tmp, modelDir);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

type Embedder = { passageEmbed(texts: string[], batchSize?: number): AsyncGenerator<number[][], void, unknown> };

async function initEmbedder(cacheDir: string, model: string): Promise<Embedder> {
  mkdirSync(cacheDir, { recursive: true });
  await ensureModelFiles(cacheDir, model);
  const { FlagEmbedding, EmbeddingModel } = await import("fastembed");
  // Resolve the pinned model NAME to the enum member (the init overloads demand the
  // concrete non-custom member, not the enum type).
  const entry = Object.entries(EmbeddingModel).find(([, v]) => v === model && v !== EmbeddingModel.CUSTOM);
  if (!entry) throw new Error(`unknown fastembed model "${model}" (pinned: ${PINNED_MODEL})`);
  return FlagEmbedding.init({
    model: EmbeddingModel[entry[0] as keyof typeof EmbeddingModel] as Exclude<
      (typeof EmbeddingModel)[keyof typeof EmbeddingModel],
      typeof EmbeddingModel.CUSTOM
    >,
    cacheDir,
    showDownloadProgress: false,
  });
}

async function embedOne(embedder: Embedder, text: string): Promise<number[]> {
  // One symmetric space for stores AND queries (BGE v1.5 is prefix-free-friendly);
  // SoulStore uses a single embed fn for both, so symmetry is the correct choice.
  for await (const batch of embedder.passageEmbed([text.length > 0 ? text : " "], 1)) {
    const vec = batch[0];
    if (vec) return Array.from(vec as ArrayLike<number>);
  }
  throw new Error("fastembed returned no vector");
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  const { sab, cacheDir, model } = workerData as { sab: SharedArrayBuffer; cacheDir: string; model: string };
  const ctl = new Int32Array(sab, 0, 2);
  const payload = new Float64Array(sab, 8);

  void (async () => {
    try {
      const embedder = await initEmbedder(cacheDir, model ?? PINNED_MODEL);
      const probe = await embedOne(embedder, "warm-up probe");
      port.postMessage({ type: "ready", dim: probe.length });
      port.on("message", (msg: { text: string }) => {
        void (async () => {
          try {
            const vec = await embedOne(embedder, msg.text);
            if (vec.length > payload.length) throw new Error(`vector dim ${vec.length} exceeds shared buffer`);
            payload.set(vec);
            ctl[1] = vec.length;
            Atomics.store(ctl, 0, 1);
          } catch (e) {
            console.error(`[orwell] fastembed worker embed failed: ${e instanceof Error ? e.message : String(e)}`);
            Atomics.store(ctl, 0, 2);
          }
          Atomics.notify(ctl, 0);
        })();
      });
    } catch (e) {
      port.postMessage({ type: "init-error", error: e instanceof Error ? e.message : String(e) });
    }
  })();
} else if (isMainThread && process.argv.includes("--prefetch")) {
  // Deploy-time model fetch/cache (orwell-install.sh / orwell-update.sh): downloads the
  // pinned model into the cache dir so engine boots are offline + fast thereafter.
  const argOf = (flag: string): string | undefined => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const cacheDir = argOf("--cache-dir") ?? `${process.cwd()}/.orwell-data/models`;
  const model = argOf("--model") ?? PINNED_MODEL;
  void (async () => {
    try {
      const embedder = await initEmbedder(cacheDir, model);
      await embedOne(embedder, "prefetch probe");
      console.log(`[orwell] fastembed model "${model}" cached at ${cacheDir}`);
      process.exit(0);
    } catch (e) {
      console.error(`[orwell] fastembed prefetch failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  })();
}
