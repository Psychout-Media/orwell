import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fastClone } from "../../src/engine/sessionSnapshot";
import { SHARED_LIVE_KEYS, SharedCloneDivergence, SharedLiveClones, sharedSnapshotFromEnv } from "../../src/engine/sharedLiveClone";

/**
 * ORW-881 (ORW-844 option 1): the shared clone of the five big live keys. Pure unit proofs on a synthetic live object (its shape is JSON-like; no game content): the clone's bytes (key order
 * included) equal `fastClone`'s after any sequence of writes, every way of writing a key is seen, a read-only look is not a write, the paranoid mode catches a write that went around the funnel,
 * and the shared clones are never handed out writable in paranoid mode. The GUARD at the bottom reads `src/` and fails on any new way to reach those keys that the funnel cannot see.
 */
const bytes = (v: unknown): string => JSON.stringify(v);
const mk = (): Record<string, any> => ({ week: 3, name: "a", agendas: { a: { goals: [{ id: "g1" }], served: [1] }, b: { goals: [], served: [] } }, goalPlans: { a: [] }, beliefs: { a: [{ id: "x", value: 1 }] }, claims: { seq: 1, items: [{ id: "c" }] }, npcMemory: { a: { b: [{ kind: "k" }] } }, tail: { z: [1, 2] } });

describe("SharedLiveClones: the same bytes as a full clone, whatever was written", () => {
  it("equals fastClone byte for byte (key order included) after every kind of write", () => {
    const live = mk(); const sc = new SharedLiveClones();
    const same = (when: string): void => expect(bytes(sc.clone(live)), when).toBe(bytes(fastClone(live)));
    same("first");
    same("again, nothing written");
    live.agendas.a.goals.push({ id: "g2" }); same("a nested push through the accessor");
    live.beliefs = { a: [] }; same("an assignment");
    live.claims.items[0].id = "d"; same("a deep field write");
    (live.npcMemory ??= {}).c = {}; same("??= on a present key");
    live.week = 4; live.name = "b"; same("a scalar outside the five");
    live.tail.z.push(3); same("a non-shared nested write");
    delete live.goalPlans; same("a key deleted");
    live.late = { q: 1 }; same("a key added after adoption");
    live.goalPlans = { a: [{ step: 1 }] }; same("a deleted key set again (it goes last, as in a plain object)");
    live.beliefs = undefined; same("a key set to undefined (dropped)");
    live.beliefs = { n: [] }; same("and back");
    expect(Object.keys(sc.clone(live))).toEqual(Object.keys(fastClone(live)));
  });

  it("a key that is absent at the first snapshot and set later keeps the position a plain object gives it", () => {
    const live: Record<string, any> = { week: 1, agendas: { a: {} } };
    const sc = new SharedLiveClones();
    sc.clone(live);
    live.zeta = 1; live.beliefs = { a: [] }; live.alpha = 2;
    expect(bytes(sc.clone(live))).toBe(bytes(fastClone(live)));
    expect(Object.keys(sc.clone(live))).toEqual(["week", "agendas", "zeta", "beliefs", "alpha"]);
  });

  it("reuses the very same clone object while nothing wrote the key, and re-clones when something did", () => {
    const live = mk(); const sc = new SharedLiveClones();
    const a = sc.clone(live) as any, b = sc.clone(live) as any;
    for (const k of SHARED_LIVE_KEYS) expect(b[k], k).toBe(a[k]);
    expect(b).not.toBe(a);
    expect(b.tail).not.toBe(a.tail);
    live.claims.seq = 2;
    const c = sc.clone(live) as any;
    expect(c.claims).not.toBe(b.claims);
    expect(c.claims.seq).toBe(2);
    expect(b.claims.seq).toBe(1); // the earlier snapshot is untouched
    expect(c.agendas).toBe(b.agendas);
  });

  it("a read-only peek is not a write; any ordinary read is (it may hand out a mutable reference)", () => {
    const live = mk(); const sc = new SharedLiveClones();
    const first = sc.clone(live) as any;
    expect(sc.peek<any>(live, "agendas").a.goals[0].id).toBe("g1");
    expect((sc.clone(live) as any).agendas).toBe(first.agendas);
    void live.agendas;
    expect((sc.clone(live) as any).agendas).not.toBe(first.agendas);
    expect(sc.peek<any>({ agendas: 5 }, "agendas")).toBe(5); // another object: the plain read
  });

  it("restart of the owner: a different live object starts with no clones; reset() forgets them", () => {
    const sc = new SharedLiveClones();
    const l1 = mk(); const a = sc.clone(l1) as any;
    const l2 = mk(); const b = sc.clone(l2) as any;
    expect(b.agendas).not.toBe(a.agendas);
    expect(bytes(b)).toBe(bytes(a));
    sc.reset();
    expect((sc.clone(l2) as any).agendas).not.toBe(b.agendas);
  });

  it("commit-scoped mode reuses within a commit only: the fence counts every key as written", () => {
    const live = mk(), live2 = mk();
    const open = new SharedLiveClones(), scoped = new SharedLiveClones({ commitScoped: true });
    const a1 = open.clone(live) as any, s1 = scoped.clone(live2) as any;
    open.fence(); scoped.fence();
    expect((open.clone(live) as any).agendas).toBe(a1.agendas);
    expect((scoped.clone(live2) as any).agendas).not.toBe(s1.agendas);
  });

  it("switching the tracker over a live object that another one already put under its funnel loses nothing", () => {
    const live = mk();
    const a = new SharedLiveClones().clone(live) as any;
    const b = new SharedLiveClones({ commitScoped: true }).clone(live) as any;
    expect(bytes(b)).toBe(bytes(a));
    expect(bytes(b)).toBe(bytes(fastClone(live)));
  });
});

describe("paranoid mode and aliasing", () => {
  it("catches a write that went around the accessor (a reference held across a snapshot)", () => {
    const live = mk(); const sc = new SharedLiveClones({ paranoid: true });
    const held = live.agendas.a; // a reference taken through the funnel, then kept across a snapshot
    sc.clone(live);
    held.goals.push({ id: "sneaked" }); // written WITHOUT going back through live.agendas
    expect(() => sc.clone(live)).toThrow(SharedCloneDivergence);
    expect(sc.stats.divergences).toEqual(["agendas"]);
  });

  it("counts a clean paranoid run: compared > 0, no divergence, and the shared clones are frozen (a consumer that writes one throws)", () => {
    const live = mk(); const sc = new SharedLiveClones({ paranoid: true });
    const a = sc.clone(live) as any;
    live.claims.seq = 9; sc.clone(live); sc.clone(live);
    expect(sc.stats.divergences).toEqual([]);
    expect(sc.stats.compared).toBeGreaterThan(0);
    expect(() => { a.agendas.a.goals.push({ id: "x" }); }).toThrow(TypeError);
    expect(() => { a.beliefs.a[0].value = 5; }).toThrow(TypeError);
  });

  it("without paranoid mode nothing is frozen and nothing is compared", () => {
    const live = mk(); const sc = new SharedLiveClones();
    const a = sc.clone(live) as any;
    sc.clone(live);
    expect(Object.isFrozen(a.agendas)).toBe(false);
    expect(sc.stats.compared).toBe(0);
  });

  it("the env switch: unset, 0, off and unknown words are OFF; 1, commit and paranoid are the three modes", () => {
    for (const v of [undefined, "", "0", "false", "off", "yes"]) expect(sharedSnapshotFromEnv(v), String(v)).toBeNull();
    expect(sharedSnapshotFromEnv("1")).toBeInstanceOf(SharedLiveClones);
    expect(sharedSnapshotFromEnv("on")).toBeInstanceOf(SharedLiveClones);
    expect(sharedSnapshotFromEnv("commit")).toBeInstanceOf(SharedLiveClones);
    expect(sharedSnapshotFromEnv("PARANOID")).toBeInstanceOf(SharedLiveClones);
  });
});

/**
 * THE GUARD (the funnel is the accessor on `live`; this reads src/ and fails on any way to reach the five keys that the funnel would not see).
 * The funnel sees every `live.<key>` access, read or write. It cannot see: a property deleted/redefined behind its back, a reference kept in a field across commits, a copy of the live object made
 * with a spread (the copy would hold plain data), or a read-only `peekLive` that is in fact written through. Each is pinned below.
 */
const SRC = join(__dirname, "..", "..", "src");
const files: string[] = [];
(function walk(d: string): void { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (p.endsWith(".ts")) files.push(p); } })(SRC);
const code = (p: string): string => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, "")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1"); // comments blanked, line numbers kept
const KEYS = "agendas|goalPlans|beliefs|claims|npcMemory";
const lines = (p: string): Array<[number, string]> => code(p).split("\n").map((l, i) => [i + 1, l] as [number, string]);
const FUNNEL = join(SRC, "engine", "sharedLiveClone.ts");

describe("GUARD: nothing reaches the five live keys around the funnel", () => {
  const offenders = (re: RegExp, except: (path: string) => boolean = () => false): string[] =>
    files.filter((f) => f !== FUNNEL && !except(f)).flatMap((f) => lines(f).filter(([, l]) => re.test(l)).map(([n, l]) => `${f.slice(SRC.length)}:${n}: ${l.trim().slice(0, 140)}`));

  it("no defineProperty or descriptor read on the live object (a `delete` of a key is fine: the key is then absent, and a later set is adopted afresh at the next snapshot)", () => {
    expect(offenders(/Object\.(?:defineProperty|defineProperties|getOwnPropertyDescriptors?|setPrototypeOf|freeze|seal)\(\s*(?:this\.)?(?:live|s)\b/)).toEqual([]);
  });

  it("no copy of the live object by spread, Object.assign or structuredClone (a copy holds plain data the funnel cannot see)", () => {
    expect(offenders(/\.\.\.\s*(?:this\.)?live(?![\w.!?\[])/, (f) => f.endsWith(join("composition", "registry.ts")) /* its `live` is the tick-state probe */)).toEqual([]);
    expect(offenders(/Object\.assign\(\s*(?:this\.)?live\b/)).toEqual([]);
    expect(offenders(/structuredClone\(\s*(?:this\.)?live\b/)).toEqual([]);
  });

  it("no field or module variable keeps a reference to one of the five stores across calls", () => {
    // `this.x = <...>.<key>` / `x = live.<key>` at class or module level; a local `const` inside a method is per call and fine.
    expect(offenders(new RegExp(String.raw`this\.\w+\s*=\s*(?!=)[^;]*\b(?:live|s)!?\??\.(?:${KEYS})\b(?!\s*\?\?\s*\{\})`))).toEqual([]);
    expect(offenders(new RegExp(String.raw`^(?:export\s+)?(?:let|var)\s+\w+\s*=\s*[^;]*\blive!?\??\.(?:${KEYS})\b`))).toEqual([]);
  });

  it("the live object is replaced in exactly two places (restore, a new season), each followed by a reset of the shared clones", () => {
    const f = join(SRC, "adapters", "engine", "GameSessionAdapter.ts");
    const ls = lines(f);
    const sites = ls.filter(([, l]) => /\bthis\.live\s*=\s*(?!=)/.test(l));
    expect(sites.length).toBe(2);
    for (const [n] of sites) expect(ls[n]![1], `line ${n} must be followed by the reset`).toMatch(/this\.sharedLive\?\.reset\(\)/);
  });

  it("every read-only peek is on a pinned line list, and none of them writes through its result", () => {
    const f = join(SRC, "adapters", "engine", "GameSessionAdapter.ts");
    const sites = lines(f).filter(([, l]) => /\bthis\.peekLive\(/.test(l));
    expect(sites.length, "a new peekLive needs a review that it only reads: update this count with the reason").toBe(7);
    for (const [n, l] of sites) {
      expect(l, `line ${n}`).not.toMatch(new RegExp(String.raw`peekLive\([^)]*\)[^;]*?(?:\]|\))\s*(?:=(?![=>])|\+\+|--|\+=|-=)`));
      expect(l, `line ${n}`).not.toMatch(/peekLive\([^)]*\)[^;]*\.(?:push|pop|shift|unshift|splice|sort|reverse|fill|set|add|delete|clear)\(/);
    }
  });

  it("the two bound peek variables are only read in the lines that follow their binding", () => {
    const ls = lines(join(SRC, "adapters", "engine", "GameSessionAdapter.ts"));
    for (const name of ["memory", "ownerMemory"]) {
      const at = ls.findIndex(([, l]) => new RegExp(String.raw`const ${name} = this\.peekLive\(`).test(l));
      expect(at, `${name} is bound by a peek`).toBeGreaterThan(-1);
      const body = ls.slice(at + 1, at + 16).map(([, l]) => l).join("\n");
      expect(body, `${name} is not written`).not.toMatch(new RegExp(String.raw`\b${name}!?(?:\[[^\]]+\]!?)*\s*(?:=(?!=)|\.push\()`));
    }
  });
});
