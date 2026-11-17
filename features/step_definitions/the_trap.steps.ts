import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry, type UserSandbox } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import type { BeliefClaim } from "../../src/engine/beliefStore";
import { TRAP } from "../../src/engine/trap";
import { InMemoryKnowledgeService } from "../../src/adapters/inmemory/InMemoryKnowledgeService";
import { InMemoryEventStore } from "../../src/adapters/inmemory/InMemoryEventStore";

/**
 * Feature 0188 - the trap and the overheard plant. Drives the REAL adapter (its daily trap tick, its confide-to-player path, its overheard-plant step) through a
 * registry sandbox, with a fresh knowledge service standing in for the orchestrator's. TEST-ONLY seams: the live season (beliefs, day), the relationship read, the
 * setter's credulity, the awake set, and the private tick / plant methods. Roles only: a setter, a suspect, a go-between, the player.
 */
type Seam = {
  live: { playedGame?: boolean; week: number; dayNumber?: number; beliefs?: Record<string, BeliefClaim[]>; traps?: Array<{ setter: string; suspect: string; subject: string; status: string; factId: string }>; claims?: { items: Array<{ speaker: string; listener: string }> } };
  rel: { edge(a: string, b: string): { trust: number; affinity: number } };
  trapTick(k: InMemoryKnowledgeService): void; credulityOf(id: string): number; claimsToPlayerFor(id: string): Record<string, unknown> | undefined; disclosureEpoch: number;
  overhearPlant(c: unknown, place: string, presence: Map<string, string>, salt: string): void; awakeNow(): null; onPlayerEvent?: (c: string, w: string[], k: string) => void;
};
type Bag = { sb?: UserSandbox; g?: Seam; k?: InMemoryKnowledgeService; setter?: string; suspect?: string; go?: string; trust?: number; tells?: Record<string, unknown>; events?: Array<{ content: string; witnesses: string[] }> };
const bag = (w: unknown): Bag => ((w as { trap0188?: Bag }).trap0188 ??= {});
let n = 0;
const rumor = (holder: string, extra: Partial<BeliefClaim>): BeliefClaim => ({ id: `${holder}|r|${n++}`, holder, kind: "heard-rumor", value: true, origin: "told", confidence: 0.4, week: 1, ...extra }) as BeliefClaim;

Given("a played season with traps on", function () {
  const b = bag(this);
  b.sb = new GameSessionRegistry().sandboxFor(`trap0188-${n++}`);
  b.sb.session.setTrapsEnabled(true);
  b.sb.session.createCharacter({ playerName: "The Player", seed: 71 });
  b.g = b.sb.session as unknown as Seam;
  b.g.live.playedGame = true;
  b.k = new InMemoryKnowledgeService(new InMemoryEventStore());
  const npcs = b.sb.session.livingIds().filter((id) => id !== PLAYER);
  [b.setter, b.suspect, b.go] = npcs;
  b.g.credulityOf = (id) => (id === b.setter ? 0.2 : 0.6); // only the setter is suspicious by nature
});
function doubts(w: unknown, suspect: string): void {
  const b = bag(w);
  b.suspect = suspect;
  b.g!.live.beliefs = { [b.setter!]: [rumor(b.setter!, { nature: "talking-about", subject: suspect, object: b.go!, week: b.g!.live.week })] };
}
const runDays = (b: Bag, days = 40) => { for (let d = 1; d <= days && !(b.g!.live.traps ?? []).length; d++) { b.g!.live.dayNumber = d; b.g!.trapTick(b.k!); } };
Given("a suspicious houseguest who doubts a houseguest's discretion", function () { doubts(this, bag(this).suspect!); });
Given("a suspicious houseguest who doubts the player's discretion", function () { doubts(this, PLAYER); });
Given("a trap set on a houseguest", function () { doubts(this, bag(this).suspect!); runDays(bag(this)); assert.equal(bag(this).g!.live.traps?.[0]?.status, "open", "no trap was set"); bag(this).trust = bag(this).g!.rel.edge(bag(this).setter!, bag(this).suspect!).trust; });

When("the days pass", function () { runDays(bag(this)); });
Then("the suspicious houseguest tells that houseguest, and no one else, a made-up secret", function () {
  const b = bag(this); const t = b.g!.live.traps?.[0];
  assert.ok(t, "no trap was set");
  assert.deepEqual((b.g!.live.claims?.items ?? []).filter((c) => c.speaker === b.setter).map((c) => c.listener), [b.suspect]);
  assert.ok(b.k!.knownTo(b.suspect!).some((f) => f.factId === t.factId), "the suspect does not hold the secret");
});

When("the secret reaches the setter from someone other than that houseguest", function () {
  const b = bag(this); const t = b.g!.live.traps![0]!;
  b.k!.transmitGossip(b.go!, b.setter!, { content: "it came back", factId: t.factId, subject: t.subject, confidence: 0.6, source: b.go!, hops: 2, distortion: 0 }, `told-by:${b.go}`);
  b.g!.live.dayNumber = (b.g!.live.dayNumber ?? 0) + 1; b.g!.trapTick(b.k!);
});
Then("the setter trusts that houseguest less and holds that they talk", function () {
  const b = bag(this);
  assert.equal(b.g!.live.traps![0]!.status, "sprung");
  assert.ok(b.g!.rel.edge(b.setter!, b.suspect!).trust < b.trust!, "trust did not fall");
  assert.ok((b.g!.live.beliefs?.[b.setter!] ?? []).some((x) => x.nature === "talking-about" && x.subject === b.suspect && x.origin === "deduced"));
});
When("the watch runs out with nothing coming back", function () {
  const b = bag(this);
  for (let i = 0; i < TRAP.watchDays; i++) { b.g!.live.dayNumber = (b.g!.live.dayNumber ?? 0) + 1; b.g!.trapTick(b.k!); }
});
Then("the setter trusts that houseguest a little more", function () {
  const b = bag(this);
  assert.equal(b.g!.live.traps![0]!.status, "held");
  assert.ok(b.g!.rel.edge(b.setter!, b.suspect!).trust > b.trust!, "trust did not rise");
});

When("the days pass and the setter is next with the player", function () {
  const b = bag(this); runDays(b);
  assert.equal(b.g!.live.traps?.[0]?.status, "pending", "no trap waits for the player");
  b.g!.disclosureEpoch += 1;
  b.tells = b.g!.claimsToPlayerFor(b.setter!);
});
Then("the player is told a made-up secret, with nothing marking it as a test", function () {
  const b = bag(this);
  assert.ok(b.tells, "the player was told nothing");
  assert.deepEqual(Object.keys(b.tells!).sort(), ["certainty", "kind", "object", "subject"]);
  assert.ok(!/trap|canary|test|false|true/i.test(JSON.stringify(b.tells)));
});
Then("if it reaches the setter through someone else, the setter trusts the player less", function () {
  const b = bag(this); const t = b.g!.live.traps![0]!;
  const before = b.g!.rel.edge(b.setter!, PLAYER).trust;
  (b.g!.live.beliefs![b.setter!] ??= []).push(rumor(b.setter!, { nature: "going-after", subject: t.subject, object: b.setter!, source: b.go!, week: b.g!.live.week }));
  b.g!.live.dayNumber = (b.g!.live.dayNumber ?? 0) + 1; b.g!.trapTick(b.k!);
  assert.equal(t.status, "sprung");
  assert.ok(b.g!.rel.edge(b.setter!, PLAYER).trust < before);
});

Given("a houseguest planting a story with another, in a room with others and the player", function () {
  const b = bag(this); const g = b.g!;
  g.awakeNow = () => null; // the whole house is up
  b.events = [];
  const prior = g.onPlayerEvent; g.onPlayerEvent = (content, witnesses, kind) => { b.events!.push({ content, witnesses }); prior?.(content, witnesses, kind); };
  const npcs = b.sb!.session.livingIds().filter((id) => id !== PLAYER);
  const [planter, listener, target, ...rest] = npcs;
  const presence = new Map<string, string>([[planter!, "kitchen"], [listener!, "kitchen"], [PLAYER, "kitchen"], ...rest.map((id) => [id, "kitchen"] as [string, string])]);
  for (let k = 0; k < 30 && !b.events.some((e) => e.witnesses.includes(PLAYER)); k++) g.overhearPlant({ id: `plant-${k}`, speaker: planter, listener, kind: "going-after", subject: target, object: listener, week: g.live.week }, "kitchen", presence, `bdd-${k}`);
  b.setter = planter; b.suspect = target;
});
Then("someone in the room overhears it and holds that the planter talks behind the target's back", function () {
  const b = bag(this);
  assert.ok(Object.values(b.g!.live.beliefs ?? {}).flat().some((x) => x.origin === "overheard" && x.subject === b.setter && x.object === b.suspect));
});
Then("the player in the room may hear the words, never whether they are true", function () {
  const b = bag(this);
  const mine = b.events!.filter((e) => e.witnesses.includes(PLAYER));
  assert.ok(mine.length > 0, "the player never overheard");
  assert.ok(mine.every((e) => !/\b(true|false|lying|lie)\b/i.test(e.content.split(" that ")[1] ?? "")));
});
Then("no player or admin view carries a trap, a canary or a suspect", async function () {
  const sb = bag(this).sb!;
  const out = JSON.stringify([await sb.mcp.player.callTool("getGameState", {}), await sb.mcp.player.callTool("gameStatus", {}), await sb.mcp.player.callTool("getMomentPrompt", {}), await sb.mcp.admin.callTool("inspectNonVaultState", {})]);
  const m = out.match(/.{40}(canary|"traps"|trap:|"suspect"|trapsDay).{40}/i); assert.ok(!m, `a trap reached a player or admin view: ${m?.[0]}`);
});
