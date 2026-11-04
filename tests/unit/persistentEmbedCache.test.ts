import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CachedEmbedding } from "../../src/adapters/embedding/PersistentEmbedCache";

/**
 * The boot-time soul-index rebuild re-embeds a whole season's notes (~1500 for a mid-season save) through the ONE ONNX worker on EVERY engine restart — minute-long
 * at six saturated cores, starving /health and turns (rehearsal 2026-11-03). Vectors are DERIVED, DETERMINISTIC state (same text + model => same vector), so a
 * persistent text->vector cache makes every restart after the first embed nothing. Roles only.
 */
class Counting {
  calls = 0;
  degraded = false;
  readonly dim = 4;
  embed(text: string): number[] {
    this.calls++;
    let h = 0;
    for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 9973;
    return [h / 9973, 1 / (1 + (h % 7)), Math.PI * (h % 5), -0.1234567890123456];   // full-precision doubles on purpose
  }
}
const fresh = (): string => join(mkdtempSync(join(tmpdir(), "orwell-embcache-")), "embed-cache.jsonl");

describe("CachedEmbedding", () => {
  it("embeds a text once; the second ask is a hit that returns the identical vector", async () => {
    const inner = new Counting();
    const c = new CachedEmbedding(inner, fresh());
    const a = c.embed("a note about a houseguest");
    const b = c.embed("a note about a houseguest");
    expect(inner.calls).toBe(1);
    expect(b).toEqual(a);
    expect(b).not.toBe(a);                                  // a copy: a caller cannot corrupt the cache
    b[0] = 99;
    expect(c.embed("a note about a houseguest")[0]).toBe(a[0]);
  });

  it("a RESTART (new instance, same file) embeds nothing it has seen — exact full-precision vectors", async () => {
    const file = fresh();
    const first = new CachedEmbedding(new Counting(), file);
    const texts = Array.from({ length: 40 }, (_, i) => `memory number ${i}`);
    const vecs = texts.map((t) => first.embed(t));
    await first.flush();
    const inner = new Counting();
    const second = new CachedEmbedding(inner, file);
    const again = texts.map((t) => second.embed(t));
    expect(inner.calls, "a restart re-embeds nothing").toBe(0);
    expect(again).toEqual(vecs);
    expect(second.embed("a brand new note")).toHaveLength(4);
    expect(inner.calls).toBe(1);
  });

  it("never caches a vector produced after the inner provider degraded (it is the fallback space)", async () => {
    const file = fresh();
    const inner = new Counting();
    const c = new CachedEmbedding(inner, file);
    inner.degraded = true;
    c.embed("fallback-space note");
    await c.flush();
    const second = new CachedEmbedding(new Counting(), file);
    const probe = new Counting();
    const c2 = new CachedEmbedding(probe, file);
    c2.embed("fallback-space note");
    expect(probe.calls, "the degraded vector was not persisted").toBe(1);
    expect(second.size).toBe(0);
  });

  it("tolerates a corrupt or truncated file (a crash mid-append): good lines load, bad ones are skipped", async () => {
    const file = fresh();
    const seed = new CachedEmbedding(new Counting(), file);
    seed.embed("good one");
    seed.embed("good two");
    await seed.flush();
    appendFileSync(file, '{"k":"deadbeef","v":"not-base64-of-a-vector"}\nnot json at all\n{"k":"trunc');
    const inner = new Counting();
    const c = new CachedEmbedding(inner, file);
    expect(c.size).toBe(2);
    c.embed("good one");
    c.embed("good two");
    expect(inner.calls).toBe(0);
  });

  it("is bounded: past the cap the oldest entries are dropped on load and the file is compacted", async () => {
    const file = fresh();
    const seed = new CachedEmbedding(new Counting(), file, { maxEntries: 1000 });
    for (let i = 0; i < 30; i++) seed.embed(`note ${i}`);
    await seed.flush();
    const c = new CachedEmbedding(new Counting(), file, { maxEntries: 10 });
    expect(c.size).toBe(10);
    const inner = new Counting();
    const d = new CachedEmbedding(inner, file, { maxEntries: 10 });
    d.embed("note 29");           // newest survived
    expect(inner.calls).toBe(0);
    d.embed("note 0");            // oldest was dropped
    expect(inner.calls).toBe(1);
    expect(readFileSync(file, "utf8").trim().split("\n").length).toBeLessThanOrEqual(10);
  });

  it("exposes the inner provider's live degraded flag and dim (the /health tracker reads them)", () => {
    const inner = new Counting();
    const c = new CachedEmbedding(inner, fresh());
    expect(c.dim).toBe(4);
    expect(c.degraded).toBe(false);
    inner.degraded = true;
    expect(c.degraded).toBe(true);
  });

  it("an unwritable cache file never breaks embedding (the cache is an optimisation)", () => {
    const inner = new Counting();
    // a path UNDER A REGULAR FILE (ENOTDIR on mkdir/append) — unwritable by construction on any OS
    const blocker = join(mkdtempSync(join(tmpdir(), "orwell-embcache-")), "a-file");
    writeFileSync(blocker, "x");
    const c = new CachedEmbedding(inner, join(blocker, "sub", "embed-cache.jsonl"));
    expect(c.embed("still works")).toHaveLength(4);
    expect(c.embed("still works")).toHaveLength(4);
    expect(inner.calls).toBe(1);
  });
});

describe("the embed worker's ONNX thread bound", () => {
  it("defaults to 2 intra-op threads (never every core), is overridable, and rejects nonsense", async () => {
    const { embedThreads, DEFAULT_EMBED_THREADS } = await import("../../src/adapters/embedding/fastembedWorker");
    expect(DEFAULT_EMBED_THREADS).toBe(2);
    expect(embedThreads({})).toBe(2);
    expect(embedThreads({ ORWELL_EMBED_THREADS: "4" })).toBe(4);
    for (const bad of ["0", "-1", "abc", "", "999"]) expect(embedThreads({ ORWELL_EMBED_THREADS: bad }), bad).toBe(2);
  });
});
