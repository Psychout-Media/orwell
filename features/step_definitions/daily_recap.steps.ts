import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { AdvanceView, DailyRecapView } from "../../src/ports/GameSession";
import { resolvePending } from "../support/answerPending";

/**
 * Feature 0102 - the daily recap + its cliffhanger hook (the redesigned "day in review", fired at the player's own bedtime,
 * `turnIn`). Drives the REAL adapter through the per-user registry sandbox (its own events, knowledge, Vault, and the player and
 * admin MCP servers). The time-of-day clock is switched on per scenario (restored by features/support/resetStaticOverrides.ts).
 * Roles only: the player, a houseguest (teller / partner / bystander), the HOH, the nominees.
 */

type Bag = {
  sb?: UserSandbox;
  s?: GameSessionAdapter;
  recap?: DailyRecapView;
  dump?: string;
  surfaced?: string;
  unsurfaced?: string;
  diary?: string;
  sentinels?: string[];
  partner?: string;
  before?: string;
  firstRead?: DailyRecapView | null;
  dayOneFact?: string;
};
const bag = (w: unknown): Bag => ((w as { recap0102?: Bag }).recap0102 ??= {});
// TEST-ONLY seams (as in tests/unit/dailyRecapPerspective.test.ts): the live season, the deal ledger, and the adapter's own
// name/tidy helpers (used only to compare against what the recap prints, never to build the recap).
const live = (s: GameSessionAdapter) => (s as unknown as { live: Record<string, unknown> }).live;
const deals = (s: GameSessionAdapter) => (s as unknown as { deals: { make: (...a: unknown[]) => unknown; forParty(id: string): Array<{ status: string }> } }).deals;
const nameOf = (s: GameSessionAdapter, id: string) => (s as unknown as { nameOf(id: string): string }).nameOf(id);
const tidy = (s: GameSessionAdapter, t: string) => (s as unknown as { humanizeTidy(t: string): string }).humanizeTidy(t);
let n = 0;

/** A started season on a fresh, isolated sandbox with the in-game clock running. */
function start(w: unknown, seed: number): { sb: UserSandbox; s: GameSessionAdapter } {
  GameSessionAdapter.setTimeOfDayEnabled(true);
  const sb = new GameSessionRegistry().sandboxFor(`recap0102-${n++}`);
  const s = sb.session;
  s.createCharacter({ playerName: "The Player", seed });
  bag(w).sb = sb; bag(w).s = s;
  return { sb, s };
}

/** Play `beats` live beats, answering every decision legally. */
function play(s: GameSessionAdapter, beats: number): void {
  for (let i = 0; i < beats; i++) {
    const v: AdvanceView = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    if (v.finished) return;
  }
}

/** A rumor that reaches the player through a real pathway: a houseguest holds it, then tells the player. */
function tellPlayer(sb: UserSandbox, teller: string, content: string): void {
  sb.engine.knowledge.seedBelief(teller, { content, factId: `gossip:${content}` }, "witnessed");
  const fact = sb.engine.knowledge.surfaceInformationTo(PLAYER, { content }, `told-by:${teller}`);
  assert.ok(fact, "the rumor did not reach the player through the pathway");
}

const npcs = (s: GameSessionAdapter) => s.livingIds().filter((id) => id !== PLAYER);
const playerSees = (r: DailyRecapView) => JSON.stringify({ h: r.highlights, s: r.surfaced, y: r.yourDay ?? [], hook: r.hook?.framing ?? "" });

// ---- Scenario: the recap retells the day the player actually lived ----

Given("the in-game clock is running and the player has witnessed events today", function () {
  const { sb, s } = start(this, 1);
  play(s, 3);
  const seen = sb.engine.events.queryAll().filter((e) => !e.hidden && e.witnessSet.includes(PLAYER) && e.id.startsWith("season:"));
  assert.ok(seen.length > 0, "the player witnessed no ceremony beat today");
});

When("the player turns in for the night", function () {
  const b = bag(this);
  const v = b.s!.turnIn();
  assert.ok(v.dailyRecap, "the bedtime carried no daily recap");
  b.recap = v.dailyRecap;
});

Then("the result carries a daily recap for the day that just closed, built from witnessed highlights and already-surfaced gossip", function () {
  const b = bag(this); const s = b.s!; const r = b.recap!;
  assert.equal(r.day, 1, "the recap is not for the day that just closed");
  assert.ok(r.highlights.length > 0, "the recap carries no highlight of the day the player lived");
  const witnessed = b.sb!.engine.events.queryAll().filter((e) => !e.hidden && e.witnessSet.includes(PLAYER));
  for (const h of r.highlights) assert.ok(witnessed.some((e) => e.content === h), `a highlight the player never witnessed: ${h}`);
  for (const y of r.yourDay ?? []) assert.ok(witnessed.some((e) => e.content.trim().slice(0, 200) === y), `a "your day" line the player never witnessed: ${y}`);
  const told = new Set(b.sb!.engine.knowledge.knownTo(PLAYER).filter((f) => f.pathway !== "diary-room").map((f) => tidy(s, f.content)));
  for (const g of r.surfaced) assert.ok(told.has(g), `a gossip line that never reached the player: ${g}`);
});

// ---- Scenario: an un-surfaced rumor and the Diary Room never enter the recap ----

Given("one rumor has reached the player through a pathway and another is still diffusing in the hidden layer", function () {
  const b = bag(this); const { sb, s } = start(this, 2);
  const [teller, bystander] = npcs(s);
  b.surfaced = "a rumor a houseguest actually told the player";
  b.unsurfaced = "a rumor still diffusing off-screen between houseguests";
  tellPlayer(sb, teller!, b.surfaced);
  sb.engine.knowledge.seedBelief(bystander!, { content: b.unsurfaced, factId: "gossip:never-surfaced" }, "witnessed"); // never surfaced to the player
});

Given("the player has written a Diary Room entry", async function () {
  const b = bag(this);
  b.diary = "a private confession the player made only to the cameras";
  await b.sb!.mcp.player.callTool("diaryRoom", { entry: b.diary }); // the player's own Diary Room lever, through the MCP boundary
});

When("the daily recap is assembled", function () {
  const b = bag(this);
  b.recap = b.s!.turnIn().dailyRecap;
  assert.ok(b.recap, "the bedtime carried no daily recap");
});

Then("only the already-surfaced rumor may appear", function () {
  const b = bag(this);
  assert.ok(b.recap!.surfaced.includes(b.surfaced!), "the rumor the player was told is missing from the recap");
});

Then("neither the hidden rumor nor the Diary Room entry appears", function () {
  const b = bag(this); const all = JSON.stringify(b.recap);
  assert.ok(!all.includes(b.unsurfaced!), "a rumor that never reached the player entered the recap");
  assert.ok(!all.includes(b.diary!), "the player's Diary Room entry entered the recap");
});

// ---- Scenario: the Vault Wall holds for the recap and its hook ----

Given("sealed Vault sentinels exist in the season", function () {
  const b = bag(this); const { sb, s } = start(this, 4);
  play(s, 3);
  const [schemer, target] = npcs(s);
  const SECRET = "SENTINEL-0102-HIDDEN-ATTRIBUTE";
  const SCHEME = "SENTINEL-0102-OFFSCREEN-BETRAYAL";
  const CONFESSION = "SENTINEL-0102-NPC-CONFESSIONAL";
  sb.engine.vault.writeHidden({ id: "sentinel-0102-secret", kind: "hidden-attribute", content: SECRET });
  sb.engine.vault.writeHidden({ id: "sentinel-0102-confessional", kind: "confessional", content: CONFESSION });
  // An off-screen betrayal between two houseguests, today, with the player outside the witness set: a recap highlight KIND, so only the hidden flag keeps it out.
  sb.engine.events.record({ id: "hid:0102", ts: sb.engine.events.count(), type: "betrayal", initiator: schemer!, witnessSet: [schemer!, target!], hidden: true, content: SCHEME });
  tellPlayer(sb, schemer!, "an ordinary rumor the player was told"); // so the hook has something to tease
  b.sentinels = [SECRET, SCHEME, CONFESSION];
  const vault = JSON.stringify(sb.engine.vault.readHidden()) + JSON.stringify(sb.engine.events.queryAll());
  for (const x of b.sentinels) assert.ok(vault.includes(x), `the sentinel was not planted: ${x}`); // the scan below can find them
});

When("the daily recap is read on the player and admin surfaces", async function () {
  const b = bag(this); const sb = b.sb!;
  const bed = (await sb.mcp.player.callTool("turnIn", {})) as AdvanceView;
  assert.ok(bed.dailyRecap && bed.dailyRecap.highlights.length > 0, "no recap with content to sweep");
  b.recap = bed.dailyRecap;
  const reread = await sb.mcp.player.callTool("dailyRecap", {});
  sb.syncAdmin();
  const inspect = await sb.mcp.admin.callTool("inspectNonVaultState", {});
  const health = await sb.mcp.admin.callTool("sandboxHealth", {});
  b.dump = JSON.stringify(bed) + JSON.stringify(reread) + JSON.stringify(inspect) + JSON.stringify(health);
});

Then("no sentinel appears", function () {
  const b = bag(this);
  for (const x of b.sentinels!) assert.ok(!b.dump!.includes(x), `a sealed Vault sentinel reached a surface: ${x}`);
});

// ---- Scenario: the cliffhanger teases a thread in motion and commits to no outcome ----

Given("a quiet day with no thread in motion", function () {
  const { sb, s } = start(this, 5);
  assert.equal(deals(s).forParty(PLAYER).filter((d) => d.status === "open").length, 0, "the player already holds a deal");
  const told = sb.engine.knowledge.knownTo(PLAYER).filter((f) => f.pathway !== "diary-room");
  assert.equal(told.length, 0, "something already reached the player today");
});

Then("the recap closes with no fabricated hook", function () {
  const r = bag(this).s!.turnIn().dailyRecap; // the quiet day closes at bedtime
  assert.ok(r, "the bedtime carried no daily recap");
  assert.equal(r.hook, undefined, `a quiet day closed on a manufactured hook: ${JSON.stringify(r.hook)}`);
});

Given("an in-motion thread", function () {
  const b = bag(this); const { sb, s } = start(this, 6);
  for (let i = 0; i < 400 && s.gameStatus().nominees.length < 2; i++) play(s, 1); // past the nominations, so the board has an HOH and nominees
  const st = s.gameStatus();
  assert.ok(st.hoh && st.nominees.length === 2, "the season never reached its nominations");
  const onBoard = new Set([st.hoh.id, ...st.nominees.map((x) => x.id)]);
  const free = npcs(s).filter((id) => !onBoard.has(id));
  const [partner, teller] = free;
  // A deal the player holds that is still vague (a strained understanding), plus a rumor told to the player today.
  deals(s).make([PLAYER, partner!], "safety", "we keep each other safe", undefined, st.week, { vague: true });
  tellPlayer(sb, teller!, "a rumor the player heard today");
  b.partner = partner!;
  b.recap = s.turnIn().dailyRecap;
  assert.ok(b.recap, "the bedtime carried no daily recap");
});

Then("the hook never asserts a future result", function () {
  const b = bag(this); const s = b.s!; const hook = b.recap!.hook;
  assert.ok(hook, "an in-motion thread produced no hook");
  assert.ok(/^(deal|surfaced):/.test(hook.thread), `the hook is not anchored to a thread in motion: ${hook.thread}`);
  const f = hook.framing.toLowerCase();
  for (const outcome of ["will win", "wins", "won ", "will be", "evict", "goes home", "going home", "nominat", "veto", "head of household", "hoh", "winner", "jury"]) {
    assert.ok(!f.includes(outcome), `the hook commits to an outcome ("${outcome}"): ${hook.framing}`);
  }
  // It names nobody but the player's own deal partner (their own knowledge): never the HOH, a nominee, or anyone else on the board.
  for (const id of npcs(s)) {
    if (id === b.partner) continue;
    assert.ok(!f.includes(nameOf(s, id).toLowerCase()), `the hook names a houseguest outside the player's thread: ${hook.framing}`);
  }
});

// ---- Scenario: the recap augments play and is reproducible ----

When("the daily recap is materialized and then re-read", function () {
  const b = bag(this); const { sb, s } = start(this, 7);
  play(s, 2);
  const [teller] = npcs(s);
  b.dayOneFact = "a fact the player heard on the first day";
  tellPlayer(sb, teller!, b.dayOneFact);
  const board = () => {
    const st = s.gameStatus();
    const l = live(s); // the live season itself too, not only the projection (which re-syncs some fields only at the next commit)
    return JSON.stringify({ week: st.week, phase: st.phase, hoh: st.hoh, nominees: st.nominees, veto: st.veto, pending: s.getGameState().pending?.kind ?? null, ceremony: l.ceremony ?? null, live: [l.week, l.phase, l.hoh, l.nominees, l.vetoHolder, l.evictionOrder] });
  };
  b.before = board();
  b.recap = s.turnIn().dailyRecap;
  assert.ok(b.recap, "the bedtime carried no daily recap");
  b.firstRead = s.dailyRecap();
  (b as Bag & { after?: string }).after = board();
});

Then("week, phase and ceremony state are unchanged", function () {
  const b = bag(this) as Bag & { after?: string };
  assert.equal(b.after, b.before, "materializing the recap moved the board");
});

Then("re-reading returns the exact same digest, and the next day's recap does not repeat it", function () {
  const b = bag(this); const s = b.s!; const sb = b.sb!;
  assert.deepEqual(b.firstRead, b.recap, "re-reading the recap did not return the materialized digest");
  assert.deepEqual(s.dailyRecap(), b.recap, "a second re-read drifted");
  assert.ok(b.recap!.surfaced.includes(b.dayOneFact!), "the first day's recap is missing what the player heard that day");
  const dayTwoFact = "a fact the player heard on the second day";
  tellPlayer(sb, npcs(s)[1]!, dayTwoFact);
  const next = s.turnIn().dailyRecap;
  assert.ok(next, "the next bedtime carried no daily recap");
  assert.equal(next.day, b.recap!.day + 1, "the next recap is not for the next day");
  assert.ok(next.surfaced.includes(dayTwoFact), "the next day's recap is missing that day's news");
  assert.ok(!playerSees(next).includes(b.dayOneFact!), "the next day's recap repeats the previous day's news");
  for (const h of b.recap!.highlights) assert.ok(!next.highlights.includes(h), `the next day's recap repeats a highlight: ${h}`);
});
