import { mixShares, type MixScene } from "../houseMixDriver";
import type { FlagInfo, FeatureInfo } from "./discover";
import type { SeasonRecord } from "./player";
import { MASKS, ALL_DEAL_KINDS } from "./player";
import type { Difference, RestartVerdict } from "./compare";
import { PHASES, BANDS, poolSeason, inBand, type Phase, type Kind, type Share } from "../wholeSeasonMix";

/**
 * ORW-729: aggregate the played seasons + ablation results into ONE summary (JSON, stable keys), render it as markdown, diff it against the last night's summary, and refuse to
 * emit anything that looks like a name, an address or a save. The summary holds COUNTS, KINDS, ROLES and HASH-FREE verdicts only.
 */
export const LOOP_REPEATS = 3; // a decision re-raised more than this many times after being answered is a loop
/** The week-1 reference of the house-mix guard (tests/uat/houseMixGuard.test.ts REFERENCE), printed for information only; a unit test pins this equal to the guard's own constant. */
export const GUARD_REFERENCE = { bonding: 30.2, strategy: 34.7, gossip: 28.5, conflict: 6.7 } as const;
export const SPEC_FLOOR = 49; // the card's range: specs 0049 and later

export interface AblationResult { envKey: string; seed: number; fired: boolean; divergedAt: number | null; stopped: string; messages: number }
export interface RestartResult { seed: number; point: number; difference: Difference | null; verdict: RestartVerdict; finished: boolean }
export interface Inputs {
  date: string;
  seasons: SeasonRecord[];
  ablations: AblationResult[];
  restarts: RestartResult[];
  /** the same seed played twice with nothing changed: a difference here is a nondeterminism finding, and says the masks are not enough */
  determinism: Array<{ seed: number; difference: Difference | null }>;
  flags: FlagInfo[];
  features: FeatureInfo[];
}

export type FlagVerdict = "fires" | "ZERO" | "not-measured";
export interface FlagRow { envKey: string; source: string; defaultOn: boolean; verdict: FlagVerdict; firedIn: number; measuredIn: number; firstFire: number | null; specs: string[]; themes: string[] }
export interface Summary {
  date: string;
  seeds: number[];
  seasons: Array<{ seed: number; stopped: string; messages: number; week: number; events: number }>;
  flags: FlagRow[];
  specs: Array<{ id: string; title: string; flags: string[]; verdict: FlagVerdict | "no-flag" }>;
  themes: Array<{ theme: string; flags: number; zero: string[] }>;
  eventTypes: Array<{ type: string; perSeason: number; seasons: number }>;
  houseLifeActions: Array<{ action: string; perSeason: number; seasons: number }>;
  stateKeysNeverPopulated: string[];
  /** ORW-741: what the played seasons reached, by derived footprint (state sizes, post-season view kinds, the player's knowledge pathways): total per season and how many seasons reached it */
  milestones: Array<{ name: string; perSeason: number; seasons: number }>;
  faults: Array<{ kind: string; detail: string; seeds: number[] }>;
  crashes: Array<{ tool: string; what: string; seeds: number[]; count: number }>;
  loops: Array<{ seed: number; what: string }>;
  tools: Array<{ tool: string; tried: number; refused: number; noEffect: number }>;
  restarts: RestartResult[];
  determinism: Inputs["determinism"];
  mixByWeek: MixRow[];
  /** the same, counting the scenes after the player left the game too (the house a spectator watches) */
  mixByWeekAll: MixRow[];
  /** ORW-702: the pooled mix per season phase (early 1-3, mid 4-8, late 9+), while the player was in; judged against tests/support/wholeSeasonMix.ts */
  mixByPhase: Record<Phase, Share>;
  /** which scenes each phase was read from: the player-in ones, or (a phase the player never reached) the whole house */
  mixPhaseBasis: Record<Phase, string>;
}
export type MixRow = { week: number; n: number; bonding: number; strategy: number; gossip: number; conflict: number };

const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]!; };
const safe = (s: string): string => (/^[A-Za-z0-9:_.\- ]{1,64}$/.test(s) ? s : "(other)"); // a kind is a short token; anything else is bucketed, never printed

function perSeason(rs: SeasonRecord[], pick: (r: SeasonRecord) => Record<string, number>): Array<{ k: string; perSeason: number; seasons: number }> {
  const tot = new Map<string, { n: number; seasons: number }>();
  for (const r of rs) for (const [k0, v] of Object.entries(pick(r))) { const k = safe(k0); const t = tot.get(k) ?? { n: 0, seasons: 0 }; t.n += v; t.seasons++; tot.set(k, t); }
  return [...tot.entries()].map(([k, t]) => ({ k, perSeason: +(t.n / Math.max(1, rs.length)).toFixed(1), seasons: t.seasons })).sort((a, b) => a.perSeason - b.perSeason || (a.k < b.k ? -1 : 1));
}

export function buildSummary(inp: Inputs): Summary {
  const rs = inp.seasons;
  const flags: FlagRow[] = inp.flags.map((f) => {
    const a = inp.ablations.filter((x) => x.envKey === f.envKey);
    const fired = a.filter((x) => x.fired);
    return { envKey: f.envKey, source: f.source, defaultOn: f.defaultOn, verdict: a.length === 0 ? "not-measured" : fired.length ? "fires" : "ZERO", firedIn: fired.length, measuredIn: a.length, firstFire: median(fired.map((x) => x.divergedAt ?? 0)), specs: f.specs, themes: f.themes };
  });
  const byEnv = new Map(flags.map((f) => [f.envKey, f]));
  const specs = inp.features.filter((s) => Number(s.id) >= SPEC_FLOOR).map((s) => {
    const fl = inp.flags.filter((f) => f.specs.includes(s.id)).map((f) => f.envKey);
    const vs = fl.map((k) => byEnv.get(k)!.verdict);
    const verdict: FlagVerdict | "no-flag" = fl.length === 0 ? "no-flag" : vs.includes("fires") ? "fires" : vs.includes("ZERO") ? "ZERO" : "not-measured";
    return { id: s.id, title: s.title, flags: fl, verdict };
  });
  const themeNames = [...new Set(inp.flags.flatMap((f) => f.themes))].sort();
  const themes = themeNames.map((t) => { const fl = flags.filter((f) => f.themes.includes(t)); return { theme: t, flags: fl.length, zero: fl.filter((f) => f.verdict === "ZERO").map((f) => f.envKey) }; });
  const seenKeys = new Set(rs.flatMap((r) => r.stateKeysSeen)), popKeys = new Set(rs.flatMap((r) => r.stateKeysPopulated));
  const faults = new Map<string, { kind: string; detail: string; seeds: number[] }>();
  const crashes = new Map<string, { tool: string; what: string; seeds: number[]; count: number }>();
  const tools = new Map<string, { tried: number; refused: number; noEffect: number }>();
  const loops: Summary["loops"] = [];
  for (const r of rs) {
    for (const f of r.faults) { const k = `${f.kind}|${f.detail}`; const e = faults.get(k) ?? { kind: f.kind, detail: f.detail, seeds: [] }; e.seeds.push(r.seed); faults.set(k, e); }
    for (const c of r.crashes) { const k = `${c.tool}|${c.what}`; const e = crashes.get(k) ?? { tool: c.tool, what: c.what, seeds: [], count: 0 }; e.seeds.push(r.seed); e.count += c.count; crashes.set(k, e); }
    for (const [t, n] of Object.entries(r.tried)) { const e = tools.get(t) ?? { tried: 0, refused: 0, noEffect: 0 }; e.tried += n; e.refused += r.refused[t] ?? 0; e.noEffect += r.noEffect?.[t] ?? 0; tools.set(t, e); }
    for (const [k, n] of Object.entries(r.pendingRepeats)) if (n > LOOP_REPEATS) loops.push({ seed: r.seed, what: `decision "${safe(k)}" re-raised ${n} times after being answered` });
    if (r.stopped === "stalled") loops.push({ seed: r.seed, what: `stalled: ${r.stalledAt ?? `no progress (week ${r.week})`}` });
    if (r.stopped === "cap") loops.push({ seed: r.seed, what: `season did not finish within ${r.messages} messages (week ${r.week}), no crown` });
  }
  const everyScene: MixScene[] = rs.flatMap((r) => r.scenes);
  const byWeek = (scenes: MixScene[]): MixRow[] => [...new Set(scenes.map((s) => s.week))].sort((a, b) => a - b).map((w) => { const m = mixShares(scenes.filter((s) => s.week === w)); return { week: w, n: m.n, bonding: +m.bonding.toFixed(1), strategy: +m.strategy.toFixed(1), gossip: +m.gossip.toFixed(1), conflict: +m.conflict.toFixed(1) }; });
  const mixByWeek = byWeek(everyScene.filter((s) => !s.playerOut)), mixByWeekAll = byWeek(everyScene);
  const ev = perSeason(rs, (r) => r.eventTypes), hl = perSeason(rs, (r) => r.houseLifeActions);
  return {
    date: inp.date,
    seeds: rs.map((r) => r.seed),
    seasons: rs.map((r) => ({ seed: r.seed, stopped: r.stopped, messages: r.messages, week: r.week, events: Object.values(r.eventTypes).reduce((a, b) => a + b, 0) })),
    flags, specs, themes,
    eventTypes: ev.map((e) => ({ type: e.k, perSeason: e.perSeason, seasons: e.seasons })),
    houseLifeActions: hl.map((e) => ({ action: e.k, perSeason: e.perSeason, seasons: e.seasons })),
    milestones: perSeason(rs, (r) => r.milestones ?? {}).map((m) => ({ name: m.k, perSeason: m.perSeason, seasons: m.seasons })),
    stateKeysNeverPopulated: [...seenKeys].filter((k) => !popKeys.has(k)).sort(),
    faults: [...faults.values()], crashes: [...crashes.values()], loops,
    tools: [...tools.entries()].map(([tool, v]) => ({ tool, ...v })).sort((a, b) => (a.tool < b.tool ? -1 : 1)),
    restarts: inp.restarts, determinism: inp.determinism, mixByWeek, mixByWeekAll,
    mixByPhase: poolSeason(everyScene).shares,
    mixPhaseBasis: poolSeason(everyScene).basis,
  };
}

export interface Diff { newZeros: string[]; clearedZeros: string[]; newFaults: string[]; newCrashes: string[]; newLoops: string[]; newRestartDifferences: string[]; vanishedEventTypes: string[]; newEmptyStateKeys: string[] }

/** The short diff against the last report: only what got WORSE or changed kind, so the Coordinator can turn each line into a card. */
export function diffSummaries(prev: Summary | null, cur: Summary): Diff {
  const d: Diff = { newZeros: [], clearedZeros: [], newFaults: [], newCrashes: [], newLoops: [], newRestartDifferences: [], vanishedEventTypes: [], newEmptyStateKeys: [] };
  const zeros = (s: Summary): Set<string> => new Set(s.flags.filter((f) => f.verdict === "ZERO").map((f) => f.envKey));
  const cz = zeros(cur), pz = prev ? zeros(prev) : new Set<string>();
  d.newZeros = [...cz].filter((k) => !pz.has(k)).sort();
  d.clearedZeros = [...pz].filter((k) => !cz.has(k)).sort();
  const fk = (f: { kind: string; detail: string }): string => `${f.kind}${f.detail ? ` (${f.detail})` : ""}`;
  const pf = new Set((prev?.faults ?? []).map(fk)); d.newFaults = cur.faults.map(fk).filter((k) => !pf.has(k)).sort();
  const pc = new Set((prev?.crashes ?? []).map((c) => `${c.tool}: ${c.what}`)); d.newCrashes = cur.crashes.map((c) => `${c.tool}: ${c.what}`).filter((k) => !pc.has(k)).sort();
  const pl = new Set((prev?.loops ?? []).map((l) => l.what.replace(/\d+/g, "N"))); d.newLoops = cur.loops.map((l) => `seed ${l.seed}: ${l.what}`).filter((k) => !pl.has(k.replace(/^seed \d+: /, "").replace(/\d+/g, "N"))).sort();
  const rd = (s: Summary | null): Set<string> => new Set((s?.restarts ?? []).filter((r) => r.verdict === "state-lost" || !r.finished).map((r) => `seed ${r.seed} at ${r.point}: ${r.verdict === "state-lost" ? `state lost (${r.difference?.field ?? "events fell"})` : "restarted season did not finish"}`));
  const pr = rd(prev); d.newRestartDifferences = [...rd(cur)].filter((k) => !pr.has(k)).sort();
  if (prev) {
    const ct = new Set(cur.eventTypes.map((e) => e.type));
    d.vanishedEventTypes = prev.eventTypes.map((e) => e.type).filter((t) => !ct.has(t)).sort();
    const pe = new Set(prev.stateKeysNeverPopulated);
    d.newEmptyStateKeys = cur.stateKeysNeverPopulated.filter((k) => !pe.has(k));
  }
  return d;
}

const tbl = (head: string[], rows: Array<Array<string | number>>): string => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const pct = (x: number): string => x.toFixed(1);

const KINDS: Kind[] = ["bonding", "strategy", "gossip", "conflict"];
/** The per-phase table with each cell marked in or out of its agreed band. */
export function phaseTable(m: Record<Phase, Share>, basis?: Record<Phase, string>): string {
  return tbl(["phase", "scenes", "read from", ...KINDS.map((k) => `${k} (band)`)], PHASES.map((p) => [p, m[p].n, basis?.[p] ?? "player-in", ...KINDS.map((k) => `${pct(m[p][k])} ${m[p].n === 0 ? "-" : inBand(p, k, m[p][k]) ? "ok" : "OUT"} (${BANDS[p][k][0]}-${BANDS[p][k][1]})`)]));
}

export function renderMarkdown(s: Summary, d: Diff): string {
  const L: string[] = [];
  const zero = s.flags.filter((f) => f.verdict === "ZERO"), fires = s.flags.filter((f) => f.verdict === "fires"), nm = s.flags.filter((f) => f.verdict === "not-measured");
  L.push(`# What fired report ${s.date}`, "", `Played seasons: ${s.seasons.length} (seeds ${s.seeds.join(", ")}); a scripted player, no model calls. Flags discovered: ${s.flags.length} (fires ${fires.length}, ZERO ${zero.length}, not measured ${nm.length}).`, "");
  L.push("## Diff against the last report", "");
  const dl = (t: string, xs: string[]): void => { L.push(`- ${t}: ${xs.length ? xs.join("; ") : "none"}`); };
  dl("new zeros (built but never fired)", d.newZeros); dl("zeros that now fire", d.clearedZeros); dl("new faults", d.newFaults); dl("new crashes", d.newCrashes); dl("new loops or stalls", d.newLoops); dl("new restart differences", d.newRestartDifferences); dl("event types that stopped appearing", d.vanishedEventTypes); dl("state keys newly never populated", d.newEmptyStateKeys);
  L.push("", "## 2. Crashes, stalls and loops", "");
  L.push(tbl(["seed", "stopped", "messages", "week", "events"], s.seasons.map((x) => [x.seed, x.stopped, x.messages, x.week, x.events])), "");
  L.push(`Loops and stalls: ${s.loops.length ? "" : "none"}`); for (const l of s.loops) L.push(`- seed ${l.seed}: ${l.what}`);
  L.push("", `Crashes (an exception out of a load-bearing tool): ${s.crashes.length ? "" : "none"}`); for (const c of s.crashes) L.push(`- ${c.tool}: ${c.what} (seeds ${c.seeds.join(", ")}; ${c.count} times)`);
  L.push("", `Typed faults (sandboxHealth, includes tick-failure): ${s.faults.length ? "" : "none"}`); for (const f of s.faults) L.push(`- ${f.kind}${f.detail ? ` (${f.detail})` : ""}: seeds ${f.seeds.join(", ")}`);
  L.push("", "## 3. Save and restart", "", `Determinism check (the same seed twice, nothing changed): ${s.determinism.map((x) => `seed ${x.seed} ${x.difference ? `DIFFERS at message ${x.difference.at} (${x.difference.field})` : "identical"}`).join("; ") || "not run"}`, "");
  L.push(tbl(["seed", "restart at message", "result", "restarted season"], s.restarts.map((r) => [r.seed, r.point, r.verdict === "identical" ? "identical" : `${r.verdict === "state-lost" ? "STATE LOST" : "continues differently"}: first difference at message ${r.difference?.at ?? "-"} (${r.difference?.field ?? "events fell"})`, r.finished ? "finished" : "DID NOT FINISH"])), "");
  L.push("\"continues differently\" is expected: the off-screen random stream restarts from its seed and is not saved, so a restarted season is not byte-identical from the first tick after the restart. \"STATE LOST\" (a difference at or before the restart, or the event count falling) is the finding.", "", "Masked before comparing (listed so nothing hides silently):", ...MASKS.map((m) => `- \`${m.key}\`: ${m.why}`));
  L.push("", "## 4. House mix by week (information only; the agreed whole-season target comes from ORW-702)", "", `Guard week-1 reference: ${GUARD_REFERENCE.bonding} / ${GUARD_REFERENCE.strategy} / ${GUARD_REFERENCE.gossip} / ${GUARD_REFERENCE.conflict} (bonding / strategy / gossip / conflict, percent).`, "");
  const mixRows = (rows: MixRow[]): string => tbl(["week", "scenes", "bonding", "strategy", "gossip", "conflict"], rows.map((m) => [m.week, m.n, pct(m.bonding), pct(m.strategy), pct(m.gossip), pct(m.conflict)]));
  L.push("Whole-season target (ORW-702; bands from the whole-season mix constants module), pooled per phase over the played seasons (the player-in scenes; a phase the player never reached is read from the whole house and says so). A cell is `ok` inside its band, `OUT` outside:", "", phaseTable(s.mixByPhase, s.mixPhaseBasis), "");
  L.push("While the player is still in the game:", "", mixRows(s.mixByWeek), "", "Every scene, including the weeks after the player left (the house a spectator watches):", "", mixRows(s.mixByWeekAll));
  L.push("", "## 1. What fired", "", "A flag FIRES when playing a season with it turned the other way from its default changes the played game (the event stream or the saved state) from some message on; ZERO means no change in any measured season. First fire is the median message where the two games first differ. Flags are discovered from the registry, not listed by hand.", "");
  L.push(`### Zero or near-zero flags (${zero.length})`, "");
  L.push(zero.length ? tbl(["flag", "default", "source", "specs", "themes"], zero.map((f) => [`\`${f.envKey}\``, f.defaultOn ? "ON" : "off", f.source, f.specs.join(" ") || "-", f.themes.join(" ") || "-"])) : "none", "");
  const near = fires.filter((f) => f.measuredIn > 1 && f.firedIn < f.measuredIn);
  L.push(`### Fires in only some seeds (${near.length})`, "", near.length ? tbl(["flag", "fired in", "first fire (message)"], near.map((f) => [`\`${f.envKey}\``, `${f.firedIn}/${f.measuredIn}`, f.firstFire ?? "-"])) : "none", "");
  L.push("### Specs (0049 and later) by what their flags did", "", tbl(["spec", "title", "flags", "verdict"], s.specs.map((x) => [x.id, x.title.replace(/\|/g, "/"), x.flags.length ? x.flags.map((f) => `\`${f.replace(/^ORWELL_/, "")}\``).join(" ") : "-", x.verdict])), "");
  L.push("### Themes", "", tbl(["theme", "flags", "zero"], s.themes.map((t) => [t.theme, t.flags, t.zero.length ? t.zero.map((z) => `\`${z.replace(/^ORWELL_/, "")}\``).join(" ") : "-"])), "");
  L.push("### Event types per season (rarest first)", "", tbl(["type", "per season", "seasons"], s.eventTypes.map((e) => [e.type, e.perSeason, `${e.seasons}/${s.seasons.length}`])), "");
  L.push("### House-life actions per season (rarest first)", "", tbl(["action", "per season", "seasons"], s.houseLifeActions.map((e) => [e.action, e.perSeason, `${e.seasons}/${s.seasons.length}`])), "");
  L.push(`### Milestones reached in the played seasons (${s.milestones.length})`, "", "Derived footprints, not a feature list: `state.<key>` = the size of a saved-state list or map at the end of the season; `view.<part>.<field>:<value>` = a kind, shape or action the post-season views carried (the edit's moments, the story shapes, the reunion); `pathway.<word>` = how the facts the player holds reached them (told, overheard, witnessed ...). A footprint a feature should leave and that is missing here is a feature that never fired in play.", "", tbl(["milestone", "per season", "seasons"], s.milestones.map((m) => [m.name, m.perSeason, `${m.seasons}/${s.seasons.length}`])), "");
  L.push(`### Saved-state keys that never became non-empty (${s.stateKeysNeverPopulated.length})`, "", s.stateKeysNeverPopulated.length ? s.stateKeysNeverPopulated.map((k) => `\`${k}\``).join(" ") : "none", "");
  L.push("### What the scripted player tried (a tool refused or without effect every time is a script gap or a dead lever)", "", tbl(["tool", "tried", "refused", "took no effect"], s.tools.map((t) => [t.tool, t.tried, t.refused, t.noEffect])), "");
  const dealsNever = ALL_DEAL_KINDS.filter((k) => !s.tools.some((t) => t.tool === `deal:${k}` && t.tried > t.refused));
  L.push(`### Deal kinds the scripted player got agreed (ORW-1099; a kind listed here was never made in these seasons)`, "", dealsNever.length ? `ZERO: ${dealsNever.join(", ")}` : "every kind was made at least once", "");
  return L.join("\n");
}

/** The report goes into a public repository's CI artifact: refuse anything that smells like a name, an address, a path, a secret or a raw entity id. Throws with the offending line. */
const FORBIDDEN: Array<[RegExp, string]> = [
  [/\bnpc:\d+/i, "a raw houseguest id"],
  [/https?:\/\//i, "a URL"],
  [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, "an IP address"],
  [/\/home\/|\/Users\/|C:\\/, "a filesystem path"],
  [/\b(api[_-]?key|secret|token|password)\s*[:=]/i, "a credential-looking assignment"],
  [/@[A-Za-z0-9-]+\.[a-z]{2,}/, "an email address"],
];
export function assertClean(text: string): void {
  for (const line of text.split("\n")) for (const [re, what] of FORBIDDEN) if (re.test(line)) throw new Error(`what-fired report refused: ${what} in a line: ${line.slice(0, 60)}`);
}
