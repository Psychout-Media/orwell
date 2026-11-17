import { clamp01 } from "../domain/num";
import { HOUSE_GRAPH } from "./houseGraphConstants";

/**
 * Feature 0177 - the house graph (Theme 3, core 1). PURE and ENGINE-ONLY: derived from the bonds,
 * read by later slices (gossip routing, status, blocs), NEVER shown, no player-facing surface, no
 * numbers in its output. It wraps the bond layer; it never reads or writes the relationship model.
 *
 * Symmetrization: a directed pair counts as ONE tie of strength min(a->b, b->a) (missing = 0).
 * A bond only makes a clique, hub or bridge when BOTH sides lean in; a lopsided crush is not a
 * group. This matches the bond reader's own `tie(a, b)`.
 *
 * Total and deterministic: ids are sorted, unknown ids / self-ties / NaN are ignored, strengths
 * are clamped to [0, 1], and the same graph in any input order gives byte-identical output.
 */
export type GraphId = string;
export interface GraphTie { readonly from: GraphId; readonly to: GraphId; readonly strength: number }
export interface HouseGraphInput { readonly members: readonly GraphId[]; readonly ties: readonly GraphTie[] }
export interface HouseGraph {
  /** Maximal groups of >= 3 mutually tied members; members sorted, groups sorted. */
  readonly cliques: readonly (readonly GraphId[])[];
  readonly hubs: readonly GraphId[];
  readonly loners: readonly GraphId[];
  readonly brokers: readonly GraphId[];
}
/** What the bond layer must offer (structurally satisfied by the Auditor's BondReader). */
export interface GraphBondReader {
  living(): readonly GraphId[];
  /** Already symmetric: the min of the two directed strengths, 0..1. */
  tie(a: GraphId, b: GraphId): number;
  day?(): number;
}
export interface DailyHouseGraph { readonly day: number | null; readonly graph: HouseGraph }

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const EMPTY: HouseGraph = { cliques: [], hubs: [], loners: [], brokers: [] };

export function deriveHouseGraph(input: HouseGraphInput): HouseGraph {
  const members = [...new Set(Array.isArray(input?.members) ? input.members : [])].filter((m) => typeof m === "string").sort(cmp);
  if (members.length === 0) return EMPTY;
  const known = new Set(members);
  const dir = new Map<string, number>();
  for (const t of Array.isArray(input.ties) ? input.ties : []) {
    if (!t || !known.has(t.from) || !known.has(t.to) || t.from === t.to) continue;
    const s = clamp01(t.strength);
    const k = `${t.from}\u0000${t.to}`;
    dir.set(k, Math.max(dir.get(k) ?? 0, s));
  }
  const adj = new Map<string, Set<string>>(members.map((m) => [m, new Set<string>()]));
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i]!, b = members[j]!;
      const s = Math.min(dir.get(`${a}\u0000${b}`) ?? 0, dir.get(`${b}\u0000${a}`) ?? 0);
      if (s >= HOUSE_GRAPH.tieThreshold) { adj.get(a)!.add(b); adj.get(b)!.add(a); }
    }
  }
  const cliques = maximalCliques(members, adj).filter((c) => c.length >= HOUSE_GRAPH.cliqueMinSize);
  cliques.sort((x, y) => { for (let i = 0; i < Math.min(x.length, y.length); i++) { const c = cmp(x[i]!, y[i]!); if (c) return c; } return x.length - y.length; });
  const inClique = new Set(cliques.flat());
  const hubBar = Math.max(HOUSE_GRAPH.hubMinDegree, Math.ceil(HOUSE_GRAPH.hubShare * (members.length - 1)));
  const hubs = members.filter((m) => adj.get(m)!.size >= hubBar);
  const loners = members.filter((m) => adj.get(m)!.size <= HOUSE_GRAPH.lonerMaxDegree && !inClique.has(m));
  const brokers = members.filter((m) => {
    const sides = cliques
      .map((c) => c.filter((x) => x !== m && adj.get(m)!.has(x)))
      .filter((l) => l.length >= HOUSE_GRAPH.brokerMinLinks);
    for (let i = 0; i < sides.length; i++) for (let j = i + 1; j < sides.length; j++) {
      const other = new Set(sides[j]);
      if (!sides[i]!.some((x) => other.has(x))) return true;
    }
    return false;
  });
  return { cliques, hubs, loners, brokers };
}

/** Bron-Kerbosch with pivoting; 16 members is trivial. Output members sorted. */
function maximalCliques(members: readonly string[], adj: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  const out: string[][] = [];
  const bk = (r: string[], p: string[], x: string[]): void => {
    if (p.length === 0 && x.length === 0) { out.push([...r].sort(cmp)); return; }
    const pivot = [...p, ...x].sort(cmp).reduce((best, u) => (p.filter((v) => adj.get(u)!.has(v)).length > p.filter((v) => adj.get(best)!.has(v)).length ? u : best));
    for (const v of p.filter((q) => !adj.get(pivot)!.has(q))) {
      bk([...r, v], p.filter((q) => adj.get(v)!.has(q)), x.filter((q) => adj.get(v)!.has(q)));
      p = p.filter((q) => q !== v);
      x = [...x, v];
    }
  };
  bk([], [...members], []);
  return out;
}

/** Thin pure adapter: the reader's tie is already symmetric, so use it as is. */
export function houseGraphFromReader(reader: GraphBondReader): HouseGraph {
  let living: readonly GraphId[] = [];
  try { living = reader.living(); } catch { return EMPTY; }
  const members = [...new Set(living)].sort(cmp);
  const ties: GraphTie[] = [];
  for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) {
    const a = members[i]!, b = members[j]!;
    let s = 0;
    try { s = reader.tie(a, b); } catch { s = 0; }
    ties.push({ from: a, to: b, strength: s }, { from: b, to: a, strength: s });
  }
  return deriveHouseGraph({ members, ties });
}

/** The derive-daily helper (pure, NOT wired): re-derive once per in-game day, else reuse prev. */
export function deriveDailyHouseGraph(reader: GraphBondReader, prev?: DailyHouseGraph): DailyHouseGraph {
  let day: number | null = null;
  try { const d = reader.day?.(); day = typeof d === "number" && Number.isFinite(d) ? Math.floor(d) : null; } catch { day = null; }
  if (prev && day !== null && prev.day === day) return prev;
  return { day, graph: houseGraphFromReader(reader) };
}
