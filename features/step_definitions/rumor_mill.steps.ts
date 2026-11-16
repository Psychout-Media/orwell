import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { recordClaim } from "../../src/engine/beliefStore";
import { PLAYER } from "../../src/domain/ids";
import type { RetrospectiveView } from "../../src/ports/GameSession";

/**
 * Feature 0157 - the rumor mill in the retrospective (theme 2 slice 8, ORW-525). Drives the REAL adapter. Claims are told directly through the
 * engine's `tellClaim` (NPCs tell few claims until slice 3), in week one while everyone is still in the house, then the season is fast-forwarded to
 * its crown. Roles only.
 */
type Bag = { sb?: UserSandbox; s?: GameSessionAdapter; npcs?: string[]; retro?: RetrospectiveView | null; before?: string };
const bag = (w: unknown): Bag => ((w as { rm0157?: Bag }).rm0157 ??= {});
const live = (s: GameSessionAdapter) => (s as unknown as { live: { claims?: unknown; beliefs?: unknown } }).live;
let n = 0;

function start(w: unknown): void {
  const sb = new GameSessionRegistry().sandboxFor(`rumor0157-${n++}`);
  sb.session.setNpcBeliefsEnabled(true);
  sb.session.setVoteTalkEnabled(false); // these scenarios seed their own lies (and 'nobody lied' means it): vote talk's lies would be extra
  sb.session.createCharacter({ playerName: "The Player", seed: 7 });
  const b = bag(w);
  b.sb = sb; b.s = sb.session;
  b.npcs = sb.session.livingIds().filter((id) => id !== PLAYER);
}
const tell = (w: unknown, c: Parameters<GameSessionAdapter["tellClaim"]>[0]) => assert.ok(bag(w).s!.tellClaim(c), "the engine refused a valid claim");

function seedLies(w: unknown): void {
  const [liar, l1, l2, rival, other] = bag(w).npcs!;
  tell(w, { speaker: liar!, listener: l1!, kind: "voted-to-evict-you", subject: rival!, isTrue: false, intent: "mislead" });
  tell(w, { speaker: liar!, listener: l2!, kind: "voted-to-evict-you", subject: rival!, isTrue: false, intent: "mislead" });
  tell(w, { speaker: other!, listener: l1!, kind: "going-after", subject: PLAYER, object: rival!, isTrue: false, intent: "deflect" });
}

Given("a season where a houseguest lied to two others about a rival and another houseguest lied about the player", function () { start(this); seedLies(this); });
Given("a season where a houseguest lied about a rival and a second houseguest later repeated it without meaning to mislead", function () {
  start(this);
  const [liar, l1, repeater, rival] = bag(this).npcs!;
  tell(this, { speaker: liar!, listener: l1!, kind: "voted-to-evict-you", subject: rival!, isTrue: false, intent: "mislead" });
  tell(this, { speaker: repeater!, listener: liar!, kind: "voted-to-evict-you", subject: rival!, isTrue: false, intent: "inform" });
});
Given("a season where nobody lied aloud but a houseguest came to believe something false about the player", function () {
  start(this);
  const [holder] = bag(this).npcs!;
  // a belief the engine formed itself (deduced), claiming the player is after the holder; no goal exists, so the engine's records say it is false
  recordClaim(((live(bag(this).s!) as { beliefs?: Record<string, unknown[]> }).beliefs ??= {}) as never,
    { holder: holder!, kind: "targets-me", subject: PLAYER, value: true, origin: "deduced", confidence: 0.6, week: 1 });
});
Given("a season where nobody lied", function () { start(this); });

When("the season is over and a winner is crowned", function () {
  const b = bag(this);
  b.before = JSON.stringify({ c: live(b.s!).claims, b: live(b.s!).beliefs });
  assert.equal(b.s!.advanceToFinale().finished, true);
  b.before = JSON.stringify({ c: live(b.s!).claims, b: live(b.s!).beliefs });
  b.retro = b.s!.seasonRetrospective();
  assert.ok(b.retro, "the retrospective should be open after the crown");
});

Then("the retrospective lists the rival rumor as the biggest false belief", function () {
  const top = bag(this).retro!.rumorMill!.biggest[0]!;
  assert.match(top.claim, /voted to evict them/);
  assert.equal(top.believers.length, 2);
});
Then("it names the liar as who started it and both listeners as who believed it", function () {
  const [liar, l1, l2] = bag(this).npcs!;
  const top = bag(this).retro!.rumorMill!.biggest[0]!;
  assert.equal(top.starter.id, liar);
  assert.deepEqual(top.believers.map((x) => x.id).sort(), [l1!, l2!].sort());
});
Then("it lists what the house got wrong about the player", function () {
  const mine = bag(this).retro!.rumorMill!.aboutYou;
  const row = mine.find((m) => m.starter.id === bag(this).npcs![4]);
  assert.ok(row, "the claim-planted lie about the player is listed");
  assert.deepEqual(row.believers.map((x) => x.id).sort(), [bag(this).npcs![1]!]);
});
Then("the retrospective names the first teller as the starter and the second as having passed it on", function () {
  const [liar, , repeater] = bag(this).npcs!;
  const top = bag(this).retro!.rumorMill!.biggest[0]!;
  assert.equal(top.starter.id, liar);
  assert.deepEqual(top.passedOn.map((x) => x.id), [repeater]);
});

Then("no player or admin view, and no retrospective, shows a claim, its truth or what the speaker meant", async function () {
  const b = bag(this);
  assert.equal(b.s!.seasonRetrospective(), null, "the retrospective is sealed while the season is live");
  const blob = JSON.stringify([
    await b.sb!.mcp.player.callTool("getGameState", {}), await b.sb!.mcp.player.callTool("gameStatus", {}),
    await b.sb!.mcp.player.callTool("getMomentPrompt", {}), await b.sb!.mcp.player.callTool("seasonRetrospective", {}),
    await b.sb!.mcp.admin.callTool("inspectNonVaultState", {}),
  ]);
  for (const k of ["claim:", "isTrue", "rumorMill"]) assert.ok(!blob.includes(k), `a live surface carries ${k}`);
  assert.ok(!/intent\W{1,6}(inform|warn|recruit|mislead|deflect|protect)/.test(blob), "a live surface carries a claim intent");
});

Then("the retrospective carries no claim-planted rumors and is otherwise whole", function () {
  const r = bag(this).retro!;
  // no claim was ever told, so nothing claim-planted; the engine may still have formed a false belief about the player on its own (aboutYou only)
  assert.deepEqual(r.rumorMill?.biggest ?? [], []);
  assert.ok(Array.isArray(r.hiddenStory) && r.winner);
});
Then("reading the retrospective leaves the claim log and the beliefs exactly as they were", function () {
  const b = bag(this);
  b.s!.seasonRetrospective();
  assert.equal(JSON.stringify({ c: live(b.s!).claims, b: live(b.s!).beliefs }), b.before);
});

Then("the retrospective lists that wrong belief about the player with its believer and no claim, truth or intent", function () {
  const m = bag(this).retro!.rumorMill!;
  assert.deepEqual(m.biggest, []);
  const row = m.aboutYou.find((r) => r.starter.id === bag(this).npcs![0] && r.believers.some((x) => x.id === bag(this).npcs![0]));
  assert.ok(row, "the engine-formed false belief about the player is listed");
  const blob = JSON.stringify(m);
  for (const k of ["claim:", "isTrue", "intent", "confidence", "targets-me", "deduced"]) assert.ok(!blob.includes(k), `the rumor mill carries ${k}`);
});
