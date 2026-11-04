import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * ENGINE-ONLY persistent text -> vector cache around any embedder (the boot-time rebuild fix, rehearsal 2026-11-03).
 *
 * On every engine restart `rebuildSoulIndex` re-embeds a whole mid-season save's soul notes (~1500) through the ONE ONNX worker — a minute-plus of saturated
 * cores during which /health and turns starve. Vectors are DERIVED, DETERMINISTIC state (same text + same pinned model => same vector), so remembering them across
 * restarts makes every restart after the first embed (almost) nothing. The cache can never change an answer: a hit returns exactly the vector the embedder produced
 * (stored as full-precision doubles, base64), and a vector produced AFTER the inner provider degraded (the fallback space) is never stored.
 *
 * - Synchronous `embed` (the ADR 0004 seam stays sync); writes are append-only and flushed off the hot path.
 * - File name carries the model + dim (the caller's choice), so a provider/model change starts a fresh cache — spaces never mix.
 * - Tolerant: corrupt/truncated lines are skipped; an unwritable path degrades to an in-memory cache; bounded (oldest dropped + file compacted past `maxEntries`).
 * - Vault-free by construction: it only ever sees the text the embedder would have seen.
 */
export interface CacheableEmbedder {
  embed(text: string): number[];
  readonly degraded?: boolean;
  readonly dim?: number;
}

export interface CachedEmbeddingOptions {
  maxEntries?: number;
}

export const DEFAULT_MAX_CACHED_VECTORS = 20_000;

const keyOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 32);
const encode = (v: readonly number[]): string => Buffer.from(new Float64Array(v).buffer).toString("base64");
function decode(b64: string): number[] | null {
  try {
    const buf = Buffer.from(b64, "base64");
    // Strict: Node's base64 decoder is lenient (it silently skips invalid characters), so require an exact round trip, a whole number of doubles, finite values.
    if (buf.length === 0 || buf.length % 8 !== 0 || buf.toString("base64") !== b64) return null;
    const out = Array.from(new Float64Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length)));
    return out.every(Number.isFinite) ? out : null;
  } catch { return null; }
}

export class CachedEmbedding {
  private readonly map = new Map<string, number[]>();
  private pending: string[] = [];
  private writing: Promise<void> = Promise.resolve();
  private writable = true;
  private readonly max: number;

  constructor(private readonly inner: CacheableEmbedder, private readonly file: string, opts: CachedEmbeddingOptions = {}) {
    this.max = opts.maxEntries ?? DEFAULT_MAX_CACHED_VECTORS;
    this.load();
  }

  get dim(): number | undefined { return this.inner.dim; }
  get degraded(): boolean { return this.inner.degraded === true; }
  get size(): number { return this.map.size; }

  embed(text: string): number[] {
    const k = keyOf(text);
    const hit = this.map.get(k);
    if (hit) return hit.slice();
    const v = this.inner.embed(text);
    // The inner provider may have JUST fallen back to the deterministic space on this very call: never persist that vector.
    if (!this.degraded && Array.isArray(v) && v.length > 0) {
      this.map.set(k, v.slice());
      this.queue(k, v);
    }
    return v;
  }

  /** Resolves once every queued append has hit disk (tests / orderly shutdown). */
  async flush(): Promise<void> {
    this.drain();
    await this.writing;
  }

  private queue(k: string, v: readonly number[]): void {
    if (!this.writable) return;
    this.pending.push(JSON.stringify({ k, v: encode(v) }) + "\n");
    if (this.pending.length === 1) setTimeout(() => this.drain(), 250).unref?.();
  }

  private drain(): void {
    if (this.pending.length === 0 || !this.writable) return;
    const chunk = this.pending.join("");
    this.pending = [];
    this.writing = this.writing.then(() => appendFile(this.file, chunk)).catch(() => { this.writable = false; });
  }

  private load(): void {
    try { mkdirSync(dirname(this.file), { recursive: true }); } catch { this.writable = false; return; }
    let raw = "";
    try { raw = readFileSync(this.file, "utf8"); } catch { return; }          // no file yet
    const entries: Array<[string, number[]]> = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try {
        const o = JSON.parse(line) as { k?: unknown; v?: unknown };
        if (typeof o.k !== "string" || typeof o.v !== "string") continue;
        const vec = decode(o.v);
        if (vec) entries.push([o.k, vec]);
      } catch { /* a truncated / corrupt line: skip it */ }
    }
    const kept = entries.length > this.max ? entries.slice(entries.length - this.max) : entries;
    for (const [k, v] of kept) { this.map.delete(k); this.map.set(k, v); }
    if (entries.length > this.max) {
      try { writeFileSync(this.file, kept.map(([k, v]) => JSON.stringify({ k, v: encode(v) }) + "\n").join("")); } catch { this.writable = false; }
    }
  }
}
