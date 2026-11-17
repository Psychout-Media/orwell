/** ORW-509 measurement core: how often the non-character world lists repeat. The CLI is worldPoolRecurrence.ts; the ratchet test is tests/unit/worldPoolRecurrence.test.ts. */
import { COMPETITION_LIBRARY, COMPETITION_LIBRARY_PLUS, drawCompetition } from "../../src/engine/competitionLibrary";
import { themeForWeek, applyTheme } from "../../src/engine/competitionThemes";
import { drawHouseTheme, houseTheme } from "../../src/engine/roomLabels";
import { HOUSE_ROOMS } from "../../src/domain/house";
import { nextHouseEvent } from "../../src/engine/houseEvents";
import { pickAllianceName } from "../../src/engine/alliances";
import { composedCuriosityNeedle } from "../../src/engine/curiosityNeedleComposed";
import { HEDGE_POOLS } from "../../src/engine/gossipDriftConstants";
import { deriveFailureFact } from "../../src/engine/wipeoutReel";
import { simulateOffscreenStretch } from "../../src/engine/offscreen";
import { confessionalFor } from "../../src/engine/confessionals";
import { RelationshipModel } from "../../src/engine/relationships";
import { TIE_NATURES } from "../../src/engine/seededRelationships";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { PLAYER, npc } from "../../src/domain/ids";

let SEASONS = 200;
const seedOf = (i: number): number => (i * 7919 + 13) >>> 0;

export type Season = string[];
export interface Row { list: string; size: string; drawsPerSeason: number; within: number; across: number; next: number }

function measure(list: string, size: string, season: (seed: number) => Season): Row {
  const seasons = Array.from({ length: SEASONS }, (_, i) => season(seedOf(i)));
  let rep = 0, draws = 0;
  for (const s of seasons) { draws += s.length; rep += s.length - new Set(s).size; }
  const all = new Set(seasons.flat());
  let shared = 0, pairs = 0;
  for (let i = 0; i + 1 < seasons.length; i++) {
    const a = new Set(seasons[i]), b = [...new Set(seasons[i + 1])];
    if (b.length === 0) continue;
    shared += b.filter((x) => a.has(x)).length / b.length; pairs++;
  }
  return { list, size, drawsPerSeason: Math.round(draws / SEASONS), within: +(rep / Math.max(1, draws)).toFixed(4), across: all.size, next: +(shared / Math.max(1, pairs)).toFixed(4) };
}

/** Like `measure`, but each season is handed the previous season's items as its `avoid` memory (what the install's ledger would pass). */
function measureChained(list: string, size: string, season: (seed: number, prev: string[]) => Season): Row {
  let prev: string[] = [];
  const memo = new Map<number, Season>();
  const run = (seed: number): Season => {
    if (!memo.has(seed)) { const cur = season(seed, prev); memo.set(seed, cur); prev = cur; }
    return memo.get(seed)!;
  };
  return measure(list, size, run);
}

const WEEKS = 14;

/** Measure every list over `seasons` seeded seasons (seed i uses `seedOf(i)`). */
export function buildRows(seasons = 200): Row[] {
  SEASONS = seasons;
  const rows: Row[] = [];
  // O2/O3: competitions - drawn mechanic, themed name, theme world, ~14 HOH + ~13 veto a season.
  const comps = (seed: number) => {
    const rng = new SeededRandom(seed);
    const hist: Record<"hoh" | "veto", string[]> = { hoh: [], veto: [] };
    const out: { mech: string; name: string; theme: string; beat: string; premise: string }[] = [];
    for (let w = 1; w <= WEEKS; w++) for (const phase of ["hoh", "veto"] as const) {
      if (phase === "veto" && w === WEEKS) continue;
      const def = drawCompetition(phase, w, rng, hist[phase], true); hist[phase].push(def.id);
      const sk = applyTheme(def, themeForWeek(seed, phase, w, 0), `${seed}:${phase}:${w}:0`);
      out.push({ mech: def.id, name: sk.name, theme: sk.theme, beat: sk.narrative.beats.join(" | "), premise: sk.narrative.premise });
    }
    return out;
  };
  rows.push(measure("competition mechanics", `${COMPETITION_LIBRARY.length}+${COMPETITION_LIBRARY_PLUS.length}`, (s) => comps(s).map((c) => c.mech)));
  rows.push(measure("competition names (themed)", "prefix x noun", (s) => comps(s).map((c) => c.name)));
  rows.push(measure("competition themes (worlds)", "see across", (s) => comps(s).map((c) => c.theme)));
  rows.push(measure("competition scene-setter + premise", "-", (s) => comps(s).map((c) => c.premise)));
  rows.push(measure("competition beat triples", "3 beats x mechanic", (s) => comps(s).map((c) => c.mech + "::" + c.beat)));

  // O1: house theme (one per season) and its room names.
  rows.push(measure("house theme (id)", "library", (s) => [drawHouseTheme(s)]));
  rows.push(measure("house room names", "13 per theme", (s) => HOUSE_ROOMS.map((r) => houseTheme(drawHouseTheme(s))!.rooms[r].name)));

  // O4: house events (about 5 ambient picks a week over 11 weeks).
  rows.push(measure("house-event lines", "see across", (s) => {
    const store = new InMemoryEventStore(); const rng = new SeededRandom(s); const out: string[] = [];
    for (let i = 0; i < 55; i++) {
      const c = nextHouseEvent(store, rng, { week: 1 + Math.floor(i / 5), phase: "nominations" });
      store.record({ id: `e${i}`, ts: i, type: "house-event", initiator: npc(1), witnessSet: [PLAYER, npc(1)], hidden: false, content: c });
      out.push(c.replace(/^Week \d+(, day \d+)?: /, ""));
    }
    return out;
  }));

  // O5: alliance names (about 6 a season).
  rows.push(measure("alliance names", "see across", (s) => {
    const rng = new SeededRandom(s); const taken = new Set<string>(); const out: string[] = [];
    for (let i = 0; i < 6; i++) { const n = pickAllianceName(rng, taken); taken.add(n); out.push(n); }
    return out;
  }));

  // O6: off-screen scene verbs (the legacy 4-verb stretch).
  rows.push(measure("off-screen scene verbs", "4 + composed", (s) => {
    const ev = simulateOffscreenStretch({ events: new InMemoryEventStore(), rng: new SeededRandom(s), npcs: [npc(1), npc(2)], interactions: 20 });
    return ev.map((e) => String(e.content).replace(/npc[:\-_ ]?\d+/gi, "").replace(/\s+/g, " ").trim());
  }));

  // O7: confessional fallback lines (target + ally; 30 a season; fixed cast so only the line varies).
  rows.push(measure("confessional fallback lines", "3-4 per kind + composed", (s) => {
    const rng = new SeededRandom(s); const out: string[] = [];
    for (let i = 0; i < 30; i++) {
      const rel = new RelationshipModel(0.5);
      rel.edge(npc(1), npc(2)).threat = 0.9; rel.edge(npc(1), npc(3)).trust = 0.9; rel.edge(npc(1), npc(3)).affinity = 0.8;
      out.push(confessionalFor(npc(1), [npc(2), npc(3)], rel, { trigger: "x", emotionalState: 0.5, rng }).content);
    }
    return out;
  }));

  // Season memory: each season is told the previous season's picks (the `avoid` input). The base commit ignores the extra argument, so its rows equal the no-memory rows.
  rows.push(measureChained("competition themes (worlds) WITH memory", "-", (s, prev) => {
    const out: string[] = [];
    for (let w = 1; w <= WEEKS; w++) for (const phase of ["hoh", "veto"] as const) out.push((themeForWeek as (...a: unknown[]) => { id: string })(s, phase, w, 0, prev).id);
    return out;
  }));
  rows.push(measureChained("alliance names WITH memory", "-", (s, prev) => {
    const rng = new SeededRandom(s); const taken = new Set<string>(); const out: string[] = [];
    for (let i = 0; i < 6; i++) { const n = (pickAllianceName as (...a: unknown[]) => string)(rng, taken, new Set(prev)); taken.add(n); out.push(n); }
    return out;
  }));
  rows.push(measureChained("house theme WITH memory", "-", (s, prev) => [drawHouseTheme(s, prev)]));

  // O8: curiosity needle (one a season).
  rows.push(measure("curiosity needle", "5", (s) => [composedCuriosityNeedle(s)]));

  // O10: gossip hedges (30 a season, across the four voice pools).
  for (const [name, pool] of Object.entries(HEDGE_POOLS)) rows.push(measure(`gossip hedge (${name})`, String(pool.length), (s) => { const r = new SeededRandom(s); return Array.from({ length: 30 }, () => r.pick(pool as readonly string[])); }));

  // O11: wipeout failure styles (20 drops a season, mixed archetypes and a generic fallback).
  rows.push(measure("wipeout reel styles", "2 per bank", (s) => {
    const r = new SeededRandom(s); const arch = ["hothead", "analyst", undefined, "villain"]; const out: string[] = [];
    for (let i = 0; i < 20; i++) out.push(deriveFailureFact(r, arch[i % 4], undefined, undefined, 0).text);
    return out;
  }));

  // O12: pre-game tie natures (3 a season).
  rows.push(measure("tie natures", String(TIE_NATURES.length), (s) => { const r = new SeededRandom(s); return Array.from({ length: 3 }, () => TIE_NATURES[r.int(TIE_NATURES.length)]!); }));


  return rows;
}
