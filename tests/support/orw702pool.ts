import { readFileSync } from "node:fs";
import { poolSeason, evaluate, ratchet, fmtShare, PHASES } from "./wholeSeasonMix";
const lines = readFileSync(process.argv[2]!, "utf8").split("\n").filter((l) => l.startsWith("SEASONSCENES "));
const all: any[] = [];
for (const l of lines) {
  const r = JSON.parse(l.slice("SEASONSCENES ".length));
  console.log(`seed ${r.seed}: ${r.stopped} week ${r.week} messages ${r.messages} playerOut ${r.playerOutWeek ?? "never"} ${r.seconds}s publicCouples ${r.publicCouples ?? "?"} of ${r.pairsSeen ?? "?"} paced pairs`);
  for (const [type, week, out] of r.scenes) all.push({ type, action: "", msg: 0, week, playerOut: out === 1 });
}
const { shares, basis } = poolSeason(all);
console.log("POOLED", PHASES.map((p) => `${p} ${fmtShare(shares[p])} [${basis[p]}]`).join(" | "));
const res = evaluate(shares);
console.log("FAIL", res.filter((r) => !r.pass).map((r) => `${r.id}=${r.value}`).join(" "));
const v = ratchet(res);
console.log("regressions", JSON.stringify(v.regressions), "fixed", JSON.stringify(v.fixed.map((x) => x.split(" ")[0])), "worse", JSON.stringify(v.worse));
import { BANDS, HARD } from "./wholeSeasonMix";
const kinds = ["bonding", "strategy", "gossip", "conflict"] as const;
const tight: string[] = [];
for (const p of PHASES) for (const k of kinds) { const v = (shares as any)[p][k] as number; const [lo, hi] = BANDS[p][k]; const room = Math.min(v - lo, hi - v); if (room < 1.0) tight.push(`${p}:${k}=${v.toFixed(1)} (room ${room.toFixed(1)} in ${lo}-${hi})`); }
for (const p of PHASES) { const s = (shares as any)[p]; if (p !== "early") { if (s.gossip - HARD.gossipAtLeastFromMid < 1) tight.push(`${p}:gossip-floor`); if (s.strategy - HARD.strategyAtLeastFromMid < 1) tight.push(`${p}:strategy-floor`); } if (HARD.anyActivityAtMost - Math.max(s.bonding, s.strategy, s.gossip, s.conflict) < 1) tight.push(`${p}:activity-ceiling`); }
console.log("TIGHT(<1.0)", tight.length ? tight.join("; ") : "none");
