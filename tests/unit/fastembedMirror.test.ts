import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ensureModelFiles, MODEL_MIRROR, PINNED_MODEL } from "../../src/adapters/embedding/fastembedWorker";

/**
 * Regression guard (2026-11): fastembed 2.1.0 fetches the pinned model from the public
 * `qdrant-fastembed` GCS bucket, which now answers anonymous reads with 403 AccessDenied — every
 * fresh install/update silently ran semantic recall DEGRADED (smoke [A12]: TAR_BAD_ARCHIVE).
 * `ensureModelFiles` populates the cache from Qdrant's pinned, sha256-verified HuggingFace mirror
 * first, atomically, so fastembed finds the model and never reaches the dead bucket.
 */
const sha = (s: string): string => createHash("sha256").update(Buffer.from(s)).digest("hex");
const MODEL = "test-model";
const FILES = { "a.onnx": "onnx-bytes", "b.json": "{}" };
const mirror = { [MODEL]: { base: "https://mirror.example/rev", files: { "a.onnx": sha(FILES["a.onnx"]), "b.json": sha(FILES["b.json"]) } } };
const fakeFetch = (overrides: Record<string, string> = {}) => {
  const calls: string[] = [];
  const fetchBytes = async (url: string): Promise<Uint8Array> => {
    calls.push(url);
    const name = url.split("/").pop()!;
    return new Uint8Array(Buffer.from(overrides[name] ?? FILES[name as keyof typeof FILES]));
  };
  return { calls, fetchBytes };
};

describe("ensureModelFiles — pinned, verified, atomic model cache (dead GCS bucket workaround)", () => {
  it("downloads every file from the pinned revision into <cacheDir>/<model>/ when absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orwell-embed-"));
    const f = fakeFetch();
    await ensureModelFiles(dir, MODEL, { fetchBytes: f.fetchBytes, mirror });
    expect(f.calls.sort()).toEqual(["https://mirror.example/rev/a.onnx", "https://mirror.example/rev/b.json"]);
    expect(readFileSync(join(dir, MODEL, "a.onnx"), "utf8")).toBe("onnx-bytes");
    expect(readdirSync(dir)).toEqual([MODEL]); // no leftover partial dir
  });

  it("a checksum mismatch throws and leaves NO model dir (fastembed trusts mere existence)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orwell-embed-"));
    const f = fakeFetch({ "b.json": "<?xml AccessDenied?>" });
    await expect(ensureModelFiles(dir, MODEL, { fetchBytes: f.fetchBytes, mirror })).rejects.toThrow(/sha256/);
    expect(existsSync(join(dir, MODEL))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("an existing complete cache is left alone — no download, no recall migration", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orwell-embed-"));
    mkdirSync(join(dir, MODEL));
    for (const [n, c] of Object.entries(FILES)) writeFileSync(join(dir, MODEL, n), c);
    const f = fakeFetch();
    await ensureModelFiles(dir, MODEL, { fetchBytes: f.fetchBytes, mirror });
    expect(f.calls).toEqual([]);
  });

  it("an incomplete prior dir is replaced whole", async () => {
    const dir = mkdtempSync(join(tmpdir(), "orwell-embed-"));
    mkdirSync(join(dir, MODEL));
    writeFileSync(join(dir, MODEL, "a.onnx"), "stale");
    await ensureModelFiles(dir, MODEL, { fetchBytes: fakeFetch().fetchBytes, mirror });
    expect(readFileSync(join(dir, MODEL, "a.onnx"), "utf8")).toBe("onnx-bytes");
    expect(existsSync(join(dir, MODEL, "b.json"))).toBe(true);
  });

  it("pins the production model to an immutable revision with every file fastembed requires", () => {
    const entry = MODEL_MIRROR[PINNED_MODEL]!;
    expect(entry.base).toMatch(/\/resolve\/[0-9a-f]{40}$/); // a commit sha, never a moving branch
    expect(Object.keys(entry.files).sort()).toEqual(
      ["config.json", "model_optimized.onnx", "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json"]);
    for (const h of Object.values(entry.files)) expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
