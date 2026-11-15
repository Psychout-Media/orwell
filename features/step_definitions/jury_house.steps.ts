import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { Orchestrator } from "../../src/composition/orchestrator";
import type { AdvanceView, AskJurorResult, JuryHouseJurorView } from "../../src/ports/GameSession";
import type { GameEvent } from "../../src/domain/event";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { answerPending } from "../support/answerPending";

/**
 * Feature 0129 — the jury house (slices 1-4 built: the roster projection, jurors voiced from their own knowledge, the
 * `askJuror` lever, the informed `juror-vote` card). Every scenario drives the REAL registry sandbox: a seeded season is
 * played (`createCharacter` -> `advanceGame`, decisions answered by the shared faithful driver) until the player is
 * evicted onto the jury, then the jury-house surfaces are read and `askJuror` is called. Marker facts are planted into a
 * juror's OWN knowledge (`seedBelief`) so a Then can tell whose knowledge an answer came from. Roles only: player,
 * juror, finalist, active houseguest. The @pending scenarios (unbuilt slices) are skipped by the shared
 * `Before({ tags: "@pending" })` hook in per_archetype_voice.steps.ts.
 */

type Pending = NonNullable<AdvanceView["pending"]>;
interface JhState {
  jhSb?: UserSandbox;
  jhJurors?: JuryHouseJurorView[];
  /** juror id -> the event-store index at the moment that juror was first seen in the jury-house roster. */
  jhSeatedAt?: Map<EntityId, number>;
  jhTold?: AskJurorResult[];
  jhPrompt?: string;
  jhCard?: Pending;
  jhCardBefore?: Pending;
  jhEdgesBefore?: string;
  jhRuns?: [string, string];
  jhMarks?: Record<string, string>;
}
type W = BbWorld & JhState;

let seq = 0;
/** The first seed found per (mode, target) — later scenarios replay it instead of searching again. */
const seedCache = new Map<string, number>();

function newSandbox(seed: number, orchestrated: boolean): UserSandbox {
  const reg = new GameSessionRegistry();
  const user = `jh0129-${seq++}`;
  if (orchestrated) {
    // The turn-driven runtime: every committed player turn also runs one bounded off-screen tick (the house schemes,
    // confessionals are recorded) — the real path, so "after a juror's eviction" has genuine hidden life in it.
    const orch = new Orchestrator(reg, { now: () => seed }, { seed, turnDriven: true });
    reg.setCommit((u) => orch.commitPlayerTurn(u));
  }
  const sb = reg.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return sb;
}

function answer(sb: UserSandbox, p: Pending): void {
  const req = answerPending(p);
  if (req) sb.session.submitDecision(req);
}

/**
 * Play until `stop` holds (checked after each advance with no open decision). Records, for every juror, the event index
 * at which they first appeared in the jury-house roster. Returns null if the season ends first.
 */
function playUntil(seed: number, orchestrated: boolean, stop: (sb: UserSandbox, v: AdvanceView) => boolean):
  { sb: UserSandbox; seatedAt: Map<EntityId, number>; view: AdvanceView } | null {
  const sb = newSandbox(seed, orchestrated);
  const seatedAt = new Map<EntityId, number>();
  for (let i = 0; i < 9000; i++) {
    const v = sb.session.advanceGame();
    for (const j of sb.session.getGameState().juryHouse?.jurors ?? []) if (!seatedAt.has(j.id)) seatedAt.set(j.id, sb.engine.events.count());
    if (stop(sb, v)) return { sb, seatedAt, view: v };
    if (v.pending) answer(sb, v.pending);
    if (v.finished) return null;
  }
  return null;
}

function findGame(key: string, orchestrated: boolean, stop: (sb: UserSandbox, v: AdvanceView) => boolean) {
  const cached = seedCache.get(key);
  const seeds = cached !== undefined ? [cached] : Array.from({ length: 120 }, (_, i) => i + 1);
  for (const seed of seeds) {
    const got = playUntil(seed, orchestrated, stop);
    if (got) { seedCache.set(key, seed); return got; }
  }
  throw new Error(`no seed reached the jury-house state "${key}"`);
}

/** The player sits on the jury with at least `n` other jurors and no decision is open. */
const seatedWith = (n: number) => (sb: UserSandbox, v: AdvanceView): boolean => {
  const st = sb.session.getGameState();
  return st.player?.status === "jury" && (st.juryHouse?.jurors.length ?? 0) >= n && !v.pending;
};
/** The player-juror's finale vote card is open with a jury house beside it. */
const atVoteCard = (sb: UserSandbox, v: AdvanceView): boolean =>
  v.pending?.kind === "juror-vote" && (sb.session.getGameState().juryHouse?.jurors.length ?? 0) >= 1;

function seat(w: W, opts: { n?: number; orchestrated?: boolean } = {}): void {
  const n = opts.n ?? 2;
  const orchestrated = opts.orchestrated ?? false;
  const got = findGame(`seated:${n}:${orchestrated}`, orchestrated, seatedWith(n));
  w.jhSb = got.sb;
  w.jhSeatedAt = got.seatedAt;
  w.jhJurors = got.sb.session.getGameState().juryHouse!.jurors;
}

/** Set how a juror regards the player by rewriting the RECORDED eviction manner (the bearing is derived from it). */
function setManner(sb: UserSandbox, jurorId: EntityId, m: Record<string, boolean>): void {
  const core = sb.session.snapshot();
  // Replace ONLY the juror's [PLAYER] entry; the juror's recorded manner toward everyone else is jury-management history and stays.
  const prior = (core.live!.mannerByEvictee ?? {}) as Record<string, Record<string, unknown>>;
  core.live!.mannerByEvictee = { ...prior, [jurorId]: { ...(prior[jurorId] ?? {}), [PLAYER]: m } } as never;
  sb.session.restore(core);
}

/** Plant a belief in ONE holder's own knowledge (their witnessed-or-told set), never anyone else's. */
function hold(sb: UserSandbox, holder: EntityId, factId: string, content: string): void {
  sb.engine.knowledge.seedBelief(holder, { content, originalContent: content, factId, confidence: 0.9, hops: 0, distortion: 0, source: holder }, "origin");
}

/** Ask until the juror tells the fact carrying `marker` (a warm juror always tells, but picks among all they hold). */
function askUntil(w: W, jurorId: EntityId, marker: string, max = 25): AskJurorResult[] {
  const out: AskJurorResult[] = [];
  for (let i = 0; i < max; i++) {
    const r = w.jhSb!.session.askJuror(jurorId);
    assert.ok(r, "askJuror refused a seated juror");
    out.push(r);
    if (r.content?.includes(marker)) break;
  }
  return out;
}

const prompt = (w: W): string => w.jhSb!.session.getMomentPrompt({}).systemPrompt;

/** The narrator's labelled knowledge block for one juror inside the moment prompt. */
function blockOf(p: string, name: string): string {
  const at = p.indexOf(`· ${name}:`);
  assert.ok(at > -1, `the moment prompt carries no knowledge block for a juror`);
  const rest = p.slice(at + 1);
  const next = rest.search(/\n\s{4}· /);
  return next < 0 ? rest.slice(0, 4000) : rest.slice(0, next);
}

const knows = (sb: UserSandbox, who: EntityId, marker: string): boolean =>
  sb.engine.knowledge.knownTo(who).some((f) => f.content.includes(marker));

// --- Scenario: the jury is a room the player can talk to -------------------------------------------------------

Given("the player has been evicted into the jury", function (this: W) {
  seat(this, { n: 2 });
  assert.equal(this.jhSb!.session.getGameState().player?.status, "jury");
});

When("the player is in the jury house", function (this: W) {
  this.jhJurors = this.jhSb!.session.getGameState().juryHouse?.jurors;
});

Then("the other jurors are present", function (this: W) {
  const sb = this.jhSb!;
  const st = sb.session.getGameState();
  const jurors = this.jhJurors;
  assert.ok(jurors && jurors.length >= 2, "the jury house lists the other jurors");
  const live = sb.session.snapshot().live!;
  const active = new Set(st.house.filter((h) => h.status === "active").map((h) => h.id));
  const cast = st.house.some((h) => h.id === PLAYER) ? st.house.length : st.house.length + 1; // the player + every NPC
  const juryStart = Math.max(0, cast - 2 - 9); // cast − 2 finalists − 9 jurors: earlier evictees went home
  for (const j of jurors) {
    assert.notEqual(j.id, PLAYER, "the player is never listed as one of the OTHER jurors");
    assert.ok(!active.has(j.id), "a juror is never a houseguest still in the game");
    assert.ok(live.evictionOrder.indexOf(j.id) >= juryStart, "a juror is seated on the jury, not a pre-jury evictee");
    assert.ok(["warm", "even", "cool", "sour"].includes(j.bearing));
    assert.deepEqual(Object.keys(j).sort(), ["bearing", "evictedWeek", "id", "name"], "only public keys cross");
  }
  // Every evicted-onto-the-jury houseguest (other than the player) is in the room.
  const seated = live.evictionOrder.slice(juryStart).filter((id) => id !== PLAYER);
  assert.deepEqual(jurors.map((j) => j.id).sort(), [...seated].sort());
});

Then("the player can ask any juror a question", function (this: W) {
  const sb = this.jhSb!;
  for (const j of this.jhJurors!) {
    const r = sb.session.askJuror(j.id);
    assert.ok(r, "askJuror answers for every juror in the room");
    assert.equal(r.bearing, j.bearing, "the answer carries that juror's own bearing");
  }
  // ...and only jurors: an active houseguest or the player is not in the room.
  const active = sb.session.getGameState().house.find((h) => h.status === "active" && h.id !== PLAYER)!;
  assert.equal(sb.session.askJuror(active.id), null, "an active houseguest is not in the jury house");
  assert.equal(sb.session.askJuror(PLAYER), null);
});

// --- Scenario: each juror tells the season from their own perspective ------------------------------------------

Given("two jurors who were evicted at different points", function (this: W) {
  seat(this, { n: 2 });
  const order = this.jhSb!.session.snapshot().live!.evictionOrder;
  const [a, b] = this.jhJurors!;
  assert.notEqual(order.indexOf(a!.id), order.indexOf(b!.id));
});

Given("each juror holds a different belief about the same event", function (this: W) {
  const [a, b] = this.jhJurors!;
  // The SAME event (one fact id), believed two contradictory ways — each juror holds only their own version.
  hold(this.jhSb!, a!.id, "jh0129:veto-event", "MARK-VERSION-ONE the veto was kept to protect an ally");
  hold(this.jhSb!, b!.id, "jh0129:veto-event", "MARK-VERSION-TWO the veto was kept because the holder was scared");
  setManner(this.jhSb!, a!.id, { blindsided: true });
  setManner(this.jhSb!, b!.id, { respected: true });
});

When("each recounts the season", function (this: W) {
  this.jhPrompt = prompt(this);
  this.jhJurors = this.jhSb!.session.getGameState().juryHouse!.jurors;
});

Then("each account is bounded to what that juror actually witnessed or was told", function (this: W) {
  const [a, b] = this.jhJurors!;
  const blockA = blockOf(this.jhPrompt!, a!.name);
  const blockB = blockOf(this.jhPrompt!, b!.name);
  assert.ok(blockA.includes("MARK-VERSION-ONE") && !blockA.includes("MARK-VERSION-TWO"), "juror A voices only their own version");
  assert.ok(blockB.includes("MARK-VERSION-TWO") && !blockB.includes("MARK-VERSION-ONE"), "juror B voices only their own version");
  // Every line in a juror's block traces to something that juror holds (no cross-juror or live-house bleed).
  for (const j of [a!, b!]) {
    assert.ok(!knows(this.jhSb!, j.id, j === a ? "MARK-VERSION-TWO" : "MARK-VERSION-ONE"), "neither juror was told the other's version");
  }
});

Then("their bearing toward the player reflects the manner of their eviction", function (this: W) {
  const [a, b] = this.jhJurors!;
  assert.equal(a!.bearing, "sour", "a juror the player blindsided regards them sourly");
  assert.equal(b!.bearing, "warm", "a juror the player treated with respect regards them warmly");
});

Then("the two jurors hold contradictory beliefs about the same event", function (this: W) {
  const [a, b] = this.jhJurors!;
  const factOf = (id: EntityId) => this.jhSb!.engine.knowledge.knownTo(id).find((f) => f.factId === "jh0129:veto-event");
  const fa = factOf(a!.id), fb = factOf(b!.id);
  assert.ok(fa && fb, "both jurors hold a belief about the event");
  assert.notEqual(fa.content, fb.content, "their beliefs about the one event differ");
});

// --- Scenario: the player can ask a juror questions and get grounded answers -----------------------------------

Given("the player is in the jury house with a juror who regards them warmly", function (this: W) {
  seat(this, { n: 2 });
  const [a, b] = this.jhJurors!;
  setManner(this.jhSb!, a!.id, { respected: true });
  hold(this.jhSb!, a!.id, "jh0129:own", "MARK-OWN the juror saw the HOH room rearranged");
  hold(this.jhSb!, b!.id, "jh0129:other", "MARK-OTHER-JUROR a private read only the second juror holds");
  const active = this.jhSb!.session.getGameState().house.find((h) => h.status === "active" && h.id !== PLAYER)!;
  hold(this.jhSb!, active.id, "jh0129:live", "MARK-LIVE-PRIVATE a plan only an active houseguest holds");
  this.jhSb!.engine.vault.writeHidden({ id: "jh0129:v", kind: "confessional", content: "SENTINEL-0129-ASK" });
});

When("the player asks that juror a question", function (this: W) {
  this.jhTold = askUntil(this, this.jhJurors![0]!.id, "MARK-OWN");
});

Then("the answer is something that juror holds, told to the player through that juror", function (this: W) {
  const a = this.jhJurors![0]!;
  const told = this.jhTold!.find((r) => r.content?.includes("MARK-OWN"));
  assert.ok(told, "the warm juror told the player what they hold");
  assert.equal(told.told, true);
  assert.equal(told.bearing, "warm");
  const learned = this.jhSb!.engine.knowledge.knownTo(PLAYER).find((f) => f.content.includes("MARK-OWN"));
  assert.equal(learned?.pathway, `told-by:${a.id}`, "it reached the player through that juror, a traceable pathway");
  // The telling is a player-witnessed scene with that juror (not hidden, not secret).
  const scene = this.jhSb!.engine.events.queryAll().filter((e) => e.witnessSet.includes(PLAYER) && e.witnessSet.includes(a.id) && e.content.includes("jury house"));
  assert.ok(scene.length > 0 && scene.every((e) => !e.hidden), "the telling is recorded as a player-witnessed scene");
});

Then("it never draws on another juror's private knowledge or any hidden house state", function (this: W) {
  const a = this.jhJurors![0]!;
  for (let i = 0; i < 6; i++) this.jhTold!.push(this.jhSb!.session.askJuror(a.id)!);
  const blob = JSON.stringify([this.jhTold, this.jhSb!.engine.knowledge.knownTo(PLAYER), this.jhSb!.session.getGameState()]);
  for (const banned of ["MARK-OTHER-JUROR", "MARK-LIVE-PRIVATE", "SENTINEL-0129-ASK"]) {
    assert.ok(!blob.includes(banned), `${banned} reached the player through the jury house`);
  }
});

// --- Scenario: a juror never knows the live house's hidden scheming --------------------------------------------

Given("the house schemes off-screen and records confessionals after a juror's eviction", function (this: W) {
  // The orchestrated runtime: off-screen ticks run between the player's turns, recording hidden scenes + confessionals.
  seat(this, { n: 2, orchestrated: true });
  const sb = this.jhSb!;
  // Let the still-playing house live on a while after the jurors were seated.
  for (let i = 0; i < 12; i++) {
    const v = sb.session.advanceGame();
    if (v.pending) answer(sb, v.pending);
    if (v.finished) break;
  }
  this.jhJurors = sb.session.getGameState().juryHouse!.jurors;
  const juror = this.jhJurors[0]!;
  const since = this.jhSeatedAt!.get(juror.id)!;
  const after = sb.engine.events.queryAll().slice(since).filter((e) => !e.witnessSet.includes(juror.id));
  assert.ok(after.some((e) => e.hidden), "precondition: the house produced hidden scenes after the juror's eviction");
  // Plus an explicit hidden scheme, a confessional, and a Vault record, all after the eviction and without the juror.
  const t = sb.engine.events.count();
  const live = sb.session.getGameState().house.filter((h) => h.status === "active" && h.id !== PLAYER).map((h) => h.id);
  const scheme: GameEvent = { id: "jh0129:scheme", ts: t + 1, type: "conversation", initiator: live[0]!, witnessSet: live.slice(0, 2), hidden: true, content: "SENTINEL-0129-SCHEME a quiet plan to flip the vote" };
  const conf: GameEvent = { id: "jh0129:conf", ts: t + 2, type: "confessional", initiator: live[0]!, witnessSet: [live[0]!], hidden: true, content: "SENTINEL-0129-CONFESSIONAL I am lying to everyone" };
  sb.engine.events.record(scheme);
  sb.engine.events.record(conf);
  sb.engine.vault.writeHidden({ id: "jh0129:vault", kind: "confessional", content: "SENTINEL-0129-VAULT" });
  // A sealed ballot attribution in the juror's hidden layer (the engine-seeded vote deduction; E12 / 0048).
  sb.engine.knowledge.seedBelief(juror.id, { content: "SENTINEL-0129-BALLOT believes a named houseguest voted them out", factId: `traitors-fury:blame:${juror.id}:p`, source: juror.id, hops: 0, distortion: 0, confidence: 1 } as never, `jury-house:blame:${juror.id}`);
  setManner(sb, juror.id, { respected: true }); // warm: they tell whatever they legitimately hold
});

When("that juror's shareable knowledge is derived", function (this: W) {
  const juror = this.jhJurors![0]!;
  this.jhPrompt = prompt(this);
  this.jhTold = [];
  for (let i = 0; i < 30; i++) { const r = this.jhSb!.session.askJuror(juror.id); if (r) this.jhTold.push(r); }
});

Then("it contains no off-screen scene and no confessional recorded after their eviction", function (this: W) {
  const sb = this.jhSb!;
  const juror = this.jhJurors![0]!;
  const since = this.jhSeatedAt!.get(juror.id)!;
  const unseen = sb.engine.events.queryAll().slice(since)
    .filter((e) => (e.hidden || e.type === "confessional") && !e.witnessSet.includes(juror.id) && e.content.length >= 16);
  assert.ok(unseen.length > 0 && unseen.some((e) => e.type === "confessional"), "precondition: hidden scenes and confessionals happened");
  const block = blockOf(this.jhPrompt!, juror.name);
  const held = sb.engine.knowledge.knownTo(juror.id).map((f) => f.content);
  const tellings = JSON.stringify(this.jhTold);
  for (const e of unseen) {
    assert.ok(!block.includes(e.content), "a post-eviction hidden scene rode the juror's voice");
    assert.ok(!held.includes(e.content), "a post-eviction hidden scene reached the juror's knowledge");
    assert.ok(!tellings.includes(e.content), "a post-eviction hidden scene was told to the player");
  }
  for (const s of ["SENTINEL-0129-SCHEME", "SENTINEL-0129-CONFESSIONAL"]) {
    assert.ok(!block.includes(s) && !tellings.includes(s), `${s} reached the jury house`);
  }
});

Then("no Vault sentinel value appears anywhere in the jury-house projection", function (this: W) {
  const blob = JSON.stringify([this.jhSb!.session.getGameState(), this.jhPrompt, this.jhTold, this.jhSb!.engine.knowledge.knownTo(PLAYER)]);
  assert.ok(!blob.includes("SENTINEL-0129-VAULT"), "a Vault sentinel reached the jury house");
});

Then("no sealed ballot attribution appears in the juror's voice or in what they tell the player", function (this: W) {
  const juror = this.jhJurors![0]!;
  assert.ok(knows(this.jhSb!, juror.id, "SENTINEL-0129-BALLOT"), "precondition: the juror holds the sealed attribution");
  assert.ok(!blockOf(this.jhPrompt!, juror.name).includes("SENTINEL-0129-BALLOT"), "the sealed ballot rode the juror's voice");
  assert.ok(!JSON.stringify(this.jhTold).includes("SENTINEL-0129-BALLOT"), "the juror told the player a sealed ballot");
  assert.ok(!knows(this.jhSb!, PLAYER, "SENTINEL-0129-BALLOT"), "the sealed ballot reached the player's knowledge");
});

// --- Scenario: the deliberation informs the player's finale vote -----------------------------------------------

Given("the player has spent the jury phase talking with the other jurors", function (this: W) {
  const got = findGame("vote-card", false, atVoteCard);
  this.jhSb = got.sb;
  this.jhCardBefore = got.view.pending!;
  assert.equal(this.jhCardBefore.jurorBrief, undefined, "precondition: nothing told yet, so the card carries no brief");
  const juror = got.sb.session.getGameState().juryHouse!.jurors[0]!;
  const finalist = this.jhCardBefore.options[0]!;
  setManner(got.sb, juror.id, { respected: true });
  hold(got.sb, juror.id, "jh0129:about-finalist", `MARK-ABOUT-FINALIST ${finalist.name} kept their word to the jury`);
  this.jhJurors = [juror];
  this.jhTold = askUntil(this, juror.id, "MARK-ABOUT-FINALIST");
  assert.ok(this.jhTold.some((r) => r.content?.includes("MARK-ABOUT-FINALIST")), "precondition: the juror told the player");
  // Held by the juror but never told (planted after the talk): the control the card must not carry.
  hold(got.sb, juror.id, "jh0129:untold", `MARK-UNTOLD ${finalist.name} did something the juror never says`);
});

When("the finale arrives", function (this: W) {
  this.jhCard = this.jhSb!.session.advanceGame().pending!;
});

Then("the player carries what a juror told them into the finale juror vote", function (this: W) {
  const c = this.jhCard!;
  assert.equal(c.kind, "juror-vote");
  const finalist = c.options[0]!;
  const row = c.jurorBrief?.find((b) => b.finalist.id === finalist.id);
  assert.ok(row, "the vote card carries a brief for the finalist the juror spoke about");
  assert.ok(row.heard.join(" ").includes("MARK-ABOUT-FINALIST"), "the brief holds what the juror told");
  const blob = JSON.stringify(c);
  assert.ok(!blob.includes("MARK-UNTOLD"), "something the juror merely holds never rides the card");
  for (const banned of ["lean", "trust", "threat", "affinity", "bearing"]) assert.ok(!blob.includes(banned), `the card carries "${banned}"`);
});

Then("the finale vote mechanic is unchanged from feature 0037", function (this: W) {
  const { jurorBrief: _b1, ...after } = this.jhCard! as Pending & { jurorBrief?: unknown };
  const { jurorBrief: _b0, ...before } = this.jhCardBefore! as Pending & { jurorBrief?: unknown };
  assert.deepEqual(after, before, "apart from the brief, the juror-vote card is the same validated seam");
  const finalTwo = new Set(this.jhSb!.session.getGameState().house.filter((h) => h.status === "active").map((h) => h.id));
  assert.deepEqual(new Set(after.options.map((o) => o.id)), finalTwo, "the vote is still between the two finalists");
  const res = this.jhSb!.session.submitDecision({ kind: "juror-vote", vote: after.options[0]!.id });
  assert.ok(res, "the player's vote is accepted through the same seam");
  assert.notEqual(this.jhSb!.session.advanceGame().pending?.kind, "juror-vote", "the vote was recorded and the finale moved on");
});

// --- Scenario: the jury house never leaks back into the still-playing house ------------------------------------

Given("the player talks with the jurors about the finalists", function (this: W) {
  seat(this, { n: 2 });
  const sb = this.jhSb!;
  this.jhEdgesBefore = JSON.stringify(sb.engine.relationships.serialize().edges);
  for (const [i, j] of this.jhJurors!.entries()) {
    setManner(sb, j.id, { respected: true });
    hold(sb, j.id, `jh0129:leak:${i}`, `MARK-JURYTALK-${i} what this juror thinks of the finalists`);
    askUntil(this, j.id, `MARK-JURYTALK-${i}`);
  }
  assert.ok(knows(sb, PLAYER, "MARK-JURYTALK-0"), "precondition: the player heard jury-house talk");
  assert.equal(JSON.stringify(sb.engine.relationships.serialize().edges), this.jhEdgesBefore, "a jury-house telling moves no relationship edge");
});

When("an active houseguest still in the game acts", function (this: W) {
  const sb = this.jhSb!;
  for (let i = 0; i < 8; i++) {
    const v = sb.session.advanceGame();
    if (v.pending) answer(sb, v.pending);
    if (v.finished) break;
  }
});

Then("nothing the player or jurors said in the jury house reaches that active houseguest", function (this: W) {
  const sb = this.jhSb!;
  const active = sb.session.getGameState().house.filter((h) => h.status === "active" && h.id !== PLAYER).map((h) => h.id);
  assert.ok(active.length > 0, "precondition: houseguests are still playing");
  for (const id of active) {
    for (let i = 0; i < this.jhJurors!.length; i++) assert.ok(!knows(sb, id, `MARK-JURYTALK-${i}`), "jury-house talk reached an active houseguest");
  }
  // The jury-house scenes the player had are witnessed by the player and jurors only.
  const jurySet = new Set([PLAYER, ...this.jhJurors!.map((j) => j.id)]);
  const scenes = sb.engine.events.queryAll().filter((e) => e.content.includes("in the jury house") && e.witnessSet.includes(PLAYER));
  assert.ok(scenes.length > 0, "precondition: jury-house scenes were recorded");
  for (const e of scenes) assert.ok(e.witnessSet.every((w) => jurySet.has(w)), "an active houseguest witnessed a jury-house scene");
});

// --- Scenario: the jury-house experience touches no seeded outcome ---------------------------------------------

Given("the jury-house experience with no optional roundtable vote-nudging enabled", function (this: W) {
  assert.equal(process.env.ORWELL_JURY_ROUNDTABLE, undefined, "no roundtable flag is set (none is built)");
});

When("a seeded season is played to its finale with and without the player using the jury house", function (this: W) {
  // A seed whose player really lands on the jury (found here, so the scenario never depends on another one's cache).
  findGame("seated:2:false", false, seatedWith(2));
  const seed = seedCache.get("seated:2:false")!;
  const run = (useJury: boolean): string => {
    const sb = newSandbox(seed, false);
    let asked = 0;
    for (let i = 0; i < 9000; i++) {
      if (useJury) {
        for (const j of sb.session.getGameState().juryHouse?.jurors ?? []) { if (sb.session.askJuror(j.id)) asked++; }
      }
      const v = sb.session.advanceGame();
      if (v.pending) answer(sb, v.pending);
      if (v.finished) break;
    }
    const l = sb.session.snapshot().live!;
    assert.ok(l.winner, "the season reached its finale");
    if (useJury) assert.ok(asked > 0, "precondition: the player really used the jury house");
    return JSON.stringify({ order: l.evictionOrder, finalTwo: l.finalTwo, jury: l.jury, winner: l.winner });
  };
  this.jhRuns = [run(true), run(false)];
});

Then("the eviction order, the finalists, and the jury result are byte-identical", function (this: W) {
  assert.equal(this.jhRuns![0], this.jhRuns![1]);
});

// --- @pending placeholders (the scenarios are skipped by the shared @pending Before hook; these never run) ------

When("a juror has fresh news or a pick to lobby for", function () { return "pending"; });
Then("that juror approaches the player unprompted", function () { return "pending"; });
Given("the player is a juror and another houseguest is then evicted", function () { return "pending"; });
When("the new evictee joins the jury house", function () { return "pending"; });
Then("the jury-house picture updates with the new arrival's fresh read and the shared broadcast", function () { return "pending"; });
