import { describe, it } from "vitest";
import { playMixGame } from "../support/houseMixDriver";
import type { DecisionWhy } from "../../src/engine/decisionWhy";
import { VOTE_TERM_NAMES } from "../../src/engine/liveSeason";
import { NOMINATION_TERM_NAMES } from "../../src/engine/season";

/**
 * REPORT, NOT A GATE (ORW-640, from Fable's stacking audit 2026-11-17). Plays N chat-paced seeded games (the house-mix guard's own driver) with an ACTIVE player and
 * reads the engine's own hidden "why" record of every NPC decision (ORW-305: the chosen option and the runner-up, each with every named term). Per decision kind it
 * prints the typical gap between the two, and per term: how often it is present, its average and largest size, and how often it is DECISIVE (without it the
 * runner-up would have won). Each new decision term's card states its range against its decision's typical gap; this is where that number comes from.
 *
 * Skipped unless ORWELL_STACKING_REPORT=1. ORWELL_STACKING_REPORT_SEEDS (default 6), ORWELL_STACKING_REPORT_MESSAGES (default 1500),
 * ORWELL_STACKING_REPORT_ACTIVE (default 1; =0 is the silent player Fable's first probe used).
 *
 * The active player, every 25 messages, with someone in the room and in turn: proposes a deal (safety, final two or a vote), gives a casual assurance on a recorded
 * scene, or has a recorded bonding or conflict scene - so the deal, assurance, memory and belief terms that need the player's social play are fed.
 */
const RUN = process.env.ORWELL_STACKING_REPORT === "1";
const N = Number.parseInt(process.env.ORWELL_STACKING_REPORT_SEEDS ?? "6", 10);
const MSGS = Number.parseInt(process.env.ORWELL_STACKING_REPORT_MESSAGES ?? "1500", 10);
const ACTIVE = process.env.ORWELL_STACKING_REPORT_ACTIVE !== "0";
const DEALS = ["safety", "final-two", "vote"] as const;

async function onMessage(call: (name: string, args: Record<string, unknown>) => Promise<unknown>, i: number): Promise<void> {
  if (i % 25 !== 24) return;
  const wa = (await call("whereabouts", {}).catch(() => null)) as { present?: Array<{ id: string }> } | null;
  const others = (wa?.present ?? []).map((x) => x.id).filter((id) => id !== "player");
  if (others.length === 0) return;
  const turn = (i / 25) | 0;
  const npc = others[turn % others.length]!;
  switch (turn % 4) {
    case 0: await call("makeDeal", { with: npc, kind: DEALS[(turn / 4 | 0) % DEALS.length], terms: "let's look after each other" }).catch(() => null); break;
    case 1:
      // ORW-636: both directions. The player assures the houseguest (feeds the player's own ledger) and, every other time, the houseguest assures the PLAYER (an NPC-made assurance: the only kind an NPC voter or HOH ever reads).
      if ((turn / 4 | 0) % 2 === 0) await call("recordInteraction", { initiator: "player", witnessSet: ["player", npc], content: "I tell them they are safe with me this week", kind: "alliance", assurance: { kind: "safe" } }).catch(() => null);
      else await call("recordInteraction", { initiator: npc, witnessSet: ["player", npc], content: "they tell me I am safe with them this week", kind: "alliance", assurance: { kind: (turn / 8 | 0) % 2 === 0 ? "safe" : "vote" } }).catch(() => null);
      break;
    case 2: await call("recordInteraction", { initiator: "player", witnessSet: ["player", npc], content: "we talk about home and laugh for a while", kind: "bonding" }).catch(() => null); break;
    default: await call("recordInteraction", { initiator: "player", witnessSet: ["player", npc], content: "we argue about the last vote", kind: "conflict" }).catch(() => null); break;
  }
}

type TermStat = { rows: number; sumAbs: number; maxAbs: number; decisive: number };
const median = (xs: number[]): number => { if (xs.length === 0) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };

describe.skipIf(!RUN)("stacking report (not a gate)", () => {
  it("prints, per decision kind, the typical gap and each term's presence, size and decisiveness", async () => {
    const decisions: DecisionWhy[] = [];
    const census = new Map<string, number>(); // ORW-636: what the sources of the never-firing terms produced (claims by kind/nature, assurances by source/kind/status)
    const bump = (k: string, n = 1): void => { census.set(k, (census.get(k) ?? 0) + n); };
    for (let seed = 1; seed <= N; seed++) {
      await playMixGame(seed, MSGS, { advanceEvery: 6, ...(ACTIVE ? { onMessage } : {}), inspect: (s) => {
        const why = (s as { live?: { decisionWhy?: DecisionWhy[] } }).live?.decisionWhy ?? [];
        decisions.push(...why);
        const live = (s as { live?: { beliefs?: Record<string, Array<{ kind: string; nature?: string; value: boolean; refuted?: boolean }>>; assurances?: { items: Array<{ source: string; kind: string; status: string }> }; ties?: unknown } }).live;
        for (const claims of Object.values(live?.beliefs ?? {})) for (const c of claims) bump(`claim ${c.kind}${c.nature ? `/${c.nature}` : ""}${c.value ? "" : " (false)"}`);
        for (const t of (s as { seededRels?: { ties?: Array<{ nature: string }> } }).seededRels?.ties ?? []) bump(`pre-show tie ${t.nature}`);
        for (const a of live?.assurances?.items ?? []) bump(`assurance ${a.source}/${a.kind}/${a.status}`);
      } });
    }
    const byKind = new Map<string, DecisionWhy[]>();
    for (const d of decisions) if (d.options.length >= 2) (byKind.get(d.kind) ?? byKind.set(d.kind, []).get(d.kind)!).push(d);
    console.log(`STACKING player=${ACTIVE ? "active" : "silent"} seeds=${N} messages=${MSGS} decisions=${decisions.length} (with a runner-up: ${[...byKind.values()].reduce((a, v) => a + v.length, 0)})`);
    for (const [k, n] of [...census].sort(([a], [b]) => a.localeCompare(b))) console.log(`STACKING census ${k}: ${n}`);
    const voteNames: readonly string[] = VOTE_TERM_NAMES, nomNames: readonly string[] = NOMINATION_TERM_NAMES;
    const named = (k: string): readonly string[] => (k === "vote" || k === "tie-break" ? voteNames : k.startsWith("nomination") || k === "replacement" ? nomNames : []);
    for (const [kind, ds] of [...byKind].sort(([a], [b]) => a.localeCompare(b))) {
      const gaps = ds.map((d) => d.options[0]!.total - d.options[1]!.total);
      const stats = new Map<string, TermStat>();
      for (const d of ds) {
        const [c, r] = [d.options[0]!, d.options[1]!];
        const cv = new Map(c.terms), rv = new Map(r.terms);
        for (const name of new Set([...cv.keys(), ...rv.keys()])) {
          const a = cv.get(name) ?? 0, b = rv.get(name) ?? 0;
          const st = stats.get(name) ?? { rows: 0, sumAbs: 0, maxAbs: 0, decisive: 0 };
          for (const v of [a, b]) if (v !== 0) { st.rows++; st.sumAbs += Math.abs(v); st.maxAbs = Math.max(st.maxAbs, Math.abs(v)); }
          if (c.total - a < r.total - b) st.decisive++; // without this term the runner-up wins
          stats.set(name, st);
        }
      }
      for (const nm of named(kind)) if (!stats.has(nm)) console.log(`STACKING   ${kind}.${nm}: NEVER non-zero in ${ds.length} decisions`);
      const rows = [...stats].sort((x, y) => y[1].decisive - x[1].decisive || y[1].sumAbs - x[1].sumAbs);
      const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : "-");
      console.log(`STACKING ${kind}: n=${ds.length} median gap=${median(gaps).toFixed(2)} under 0.2: ${pct(gaps.filter((g) => g < 0.2).length, gaps.length)}%`);
      for (const [name, st] of rows) {
        console.log(`STACKING   ${kind}.${name}: in ${pct(st.rows, 2 * ds.length)}% of option rows, avg |${(st.rows ? st.sumAbs / st.rows : 0).toFixed(3)}|, max |${st.maxAbs.toFixed(2)}|, decisive ${pct(st.decisive, ds.length)}%`);
      }
    }
  }, 3_600_000);
});
