import { auditSeason } from "../../tests/support/activeInHouseAudit";
const seeds = (process.argv[2] ?? "1").split(",").map(Number);
const survive = process.argv[3] === "survive";
for (const s of seeds) {
  const r = await auditSeason(s, { survive });
  const byType: Record<string, number> = {};
  const shown: Record<string, number> = {};
  for (const h of r.hits) byType[`${h.kind}:${h.type}`] = (byType[`${h.kind}:${h.type}`] ?? 0) + 1;
  console.log("AUDIT " + JSON.stringify({ seed: s, finished: r.finished, msgs: r.messages, events: r.events, jurorWithActive: r.jurorWithActive, preJuryEvictee: r.preJuryEvictee, outPlayer: r.outPlayer, byType }));
  if (process.env.SHOW) for (const h of r.hits) { const k = `${h.kind}:${h.type}`; if ((shown[k] = (shown[k] ?? 0) + 1) <= Number(process.env.SHOW)) console.log("AUDIT   ", h.kind, h.type, h.id, h.who.join(","), "|", h.content); }
}
