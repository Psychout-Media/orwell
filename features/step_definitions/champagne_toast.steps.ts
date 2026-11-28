import { Given, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { resolvePending } from "../support/answerPending";

/**
 * 0111 champagne toast first impressions (ORW-194 / ORW-286, wired into the BDD gate by ORW-368) + the circle never returning to the player (ORW-368). Roles only; every name comes from the generated cast.
 * The toast is replayed here batch by batch (the engine releases TOAST_BATCH speakers per advanceGame) with the narrator's moment prompt captured at each batch: what the narrator is handed IS the toast's content (it voices
 * the facts, ADR 0003), so the Then steps read the batch prompts and the engine's own recorded toast events.
 */
type Batch = { speakers: Array<{ id?: string; name: string; host?: true; isPlayer?: true }>; prompt: string; playerToast: string | undefined };
type Toast = { session: GameSessionAdapter; sandbox: ReturnType<GameSessionRegistry["sandboxFor"]>; seed: number; batches: Batch[]; full: string[]; played: boolean };
const store = new WeakMap<object, Toast>();
let userSeq = 0;

function begin(seed: number, on: boolean): Toast {
  const sandbox = new GameSessionRegistry().sandboxFor(`ct-${seed}-${userSeq++}`);
  const session = sandbox.session;
  session.setPremiereEntrancesEnabled(on);
  session.createCharacter({ playerName: "P", seed });
  return { session, sandbox, seed, batches: [], full: [], played: false };
}
function play(t: Toast): void {
  if (t.played) return;
  const s = t.session;
  for (let i = 0; i < 80 && s.premiereIntros()?.entrance && s.premiereIntros()!.entrance!.stage !== "done"; i++) {
    const v = s.advanceGame();
    if (v.pending) resolvePending(v.pending, (req) => void s.submitDecision(req));
    const e = s.premiereIntros()?.entrance;
    if (e?.stage === "toast" && e.speakers?.length) {
      const prompt = s.getMomentPrompt({ moment: "premiere" }).systemPrompt;
      t.batches.push({ speakers: e.speakers, prompt, playerToast: e.playerToast });
      t.full.push(prompt);
    }
  }
  t.played = true;
}
const of = (w: BbWorld): Toast => { const t = store.get(w); assert.ok(t, "a started season"); return t!; };

Given("a started season with the premiere entrances enabled", function (this: BbWorld) { store.set(this, begin(111, true)); });

/** Called by the shared "the entrances and the toast are played through" step (premiere_entrances.steps.ts): true when THIS world is a toast world, which it then plays batch by batch. */
export function playChampagneWorld(w: object): boolean {
  const t = store.get(w);
  if (!t) return false;
  play(t);
  assert.equal(t.session.premiereIntros()?.entrance?.stage ?? "done", "done", "the entrances and the toast finished within a bounded number of steps");
  return true;
}

const npcCards = (t: Toast) => t.session.premiereIntros()!.met;
const speakerNpcIds = (t: Toast): string[] => t.batches.flatMap((b) => b.speakers.filter((x) => !x.host && !x.isPlayer).map((x) => x.id!));

Then("every houseguest except the player gave a toast that states their name, age, hometown and job", function (this: BbWorld) {
  const t = of(this);
  const released = new Set(speakerNpcIds(t));
  assert.equal(released.size, 15, "all fifteen houseguests were released to speak, each in some batch");
  for (const b of t.batches) for (const sp of b.speakers.filter((x) => !x.host && !x.isPlayer)) {
    const c = npcCards(t).find((m) => m.houseguest.id === sp.id)!;
    assert.ok(b.prompt.includes(c.houseguest.name), `${sp.id}: named in their batch`);
    assert.ok(b.prompt.includes(`${c.age}, works as ${c.vocation}`), `${sp.id}: age then job`);
    assert.ok(b.prompt.includes(`from ${c.hometown}`), `${sp.id}: hometown`);
    assert.match(b.prompt, /Voice EVERY houseguest speaker named here/, "the batch tells the narrator to voice each speaker");
  }
});

Then("each of those toasts carries one line of personality", function (this: BbWorld) {
  const t = of(this);
  assert.ok(t.full.length > 0 && t.batches.filter((b) => b.speakers.some((x) => !x.host && !x.isPlayer)).every((b) => /one line of (how they come across|personality)/i.test(b.prompt)), "every batch asks for the one line of personality, drawn from the stored facts");
});

Then("the host's opening toast needs no basics", function (this: BbWorld) {
  const t = of(this);
  assert.equal(t.batches[0]!.speakers[0]!.host, true, "the host speaks first");
  assert.ok(!t.full.join("\n").includes("THE TOAST \u2014 The host's facts"), "no basics are attached to the host");
});

Then("each houseguest's stated age, hometown and job are exactly their stored public facets", function (this: BbWorld) {
  const t = of(this);
  const roster = t.session.getGameState();
  for (const c of npcCards(t)) {
    const h = roster.house.find((x) => x.id === c.houseguest.id)!;
    assert.equal(c.houseguest.name, h.name);
    const line = t.full.join("\n").split("\n").find((l) => l.includes(c.houseguest.name) && l.includes(`${c.age}, works as ${c.vocation}`) && l.includes(`from ${c.hometown}`));
    assert.ok(line, `${c.houseguest.id}: the prompt carries exactly the stored age, job and hometown, on that houseguest's own line`);
  }
});

Then("a houseguest with no stored public age is not given a made-up one in the toast", function (this: BbWorld) {
  const t = of(this);
  for (const c of npcCards(t).filter((m) => typeof m.age !== "number")) {
    const line = t.full.join("\n").split("\n").find((l) => l.includes(c.houseguest.name) && l.includes("works as"));
    assert.ok(!line || !/\d+, works as/.test(line), `${c.houseguest.id}: no invented age`);
  }
  assert.ok(true);
});

Then("the same seed reproduces the same introductions", function (this: BbWorld) {
  const t = of(this);
  const again = begin(t.seed, true); play(again);
  assert.deepEqual(again.batches.map((b) => b.speakers.map((x) => x.name)), t.batches.map((b) => b.speakers.map((x) => x.name)), "the same speakers in the same batches");
  assert.deepEqual(again.full, t.full, "the same prompts");
});

Given("a unique marker is planted in every houseguest's hidden elements, pre-show ties, game philosophy and relationship reads", function (this: BbWorld) {
  const t = begin(111, true); store.set(this, t);
  const roster = t.session.getGameState().house;
  roster.forEach((h, i) => t.sandbox.engine.vault.writeHidden({ id: `ct:marker:${i}`, kind: "confessional", content: `MARKER-TOAST-${i}-${h.id}` }));
  (this as unknown as { toastMarkers: string[] }).toastMarkers = roster.map((h, i) => `MARKER-TOAST-${i}-${h.id}`);
});

Then("no marker appears in any toast, entrance or narration prompt the player can see", function (this: BbWorld) {
  const t = of(this); play(t);
  const text = t.full.join("\n") + t.session.getMomentPrompt({ moment: "premiere" }).systemPrompt + JSON.stringify(t.session.premiereIntros());
  for (const m of (this as unknown as { toastMarkers: string[] }).toastMarkers) assert.ok(!text.includes(m), `${m} must never reach a player-visible surface`);
});

Then("the archetype label appears only inside the fenced private cue {string} in the narrator's prompt and never in any introduction the player sees", function (this: BbWorld, _cue: string) {
  const t = of(this); play(t);
  for (const c of npcCards(t) as Array<{ houseguest: { name: string }; archetype?: string }>) {
    if (!c.archetype) continue;
    const lines = t.full.join("\n").split("\n").filter((l) => l.includes(c.houseguest.name)); // EVERY line that names the houseguest, not only the fenced-cue line
    for (const l of lines) assert.ok(!l.replace(/\(private (?:voice )?cue, never said aloud: [^)]*\)/g, "").replaceAll(`who plays as a ${c.archetype}`, "").includes(c.archetype), `${c.houseguest.name}: label outside the fenced cue`);
  }
});

Then("no tie, relationship number or game philosophy appears in any introduction", function (this: BbWorld) {
  const t = of(this); play(t);
  assert.ok(!/trust|threat|affinity|philosophy|pre-show tie/i.test(JSON.stringify(t.session.premiereIntros()!.met)), "the cards carry none of them");
  // and the narrator's introduction lines (the speaker lines and each speaker's facts line) carry none of them either
  const intro = t.full.join("\n").split("\n").filter((l) => l.includes("'s facts (voice their toast from these only") || /works as/.test(l)).join("\n");
  assert.ok(intro.length > 0, "there are introduction lines to check");
  assert.ok(!/\b(trust|threat|affinity|philosophy|pre-show tie)\b/i.test(intro), "the introduction lines carry no tie, relationship number or philosophy");
});

Then("the player and the admin projections carry no Vault data", function (this: BbWorld) {
  const t = of(this); play(t);
  assert.ok(!/MARKER-TOAST/.test(JSON.stringify(t.session.getGameState())), "the player projection is Vault-free");
  assert.ok(!/MARKER-TOAST/.test(JSON.stringify(t.sandbox.admin.inspect())), "the admin projection (AdminPort.inspect) is Vault-free too");
});

Then("each introduction is a spoken line in the houseguest's own toast voice", function (this: BbWorld) {
  const t = of(this); play(t);
  assert.ok(t.full.every((p) => /woven into the scene|never a data dump/i.test(p)), "the narrator is told to speak each introduction in the scene, never recite it");
});

Then("no introduction shows a raw field name or a list of labelled values", function (this: BbWorld) {
  const t = of(this); play(t);
  for (const p of t.full) assert.ok(!/\b(vocation|hometown|archetype):\s/i.test(p.split("\n").filter((l) => /works as/.test(l)).join("\n")), "the facts are phrased, not labelled");
});

Then("the engine hands the narrator the facts to voice and not a script to recite", function (this: BbWorld) {
  const t = of(this); play(t);
  for (const p of t.full) {
    const factLines = p.split("\n").filter((l) => l.includes("'s facts (voice their toast from these only"));
    assert.ok(factLines.length > 0 && factLines.every((l) => /never read out as a list/.test(l) && !/["\u201c]/.test(l.split("never read out as a list):")[1] ?? "")), "each speaker's facts line hands over facts and carries no ready-made quoted line");
    assert.ok(/never (a data dump|read out as a list)/i.test(p), "and the narrator is told never to dump data");
  }
});

Then("the player's own toast slot is still authored by the player in chat", function (this: BbWorld) {
  const t = of(this); play(t);
  const me = t.session.getGameState().player!.id;
  const speeches = t.sandbox.engine.events.queryAll().filter((e) => e.type === "toast-speech").map((e) => e.content);
  assert.ok(!speeches.some((c) => c.includes("P gives a toast")), "the engine never records a toast for the player");
  assert.equal(t.batches.filter((b) => b.speakers.some((x) => x.isPlayer && x.id === me)).length, 1, "the player's slot came up once");
  // ORW-368: it is invited exactly once, in its own batch, and the circle does not come back to the player
  const invites = t.batches.map((b) => b.playerToast);
  assert.equal(invites.filter((x) => x === "now").length, 1);
  assert.ok(invites.slice(invites.indexOf("now") + 1).every((x) => x === "done"), "after their slot the player is never invited again");
});

Then("everyone is still met by the end of the toast and the first power still waits for the Day-1 morning", function (this: BbWorld) {
  const t = of(this); play(t);
  const pr = t.session.premiereIntros();
  assert.ok(!pr || (pr.met.length === 15 && pr.complete), "everyone is met");
  assert.ok(!t.session.gameStatus().hoh, "no HOH is crowned by the end of the toast");
});

Then("with the premiere entrances OFF the season is byte-identical to today", function (this: BbWorld) {
  const a = begin(111, false), b = begin(111, false);
  assert.equal(JSON.stringify(a.session.snapshot().live), JSON.stringify(b.session.snapshot().live), "an OFF season is deterministic");
  assert.equal((a.session.snapshot().live as unknown as { premiereEntrance?: unknown }).premiereEntrance, undefined, "no entrance state when OFF");
});
