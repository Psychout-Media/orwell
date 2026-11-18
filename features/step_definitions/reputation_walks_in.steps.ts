import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { GameSessionRegistry } from "../../src/composition/registry";
import { deriveNotoriety, type OpenSetSeasonOutcome, type NotorietySummary } from "../../src/engine/notoriety";
import { recordClaim, type BeliefStore } from "../../src/engine/beliefStore";
import { PLAYER } from "../../src/domain/ids";

/** Feature 0208 B2 - drives the played-season seam and the carried summary. Roles only. */
type Seam = { live: { active: string[]; finished?: boolean; winner?: string; beliefs?: BeliefStore }; openSetOutcome(): OpenSetSeasonOutcome | null; snapshot(): unknown; setNotoriety(n: NotorietySummary | null): void };
type Bag = { s?: Seam; outcome?: OpenSetSeasonOutcome | null; sentinel?: string };
const bag = (w: unknown): Bag => ((w as { rep0208?: Bag }).rep0208 ??= {});
let n = 0;
const npcsOf = (s: Seam) => s.live.active.filter((x) => x.startsWith("npc:"));
const hear = (s: Seam, holder: string, nature: string, content?: string) => {
  s.live.beliefs ??= {};
  recordClaim(s.live.beliefs, { holder, kind: "heard-rumor", subject: PLAYER, object: "npc:other", nature, value: true, origin: "told", confidence: 0.9, week: 1, ...(content ? { content } : {}) } as never);
};
const BASE: OpenSetSeasonOutcome = { placement: 3, castSize: 16, playerCompWins: 1, playerEvictionRoles: [], reachedJury: true, reachedFinalTwo: false, juryVoteShare: 0 };
const threatOf = (summary: NotorietySummary | null): number => {
  const sb = new GameSessionRegistry().sandboxFor(`rep0208-r-${n++}`);
  (sb.session as unknown as Seam).setNotoriety(summary);
  sb.session.createCharacter({ playerName: "The Player", seed: 11 });
  const ids = (sb.session.snapshot().house?.npcs ?? []).map((x) => x.id);
  return ids.reduce((a, id) => a + sb.engine.relationships.edge(id, PLAYER).threat, 0) / ids.length;
};

Given("reputation: a played season the player finished", function () {
  const sb = new GameSessionRegistry().sandboxFor(`rep0208-${n++}`);
  sb.session.createCharacter({ playerName: "The Player", seed: 5 });
  sb.session.noteMessage({ messageId: "m1" });
  const s = sb.session as unknown as Seam; s.live.finished = true; s.live.winner = "npc:other";
  bag(this).s = s;
});
Given("reputation: several houseguests heard the player went back on their word", function () {
  const s = bag(this).s!; for (const id of npcsOf(s).slice(0, 5)) { hear(s, id, "lying"); hear(s, id, "betrayal"); }
});
Given("reputation: the house heard only kind things, and a sealed fact sits in the hidden layer", function () {
  const b = bag(this); b.sentinel = "SENTINEL-HIDDEN-FACT"; for (const id of npcsOf(b.s!)) hear(b.s!, id, "kindness", b.sentinel);
});
When("reputation: the season ends", function () { const b = bag(this); b.outcome = b.s!.openSetOutcome(); });
Then("reputation: the season record carries what share of the house heard it", function () { const h = bag(this).outcome!.houseHeardWrong!; assert.ok(h > 0.05 && h < 1); });
Then("reputation: the player's carried treachery is higher than after a clean season", function () {
  const o = bag(this).outcome!;
  assert.ok(deriveNotoriety(o).reputation.treachery > deriveNotoriety({ ...o, houseHeardWrong: 0 }).reputation.treachery);
});
Then("reputation: the season record shows nothing heard", function () { assert.equal(bag(this).outcome!.houseHeardWrong, 0); });
Then("reputation: the sealed fact reaches neither the record nor the summary", function () {
  const b = bag(this); assert.ok(!JSON.stringify([b.outcome, deriveNotoriety(b.outcome!)]).includes(b.sentinel!));
});
Given("reputation: a new player with no past season", function () { bag(this).s = undefined; });
Then("reputation: the new cast reads them byte-for-byte as before", function () {
  const mk = (id: string) => { const sb = new GameSessionRegistry().sandboxFor(id); sb.session.createCharacter({ playerName: "The Player", seed: 9 }); return JSON.stringify(sb.session.snapshot()); };
  assert.equal(mk("rep0208-new-a"), mk("rep0208-new-b"));
});
Given("reputation: the player returns after a season of broken word", function () { /* the carried summary is built in the Then */ });
Then("reputation: the new cast reads them as more of a threat than a returning player with a clean name", function () {
  assert.ok(threatOf(deriveNotoriety({ ...BASE, houseHeardWrong: 0.5 })) > threatOf(deriveNotoriety({ ...BASE, houseHeardWrong: 0 })));
});
