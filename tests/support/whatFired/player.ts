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
  /** ORW-852: the sandbox name. It is part of the game's identity (with the seed it keys the player-action and off-screen streams), so a real-path test pins it; default `wf-<seed>`. */
  user?: string;
  maxMessages?: number;
  advanceEvery?: number;
  talkEvery?: number;
  sampleEvery?: number;
  /** restart the runtime (a new process's worth of state, loaded from the durable save) after this message index; needs `saveDir`. */
  restartAt?: number;
  /** a durable save folder (FileSaveStore); when absent the run is in-memory. */
  saveDir?: string;
  /** ORW-741: called once right after the character is created, with the live session: the flag-off runs switch a feature off here through the session's own setter (the same switch the env var sets). */
  setup?: (sess: any) => void;
  /** ORW-813: the player's own choice on a pending decision (e.g. how they vote): return a submitDecision request, or undefined to let the script decide as usual. Read-only on the session. */
  decide?: (pending: any, sess: any) => Record<string, unknown> | undefined;
  /**
   * ORW-778: play to STAY in the game (the survival script below). Off by default: the real-path tests under tests/realpath and tests/uat read states the plain script reaches (a chosen seed's moment), and a player who
   * lasts longer plays a different season. The nightly what-fired report, the whole-season mix guard and the survival tests turn it on.
   */
  survive?: boolean;
  /** ORW-810: called once with the live session BEFORE the character is created: the place for a switch read at createCharacter (the premiere entrances). */
  beforeCreate?: (sess: any) => void;
  /** ORW-741: called once when the season ends (finished, capped or watched), with the live session: the place to read a post-season view, or flip a read-only feature and read it again. */
  after?: (ctx: { sess: any; engine: any; call: Call }) => void | Promise<void>;
  /** ORW-741: called after every message with the live session (engine-side, in-process) and the player-channel caller; returning true ends the season early. The real-path tests use it to stop at the first moment the feature under test has fired: nothing is hand-set, the season is played. */
  watch?: (ctx: { sess: any; engine: any; call: Call; msg: number }) => boolean | Promise<boolean>;
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
  stopped: "finished" | "cap" | "stalled" | "diverged" | "watched";
  /** ORW-777: when the run stopped as "stalled", the stage it was stuck at (week, phase, day, pending kind and why: the advance refused, or no day change). Counts and kinds only. */
  stalledAt?: string;
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
  /** the game week the player left the game (evicted), when they did: a season where the player goes early exercises the late game only as a spectator */
  playerOutWeek?: number;
  /** ORW-741: generic footprints of what the season reached (counts), derived from the saved state and the post-season views, not from a list of features: see `milestonesOf`. */
  milestones: Record<string, number>;
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
// Canonical form: object keys sorted, so a state that was saved and loaded (keys re-inserted in file order) compares equal to the same state that never was (ORW-730).
const stable = (v: unknown): string => JSON.stringify(v, (k, x) => (MASKED.has(k) ? undefined : x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

const mulberry = (a: number) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const nonEmpty = (v: unknown): boolean => v !== null && v !== undefined && v !== false && v !== 0 && v !== "" && !(Array.isArray(v) && v.length === 0) && !(typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** Scrub an error head so a report never carries a name or an id: ids become npc:N, two capitalised words become <name>. */
export function scrub(s: string): string {
  return s.replace(/npc:\d+/g, "npc:N").replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, "<name>").replace(/\d{3,}/g, "N").slice(0, 80);
}

/**
 * ORW-741: the milestone footprints, all DERIVED (no list of feature names): (1) every saved-state key under `live` that is a list or a map: its size, `state.<key>`; (2) every `kind` / `shape` / `action` string
 * in the post-season views (the story, the edit's moments, the reunion): `view.<head>.<field>:<value>`, one count per occurrence; (3) the pathway family of every fact the player holds
 * (`pathway.<word before the first colon or dash>`). Counts and kinds only: no name, no content and no id is ever copied.
 */
export function milestonesOf(live: Record<string, unknown>, retro: unknown, knowledge: ReadonlyArray<{ pathway?: unknown }>): Record<string, number> {
  const out: Record<string, number> = {};
  const bump = (k: string, n = 1): void => { out[k] = (out[k] ?? 0) + n; };
  for (const [k, v] of Object.entries(live)) {
    if (Array.isArray(v) && v.length) bump(`state.${k}`, v.length);
    else if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length) bump(`state.${k}`, Object.keys(v as object).length);
  }
  const FIELDS = new Set(["kind", "shape", "action"]);
  const walk = (v: unknown, head: string, depth: number): void => {
    if (depth > 6 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) { for (const x of v) walk(x, head, depth + 1); return; }
    for (const [f, x] of Object.entries(v as Record<string, unknown>)) {
      if (FIELDS.has(f) && typeof x === "string" && /^[a-z][a-z0-9-]{0,30}$/.test(x)) bump(`view.${head}.${f}:${x}`);
      else walk(x, head, depth + 1);
    }
  };
  if (retro && typeof retro === "object") for (const [h, v] of Object.entries(retro as Record<string, unknown>)) walk(v, h, 0);
  for (const f of knowledge) { const w = typeof f.pathway === "string" ? /^[a-z]+/.exec(f.pathway)?.[0] : undefined; if (w) bump(`pathway.${w}`); }
  return out;
}

/** ORW-777: how many advances in a row the engine may refuse, and how many messages the game may sit on one (week, phase, day, pending) stage, before the season is called stalled. */
export const STALL_REFUSED_ADVANCES = 40;
export const STALL_SAME_STAGE_MESSAGES = 3000;
/**
 * ORW-777: the season's progress watchdog. It watches the STAGE (week, phase, day, pending kind), never the event count: a stuck game keeps recording talk, so a counter that moves with every message (the old
 * test) never fires. It also fires fast when the engine refuses the advance again and again (a refused turn never moves the game). `note` returns the named stage when the season is stalled, else null.
 */
export class StallWatch {
  private stage = ""; private since = 0; private refused = 0;
  note(msg: number, s: { week?: number; phase?: string; day?: number; pending?: string | null }, advance: "ok" | "refused" | "none"): string | null {
    const stage = `week ${s.week ?? "?"}, phase ${s.phase ?? "?"}, day ${s.day ?? "?"}, pending ${s.pending ?? "none"}`;
    if (stage !== this.stage) { this.stage = stage; this.since = msg; }
    if (advance === "refused") this.refused++; else if (advance === "ok") this.refused = 0;
    if (this.refused >= STALL_REFUSED_ADVANCES) return `${stage}: the engine refused the last ${this.refused} advances`;
    if (msg - this.since > STALL_SAME_STAGE_MESSAGES) return `${stage}: no change of stage for ${msg - this.since} messages`;
    return null;
  }
}

const SCENES = ["bonding", "strategy", "gossip", "conflict", "alliance"] as const;
const DEALS = ["safety", "final-two", "vote"] as const;
/** ORW-1099: every deal kind a player can ask for (the nine single promises and the two-part package). The surviving player asks each once a season, from the hostile weeks on, so the nightly report can say whether each one works. */
export const ALL_DEAL_KINDS = ["safety", "vote", "final-two", "target-other", "comp-throw", "veto-save", "protect-third", "conditional", "information", "package"] as const;
/** ORW-1099: how many times a kind is tried before the player gives up on it for the season (a deal can be illegal at the moment it is asked: no vote to give, the same deal already live). */
const DEAL_TRIES = 3;
/** ORW-778: the game week from which the scripted player plays its hostile and risky moves (fights, accusations, exposing, confronting, and making deals: a houseguest may take a deal with a plan to break it, and the first scripted seasons showed a player with many deals flipped on by most of the house). Before it the player is a pleasant floater building a base. */
export const HOSTILE_FROM_WEEK = 9;

export async function playSeason(opts: PlayOpts): Promise<SeasonRecord> {
  const { seed } = opts;
  const maxMessages = opts.maxMessages ?? 40000, advEvery = opts.advanceEvery ?? 6, talkEvery = opts.talkEvery ?? 2, sampleEvery = opts.sampleEvery ?? 25;
  const user = opts.user ?? `wf-${seed}`;
  const rnd = mulberry(seed * 7919 + 13);
  // the production clock (a fixed-epoch logical play-clock) in BOTH the in-memory and the durable run, so the only difference a comparison can see is the save and the restart
  const mk = (): Runtime => composeRuntime(opts.saveDir ? { saveStore: new FileSaveStore(opts.saveDir), seed } : { seed });
  let rt = mk();
  const bind = (): { call: Call; admin: Call } => ({
    call: (n, a) => rt.registry.resolver()("player", user).callTool(n, a) as Promise<any>,
    admin: (n, a) => rt.registry.resolver()("admin", user).callTool(n, a) as Promise<any>,
  });
  let { call, admin } = bind();
  const rec: SeasonRecord = { seed, finished: false, messages: 0, advances: 0, week: 1, stopped: "cap", eventTypes: {}, houseLifeActions: {}, eventFields: {}, stateKeysPopulated: [], stateKeysSeen: [], pendingKinds: {}, pendingRepeats: {}, faults: [], crashes: [], refused: {}, noEffect: {}, tried: {}, scenes: [], milestones: {}, trace: [] };
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

  opts.beforeCreate?.(sess());
  await must("createCharacter", { playerName: "The Player", seed, archetype: "floater" }, -1);
  opts.setup?.(sess());
  let msg = 0, nonce = 0, stampedUpTo = 0, week = 1, finished = false, restarted = false;
  const stallWatch = new StallWatch();
  let advanceOutcome: "ok" | "refused" | "none" = "none";
  let lastPendingKey = "", repeats = 0;
  const stamp: Array<{ msg: number; week: number; out: boolean }> = [];
  const factIds: string[] = [];
  /** ORW-1099 (surviving player only): the facts the player really holds about a houseguest (never a Diary Room note, which the engine refuses to wield), for the secret levers. */
  const facts: Array<{ id: string; subject: string }> = [];
  const spentFacts = new Set<string>(); const tradedTo = new Set<string>();
  const dealTries = new Map<string, number>(); const dealMade = new Set<string>();
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
    const veto = p.kind === "veto-decision" || rnd() < 0.4 ? "always-use-veto" : "never-use-veto"; // a player on the block (or holding the veto) uses it // a varied player: sometimes uses the veto
    try { await call("submitDecision", opts.decide?.(p, sess()) ?? survivalChoice(p) ?? autoResolve(p, veto)); } catch (e) { crash("submitDecision", msg, e); await must("advanceGame", {}, msg); }
  };

  /** ORW-778: the houseguests the player stands with (any alliance they are in), refreshed whenever the player reads the board. */
  let allies = new Set<string>();
  const joinTried = new Set<string>(); // a pitch is answered once
  const dealtWith = new Set<string>(); // anyone the player holds a deal with: a vote against them breaks it, so the vote goes elsewhere
  const notAllies = (opts: ReadonlyArray<{ id: string }>): string[] => { const free = opts.filter((o) => !allies.has(o.id) && !dealtWith.has(o.id)).map((o) => o.id); return free.length ? free : opts.map((o) => o.id); };
  /**
   * ORW-778: a player who wants to stay answers the board the way a person does: a nomination goes on someone outside the player's alliances, a vote goes against someone outside them, and a player on the block
   * uses the veto on THEMSELF (the old script saved whoever was listed first, which was often the other nominee). Null leaves every other decision to the shared harness.
   */
  const survivalChoice = (p: PendingDecision): Record<string, unknown> | null => {
    if (opts.survive !== true) return null;
    const choices = (p.options ?? []) as Array<{ id: string }>;
    if (p.kind === "veto-decision" && choices.some((o) => o.id === "player")) return { kind: "veto-decision", use: true, save: "player" };
    if (p.kind === "nominations" && choices.length >= 2) { const pick = notAllies(choices).slice(0, 2); if (pick.length === 2) return { kind: "nominations", choice: pick }; }
    if ((p.kind === "eviction-vote" || p.kind === "tie-break") && choices.length >= 1) return { kind: p.kind, vote: notAllies(choices)[0] };
    if (p.kind === "replacement" && choices.length >= 1) return { kind: "replacement", replacement: notAllies(choices)[0] };
    return null;
  };
  /**
   * ORW-778: the play-to-stay moves, all through the player channel a person has: take the offers made to them (a deal, an alliance pitch), make the case to the sitting HOH in the short window before nominations
   * (a private word, a strategy talk, a safety deal), and when on the block lobby the veto holder, then the HOH, then the voters (a vote deal, a favour called in). Returns true when it used the turn.
   */
  const survive = async (t: number, present: readonly string[]): Promise<boolean> => {
    const st = await read("gameStatus", {});
    if (!st) return false;
    const mine = new Set<string>();
    for (const a of (st.alliances ?? []) as Array<{ members?: Array<{ id: string }> }>) for (const m of a.members ?? []) if (m.id !== "player") mine.add(m.id);
    allies = mine;
    if (st.openDealOffer) await social("submitDecision", { kind: "deal-offer", vote: "accept" });
    for (const a of (st.alliancePitches ?? []) as Array<{ id: string }>) if (!joinTried.has(a.id)) { joinTried.add(a.id); await social("joinAlliance", { allianceId: a.id }); break; }
    const hoh: string | undefined = st.hoh?.id, noms: string[] = (st.nominees ?? []).map((n: { id: string }) => n.id), vetoHolder: string | undefined = st.veto?.holder?.id ?? (typeof st.veto?.holder === "string" ? st.veto.holder : undefined);
    const lobby = async (npcId: string, deal: (typeof DEALS)[number] | null): Promise<void> => {
      if (!present.includes(npcId)) await social("askToTalkAlone", { npcId });
      await social("recordInteraction", { initiator: "player", witnessSet: ["player", npcId], content: "I make my case for staying and ask what they need from me", kind: "strategy" });
      if (deal && week >= HOSTILE_FROM_WEEK) { const d = await social("makeDeal", { with: npcId, kind: deal, terms: "keep me off the block" }); if (d && !d.refused) dealtWith.add(npcId); }
    };
    if (hoh && hoh !== "player" && noms.length === 0) { await lobby(hoh, t % 3 === 0 ? "safety" : null); return true; } // the window before nominations is short: every talk goes to the HOH
    if (noms.includes("player")) {
      const voters = present.filter((id) => id !== "player" && !noms.includes(id) && id !== hoh);
      const target = t % 4 === 0 && vetoHolder && vetoHolder !== "player" ? vetoHolder : t % 4 === 1 && hoh && hoh !== "player" ? hoh : voters[t % Math.max(1, voters.length)];
      if (!target) return false;
      await lobby(target, "vote");
      if (t % 3 === 2) await social("callInFavor", { npcId: target });
      return true;
    }
    // off the block but not safe: the veto holder may name a replacement and the HOH decides who is next, so every other talk keeps the sitting power on side
    const power = [vetoHolder, hoh].filter((id): id is string => !!id && id !== "player" && !noms.includes(id));
    if (hoh !== "player" && power.length && t % 2 === 0) { await lobby(power[(t >> 1) % power.length]!, t % 6 === 0 ? "safety" : null); return true; }
    return false;
  };

  /** ORW-1099: a held fact whose subject is still in the house, for each secret lever (the surviving player only). */
  const outNow = (): Set<string> => new Set<string>((sess().live?.evictionOrder ?? []) as string[]);
  const usable = (): Array<{ id: string; subject: string }> => { const out = outNow(); return facts.filter((x) => !out.has(x.subject)); };
  /** a trade needs a secret about a third party the recipient has not been given yet */
  const tradeFact = (recipient: string): string | undefined => usable().find((x) => x.subject !== recipient && !spentFacts.has(x.id) && !tradedTo.has(`${x.id}|${recipient}`))?.id;
  /** the NPC confronted is the subject of the fact when the player holds one about them, else any fact still about someone in the house */
  const confrontFact = (npc: string): string | undefined => { const u = usable(); return (u.find((x) => x.subject === npc) ?? u[0])?.id; };
  const exposeFact = (): string | undefined => usable().find((x) => !spentFacts.has(x.id))?.id;
  /** ORW-1099: ask the next deal kind not yet made this season (each kind is tried up to DEAL_TRIES times). True when the turn was used. */
  const askNextDealKind = async (npc: string, other: string): Promise<boolean> => {
    // the kind tried least so far goes next, so a kind the houseguests keep refusing cannot starve the others of turns
    const kind = ALL_DEAL_KINDS.filter((k) => !dealMade.has(k) && (dealTries.get(k) ?? 0) < DEAL_TRIES && !(k === "protect-third" && other === npc)).sort((a, b) => (dealTries.get(a) ?? 0) - (dealTries.get(b) ?? 0))[0];
    if (!kind) return false;
    dealTries.set(kind, (dealTries.get(kind) ?? 0) + 1);
    const req: Record<string, unknown> = { with: npc, kind, terms: "let's look after each other" };
    if (kind === "protect-third") req["third"] = other;
    if (kind === "comp-throw" || kind === "veto-save") req["direction"] = "ask";
    if (kind === "package") req["parts"] = [{ kind: "safety" }, { kind: "information" }];
    rec.tried[`deal:${kind}`] = (rec.tried[`deal:${kind}`] ?? 0) + 1;
    const d = await social("makeDeal", req);
    if (d && !d.refused) { dealtWith.add(npc); dealMade.add(kind); } else rec.refused[`deal:${kind}`] = (rec.refused[`deal:${kind}`] ?? 0) + 1;
    return true;
  };

  const talk = async (t: number): Promise<void> => {
    const wa = await read("whereabouts", {});
    const present: string[] = (wa?.present ?? []).map((x: { id: string }) => x.id).filter((id: string) => id !== "player");
    // answer an approach first: a houseguest who came to the player is spoken to (a bonding approach warmly, a probing one carefully)
    const inits = (await read("socialInitiatives", {})) as Array<{ houseguest: { id: string }; motive: string }> | null;
    if (inits?.length) { const a = inits[0]!; await social("recordInteraction", { initiator: a.houseguest.id, witnessSet: ["player", a.houseguest.id], content: a.motive === "bond" ? "they came over to talk and we got along" : "they came over to feel me out and I gave little away", kind: a.motive === "bond" ? "bonding" : "strategy" }); }
    // ORW-1117: the surviving player takes a one-hour daytime nap now and then, so the nap lever (flag ORWELL_NAP) is reached and the nightly ablation can measure it (the lever refuses by itself outside its window)
    if (opts.survive === true && t % 24 === 11 && ["morning", "afternoon"].includes(sess().live?.timeOfDay)) { const n = await social("nap", { hours: 1 }); if (n?.ok === true) return; }
    if (present.length === 0) { await social("hangOut", { maxBeats: 2 }); return; }
    if (opts.survive === true && await survive(t, present)) return;
    const npc = present[t % present.length]!, other = present[(t + 1) % present.length]!;
    // ORW-778: the hostile moves (a fight, an accusation, a secret used against someone, a confrontation) make enemies and raise the player's threat, so a player who means to last keeps them for the late game
    const hostile = opts.survive !== true || week >= HOSTILE_FROM_WEEK;
    switch (t % 16) {
      case 0: case 5: case 9: case 13: await social("recordInteraction", { initiator: "player", witnessSet: ["player", npc], content: "we talk about home and laugh for a while", kind: SCENES[t % SCENES.length] }); break;
      case 1: if (!hostile) await social("recordInteraction", { initiator: "player", witnessSet: ["player", npc], content: "we get to know each other over a long talk", kind: "bonding" }); else if (opts.survive === true && await askNextDealKind(npc, other)) break; else { const d = await social("makeDeal", { with: npc, kind: DEALS[(t >> 4) % DEALS.length], terms: "let's look after each other" }); if (d && !d.refused) dealtWith.add(npc); } break;
      case 2: await social("confide", { npcId: npc }); break;
      case 3: await social("recordInteraction", { initiator: "player", witnessSet: ["player", npc], content: "I tell them they are safe with me this week", kind: "alliance", assurance: { kind: "safe" } }); break;
      case 4: await social("recordInteraction", { initiator: npc, witnessSet: ["player", npc], content: "they tell me I am safe with them this week", kind: "alliance", assurance: { kind: "vote" } }); break;
      case 6: if (present.length >= 2) { const r = await social("formAlliance", { name: `Alliance ${t}`, members: [npc, other] }); allianceId = r?.id ?? r?.allianceId ?? allianceId; } break;
      case 7: if (allianceId) await social("joinAlliance", { allianceId }); break;
      case 8: if (hostile && t % 64 === 8) await social("recordInteraction", { initiator: "player", witnessSet: ["player", npc], content: "we argue about the last vote", kind: "conflict" }); else await social("recordInteraction", { initiator: "player", witnessSet: ["player", npc], content: "we plan the week together", kind: "strategy" }); break;
      case 10: if (hostile && present.length >= 2 && t % 48 === 10) await social("accuseTie", { aId: npc, bId: other }); break;
      case 11: await social("callInFavor", { npcId: npc }); break;
      case 12: await social("diaryRoom", { entry: "I think I am in a decent spot this week." }); break;
      case 14: { const f = opts.survive === true ? tradeFact(npc) : factIds[t % Math.max(1, factIds.length)]; if (!hostile) await social("recordInteraction", { initiator: "player", witnessSet: ["player", npc], content: "we trade stories and laugh", kind: "bonding" }); else if (f) { const r = await social("tradeSecret", { toNpcId: npc, factId: f }); if (opts.survive === true && r && !r.refused) tradedTo.add(`${f}|${npc}`); } else await social("tradeSecret", { toNpcId: npc, bluff: true, subject: other }); break; }
      default: {
        const confronting = t % 32 === 15;
        const f = opts.survive === true ? (confronting ? confrontFact(npc) : exposeFact()) : factIds[0];
        if (!hostile) await social("recordInteraction", { initiator: "player", witnessSet: ["player", npc], content: "we sit together and talk about the week", kind: "bonding" });
        else if (f) { const r = await social(confronting ? "confront" : "exposeSecret", confronting ? { npcId: npc, factId: f } : { factId: f }); if (opts.survive === true && !confronting && r && r.exposed === true) spentFacts.add(f); }
        else await social("moveTo", { room: "kitchen" });
      }
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
    if (opts.saveDir && msg % 10 === 0) await new Promise<void>((r) => setImmediate(r)); // the durable store syncs in the background: let it, or its files pile up in a loop that never yields
    if (msg % talkEvery === 0) await talk(msg / talkEvery | 0);
    if (msg % 40 === 20) { // learn what the player knows: the facts a secret trade or confrontation can use
      const d = await read("getVisibleStateFor", { entity: "player" });
      for (const f of (d?.knowledge ?? []) as Array<{ id?: string; pathway?: string; subject?: string }>) {
        if (f.id && !factIds.includes(f.id) && factIds.length < 24) factIds.push(f.id);
        if (opts.survive === true && f.id && f.pathway !== "diary-room" && f.subject && f.subject !== "player" && !facts.some((x) => x.id === f.id) && facts.length < 40) facts.push({ id: f.id, subject: f.subject });
      }
    }
    if (msg % advEvery === advEvery - 1) {
      const r = await must("advanceGame", {}, msg); rec.advances++;
      advanceOutcome = r === null ? "refused" : "ok";
      if (r?.held) await pass(`h${msg}`); else await answer(r);
      if (r?.finished) finished = true;
      await faultsNow();
    }
    const gs = await must("getGameState", {}, msg);
    week = gs?.week ?? week;
    if (gs?.finished) finished = true;
    const evs = events();
    const out = !!sess().live?.evictionOrder?.includes(sess().house?.player?.id);
    if (out && rec.playerOutWeek === undefined) rec.playerOutWeek = week;
    while (stampedUpTo < evs.length) stamp[stampedUpTo++] = { msg, week, out };
    const row: TraceRow = { i: msg, ev: evs.length, last: eventHash(evs[evs.length - 1]) };
    if (msg % sampleEvery === 0) row.st = sampleState();
    rec.trace.push(row);
    if (opts.against) { // the ablation's early exit: the first row that differs from the baseline is where the toggled flag first changed the game
      const b = opts.against[msg];
      if (!b || b.ev !== row.ev || b.last !== row.last || (b.st !== undefined && row.st !== undefined && b.st !== row.st)) { rec.stopped = "diverged"; rec.divergedAt = msg; msg++; break; }
    }
    if (opts.watch && (await opts.watch({ sess: sess(), engine: rt.registry.sandboxFor(user).engine, call, msg }))) { rec.stopped = "watched"; msg++; break; }
    const stalled = stallWatch.note(msg, { week, phase: gs?.phase, day: gs?.dayNumber, pending: gs?.pending?.kind ?? null }, advanceOutcome);
    advanceOutcome = "none";
    if (stalled) { rec.stopped = "stalled"; rec.stalledAt = stalled; msg++; break; }
    if (opts.restartAt !== undefined && msg === opts.restartAt && !restarted && opts.saveDir) {
      restarted = true;
      rt = mk(); ({ call, admin } = bind()); // a fresh runtime over the same durable save: the game resumes from disk
    }
  }
  if (finished) rec.stopped = "finished";
  rec.milestones = milestonesOf(sess().snapshot()?.live ?? {}, finished ? await read("seasonRetrospective", {}) : null, rt.registry.sandboxFor(user).engine.knowledge.knownTo("player" as never));
  await opts.after?.({ sess: sess(), engine: rt.registry.sandboxFor(user).engine, call });
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
