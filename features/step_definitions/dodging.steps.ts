import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import { decideDodge, type DodgeInput } from "../../src/engine/dodging";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";

// Feature 0196 (ORW-630). Roles only. The decision is pure; the wall and flag scenarios use a real played sandbox.
const SEALED = "SEALED-0196-held-fact";
const base: DodgeInput = { cunning: 0.5, leakiness: 0.3, rattled: 0.2, trustInAsker: 0.5, stakes: 0.3 };
const rate = (i: DodgeInput, pick: (f: ReturnType<typeof decideDodge>) => boolean): number => { let n = 0; for (let k = 0; k < 400; k++) if (pick(decideDodge(i, [(k * 0.618) % 1, (k * 0.377) % 1, (k * 0.911) % 1]))) n++; return n / 400; };

Given("dodging: houseguests of differing guile, nerves and trust in the asker", function () { /* pure inputs below */ });
Then("dodging: the guileful push back more, the rattled read uneasy more, the trusting laugh it off more, and every way of dodging stays possible", function () {
  assert.ok(rate({ ...base, cunning: 0.9 }, (f) => f.pushesBack) > rate({ ...base, cunning: 0.1 }, (f) => f.pushesBack));
  assert.ok(rate({ ...base, rattled: 1, leakiness: 0.6 }, (f) => f.openness === "uneasy") > rate({ ...base, rattled: 0 }, (f) => f.openness === "uneasy"));
  assert.ok(rate({ ...base, trustInAsker: 1, stakes: 0 }, (f) => f.approach === "laugh-off") > rate({ ...base, trustInAsker: 0, stakes: 0 }, (f) => f.approach === "laugh-off"));
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(decideDodge(base, [i / 200, 0.5, 0.5]).approach);
  assert.equal(seen.size, 6);
});

type S = { livingIds(): string[]; npcVoice(id: string): { dodge?: Record<string, unknown> } | null; getMomentPrompt(o: object): { systemPrompt: string }; setDodgingEnabled(on: boolean): void;
  noteDisclosure(n: string, e: object): void; recordDodge(n: unknown, s: object): void; dodgeLog: unknown[]; house: { npcs: Array<{ id: string }> }; presence: Map<string, string> };
let sess: S | undefined; let holder = "";
const sig = { npcTrust: 0.3, npcAffinity: 0.3, npcThreat: 0.1, playerTrust: 0.3, playerAffinity: 0.3, goodwill: 0, archetype: "floater" };
async function played(on: boolean): Promise<void> {
  const reg = composeRuntime({ clock: new FakeClock(), seed: 5 }).registry;
  const user = `dodging-bdd-${on}`;
  const mcp = reg.resolver()("player", user);
  await mcp.callTool("createCharacter", { playerName: "The Player", seed: 5, archetype: "floater" });
  await mcp.callTool("noteMessage", { messageId: "first" });
  const sb = reg.sandboxFor(user);
  const s = sb.session as unknown as S;
  s.setDodgingEnabled(on);
  holder = s.livingIds().filter((i) => i !== PLAYER)[0]!;
  (sb.engine.knowledge as unknown as { seedBelief(e: string, f: object, p: string): unknown }).seedBelief(holder, { content: SEALED, factId: "f-sealed" }, "witnessed");
  for (const id of [...s.presence.keys()]) s.presence.set(id, "backyard");
  s.presence.set(holder, "kitchen"); s.presence.set(PLAYER, "kitchen");
  s.noteDisclosure(holder, { outcome: "deflect", via: "confide", truthful: true });
  const npc = s.house.npcs.find((n) => n.id === holder);
  s.recordDodge(npc, sig); s.recordDodge(npc, sig);
  sess = s;
}
Given("dodging: a played game where a houseguest holds a sealed fact and their press was declined", async function () { await played(true); });
Given("dodging: a played game with the feature switched off", async function () { await played(false); });
Then("dodging: the voice carries a dodge of approach, openness and push-back only, repeats within the beat are one entry, and the sealed fact and every number stay out", function () {
  assert.equal(sess!.dodgeLog.length, 1);
  const v = sess!.npcVoice(holder)!;
  assert.deepEqual(Object.keys(v.dodge!).sort(), ["approach", "openness", "pushesBack"]);
  assert.ok(!JSON.stringify(v).includes(SEALED) && !sess!.getMomentPrompt({}).systemPrompt.includes(SEALED));
  assert.ok(!/\d/.test(JSON.stringify(v.dodge)));
});
Then("dodging: no dodge is decided, recorded or handed to the narrator", function () {
  assert.equal(sess!.dodgeLog.length, 0);
  assert.ok(!("dodge" in sess!.npcVoice(holder)!));
});
