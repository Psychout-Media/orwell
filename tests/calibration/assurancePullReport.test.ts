import { describe, it } from "vitest";
import { playMixGame } from "../support/houseMixDriver";
import type { DecisionWhy } from "../../src/engine/decisionWhy";

/**
 * REPORT, NOT A GATE (ORW-723). Plays N chat-paced seeded games (the stacking report's driver, an active player) and prints, per BAND of voter, how often a vote promise
 * is kept or broken and how often the vote term `assurance` is present and DECISIVE (without it the runner-up would have won). The band is the voter's own traits (loyalty and
 * honesty, the same reads the pull uses), never a name: loyal/honest >= 0.6, scheming <= 0.4, middling between. Run before (ORWELL_ASSURANCE_PULL=0) and after.
 *
 * Skipped unless ORWELL_ASSURANCE_PULL_REPORT=1. ORWELL_ASSURANCE_PULL_REPORT_SEEDS (default 8), ORWELL_ASSURANCE_PULL_REPORT_MESSAGES (default 1500).
 */
const RUN = process.env.ORWELL_ASSURANCE_PULL_REPORT === "1";
const N = Number.parseInt(process.env.ORWELL_ASSURANCE_PULL_REPORT_SEEDS ?? "8", 10);
const MSGS = Number.parseInt(process.env.ORWELL_ASSURANCE_PULL_REPORT_MESSAGES ?? "1500", 10);
const BANDS = ["loyal-honest", "middling", "scheming"] as const;
type Band = (typeof BANDS)[number];
type Sess = { assuranceVoteFor(n: string, v: string): number; assuranceTraitsOf(id: string): { loyalty: number; honesty: number }; live?: { assurances?: { items: Array<{ id: string; from: string; to: string; kind: string; source: string; status: string }> } } };
const bandOf = (t: { loyalty: number; honesty: number }): Band => { const x = 0.5 * t.loyalty + 0.5 * t.honesty; return x >= 0.6 ? "loyal-honest" : x <= 0.4 ? "scheming" : "middling"; };

async function onMessage(call: (name: string, args: Record<string, unknown>) => Promise<unknown>, i: number): Promise<void> {
  if (i % 25 !== 24) return;
  const wa = (await call("whereabouts", {}).catch(() => null)) as { present?: Array<{ id: string }> } | null;
  const others = (wa?.present ?? []).map((x) => x.id).filter((id) => id !== "player");
  if (others.length === 0) return;
  const turn = (i / 25) | 0;
  const npc = others[turn % others.length]!;
  switch (turn % 4) {
    case 0: await call("makeDeal", { with: npc, kind: (["safety", "final-two", "vote"] as const)[(turn / 4 | 0) % 3], terms: "let's look after each other" }).catch(() => null); break;
    case 1: await call("recordInteraction", { initiator: npc, witnessSet: ["player", npc], content: "they tell me I am safe with them this week", kind: "alliance", assurance: { kind: (turn / 8 | 0) % 2 === 0 ? "safe" : "vote" } }).catch(() => null); break;
    case 2: await call("recordInteraction", { initiator: "player", witnessSet: ["player", npc], content: "we talk about home and laugh for a while", kind: "bonding" }).catch(() => null); break;
    default: await call("recordInteraction", { initiator: "player", witnessSet: ["player", npc], content: "we argue about the last vote", kind: "conflict" }).catch(() => null); break;
  }
}

describe.skipIf(!RUN)("assurance pull report (not a gate)", () => {
  it("prints, per voter band, the keep and break rate of NPC vote promises and the vote term's presence and decisiveness", async () => {
    const mk = () => ({ pullKept: 0, pullBroke: 0, gaps: [] as number[], kept: 0, broken: 0, open: 0, lapsed: 0, rows: 0, decisions: 0, present: 0, decisive: 0 });
    const by = new Map<string, ReturnType<typeof mk>>();
    const stat = (k: string) => by.get(k) ?? by.set(k, mk()).get(k)!;
    for (let seed = 1; seed <= N; seed++) {
      const bandAt = new Map<string, Band>();
      const lastShield = new Map<string, { band: Band; to: string; kept: boolean }>();
      await playMixGame(seed, MSGS, { advanceEvery: 6, onMessage, onStep: (s) => {
        const sess = s as Sess;
        for (const a of sess.live?.assurances?.items ?? []) { if (a.source !== "npc" || a.from === "player") continue; if (!bandAt.has(a.id)) bandAt.set(a.id, bandOf(sess.assuranceTraitsOf(a.from))); if (a.status === "open" && (a.kind === "vote" || a.kind === "safe")) lastShield.set(a.id, { band: bandAt.get(a.id)!, to: a.to, kept: sess.assuranceVoteFor(a.to, a.from) > 0 }); }
      }, inspect: (s) => {
        const sess = s as Sess;
        for (const v of lastShield.values()) { const st = stat(`pull:${v.band}`); if (v.kept) st.pullKept++; else st.pullBroke++; }
        for (const a of sess.live?.assurances?.items ?? []) {
          if (a.source !== "npc" || a.from === "player") continue;
          const st = stat(`${a.to === "player" ? "to-player" : "to-npc"}:${bandAt.get(a.id) ?? bandOf(sess.assuranceTraitsOf(a.from))}`);
          st[a.status as "kept" | "broken" | "open" | "lapsed"]++;
        }
        const why = (s as { live?: { decisionWhy?: DecisionWhy[] } }).live?.decisionWhy ?? [];
        for (const d of why) {
          if (d.kind !== "vote" || d.options.length < 2 || d.by === "player") continue;
          const st = stat(`vote:${bandOf(sess.assuranceTraitsOf(d.by))}`);
          st.decisions++;
          if ((d.options[0]!.terms.some(([n]) => n === "assurance")) || d.options[1]!.terms.some(([n]) => n === "assurance")) st.gaps.push(d.options[0]!.total - d.options[1]!.total);
          const [c, r] = [d.options[0]!, d.options[1]!];
          const cv = new Map(c.terms), rv = new Map(r.terms);
          for (const v of [cv.get("assurance") ?? 0, rv.get("assurance") ?? 0]) if (v !== 0) st.rows++;
          if ((cv.get("assurance") ?? 0) !== 0 || (rv.get("assurance") ?? 0) !== 0) st.present++;
          if (c.total - (cv.get("assurance") ?? 0) < r.total - (rv.get("assurance") ?? 0)) st.decisive++;
        }
      } });
    }
    const pct = (a: number, b: number) => (b ? ((100 * a) / b).toFixed(1) : "-");
    console.log(`ASSURANCE-PULL seeds=${N} messages=${MSGS}`);
    for (const side of ["to-npc", "to-player"]) for (const b of BANDS) {
      const s = stat(`${side}:${b}`); const res = s.kept + s.broken;
      console.log(`ASSURANCE-PULL ${side} ${b}: made=${s.kept + s.broken + s.open + s.lapsed} resolved=${res} kept=${s.kept} broken=${s.broken} keep%=${pct(s.kept, res)} break%=${pct(s.broken, res)}`);
    }
    for (const b of BANDS) { const s = stat(`pull:${b}`); console.log(`ASSURANCE-PULL pull-decision ${b}: open vote/safe promises=${s.pullKept + s.pullBroke} keep=${pct(s.pullKept, s.pullKept + s.pullBroke)}% break=${pct(s.pullBroke, s.pullKept + s.pullBroke)}%`); }
    for (const b of BANDS) { const s = stat(`vote:${b}`); console.log(`ASSURANCE-PULL vote ${b}: decisions=${s.decisions} nonzero=${pct(s.present, s.decisions)}% decisive=${pct(s.decisive, s.decisions)}% median gap where present=${s.gaps.length ? [...s.gaps].sort((x, y) => x - y)[s.gaps.length >> 1]!.toFixed(2) : "-"} (n=${s.gaps.length})`); }
  }, 3_600_000);
});
