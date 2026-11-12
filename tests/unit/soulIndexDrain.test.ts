import { describe, it, expect, afterEach } from "vitest";
import { SoulStore } from "../../src/adapters/engine/SoulStore";
import { DeterministicEmbedding } from "../../src/adapters/embedding/DeterministicEmbedding";
import { npc } from "../../src/domain/ids";

/**
 * Lanes G8/G12 — a soul-write batch must not pin the event loop. The real embedder
 * (ADR 0004) blocks the loop per call, so `recordToSoul` defers the DERIVED vector
 * indexing to a one-embed-per-macrotask drain; the AUTHORITATIVE soul (narrative +
 * memories) still updates synchronously, and `recall` flushes its houseguest's
 * pending queue first so recall semantics are unchanged.
 *
 * G12 hoists the queue to ONE shared, process-wide lane: many stores (one per user
 * sandbox) bursting together still cost at most a single embed per macrotask — and a
 * dropped sandbox can `discardPending` its derived backlog off the lane entirely.
 * Roles only — no names.
 */

/** A counting embed over the deterministic vectors (the test adapter's space). */
function countingEmbed(): { calls: () => number; embed: (t: string) => number[] } {
  const inner = new DeterministicEmbedding();
  let n = 0;
  return { calls: () => n, embed: (t: string) => { n++; return inner.embed(t); } };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The lane is shared process-wide (G12): never leak one test's backlog into the next. */
afterEach(async () => {
  for (let i = 0; i < 1_000 && SoulStore.pendingTotal() > 0; i++) await tick();
  expect(SoulStore.pendingTotal()).toBe(0);
});

const A = npc(1);
const B = npc(2);

describe("G8 — SoulStore spaces its sync embeds (the loop breathes during a seeding batch)", () => {
  it("recordToSoul is synchronous for the AUTHORITATIVE soul but embeds nothing inline", () => {
    const e = countingEmbed();
    const s = new SoulStore(e.embed);
    for (let i = 0; i < 8; i++) s.recordToSoul(A, `a consequential beat ${i}`);
    expect(s.soulOf(A).memories).toHaveLength(8); // the soul itself deepened synchronously (0007)
    expect(s.soulOf(A).narrative.length).toBeGreaterThan(0);
    expect(e.calls()).toBe(0); // the batch pinned the loop with ZERO inline embeds
    expect(s.pendingCount()).toBe(8); // …all queued on the breathing lane instead
  });

  it("the queue drains in the background, one embed per macrotask (the loop yields between calls)", async () => {
    const e = countingEmbed();
    const s = new SoulStore(e.embed);
    for (let i = 0; i < 5; i++) s.recordToSoul(A, `beat ${i}`);
    expect(e.calls()).toBe(0);
    await tick(); // each macrotask indexes exactly one memory — the spacing IS the fix
    expect(e.calls()).toBe(1);
    await tick();
    expect(e.calls()).toBe(2);
    for (let i = 0; i < 10; i++) await tick(); // the drain completes without any recall
    expect(e.calls()).toBe(5);
  });

  it("recall immediately after a batch is COMPLETE (it flushes that houseguest's pending queue)", () => {
    const e = countingEmbed();
    const s = new SoulStore(e.embed);
    s.recordToSoul(A, "a brutal veto betrayal that cut deep");
    for (let i = 0; i < 6; i++) s.recordToSoul(A, `trivial chat about breakfast cereal ${i}`);
    const r = s.recall(A, "the veto betrayal", 1); // no macrotask has run yet
    expect(r).toHaveLength(1);
    expect(r[0]!.content).toContain("veto betrayal");
    expect(e.calls()).toBe(8); // 7 flushed memories + 1 context embed — all on the sync seam
  });

  it("recall flushes ONLY its own houseguest; the rest of the batch keeps draining in the background", async () => {
    const e = countingEmbed();
    const s = new SoulStore(e.embed);
    s.recordToSoul(A, "an alliance whisper");
    s.recordToSoul(A, "a kitchen confrontation");
    s.recordToSoul(B, "a private scheme");
    s.recordToSoul(B, "a thrown competition");
    s.recordToSoul(B, "a goodbye grudge");
    expect(s.recall(A, "alliance", 1)).toHaveLength(1);
    expect(e.calls()).toBe(3); // A's two memories + the context — B's three stay queued
    for (let i = 0; i < 10; i++) await tick();
    expect(e.calls()).toBe(6); // …and drain without ever being forced inline
    expect(s.recall(B, "scheme", 1)[0]!.content).toContain("scheme");
  });

  it("a failing embed degrades only that memory's recall — the drain and the soul survive", async () => {
    let n = 0;
    const inner = new DeterministicEmbedding();
    const s = new SoulStore((t) => {
      n++;
      if (n === 1) throw new Error("model hiccup");
      return inner.embed(t);
    });
    s.recordToSoul(A, "the lost memory");
    s.recordToSoul(A, "the surviving veto grudge");
    for (let i = 0; i < 10; i++) await tick();
    expect(s.soulOf(A).memories).toHaveLength(2); // the authoritative soul never thinned (0007)
    const r = s.recall(A, "veto grudge", 2);
    expect(r.map((m) => m.content)).toContain("the surviving veto grudge");
  });
});

describe("G12 — the breathing lane is SHARED across every store (sandbox bursts never stack)", () => {
  it("two stores flooding together still drain ONE embed per macrotask TOTAL, in arrival order", async () => {
    const e1 = countingEmbed();
    const e2 = countingEmbed();
    const s1 = new SoulStore(e1.embed); // two sandboxes restoring in the same tick (the boot preload)
    const s2 = new SoulStore(e2.embed);
    for (let i = 0; i < 3; i++) s1.recordToSoul(A, `house one arc beat ${i}`);
    for (let i = 0; i < 3; i++) s2.recordToSoul(A, `house two arc beat ${i}`);
    expect(SoulStore.pendingTotal()).toBe(6);
    await tick();
    expect(e1.calls() + e2.calls()).toBe(1); // pre-G12: one embed per STORE per macrotask — stalls stacked
    await tick();
    expect(e1.calls() + e2.calls()).toBe(2);
    await tick();
    expect([e1.calls(), e2.calls()]).toEqual([3, 0]); // FIFO: the first flood drains first
    for (let i = 0; i < 10 && SoulStore.pendingTotal() > 0; i++) await tick();
    expect([e1.calls(), e2.calls()]).toEqual([3, 3]);
  });

  it("recall flushes ONLY its own store's houseguest — another sandbox's backlog stays on the lane", () => {
    const e1 = countingEmbed();
    const e2 = countingEmbed();
    const s1 = new SoulStore(e1.embed);
    const s2 = new SoulStore(e2.embed);
    s1.recordToSoul(A, "a whispered final-two promise");
    s2.recordToSoul(A, "an unrelated scheme in another house"); // SAME houseguest id, different sandbox
    expect(s1.recall(A, "final-two promise", 1)).toHaveLength(1);
    expect(e1.calls()).toBe(2); // s1's one memory + the context embed
    expect(e2.calls()).toBe(0); // the other sandbox was never forced inline
    expect(s2.pendingCount()).toBe(1); // …its backlog still breathes on the shared lane
  });

  it("discardPending drops only THIS store's queued work; the authoritative soul is untouched", async () => {
    const e1 = countingEmbed();
    const e2 = countingEmbed();
    const dead = new SoulStore(e1.embed); // a sandbox being reset/unloaded mid-drain
    const live = new SoulStore(e2.embed);
    for (let i = 0; i < 4; i++) dead.recordToSoul(A, `dead season beat ${i}`);
    for (let i = 0; i < 2; i++) live.recordToSoul(B, `live season beat ${i}`);
    dead.discardPending();
    expect(dead.pendingCount()).toBe(0);
    expect(SoulStore.pendingTotal()).toBe(2); // only the live sandbox's work remains
    for (let i = 0; i < 10 && SoulStore.pendingTotal() > 0; i++) await tick();
    expect(e1.calls()).toBe(0); // the dead season never burned an inference on the shared lane
    expect(e2.calls()).toBe(2);
    // Derived state only: the authoritative soul never thinned (0007) — a restore re-derives.
    expect(dead.soulOf(A).memories).toHaveLength(4);
    expect(dead.recall(A, "dead season", 2)).toEqual([]); // the discarded index is gone…
    expect(e1.calls()).toBe(0); // …and recall on an index-less soul costs no embed
  });
});

describe("ORW-304 - a very large shared queue never overflows the call stack", () => {
  it("recall (flushPending) and discardPending compact the shared lane in place, whatever its size", () => {
    const e = countingEmbed();
    const a = new SoulStore(e.embed);
    const b = new SoulStore(e.embed);
    // A burst far past the ~100k arguments a spread into push() can take (the ORW-300 full BDD gate hit it): all synchronous, so nothing drains in between. Many houseguests x few memories each keeps every
    // soul's own narrative cheap (it recomposes per write).
    const HG = 3_000, PER = 50, BIG = HG * PER;
    for (let h = 1; h <= HG; h++) for (let k = 0; k < PER; k++) (h % 2 === 0 ? a : b).recordToSoul(npc(h), `fact ${h}-${k}`);
    expect(SoulStore.pendingTotal()).toBe(BIG);
    expect(() => a.recall(npc(2), "fact 2-0", 1), "flushPending on a huge queue").not.toThrow();
    expect(SoulStore.pendingTotal(), "only store A's entries for that houseguest were flushed; everything else stays queued").toBe(BIG - PER);
    expect(() => b.discardPending(), "discardPending on a huge queue").not.toThrow();
    expect(SoulStore.pendingTotal(), "store B's backlog is gone, store A's remaining backlog stays").toBe(BIG / 2 - PER);
    a.discardPending();
    expect(SoulStore.pendingTotal()).toBe(0);
  }, 120_000);
});
