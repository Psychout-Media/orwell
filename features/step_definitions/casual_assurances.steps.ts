import { Given, When, Then, Before, After } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import type { SessionSnapshot } from "../../src/engine/sessionSnapshot";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { ASSURANCE, type Assurance } from "../../src/engine/assurances";
import { claimsOf, type BeliefStore } from "../../src/engine/beliefStore";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import type { AdvanceView } from "../../src/ports/GameSession";
import { newLiveGame, advanceUntil, cloneSnapshot, resumeFrom, edgeIn, searchSeeds, type LiveGame } from "../support/liveEvictionNight";

// Theme 2 slice 5b: vote talk (default on) adds told claims at every eviction, and the HOH's tie-break (which differs between the branch and the control here) would draw different ones, so the exact deal-broken memory deltas below would no longer isolate the assurance break. This feature pins THAT mechanism, so it runs with vote talk off.
let __voteTalk0143: string | undefined;
Before({ tags: "@no-vote-talk" }, function () { __voteTalk0143 = process.env.ORWELL_VOTE_TALK; process.env.ORWELL_VOTE_TALK = "0"; });
After({ tags: "@no-vote-talk" }, function () { if (__voteTalk0143 === undefined) delete process.env.ORWELL_VOTE_TALK; else process.env.ORWELL_VOTE_TALK = __voteTalk0143; });

// Feature 0143 - Casual assurances ("you're safe with me"), B4 + ORW-15. Roles only.
// Recording goes through the player MCP boundary (McpServer.callTool). The nomination / ballot / tie-break / lapse scenarios play a
// REAL seeded game through the live adapter, park it just before the act, and play that ONE engine snapshot twice: a control
// as it is, and a branch with one assurance recorded. Every Then compares the branch against the control, so it asserts only
// what the assurance caused.

type AsrInput = { from: EntityId; to: EntityId; kind: "safe" | "vote" | "loyal"; sincerity: number; source: "player" | "npc"; heardBy?: EntityId[] };
type Mem = { kind: string; severity: number };
type LiveX = { assurances?: { seq: number; items: Assurance[] }; beliefs?: BeliefStore; npcMemory?: Record<string, Record<string, Mem[]>>; nominees?: EntityId[]; hoh?: EntityId; week: number; evictionOrder: EntityId[]; eviction?: { voteOf: Record<string, EntityId>; nominees: EntityId[] } };
type HasLive = { live?: unknown };
const liveOf = (snap: HasLive): LiveX => snap.live as unknown as LiveX;
const sev = (snap: SessionSnapshot, holder: EntityId, about: EntityId, kind: string): number =>
  (liveOf(snap).npcMemory?.[holder]?.[about] ?? []).filter((m) => m.kind === kind).reduce((n, m) => n + m.severity, 0);
const assurancesIn = (snap: HasLive): Assurance[] => liveOf(snap).assurances?.items ?? [];
const liedClaims = (snap: SessionSnapshot, holder: EntityId): string[] =>
  claimsOf(liveOf(snap).beliefs, holder).filter((c) => c.kind === "lied-to-me").map((c) => JSON.stringify(c)).sort();
const EPS = 1e-9;

interface Played { game: LiveGame; snap: SessionSnapshot }
interface Contest {
  holder: EntityId;
  assured: EntityId;
  witness?: EntityId;
  pool?: EntityId[];
  control: Played;
  branch: Played;
}
interface Ctx {
  sb?: UserSandbox;
  npc?: EntityId;
  contest?: Contest;
  lapse?: { game: LiveGame; oldId: string; freshId: string; week: number };
}
const state = new WeakMap<object, Ctx>();
const st = (w: BbWorld): Ctx => { let c = state.get(w); if (!c) { c = {}; state.set(w, c); } return c; };

/** Resume `snap` in a fresh registry, apply `mutate` to the live session, and play until `stop`. */
function play(snap: SessionSnapshot, stop: (v: AdvanceView, g: LiveGame) => boolean, mutate?: (g: LiveGame) => void): Played | null {
  const g = resumeFrom(snap, 0, "asr");
  mutate?.(g);
  return advanceUntil(g, (v) => stop(v, g)) ? { game: g, snap: cloneSnapshot(g) } : null;
}
const record = (a: AsrInput) => (g: LiveGame): void => { g.session.recordAssurance(a); };
const atBeat = (beat: string) => (v: AdvanceView): boolean => v.event?.beat === beat;
// State-based, not view-based: when the player votes, the count happens inside submitDecision, so no advanceGame view ever
// shows the "votes" stage. The staged eviction exists from the count until the result commits.
const ballotCounted = (g: LiveGame): boolean => !!(g.session.snapshot().live as unknown as { eviction?: unknown } | undefined)?.eviction;
const atVotes = (_v: AdvanceView, g: LiveGame): boolean => ballotCounted(g);

/** Walk seeds and weeks to an NPC HOH parked just before nominations; offer (parked, control) to `pick`. */
function findNominations(what: string, pick: (parked: SessionSnapshot, control: Played, hoh: EntityId) => Omit<Contest, "control"> | undefined): Contest {
  return searchSeeds(what, 60, (seed) => {
    const g = newLiveGame(seed, "asr-nom");
    for (let week = 0; week < 4; week++) {
      const parkedAtNoms = (view: AdvanceView): boolean => {
        if (view.pending) return false;
        const live = g.session.snapshot().live;
        return live?.beat === "nominations" && !!live.hoh && live.hoh !== PLAYER;
      };
      if (!advanceUntil(g, parkedAtNoms)) return undefined;
      const parked = cloneSnapshot(g);
      const control = play(parked, atBeat("nominations"));
      if (control) {
        const found = pick(parked, control, parked.live!.hoh as EntityId);
        if (found) return { ...found, control };
      }
      if (!advanceUntil(g, atBeat("eviction-result"))) return undefined;
    }
    return undefined;
  });
}

/** Walk seeds to a staged eviction parked just BEFORE the ballots are counted; offer (parked, control at the counted votes) to `pick`. */
function findBallot(what: string, max: number, pick: (parked: SessionSnapshot, control: Played) => Omit<Contest, "control"> | undefined, parkAt: "before-count" | "counted" = "before-count"): Contest {
  return searchSeeds(what, max, (seed) => {
    const g = newLiveGame(seed, "asr-vote");
    for (let night = 0; night < 12; night++) {
      const beforeCount = (view: AdvanceView): boolean => {
        const live = g.session.snapshot().live as unknown as { beat?: string; finalNominees?: EntityId[]; eviction?: unknown } | undefined;
        void view;
        return parkAt === "before-count" ? (live?.beat === "eviction" && !!live.finalNominees && !live.eviction) : !!live?.eviction;
      };
      if (!advanceUntil(g, beforeCount)) return undefined;
      const parked = cloneSnapshot(g);
      const control = parkAt === "before-count" ? play(parked, atVotes) : play(parked, atBeat("eviction"));
      if (control) {
        const found = pick(parked, control);
        if (found) return { ...found, control };
      }
      if (!advanceUntil(g, atBeat("eviction-result"))) return undefined;
    }
    return undefined;
  });
}

// --- A promise made in a scene is recorded -----------------------------------------------------------------------------

Given("the assurances flag is on and a scene in which the player tells a houseguest \"you're safe with me\"", function (this: BbWorld) {
  const sb = new GameSessionRegistry().sandboxFor(`asr-rec-fixed`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  sb.session.setAssurancesEnabled(true);
  const npc = sb.session.livingIds().find((id) => id !== PLAYER)! as EntityId;
  (sb.session as unknown as { presence: Map<string, string> }).presence = new Map([[PLAYER, "kitchen"], [npc, "kitchen"]]); // seated together: a grounded scene
  assert.deepEqual(assurancesIn(sb.session.snapshot()), [], "no assurance before the scene");
  const c = st(this); c.sb = sb; c.npc = npc;
});

When("the scene is recorded with that assurance", async function (this: BbWorld) {
  const c = st(this);
  await c.sb!.mcp.player.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, c.npc!], content: "I tell them they are safe with me", kind: "alliance", assurance: { kind: "safe" } });
});

Then("an open assurance exists from the promiser to the assured", function (this: BbWorld) {
  const c = st(this);
  const got = assurancesIn(c.sb!.session.snapshot());
  assert.equal(got.length, 1, JSON.stringify(got));
  assert.equal(got[0]!.from, PLAYER);
  assert.equal(got[0]!.to, c.npc);
  assert.equal(got[0]!.kind, "safe");
  assert.equal(got[0]!.status, "open");
});

// --- Nominations: kept protects, broken costs --------------------------------------------------------------------------

Given("an NPC HOH who has given a \"safe\" assurance to a houseguest and means to keep it, about to nominate them", function (this: BbWorld) {
  st(this).contest = findNominations("an NPC HOH who would nominate a houseguest they mean to keep safe", (parked, control, hoh) => {
    for (const assured of (liveOf(control.snap).nominees ?? []).filter((n) => n !== PLAYER)) {
      const a: AsrInput = { from: hoh, to: assured, kind: "safe", sincerity: 1, source: "npc" };
      const probe = resumeFrom(parked, 0, "asr-probe");
      probe.session.recordAssurance(a);
      if (!probe.session.assuranceProtects(assured, hoh)) continue; // the HOH's own cost-benefit would break it: not this case
      const branch = play(parked, atBeat("nominations"), record(a));
      if (branch) return { holder: hoh, assured, branch };
    }
    return undefined;
  });
});

When("nominations are decided", function (this: BbWorld) {
  const c = st(this).contest!;
  assert.ok(liveOf(c.control.snap).nominees?.includes(c.assured), "(control) without the assurance the HOH nominates them");
});

Then("the assured houseguest is not nominated", function (this: BbWorld) {
  const c = st(this).contest!;
  const noms = liveOf(c.branch.snap).nominees ?? [];
  assert.equal(noms.length, 2);
  assert.ok(!noms.includes(c.assured), `the assured stays off the block (nominees ${noms.join(", ")})`);
});

Given("an NPC HOH who has given an open \"safe\" assurance to a houseguest and will not keep it, about to nominate them", function (this: BbWorld) {
  st(this).contest = findNominations("an NPC HOH who nominates a houseguest they assured anyway", (parked, control, hoh) => {
    for (const assured of (liveOf(control.snap).nominees ?? []).filter((n) => n !== PLAYER)) {
      // a room for the trust drop to show: the assured's control trust in the HOH must exceed the drop
      if (edgeIn(control.snap, assured, hoh).trust <= ASSURANCE.brokenTrustDrop) continue;
      const a: AsrInput = { from: hoh, to: assured, kind: "safe", sincerity: 1, source: "npc" };
      const probe = resumeFrom(parked, 0, "asr-probe");
      probe.session.recordAssurance(a);
      if (probe.session.assuranceProtects(assured, hoh)) continue; // they would keep it: not this case
      const branch = play(parked, atBeat("nominations"), record(a));
      if (branch && liveOf(branch.snap).nominees?.includes(assured)) return { holder: hoh, assured, branch };
    }
    return undefined;
  });
});

When("the HOH nominates that houseguest", function (this: BbWorld) {
  const c = st(this).contest!;
  assert.ok(liveOf(c.branch.snap).nominees?.includes(c.assured), "the HOH put the assured houseguest on the block");
});

Then("the assurance resolves broken once", function (this: BbWorld) {
  const c = st(this).contest!;
  const mine = assurancesIn(c.branch.snap).filter((a) => a.from === c.holder && a.to === c.assured);
  assert.deepEqual(mine.map((a) => a.status), ["broken"]);
});

Then("the assured remembers it and trusts the HOH less", function (this: BbWorld) {
  const c = st(this).contest!;
  const memDelta = sev(c.branch.snap, c.assured, c.holder, "deal-broken") - sev(c.control.snap, c.assured, c.holder, "deal-broken");
  assert.ok(Math.abs(memDelta - ASSURANCE.brokenMemorySeverity) < EPS, `the assured remembers the break, once (memory +${memDelta})`);
  const drop = edgeIn(c.control.snap, c.assured, c.holder).trust - edgeIn(c.branch.snap, c.assured, c.holder).trust;
  assert.ok(Math.abs(drop - ASSURANCE.brokenTrustDrop) < EPS, `trust in the HOH fell by the break, once (drop ${drop})`);
});

Then("no assurance or number is shown to the player", function (this: BbWorld) {
  const c = st(this).contest!;
  const branchView = JSON.stringify(c.branch.game.session.getGameState());
  assert.ok(!/assurance/i.test(branchView), "the player's state view carries no assurance ledger");
  assert.equal(branchView, JSON.stringify(c.control.game.session.getGameState()), "the player's view is identical with or without the hidden assurance");
});

// --- Sealed ballot ------------------------------------------------------------------------------------------------------

Given("a houseguest holds an open \"vote\" assurance toward a nominee they are about to vote out, with a witness who heard it", function (this: BbWorld) {
  st(this).contest = findBallot("a staged eviction where an NPC voter sends out an NPC nominee among >= 3 voters", 60, (parked, control) => {
    const e = liveOf(control.snap).eviction!;
    const voters = Object.keys(e.voteOf) as EntityId[];
    if (voters.length < 3) return undefined;
    for (const assured of e.nominees.filter((n) => n !== PLAYER)) {
      for (const holder of voters.filter((v) => v !== PLAYER && e.voteOf[v] === assured)) {
        const witness = voters.find((v) => v !== holder && v !== PLAYER);
        if (!witness) continue;
        const a: AsrInput = { from: holder, to: assured, kind: "vote", sincerity: 1, source: "npc", heardBy: [witness] };
        const branch = play(parked, atVotes, record(a));
        if (branch && liveOf(branch.snap).eviction?.voteOf[holder] === assured) {
          return { holder, assured, witness, pool: voters.filter((v) => v !== assured).sort(), branch };
        }
      }
    }
    return undefined;
  });
});

When("the houseguest votes that nominee out on a secret ballot", function (this: BbWorld) {
  const c = st(this).contest!;
  assert.equal(liveOf(c.branch.snap).eviction!.voteOf[c.holder], c.assured);
});

Then("the assurance resolves broken in the engine", function (this: BbWorld) {
  const c = st(this).contest!;
  const mine = assurancesIn(c.branch.snap).filter((a) => a.from === c.holder && a.to === c.assured);
  assert.deepEqual(mine.map((a) => a.status), ["broken"]);
});

Then("nothing the assured or a witness holds names the voter", function (this: BbWorld) {
  const c = st(this).contest!;
  assert.deepEqual(liedClaims(c.branch.snap, c.assured), liedClaims(c.control.snap, c.assured), "no new lied-to-me claim for the assured");
  assert.equal(sev(c.branch.snap, c.witness!, c.holder, "deal-broken"), sev(c.control.snap, c.witness!, c.holder, "deal-broken"), "the witness learns nothing about the ballot");
});

Then("the memory and trust cost is shared equally across every possible voter", function (this: BbWorld) {
  const c = st(this).contest!;
  const pool = c.pool!;
  const share = ASSURANCE.brokenMemorySeverity / pool.length;
  for (const s of pool) {
    const d = sev(c.branch.snap, c.assured, s, "deal-broken") - sev(c.control.snap, c.assured, s, "deal-broken");
    assert.ok(Math.abs(d - share) < EPS, `voter ${s === c.holder ? "(the real one)" : s} carries the same memory share (${d} vs ${share})`);
    const before = edgeIn(c.control.snap, c.assured, s).trust;
    const drop = before - edgeIn(c.branch.snap, c.assured, s).trust;
    const expected = Math.min(before, ASSURANCE.brokenTrustDrop / pool.length);
    assert.ok(Math.abs(drop - expected) < EPS, `voter ${s} takes the same trust share (${drop} vs ${expected})`);
  }
});

// --- HOH tie-break ------------------------------------------------------------------------------------------------------

Given("an eviction vote is tied and the HOH, who holds an open \"safe\" assurance toward a nominee, is about to break it against them", function (this: BbWorld) {
  st(this).contest = findBallot("a tied staged eviction broken by an NPC HOH against an NPC nominee", 80, (parked, control) => {
    const live = liveOf(parked);
    const e = live.eviction!;
    const hoh = live.hoh;
    if (!hoh || hoh === PLAYER) return undefined;
    const tally = e.nominees.map((n) => Object.values(e.voteOf).filter((t) => t === n).length);
    if (tally[0] !== tally[1]) return undefined;
    const prog = e as { stage?: string; evictee?: string };
    if (prog.stage !== "votes" || prog.evictee !== undefined) return undefined; // ORW-1088: parked BEFORE the tie is broken (an assurance recorded after the break cannot be broken by it)
    const evictee = liveOf(control.snap).evictionOrder.at(-1);
    // ORW-1088: the evictee must be one of THIS ceremony's nominees (a control that played on into a later week once named the HOH themself, and the step then had the HOH assure themself).
    if (!evictee || evictee === PLAYER || !e.nominees.includes(evictee) || evictee === hoh) return undefined;
    const a: AsrInput = { from: hoh, to: evictee, kind: "safe", sincerity: 1, source: "npc" };
    const branch = play(parked, atBeat("eviction"), record(a));
    if (!branch || liveOf(branch.snap).evictionOrder.at(-1) !== evictee) return undefined;
    return { holder: hoh, assured: evictee, pool: Object.keys(e.voteOf) as EntityId[], branch };
  }, "counted");
});

When("the break is recorded", function (this: BbWorld) {
  const c = st(this).contest!;
  assert.deepEqual(assurancesIn(c.branch.snap).filter((a) => a.from === c.holder && a.to === c.assured).map((a) => a.status), ["broken"], "the HOH's tie-break broke the assurance");
});

Then("the HOH is named as the breaker, because that act is public", function (this: BbWorld) {
  const c = st(this).contest!;
  const d = (who: EntityId) => sev(c.branch.snap, c.assured, who, "deal-broken") - sev(c.control.snap, c.assured, who, "deal-broken");
  assert.ok(Math.abs(d(c.holder) - ASSURANCE.brokenMemorySeverity) < EPS, `the full break is remembered against the HOH (${d(c.holder)})`);
  for (const v of c.pool!.filter((x) => x !== c.holder)) assert.ok(Math.abs(d(v)) < EPS, `voter ${v} takes no share of a public break`);
  const named = claimsOf(liveOf(c.branch.snap).beliefs, c.assured).some((cl) => cl.kind === "lied-to-me" && cl.subject === c.holder);
  const namedBefore = claimsOf(liveOf(c.control.snap).beliefs, c.assured).some((cl) => cl.kind === "lied-to-me" && cl.subject === c.holder);
  assert.ok(named && !namedBefore, "the assured now holds a lied-to-me claim naming the HOH");
});

// --- Lapse --------------------------------------------------------------------------------------------------------------

Given("an open assurance older than the horizon and a fresh one", function (this: BbWorld) {
  const g = newLiveGame(3, "asr-lapse");
  // mid-week, after nominations, so no ceremony this week resolves the 'loyal' assurances we add between two houseguests off the block
  assert.ok(advanceUntil(g, (v) => atVotes(v, g)), "reached an eviction ballot");
  const live = (g.session as unknown as { live: LiveX }).live;
  const free = g.session.livingIds().filter((id) => id !== PLAYER && id !== live.hoh && !live.eviction!.nominees.includes(id)) as EntityId[];
  const [from, to1, to2] = free;
  g.session.recordAssurance({ from: from!, to: to1!, kind: "loyal", sincerity: 1, source: "npc" });
  g.session.recordAssurance({ from: from!, to: to2!, kind: "loyal", sincerity: 1, source: "npc" });
  const items = live.assurances!.items;
  const old = items.at(-2)!, fresh = items.at(-1)!;
  old.week = live.week - ASSURANCE.horizonWeeks; // past the horizon once the week rolls
  assert.equal(old.status, "open"); assert.equal(fresh.status, "open");
  st(this).lapse = { game: g, oldId: old.id, freshId: fresh.id, week: live.week };
});

When("the week advances", function (this: BbWorld) {
  const l = st(this).lapse!;
  assert.ok(advanceUntil(l.game, () => (l.game.session as unknown as { live: LiveX }).live.week > l.week), "the week rolled");
});

Then("the old one is marked lapsed and no longer binds, and the fresh one stays open", function (this: BbWorld) {
  const l = st(this).lapse!;
  const items = assurancesIn(l.game.session.snapshot());
  assert.equal(items.find((a) => a.id === l.oldId)?.status, "lapsed", "past the horizon: lapsed, never deleted");
  assert.equal(items.find((a) => a.id === l.freshId)?.status, "open", "within the horizon: still open");
  const from = items.find((a) => a.id === l.oldId)!.from;
  assert.ok(!l.game.session.assuranceProtects(items.find((a) => a.id === l.oldId)!.to, from), "a lapsed assurance protects nobody");
});
