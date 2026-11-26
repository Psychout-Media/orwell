import { fastClone } from "./sessionSnapshot";

/**
 * ORW-881 (ORW-844 option 1): structure-shared snapshots of the five big keys of the live loop.
 *
 * `snapshot()` clones the whole live loop (about 1.2 MB late in a season) several times per message, and 80 % of it is five keys that hold the same bytes
 * from one snapshot to the next. This module reuses the last clone of such a key when nothing could have written it since.
 *
 * HOW A WRITE IS SEEN (the one funnel). The five keys are plain JSON records that the engine's helpers mutate in place at any depth, through references taken
 * from the live object (`recordClaim(store, ...)`, `a.served.push(...)`), so "every writer calls a bump" cannot be enforced by reading the code. Instead the live
 * object's own property is the funnel: each of the five keys is turned into an accessor property whose getter AND setter count a version. Every way to get at the
 * data (a read that returns a mutable reference, an assignment, `??=`, a spread) goes through that accessor, so no code path can hold a reference without having
 * bumped the version first. A clone is reused only if the version is still the one the clone was taken at. The cloner itself reads the backing value raw, so
 * taking a snapshot does not dirty anything. Reads count as writes (conservative): a reader costs a re-clone, never a stale save.
 * The one thing this cannot see is a reference held ACROSS a snapshot and written later without going back through the accessor; paranoid mode is the net for that.
 *
 * KEY ORDER. An accessor is installed over an existing data property with `Object.defineProperty`, which keeps the property's position, so `Object.keys` order (and the
 * saved JSON) is unchanged. A key that is absent stays absent until it is first set (as a plain property, in the position it would have had), and is adopted at the next snapshot.
 *
 * ALIASING. The clones are shared between successive snapshots: a snapshot is read-only to its consumers. `freeze` deep-freezes a shared clone so that a consumer that
 * writes one fails loudly (tests and paranoid mode).
 *
 * PARANOID. Every snapshot also clones every shared key fresh and compares the bytes with the clone it would have reused; any difference is recorded and thrown.
 */
export const SHARED_LIVE_KEYS: readonly string[] = ["agendas", "goalPlans", "beliefs", "claims", "npcMemory"];
const SHARED = new Set(SHARED_LIVE_KEYS);

/** `paranoid`: compare every reuse with a fresh clone (throws on a difference). `freeze`: deep-freeze the shared clones. `commitScoped`: `fence()` is honored, so a clone is reused only within the commit that took it. */
export interface SharedCloneOptions { paranoid?: boolean; freeze?: boolean; commitScoped?: boolean }
export interface SharedCloneStats { reused: number; cloned: number; compared: number; falseDirty: number; /** the keys a paranoid compare found different (also thrown): must stay empty */ divergences: string[]; byKey: Record<string, { reused: number; cloned: number }> }
export class SharedCloneDivergence extends Error {
  constructor(readonly key: string) { super(`ORW-881 shared live snapshot diverged from a fresh clone at live.${key}: a write reached it without going through its accessor`); }
}

export function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

/** Process-wide totals (every adapter, so a rollback or restart that rebuilds the session does not lose them): measurement and tests only; nothing in the engine reads them. */
export const SHARED_CLONE_TOTALS: { reused: number; cloned: number; compared: number; divergences: string[] } = { reused: 0, cloned: 0, compared: 0, divergences: [] };

export class SharedLiveClones {
  private owner: object | null = null;
  private readonly version: Record<string, number> = {};
  private readonly backing: Record<string, unknown> = {};
  private readonly cache = new Map<string, { ver: number; clone: unknown }>();
  private readonly getters: Record<string, () => unknown> = {};
  readonly stats: SharedCloneStats = { reused: 0, cloned: 0, compared: 0, falseDirty: 0, divergences: [], byKey: {} };
  constructor(private readonly opts: SharedCloneOptions = {}) {}

  /**
   * The quiescence fence: count every shared key as written, so no clone taken so far is reused again. Called when a commit ends (and so a reference held across
   * a commit, then written without going back through the accessor, can never leave a stale clone for the next one): clones are reused only within the one commit
   * that took them, between the candidate, baseline and tick snapshots.
   */
  fence(): void { if (this.opts.commitScoped) this.bumpAll(); }
  private bumpAll(): void { for (const k of Object.keys(this.version)) this.version[k] = this.version[k]! + 1; }

  /** Forget every clone (restore, a new season). Accessors already installed on an old live object keep counting into versions nobody reads. */
  reset(): void { this.owner = null; this.cache.clear(); }

  private install(live: Record<string, unknown>, k: string): void {
    this.backing[k] = live[k];
    this.version[k] = (this.version[k] ?? 0) + 1;
    const get = (): unknown => { this.version[k] = (this.version[k] ?? 0) + 1; return this.backing[k]; };
    this.getters[k] = get;
    Object.defineProperty(live, k, {
      enumerable: true, configurable: true,
      get,
      set: (x: unknown) => { this.version[k] = (this.version[k] ?? 0) + 1; this.backing[k] = x; },
    });
  }

  /**
   * A READ-ONLY look at one of the five keys that does NOT count as a write: for a hot reader that only reads and never keeps or hands out the reference (it would otherwise
   * dirty the key and cost a re-clone). The caller promises not to write through the result; paranoid mode catches a caller that does. Falls back to the ordinary read when
   * the key is not under the funnel (not yet adopted, a different live object).
   */
  peek<T>(live: object, k: string): T {
    if (this.owner === live) {
      const d = Object.getOwnPropertyDescriptor(live, k);
      if (d !== undefined && d.get !== undefined && d.get === this.getters[k]) return this.backing[k] as T;
    }
    return (live as Record<string, T>)[k] as T;
  }

  private stat(k: string): { reused: number; cloned: number } { return (this.stats.byKey[k] ??= { reused: 0, cloned: 0 }); }

  private fresh(k: string, raw: unknown): unknown {
    const c = fastClone(raw);
    return this.opts.freeze || this.opts.paranoid ? deepFreeze(c) : c;
  }

  /** The same value `fastClone(live)` returns, sharing the unchanged clones of the five keys. */
  clone(liveIn: object): Record<string, unknown> {
    const live = liveIn as Record<string, unknown>;
    if (this.owner !== live) { this.reset(); this.owner = live; }
    const out: Record<string, unknown> = {};
    const keys = Object.keys(live);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i]!;
      if (!SHARED.has(k)) {
        const e = live[k];
        const te = typeof e;
        if (te === "string" || te === "boolean" || (te === "number" && Number.isFinite(e as number))) { out[k] = e; continue; }
        const c = fastClone(e);
        if (c !== undefined) out[k] = c;
        continue;
      }
      const desc = Object.getOwnPropertyDescriptor(live, k)!;
      let value: unknown;
      if (desc.get === undefined || desc.get !== this.getters[k]) {
        // a data property (first snapshot, or the key was deleted and set again) or an accessor of a previous tracker (the mode was switched): read it, clone it, then put it under THIS funnel at the same position
        const f = this.fresh(k, desc.get === undefined ? desc.value : live[k]);
        this.install(live, k);
        this.cache.set(k, { ver: this.version[k]!, clone: f });
        this.stat(k).cloned++; this.stats.cloned++; SHARED_CLONE_TOTALS.cloned++;
        value = f;
      } else {
        const entry = this.cache.get(k);
        if (entry !== undefined && entry.ver === this.version[k]) {
          value = entry.clone;
          this.stat(k).reused++; this.stats.reused++; SHARED_CLONE_TOTALS.reused++;
          if (this.opts.paranoid) {
            const again = fastClone(this.backing[k]);
            this.stats.compared++; SHARED_CLONE_TOTALS.compared++;
            if (JSON.stringify(again) !== JSON.stringify(entry.clone)) { this.stats.divergences.push(k); SHARED_CLONE_TOTALS.divergences.push(k); throw new SharedCloneDivergence(k); }
          }
        } else {
          const f = this.fresh(k, this.backing[k]);
          this.cache.set(k, { ver: this.version[k]!, clone: f });
          this.stat(k).cloned++; this.stats.cloned++; SHARED_CLONE_TOTALS.cloned++;
          if (this.opts.paranoid && entry !== undefined && JSON.stringify(entry.clone) === JSON.stringify(f)) this.stats.falseDirty++;
          value = f;
        }
      }
      if (value !== undefined) out[k] = value;
    }
    return out;
  }
}

/** `ORWELL_SHARED_SNAPSHOT`: unset/0/anything else => off (null); `1`/`true`/`on` => reuse across commits; `commit` => reuse only within the commit that took the clone; `paranoid` => `1` + compare every reuse against a fresh clone + freeze. */
export function sharedSnapshotFromEnv(v: string | undefined): SharedLiveClones | null {
  const m = (v ?? "").trim().toLowerCase();
  if (m === "1" || m === "true" || m === "on") return new SharedLiveClones();
  if (m === "commit") return new SharedLiveClones({ commitScoped: true });
  if (m === "paranoid") return new SharedLiveClones({ paranoid: true, freeze: true });
  return null;
}
