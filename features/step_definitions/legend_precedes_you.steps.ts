import { Given, When, Then } from "@cucumber/cucumber";
import assert from "node:assert/strict";
import type { BbWorld } from "../support/world";
import { GameSessionRegistry } from "../../src/composition/registry";
import type { NotorietySummary } from "../../src/engine/notoriety";

// Feature 0136 - your legend precedes you. Roles only; the carried notoriety is a test-built summary (format only).
type Sb = ReturnType<GameSessionRegistry["sandboxFor"]>;
interface Ctx { sb: Sb; prompt: string; surface: string }
const state = new WeakMap<object, Ctx>();
const st = (w: BbWorld): Ctx => state.get(w)!;

const LEGEND = ["blindsided their own ally", "won their first season"];
const SUMMARY: NotorietySummary = {
  seasonsPlayed: 3, lastPlacement: 2, bestPlacement: 1,
  reputation: { loyalty: -0.81, treachery: 0.93, competitor: 0.77, social: -0.42 },
  legendBeats: LEGEND,
};
function returning(seed: number): Sb {
  const sb = new GameSessionRegistry().sandboxFor(`legend-${seed}-${Math.random()}`);
  sb.session.setNotoriety(SUMMARY);
  sb.session.createCharacter({ playerName: "The Player", seed });
  return sb;
}
const promptOf = (sb: Sb): string => sb.session.getMomentPrompt({ moment: "social" }).systemPrompt;

Given("a returning player with recorded legend beats", function (this: BbWorld) {
  state.set(this, { sb: returning(7), prompt: "", surface: "" });
});
Given("the same returning player past week 1", function (this: BbWorld) {
  const sb = returning(7);
  let phases = "";
  for (let i = 0; i < 800 && ((sb.session.getGameState() as unknown as { week?: number }).week ?? 1) < 2; i++) {
    const adv = sb.session.advanceGame();
    const p = adv.pending as { kind: string; options: Array<{ id: string }> } | undefined;
    if (!p) continue;
    phases = p.kind;
    if (p.kind === "nominations") sb.session.submitDecision({ kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] });
    else if (p.kind === "veto-decision") sb.session.submitDecision({ kind: "veto-decision", use: false });
    else if (p.kind === "replacement") sb.session.submitDecision({ kind: "replacement", replacement: p.options[0]!.id });
    else sb.session.submitDecision({ kind: p.kind, vote: p.options[0]?.id } as never);
  }
  assert.ok(((sb.session.getGameState() as unknown as { week?: number }).week ?? 1) >= 2, `reached week 2 (last pending ${phases})`);
  state.set(this, { sb, prompt: "", surface: "" });
});
Given("a returning player with a notoriety summary", function (this: BbWorld) {
  state.set(this, { sb: returning(13), prompt: "", surface: "" });
});

When("the premiere context is built", function (this: BbWorld) { st(this).prompt = promptOf(st(this).sb); });
When("a later context is built", function (this: BbWorld) { st(this).prompt = promptOf(st(this).sb); });
When("any player, prompt or admin surface is read", function (this: BbWorld) {
  const sb = st(this).sb;
  sb.syncAdmin();
  const player = JSON.stringify(sb.session.getGameState()) + JSON.stringify(sb.player.getVisibleState()) + JSON.stringify(sb.session.gameStatus());
  const prompts = sb.session.getMomentPrompt({}).systemPrompt + promptOf(sb) + sb.session.getMomentPrompt({ moment: "character-creation" }).systemPrompt;
  st(this).surface = player + prompts + JSON.stringify(sb.admin.inspect());
});

Then("it includes the RETURNING CAST line with the legend clauses", function (this: BbWorld) {
  const p = st(this).prompt;
  assert.ok(p.includes("- RETURNING CAST: the house has heard things"), "the line is present");
  for (const clause of LEGEND) assert.ok(p.includes(clause), `clause ${clause}`);
});
Then("no RETURNING CAST line is present", function (this: BbWorld) {
  assert.ok(!st(this).prompt.includes("RETURNING CAST"));
});
Then("no reputation facets, numbers or keys appear", function (this: BbWorld) {
  const s = st(this).surface;
  assert.ok(!/treachery|reputation":\s*\{|seasonsPlayed|legendBeats/i.test(s));
  assert.ok(!s.includes("0.93") && !s.includes("0.81"));
});
