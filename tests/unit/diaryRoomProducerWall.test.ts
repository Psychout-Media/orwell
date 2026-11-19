import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSaveStore } from "../../src/adapters/engine/FileSaveStore";
import { GameSessionRegistry } from "../../src/composition/registry";
import { PLAYER } from "../../src/domain/ids";
import { renderGameContext, MOMENT_PROMPTS } from "../../src/engine/momentPrompts";
import { visitWords, renderDiaryCallLines } from "../../src/engine/diaryCalls";

/** ORW-724: the Diary Room producer never confirms hidden views or whereabouts, and speaks the player's true visit count. Roles only. */
type Any = Record<string, any>;
const HIDDEN = "SENTINEL_HIDDEN_VIEW_724";

function boot(seed = 5): { sb: Any; s: Any } {
  const reg = new GameSessionRegistry(new FileSaveStore(mkdtempSync(join(tmpdir(), "orwell-724-"))));
  const sb = reg.sandboxFor("u") as unknown as Any;
  const s = sb.session as Any;
  s.createCharacter({ playerName: "P", seed });
  s.noteMessage({ messageId: "m1" });
  s.phase = "social";
  Object.assign(s.live, { champagneCircle: "done", pending: undefined, ceremony: undefined, dayNumber: 2, nightDepth: 15 });
  return { sb, s };
}

describe("ORW-724 - the Diary Room beat carries the true visit count", () => {
  it("once is once; a later visit is twice; absent outside the Diary Room", () => {
    const { s, sb } = boot();
    expect(s.getGameState().diaryCall?.playerVisits).toBeUndefined();
    sb.commands.diaryRoom({ entry: "x" });
    const v = s.getGameState().diaryCall;
    expect(v.playerVisits).toBe(1);
    expect(renderGameContext(s.getGameState() as never)).toMatch(/Diary Room once this game/);
    s.live.dayNumber = 4; // a later in-game hour: a second recorded visit
    sb.commands.diaryRoom({ entry: "y" });
    expect(s.getGameState().diaryCall.playerVisits).toBe(2);
    expect(renderGameContext(s.getGameState() as never)).toMatch(/Diary Room twice this game/);
    expect(visitWords(5)).toBe("5 times");
    expect(renderDiaryCallLines({ register: "r", playerVisits: 1 }).join("\n")).not.toMatch(/five/);
  });
});

describe("ORW-724 - no hidden view or whereabouts reaches the Diary Room beat", () => {
  it("a hidden opinion/event sentinel and every houseguest's relationship edge stay out of the view and the fact blocks", () => {
    const { s, sb } = boot();
    const npc = s.livingIds().find((x: string) => x !== PLAYER);
    sb.engine.events.record({ id: "h724", ts: 0, type: "scheme", initiator: npc, witnessSet: [npc], hidden: true, content: HIDDEN });
    sb.commands.diaryRoom({ entry: "who dislikes me" });
    const state = JSON.stringify(s.getGameState());
    const ctx = renderGameContext(s.getGameState() as never);
    expect(state).not.toContain(HIDDEN);
    expect(ctx).not.toContain(HIDDEN);
    expect(state).not.toMatch(/"(trust|affinity|threat|dislikes|opinionOfPlayer|hiddenView)"/);
    // the awake list is the only whereabouts-adjacent field: names of who is up, never a room for an unseen houseguest
    const awake = (s.getGameState().whereabouts ?? {}) as Any;
    expect(JSON.stringify(awake.counts ?? {})).not.toMatch(/dislike|trust|threat/);
  });
});

describe("ORW-724 - the Diary Room moment carries the producer rule; the base prompt is untouched", () => {
  it("the fragment states the limit with no examples or menus", () => {
    const frag: string = (MOMENT_PROMPTS as Any)["diary-room"];
    expect(frag).toMatch(/never states,\s*confirms or denies what any houseguest thinks/);
    expect(frag).toMatch(/never says where an unseen houseguest is/);
    expect(frag).not.toMatch(/e\.g\.|for example|such as/i);
    const src = readFileSync(join(__dirname, "../../src/engine/momentPrompts.ts"), "utf8");
    expect(src.split("never states,").length - 1).toBe(1); // in the moment fragment only, never also in the base prompt
  });
});
