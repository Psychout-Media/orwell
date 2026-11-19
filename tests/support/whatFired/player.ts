import { composeRuntime, type Runtime } from "../../../src/composition/runtime";
import { FileSaveStore } from "../../../src/adapters/engine/FileSaveStore";
import { autoResolve, type PendingDecision } from "../../uat/fullGameUatHarness";
import type { MixScene } from "../houseMixDriver";
import { createHash } from "node:crypto";

/**
 * ORW-729 (Automation 1): the SCRIPTED TALKING PLAYER and the played season it drives. Engine-side developer tooling: it holds the engine's own full access in-process,
 * calls the same player-channel tools a person's front end calls (never a model: the narrator is not involved), is deterministic per seed, and reads only COUNTS, KINDS and
 * hashes out of the sandbox. Nothing here is reachable from any MCP/HTTP tool, and nothing prints game content (see `report.ts` for the clean-report check).
 *
 * The player talks in rotation (bonding, strategy, gossip, conflict scenes; deals, alliances, confiding, accusing, the diary room, calling in favours), answers every approach
 * (`socialInitiatives`) and every pending decision (nominations, veto, comps, votes, the finale), passes a held night the way a person does (hang out through the day, turn in
 * at night), and plays on until the crown or the message cap.
 */
export type Call = (name: string, args: Record<string, unknown>) => Promise<any>;

/** One row of a season's trace: the message index, the event count, a hash of the newest event, and (at sample points) a digest of the whole saved state. */
export interface TraceRow { i: number; ev: number; last: string; st?: string }

export interface PlayOpts {
  seed: number;
  maxMessages?: number;
  advanceEvery?: number;
  talkEvery?: number;
  sampleEvery?: number;
  /** restart the runtime (a new process's worth of state, loaded from the durable save) after this message index; needs `saveDir`. */
  restartAt?: number;
  /** a durable save folder (FileSaveStore); when absent the run is in-memory. */
  saveDir?: string;
  /** compare against this trace as the run goes and STOP at the first difference (the ablation's early exit). */
  against?: readonly TraceRow[];
}

export interface FaultSeen { kind: string; detail: string; firstAt: number; count: number }
export interface SeasonRecord {
  seed: number;
  finished: boolean;
  messages: number;
  advances: number;
  week: number;
  /** why the run stopped early, when it did: "stalled" (no progress for a long time), "cap" (message cap, no crown), "diverged" (against a trace) */
  stopped: "finished" | "cap" | "stalled" | "diverged";
  divergedAt?: number;
  eventTypes: Record<string, number>;
  houseLifeActions: Record<string, number>;
  eventFields: Record<string, number>;
  /** state keys (live.<key> / top-level <key>) that were non-empty at any sample */
  stateKeysPopulated: string[];
  stateKeysSeen: string[];
  pendingKinds: Record<string, number>;
  /** the most times one decision was re-raised after being answered, by kind */
  pendingRepeats: Record<string, number>;
  faults: FaultSeen[];
  /** exceptions out of the load-bearing tools (advanceGame / noteMessage / submitDecision / turnIn ...): tool + class + scrubbed head */
  crashes: Array<{ tool: string; at: number; what: string; count: number }>;
  /** social actions the engine refused (a legal refusal, not a crash), by tool */
  refused: Record<string, number>;
  /** social actions the engine took in (no exception) but that did nothing: a success flag of false (landed / accepted / disclosed ...) */
  noEffect: Record<string, number>;
  /** social actions the script tried, by tool */
  tried: Record<string, number>;
  scenes: MixScene[];
  trace: TraceRow[];
}

const hash = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 12);

/** The keys named here are dropped before a state digest or event hash: values that differ between two identical runs for a reason that is not a game difference. Listed in every report. */
export const MASKS: ReadonlyArray<{ key: string; why: string }> = [
  { key: "ts", why: "an event's logical-clock stamp (a restart re-seeds the play clock; the order of events is compared, not their stamps)" },
  { key: "savedAt", why: "a save's own write stamp" },
];
const MASKED = new Set(MASKS.map((m) => m.key));
const stable = (v: unknown): string => JSON.stringify(v, (k, x) => (MASKED.has(k) ? undefined : x));

const mulberry = (a: number) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const nonEmpty = (v: unknown): boolean => v !== null && v !== undefined && v !== false && v !== 0 && v !== "" && !(Array.isArray(v) && v.length === 0) && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** Scrub an error head so a report never carries a name or an id: ids become npc:N, two capitalised words become <name>. */
export function scrub(s: string): string {
  return s.replace(/npc:\d+/g, "npc:N").replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, "<name>").replace(/\d{3,}/g, "N").slice(0, 80);
}

const SCENES = ["bonding", "strategy", "gossip", "conflict", "alliance"] as const;
const DEALS = ["safety", "final-two", "vote"] as const;

export async function playSeason(opts: PlayOpts): Promise<SeasonRecord> {
  const { seed } = opts;
  const maxMessages = opts.maxMessages ?? 40000, advEvery = opts.advanceEvery ?? 6, talkEvery = opts.talkEvery ?? 2, sampleEvery = opts.sampleEvery ?? 25;
  const user = `wf-${seed}`;
  const rnd = mulberry(seed * 7919 + 13);
  // the production clock (a fixed-epoch logical play-clock) in BOTH the in-memory and the durable run, so the only difference a comparison can see is the save and the restart
  const mk = (): Runtime => composeRuntime(opts.saveDir ? { saveStore: new FileSaveStore(opts.saveDir), seed } : { seed });
  let rt = mk();
  const bind = (): { call: Call; admin: Call } => ({
    call: (n, a) => rt.registry.resolver()("player", user).callTool(n, a) as Promise<any>,
    admin: (n, a) => rt.registry.resolver()("admin", user).callTool(n, a) as Promise<any>,
  });
  let { call, admin } = bind();
  const rec: SeasonRecord = { seed, finished: false, messages: 0, advances: 0, week: 1, stopped: "cap", eventTypes: {}, houseLifeActions: {}, eventFields: {}, stateKeysPopulated: [], stateKeysSeen: [], pendingKinds: {}, pendingRepeats: {}, faults: [], crashes: [], refused: {}, noEffect: {}, tried: {}, scenes: [], trace: [] };
  const populated = new Set<string>(), seen = new Set<string>();
  const crash = (tool: string, at: number, e: unknown): void => {
    const what = scrub(`${(e as Error)?.name ?? "Error"}: ${(e as Error)?.message ?? String(e)}`);
    const hit = rec.crashes.find((c) => c.tool === tool && c.what === what);
    if (hit) hit.count++; else rec.crashes.push({ tool, at, what, count: 1 });
  };
  /** a load-bearing call: an exception here is a finding. */
  const must = async (tool: string, args: Record<string, unknown>, at: number): Promise<any> => { try { return await call(tool, args); } catch (e) { crash(tool, at, e); return null; } };
  /** a social action: the engine may legally refuse it. */
  const social = async (tool: string, args: Record<string, unknown>): Promise<any> => {
    rec.tried[tool] = (rec.tried[tool] ?? 0) + 1;
    try {
      const r = await call(tool, args);
      if (r === null || r === undefined || typeof r.refused === "string") rec.refused[tool] = (rec.refused[tool] ?? 0) + 1;
      else if (r && typeof r === "object" && ["landed", "accepted", "disclosed", "ok", "recorded", "applied"].some((k) => r[k] === false)) rec.noEffect[tool] = (rec.noEffect[tool] ?? 0) + 1;
      return r;
    } catch { rec.refused[tool] = (rec.refused[tool] ?? 0) + 1; return null; }
  };
  /** a read: not counted as something the player tried. */
  const read = async (tool: string, args: Record<string, unknown>): Promise<any> => { try { return await call(tool, args); } catch { return null; } };

  const sess = (): any => rt.registry.sandboxFor(user).session;
  const events = (): ReadonlyArray<any> => rt.registry.sandboxFor(user).engine.events.queryAll();
  const eventHash = (e: any): string => (e ? hash(stable({ t: e.type, i: e.initiator, w: e.witnessSet, h: e.hidden, c: e.content, a: e.houseLife?.action })) : "-");

  await must("createCharacter", { playerName: "The Player", seed, archetype: "floater" }, -1);
  let msg = 0, nonce = 0, stampedUpTo = 0, week = 1, finished = false, restarted = false;
  let lastProgress = "", lastProgressAt = 0;
  let lastPendingKey = "", repeats = 0;
  const stamp: Array<{ msg: number; week: number; out: boolean }> = [];
  const factIds: string[] = [];
  let allianceId: string | undefined;

  const pass = async (tag: string): Promise<void> => { // the held night, played the way a person plays it: hang out through the day, turn in at night
    for (let k = 0; k < 60; k++) {
      const st = await must("gameStatus", {}, msg);
      const tod = st?.timeOfDay;
      if (tod === "evening" || tod === "night" || tod === "late-night") {
        const t = await must("turnIn", {}, msg);
        if (!t?.held) return;
        for (let q = 0; q < Math.max(1, Math.ceil((t.held.minutesUntil ?? 5) / 5)); q++) await must("noteMessage", { messageId: `${tag}-${k}-${q}-${nonce++}` }, msg);
      } else {
        const gs = await must("getGameState", {}, msg);
        if (gs?.daySchedule?.due) return;
        await must("hangOut", { untilBandEnd: true }, msg);
        const r = await must("advanceGame", {}, msg);
        if (r && !r.held) { await answer(r); return; }
      }
    }
    await must("turnIn", {}, msg);
  };

  const answer = async (r: any): Promise<void> => {
    const p = r?.pending as PendingDecision | null | undefined;
    if (!p) { lastPendingKey = ""; repeats = 0; return; }
    rec.pendingKinds[p.kind] = (rec.pendingKinds[p.kind] ?? 0) + 1;
    const key = `${p.kind}|${r.status?.week ?? ""}|${(p.options ?? []).map((o) => o.id).join(",")}`;
    if (key === lastPendingKey) { repeats++; rec.pendingRepeats[p.kind] = Math.max(rec.pendingRepeats[p.kind] ?? 0, repeats); } else { lastPendingKey = key; repeats = 0; }
    if ((p.kind as string) === "ceremony-step") { await must("advanceGame", {}, msg); return; }
    const veto = rnd() < 0.4 ? "always-use-veto" : "never-use-veto"; // a varied player: sometimes uses the veto
    try { await call("submitDecision", autoResolve(p, veto)); } catch (e) { crash("submitDecision", msg, e); await must("advanceGame", {}, msg); }
  };

  const talk = async (t: number): Promise<void> => {
    const wa = await read("whereabouts", {});
    const present: string[] = (wa?.present ?? []).map((x: { id: string }) => x.id).filter((id: string) => id !== "player");
    // answer an approach first: a houseguest who came to the player is spoken to (a bonding approach warmly, a probing one carefully)
    const inits = (await read("socialInitiatives", {})) as Array<{ houseguest: { id: string }; motive: string }> | null;
    if (inits?.length) { const a = inits[0]!; await social("recordInteraction", { initiator: a.houseguest.id, witnessSet: ["player", a.houseguest.id], content: a.motive === "bond" ? "they came over to talk and we got along" : "they came over to feel me out and I gave little away", kind: a.motive === "bond" ? "bonding" : "strategy" }); }
    if (present.length === 0) { await social("hangOut", { maxBeats: 2 }); return; }
    const npc = present[t % present.length]!, other = present[(t + 1) % present.length]!;
    switch (t % 16) {
      case 0: case 5: case 9: case 13: await social("recordInteraction", { initiator: "player", witnessSet: ["player", npc], content: "we talk about home and laugh for a while", kind: SCENES[t % SCENES.length] }); break;
      case 1: await social("makeDeal", { with: npc, kind: DEALS[(t >> 4) % DEALS.length], terms: "let's look after each other" }); break;
      case 2: await social("confide", { npcId: npc }); break;
      case 3: await social("recordInteraction", { initiator: "player", witnessSet: ["player", npc], content: "I tell them they are safe with me this week", kind: "alliance", assurance: { kind: "safe" } }); break;
      case 4: await social("recordInteraction", { initiator: npc, witnessSet: ["player", npc], content: "they tell me I am safe with them this week", kind: "alliance", assurance: { kind: "vote" } }); break;
      case 6: if (present.length >= 2) { const r = await social("formAlliance", { name: `Alliance ${t}`, members: [npc, other] }); allianceId = r?.id ?? r?.allianceId ?? allianceId; } break;
      case 7: if (allianceId) await social("joinAlliance", { allianceId }); break;
      case 8: await social("recordInteraction", { initiator: "player", witnessSet: ["player", npc], content: "we argue about the last vote", kind: "conflict" }); break;
      case 10: if (present.length >= 2) await social("accuseTie", { aId: npc, bId: other }); break;
      case 11: await social("callInFavor", { npcId: npc }); break;
      case 12: await social("diaryRoom", { entry: "I think I am in a decent spot this week." }); break;
      case 14: { const f = factIds[t % Math.max(1, factIds.length)]; if (f) await social("tradeSecret", { toNpcId: npc, factId: f }); else await social("tradeSecret", { toNpcId: npc, bluff: true, subject: other }); break; }
      default: { const f = factIds[0]; if (f) await social(t % 32 === 15 ? "confront" : "exposeSecret", t % 32 === 15 ? { npcId: npc, factId: f } : { factId: f }); else await social("moveTo", { room: "kitchen" }); }
    }
  };

  const sampleState = (): string => {
    const snap = sess().snapshot();
    const st = hash(stable(snap));
    const top: Record<string, unknown> = { ...snap, live: undefined };
    for (const [k, v] of Object.entries(top)) { if (v === undefined) continue; seen.add(k); if (nonEmpty(v)) populated.add(k); }
    for (const [k, v] of Object.entries(snap.live ?? {})) { seen.add(`live.${k}`); if (nonEmpty(v)) populated.add(`live.${k}`); }
    return st;
  };

  const faultsNow = async (): Promise<void> => {
    try {
      const h = (await admin("sandboxHealth", {})) as { faults?: Array<{ kind: string; detail?: string }>; circuitOpen?: boolean };
      for (const f of h.faults ?? []) {
        const detail = scrub(f.detail ?? "");
        const hit = rec.faults.find((x) => x.kind === f.kind && x.detail === detail);
        if (hit) hit.count = Math.max(hit.count, 1); else rec.faults.push({ kind: f.kind, detail, firstAt: msg, count: 1 });
      }
      if (h.circuitOpen && !rec.faults.some((x) => x.kind === "circuit-open")) rec.faults.push({ kind: "circuit-open", detail: "", firstAt: msg, count: 1 });
    } catch (e) { crash("sandboxHealth", msg, e); }
  };

  rec.stopped = "cap";
  for (; msg < maxMessages && !finished; msg++) {
    await must("noteMessage", { messageId: `m${msg}` }, msg);
    if (msg % talkEvery === 0) await talk(msg / talkEvery | 0);
    if (msg % 40 === 20) { // learn what the player knows: the facts a secret trade or confrontation can use
      const d = await read("getVisibleStateFor", { entity: "player" });
      for (const f of (d?.knowledge ?? []) as Array<{ id?: string }>) if (f.id && !factIds.includes(f.id) && factIds.length < 24) factIds.push(f.id);
    }
    if (msg % advEvery === advEvery - 1) {
      const r = await must("advanceGame", {}, msg); rec.advances++;
      if (r?.held) await pass(`h${msg}`); else await answer(r);
      if (r?.finished) finished = true;
      await faultsNow();
    }
    const gs = await must("getGameState", {}, msg);
    week = gs?.week ?? week;
    if (gs?.finished) finished = true;
    const evs = events();
    const out = !!sess().live?.evictionOrder?.includes(sess().house?.player?.id);
    while (stampedUpTo < evs.length) stamp[stampedUpTo++] = { msg, week, out };
    const row: TraceRow = { i: msg, ev: evs.length, last: eventHash(evs[evs.length - 1]) };
    if (msg % sampleEvery === 0) row.st = sampleState();
    rec.trace.push(row);
    if (opts.against) { // the ablation's early exit: the first row that differs from the baseline is where the toggled flag first changed the game
      const b = opts.against[msg];
      if (!b || b.ev !== row.ev || b.last !== row.last || (b.st !== undefined && row.st !== undefined && b.st !== row.st)) { rec.stopped = "diverged"; rec.divergedAt = msg; msg++; break; }
    }
    const prog = `${week}|${gs?.phase}|${gs?.dayNumber}|${evs.length}`;
    if (prog !== lastProgress) { lastProgress = prog; lastProgressAt = msg; } else if (msg - lastProgressAt > 3000) { rec.stopped = "stalled"; msg++; break; }
    if (opts.restartAt !== undefined && msg === opts.restartAt && !restarted && opts.saveDir) {
      restarted = true;
      rt = mk(); ({ call, admin } = bind()); // a fresh runtime over the same durable save: the game resumes from disk
    }
  }
  if (finished) rec.stopped = "finished";
  rec.finished = finished; rec.messages = msg; rec.week = week;
  const evs = events();
  for (const e of evs) {
    rec.eventTypes[e.type] = (rec.eventTypes[e.type] ?? 0) + 1;
    for (const f of Object.keys(e)) rec.eventFields[f] = (rec.eventFields[f] ?? 0) + 1;
    if (e.houseLife) {
      const a = String(e.houseLife.action);
      rec.houseLifeActions[a] = (rec.houseLifeActions[a] ?? 0) + 1;
      for (const f of Object.keys(e.houseLife)) rec.eventFields[`houseLife.${f}`] = (rec.eventFields[`houseLife.${f}`] ?? 0) + 1;
    }
  }
  evs.forEach((e, idx) => { if (!e.houseLife) return; const s = stamp[idx] ?? { msg: msg - 1, week, out: false }; rec.scenes.push({ type: e.type, action: String(e.houseLife.action), msg: s.msg, week: s.week, playerOut: s.out }); });
  rec.stateKeysPopulated = [...populated].sort(); rec.stateKeysSeen = [...seen].sort();
  return rec;
}
