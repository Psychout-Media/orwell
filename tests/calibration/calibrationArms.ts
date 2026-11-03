/**
 * Calibration ARMS — the shared play spine for the 3-arm calibration instrument (data-gathering,
 * `calibrationInstrument.test.ts`) and the PO-target gate (`calibrationPoTarget.*`). Extracted verbatim from the
 * instrument so both play EXACTLY the same passive / solid / reckless seasons over the SAME runtime composition `main.ts`
 * uses. No behavior change. Roles only — no houseguest names; reads only Vault-free public projections.
 */
import { PLAYER } from "../../src/domain/ids";

// ---- Vault-free view shapes (only the public fields the instrument reads) ----
interface NamedRef { id: string; name: string }
interface PendingView { kind: string; options: NamedRef[]; appeals?: string[] }
interface FinaleRevealView { reveals: Array<{ juror: NamedRef; votedFor: NamedRef }> }
interface AdvanceResult {
  started: boolean;
  finished: boolean;
  pending: PendingView | null;
  winner?: NamedRef | null;
  event?: { beat?: string; content?: string } | null;
  finale?: FinaleRevealView | null;
}
interface HouseCard { id: string; status: string }
interface StateView {
  week: number;
  player: { id?: string; status: "active" | "jury" | "evicted" } | null;
  house?: HouseCard[];
}
interface Mcp { callTool(name: string, args?: Record<string, unknown>): Promise<unknown> }
export type Resolver = (channel: "player" | "admin", user: string) => Mcp;

export type Status = "active" | "jury" | "evicted";

// ---- Per-season metrics --------------------------------------------------------
export interface SeasonMetrics {
  seed: number;
  arm: Arm;
  /** The PUBLIC final seat (0046): active@finish = sat in the Final 2; jury / evicted otherwise. */
  status: Status;
  /** Reached the jury (= not a pre-jury eviction). */
  reachedJury: boolean;
  /** Reached each rung — derived from the active-house size at the moment the player left (or sat F2). */
  reachedF5: boolean;
  reachedF4: boolean;
  reachedF3: boolean;
  reachedF2: boolean;
  won: boolean;
  /** PUBLIC competition wins (broadcast beats only) — the player's visible resume. */
  playerCompWins: number;
  /** The active-house size when the player left the game (null = the player sat the Final 2). */
  houseSizeWhenPlayerLeft: number | null;
  /** The week the player's game was decided — their eviction week, or the final week if they sat F2. */
  decidedWeek: number;
  /** The jury vote at the finale, when the player reached the Final 2 (else null). */
  finale: {
    /** Votes the player received. */
    playerVotes: number;
    /** Votes the NPC finalist received. */
    rivalVotes: number;
    /** Total jurors who voted. */
    jurors: number;
  } | null;
  /** The exact concern: this player BOTH reached F2 AND lost the jury vote. */
  reachedF2AndLost: boolean;
}

// ---- The two player policies (mirror juryReach / calibrationGradient exactly) ----

/** PASSIVE: first legal option everywhere; compete; veto only ever used on self. */
function passiveAnswer(p: PendingView): Record<string, unknown> {
  switch (p.kind) {
    case "nominations":
      return { kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] };
    case "veto-decision":
      return p.options.some((o) => o.id === PLAYER)
        ? { kind: "veto-decision", use: true, save: PLAYER }
        : { kind: "veto-decision", use: false };
    case "comp-intent":
      return { kind: "comp-intent", intent: "compete" };
    case "comp-round":
      return { kind: "comp-round", intent: "compete" }; // 0006 staged-rounds
    case "houseguests-choice":
      return { kind: "houseguests-choice", vote: p.options[0]!.id };
    case "replacement":
      return { kind: "replacement", replacement: p.options[0]!.id };
    case "eviction-vote":
      return { kind: "eviction-vote", vote: p.options[0]!.id };
    case "tie-break":
      return { kind: "tie-break", vote: p.options[0]!.id };
    case "final-eviction":
      return { kind: "final-eviction", vote: p.options[0]!.id };
    case "finale-statement":
      return { kind: "finale-statement", statement: "I played my own game." };
    case "finale-answer":
      return { kind: "finale-answer", appeal: p.appeals?.[0] ?? "own-game" };
    case "juror-vote":
      return { kind: "juror-vote", vote: p.options[0]!.id };
    case "goodbye-message":
      return { kind: "goodbye-message", vote: "respectful" };
    case "exit-interview": // 0130: the evicted player's exit posture rides `vote` (first legal stance).
      return { kind: "exit-interview", vote: p.options[0]?.id ?? "gracious" };
    case "spectator-choice": // 0133
      return { kind: "spectator-choice", vote: "watch" };
    case "finale-interview":
      return { kind: "finale-interview", vote: p.options[0]?.id ?? "gracious" };
    case "juror-question":
      return { kind: "juror-question", statement: "What was your biggest move?" };
    default:
      throw new Error(`unhandled pending kind: ${p.kind}`);
  }
}

/**
 * The three test players (2026-11-02, PO): PASSIVE does nothing; SOLID is a steady, sensible social game
 * (the PO's "active" targets — two tended allies it protects); RECKLESS plays loud but badly (picks a
 * fight every week, befriends someone new, then nominates that friend as HOH). RECKLESS is a sanity
 * check: bad strategy must not beat doing nothing by much. No exact target.
 */
export type Arm = "passive" | "solid" | "reckless";

/** RECKLESS weekly play: start a fight with one houseguest and cosy up to another (rotating by week). */
async function recklessWeek(mcp: Mcp, st: { friend: string | undefined }, week: number): Promise<void> {
  const gs = (await mcp.callTool("getGameState", {})) as StateView;
  const live = (gs.house ?? []).filter((h) => h.status === "active" && h.id !== PLAYER).map((h) => h.id);
  if (live.length < 2) return;
  const foe = live[week % live.length]!;
  const friend = live[(week + 1) % live.length]!;
  st.friend = friend;
  let room: string | undefined;
  try { room = ((await mcp.callTool("whereabouts", {})) as { room?: string }).room; } catch { room = undefined; }
  for (const [who, kind, content] of [[foe, "conflict", "A loud argument that gets personal."], [friend, "bonding", "A quick, friendly chat."]] as const) {
    try {
      if (room) await mcp.callTool("moveHouseguest", { id: who, room });
      await mcp.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, who], content, kind });
    } catch { /* a refused scene just skips */ }
  }
}

/** RECKLESS decisions: as HOH, nominate the newest friend (a betrayal); otherwise the passive defaults. */
function recklessAnswer(p: PendingView, st: { friend: string | undefined }): Record<string, unknown> {
  if (p.kind === "nominations" && st.friend && p.options.some((o) => o.id === st.friend)) {
    const other = p.options.find((o) => o.id !== st.friend)!;
    return { kind: "nominations", choice: [st.friend, other.id] };
  }
  return passiveAnswer(p);
}

/**
 * SOLID: the passive answers PLUS basic self-preservation — never nominate or vote out an ALLY,
 * and at the finale make the STRONGEST generic appeal available (own-game) rather than the first
 * option. The bonding scenes that build the allies are recorded out-of-band in `recordEarlyScenes`.
 */
function solidAnswer(p: PendingView, allies: ReadonlySet<string>): Record<string, unknown> {
  const notAlly = (o: NamedRef) => !allies.has(o.id) && o.id !== PLAYER;
  switch (p.kind) {
    case "nominations": {
      const targets = p.options.filter(notAlly).map((o) => o.id);
      const choice = targets.length >= 2 ? [targets[0]!, targets[1]!] : [p.options[0]!.id, p.options[1]!.id];
      return { kind: "nominations", choice };
    }
    case "eviction-vote": {
      const target = p.options.find(notAlly) ?? p.options[0]!;
      return { kind: "eviction-vote", vote: target.id };
    }
    case "tie-break": {
      const target = p.options.find(notAlly) ?? p.options[0]!;
      return { kind: "tie-break", vote: target.id };
    }
    case "final-eviction": {
      const target = p.options.find(notAlly) ?? p.options[0]!;
      return { kind: "final-eviction", vote: target.id };
    }
    case "replacement": {
      const target = p.options.find(notAlly) ?? p.options[0]!;
      return { kind: "replacement", replacement: target.id };
    }
    case "finale-answer":
      // The strategic finalist makes the best generic appeal it can (own-game leads the enum) rather
      // than blindly taking appeals[0] — a small, deterministic upgrade over the passive arm.
      return { kind: "finale-answer", appeal: p.appeals?.includes("own-game") ? "own-game" : (p.appeals?.[0] ?? "own-game") };
    default:
      return passiveAnswer(p);
  }
}

const SCENES_PER_ALLY = 3;

/** Record a small, bounded set of player-witnessed bonding/alliance scenes (0023 hidden fold). */
async function recordEarlyScenes(mcp: Mcp, allyIds: string[]): Promise<void> {
  const kinds = ["bonding", "alliance", "strategy"] as const;
  for (const ally of allyIds) {
    for (let i = 0; i < SCENES_PER_ALLY; i++) {
      await mcp.callTool("recordInteraction", {
        initiator: PLAYER,
        witnessSet: [PLAYER, ally],
        content: "A quiet conversation building trust.",
        kind: kinds[i % kinds.length],
      });
    }
  }
}

/**
 * An ACTIVE player keeps tending their relationships every week (2026-11-02): one quiet scene with
 * each still-active ally, walking the ally into the player's room first (a scene is recorded from the
 * player's room — BL-014 drops a named participant placed elsewhere). An evicted ally is replaced by
 * the next active houseguest, so the player always works two relationships. Without this, the early
 * bonds decayed and the active arm read as a floater by mid-season.
 */
async function tendAllies(mcp: Mcp, allies: Set<string>): Promise<void> {
  const st = (await mcp.callTool("getGameState", {})) as StateView;
  const live = (st.house ?? []).filter((h) => h.status === "active" && h.id !== PLAYER).map((h) => h.id);
  for (const a of [...allies]) if (!live.includes(a)) allies.delete(a);
  for (const c of live) { if (allies.size >= 2) break; allies.add(c); }
  let room: string | undefined;
  try { room = ((await mcp.callTool("whereabouts", {})) as { room?: string }).room; } catch { room = undefined; }
  for (const ally of allies) {
    try {
      if (room) await mcp.callTool("moveHouseguest", { id: ally, room });
      await mcp.callTool("recordInteraction", {
        initiator: PLAYER, witnessSet: [PLAYER, ally], content: "Checking in, keeping the bond strong.", kind: "bonding",
      });
    } catch {
      /* a refused scene (e.g. mid-ceremony) just skips this week's tending */
    }
  }
}

/** Map the active-house size when the player left to the named rung (16-cast: F2..F5 are 2..5). */
function rungFlags(houseSizeWhenPlayerLeft: number | null): Pick<
  SeasonMetrics, "reachedF5" | "reachedF4" | "reachedF3" | "reachedF2"
> {
  // The player "reached F_n" if they were still in the game when the active-house size was n, i.e.
  // they left at a size ≤ n (or sat the Final 2 ⇒ they reached every rung).
  const size = houseSizeWhenPlayerLeft ?? 2; // null = sat F2 ⇒ smallest possible
  return {
    reachedF5: size <= 5,
    reachedF4: size <= 4,
    reachedF3: size <= 3,
    reachedF2: size <= 2,
  };
}

/** Read the current public seat + active-house size. */
async function readSeat(mcp: Mcp): Promise<{ status: Status; activeHouse: number; week: number }> {
  const st = (await mcp.callTool("getGameState", {})) as StateView;
  // `house` is NPCs only; +1 for the player when the player is still active.
  const npcActive = (st.house ?? []).filter((h) => h.status === "active").length;
  const playerActive = st.player?.status === "active" ? 1 : 0;
  return { status: st.player!.status, activeHouse: npcActive + playerActive, week: st.week };
}

/** Play one full season for a seed under the given policy; collect the rich metrics. */
export async function playSeason(
  resolver: Resolver,
  seed: number,
  arm: Arm,
): Promise<SeasonMetrics> {
  const mcp = resolver("player", `instrument-${arm}-${seed}`);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed });

  let allies = new Set<string>();
  const reckless = { friend: undefined as string | undefined };
  if (arm === "solid") {
    const state0 = (await mcp.callTool("getGameState", {})) as StateView;
    const allyIds = (state0.house ?? [])
      .filter((h) => h.status === "active" && h.id !== PLAYER)
      .map((h) => h.id)
      .slice(0, 2);
    allies = new Set(allyIds);
    await recordEarlyScenes(mcp, allyIds);
  }
  const answer = (p: PendingView): Record<string, unknown> =>
    arm === "solid" ? solidAnswer(p, allies) : arm === "reckless" ? recklessAnswer(p, reckless) : passiveAnswer(p);

  let finished = false;
  let winner: NamedRef | null = null;
  let playerCompWins = 0;
  let lastFinale: FinaleRevealView | null = null;
  // The active-house size at the moment the player's seat flipped out of "active".
  let houseSizeWhenPlayerLeft: number | null = null;
  let decidedWeek = 0;
  let prevStatus: Status = "active";

  const countWin = (ev: { beat?: string; content?: string } | null | undefined): void => {
    if (ev?.content && /^The Player wins /.test(ev.content) && /competition$/.test(ev.beat ?? "")) playerCompWins++;
  };

  // After each step, watch for the player's seat flipping out of "active" and capture the rung.
  const checkSeat = async (): Promise<void> => {
    if (houseSizeWhenPlayerLeft !== null) return; // already captured the moment they left
    const seat = await readSeat(mcp);
    if (prevStatus === "active" && seat.status !== "active") {
      // They were just evicted — the active house INCLUDING them at that beat is seat.activeHouse + 1
      // (seat.activeHouse counts only those still in; the player just left). The rung the player
      // "reached" is that pre-eviction size.
      houseSizeWhenPlayerLeft = seat.activeHouse + 1;
      decidedWeek = seat.week;
    }
    prevStatus = seat.status;
  };

  let tendedWeek = 0;
  for (let i = 0; i < 5_000 && !finished; i++) {
    if (arm !== "passive" && prevStatus === "active") {
      const wk = ((await mcp.callTool("getGameState", {})) as StateView).week ?? 0;
      if (wk > tendedWeek) {
        tendedWeek = wk;
        if (arm === "solid") await tendAllies(mcp, allies);
        else await recklessWeek(mcp, reckless, wk);
      }
    }
    const adv = (await mcp.callTool("advanceGame", {})) as AdvanceResult;
    finished = adv.finished;
    winner = adv.winner ?? winner;
    countWin(adv.event);
    if (adv.finale) lastFinale = adv.finale;
    await checkSeat();
    if (adv.pending) {
      const sub = (await mcp.callTool("submitDecision", answer(adv.pending))) as AdvanceResult;
      finished = sub.finished;
      winner = sub.winner ?? winner;
      countWin(sub.event);
      if (sub.finale) lastFinale = sub.finale;
      await checkSeat();
    }
  }
  if (!finished) throw new Error(`season for seed ${seed} (${arm}) did not finish`);

  const final = await readSeat(mcp);
  const status = final.status;
  const won = winner?.id === PLAYER;
  // If the player sat the Final 2, they never "left" — record the final week as the decided week.
  if (status === "active") decidedWeek = final.week;

  // Tally the finale vote from the public reveals (juror → votedFor), if the player reached F2.
  let finale: SeasonMetrics["finale"] = null;
  if (status === "active" && lastFinale) {
    let playerVotes = 0, rivalVotes = 0;
    for (const r of lastFinale.reveals) {
      if (r.votedFor.id === PLAYER) playerVotes++; else rivalVotes++;
    }
    finale = { playerVotes, rivalVotes, jurors: lastFinale.reveals.length };
  }

  const flags = rungFlags(status === "active" ? null : houseSizeWhenPlayerLeft);
  const reachedF2 = status === "active" || flags.reachedF2;
  return {
    seed,
    arm,
    status,
    reachedJury: status !== "evicted",
    reachedF5: reachedF2 || flags.reachedF5,
    reachedF4: reachedF2 || flags.reachedF4,
    reachedF3: reachedF2 || flags.reachedF3,
    reachedF2,
    won,
    playerCompWins,
    houseSizeWhenPlayerLeft,
    decidedWeek,
    finale,
    reachedF2AndLost: reachedF2 && status === "active" && !won,
  };
}

// ---- Aggregation ---------------------------------------------------------------
export interface ArmSummary {
  arm: Arm;
  seasons: number;
  reachedJury: number;
  reachedF5: number;
  reachedF4: number;
  reachedF3: number;
  reachedF2: number;
  wins: number;
  reachedF2AndLost: number;
  /** Of the F2 appearances, how many the player won / lost. */
  f2Wins: number;
  f2Losses: number;
  /** Mean public comp wins per season; and mean among F2 appearances. */
  meanCompWins: number;
  meanCompWinsAtF2: number;
  /** Mean eviction/decision week (lower = decided earlier). */
  meanDecidedWeek: number;
  /** Mean jury-vote margin AGAINST the player in their F2 LOSSES (rivalVotes - playerVotes). */
  meanLossMargin: number | null;
}

export function summarize(arm: Arm, rows: SeasonMetrics[]): ArmSummary {
  const n = rows.length;
  const f2 = rows.filter((r) => r.reachedF2 && r.status === "active");
  const f2Wins = f2.filter((r) => r.won).length;
  const losses = f2.filter((r) => !r.won);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const lossMargins = losses
    .filter((r) => r.finale)
    .map((r) => r.finale!.rivalVotes - r.finale!.playerVotes);
  return {
    arm,
    seasons: n,
    reachedJury: rows.filter((r) => r.reachedJury).length,
    reachedF5: rows.filter((r) => r.reachedF5).length,
    reachedF4: rows.filter((r) => r.reachedF4).length,
    reachedF3: rows.filter((r) => r.reachedF3).length,
    reachedF2: rows.filter((r) => r.reachedF2).length,
    wins: rows.filter((r) => r.won).length,
    reachedF2AndLost: rows.filter((r) => r.reachedF2AndLost).length,
    f2Wins,
    f2Losses: losses.length,
    meanCompWins: n ? sum(rows.map((r) => r.playerCompWins)) / n : 0,
    meanCompWinsAtF2: f2.length ? sum(f2.map((r) => r.playerCompWins)) / f2.length : 0,
    meanDecidedWeek: n ? sum(rows.map((r) => r.decidedWeek)) / n : 0,
    meanLossMargin: lossMargins.length ? sum(lossMargins) / lossMargins.length : null,
  };
}

