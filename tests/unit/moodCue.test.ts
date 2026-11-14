import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { moodWord } from "../../src/engine/voice";

/**
 * ORW-343 (Ryne audit card 17, 2026-11-04: "mood and temperament must be VISIBLE ... a qualitative cue on the roster card, no numbers, no hidden cause"): each ACTIVE houseguest's cast card carries the mood word AS THE
 * PLAYER LAST SAW IT. A memory, not a live feed through walls (ADR 0003: people must make sense): it is captured while the player shares a room with the houseguest and kept until they are together again.
 * Roles only (holder, other).
 */
type Soul = { emotionalState: number; volatility: number; emotionalHistory: number[] };
type S = {
  livingIds(): EntityId[];
  presence: Map<EntityId, string>;
  soulObj(id: EntityId): Soul | undefined;
  persist(): void;
  setMoodCueEnabled(on: boolean): void;
  seenMoods: Map<EntityId, string> | null;
  live: { evictionOrder: EntityId[] };
  getGameState(): { house: Array<Record<string, unknown>> };
};
function game() {
  const rt = composeRuntime({ clock: new FakeClock(), seed: 11 });
  const user = `mood-cue-${Math.random()}`;
  const sb = rt.registry.sandboxFor(user);
  sb.session.createCharacter({ playerName: "The Player", seed: 11, archetype: "floater" });
  const s = sb.session as unknown as S;
  const [holder, other] = s.livingIds().filter((i) => i !== PLAYER) as [EntityId, EntityId];
  for (const id of [...s.presence.keys()]) s.presence.set(id, "backyard");
  s.presence.set(PLAYER, "kitchen");
  s.seenMoods = null; // the premiere gathers everyone, so casting already captured a first look; start each case from "nobody seen"
  const card = (id: EntityId) => s.getGameState().house.find((h) => h.id === id)!;
  const setMood = (id: EntityId, v: number) => { const soul = s.soulObj(id)!; soul.emotionalState = v; soul.emotionalHistory.push(v); }; // append, never replace (non-degradation: a soul never loses history)
  const word = (id: EntityId) => { const x = s.soulObj(id)!; return moodWord(x.emotionalState, x.volatility, x.emotionalHistory); };
  return { rt, user, s, holder, other, card, setMood, word };
}

describe("the cast card shows the mood word as the player last saw it (ORW-343)", () => {
  it("never seen together: absent. Seen together: the word. Seen, then apart: the OLD word stays while their mood moves; together again: it updates", () => {
    const { s, holder, card, setMood, word } = game();
    setMood(holder, 0.9); // buoyant, but they are in another room
    s.persist();
    expect(card(holder).lastSeenMood, "never seen together yet").toBeUndefined();
    s.presence.set(holder, "kitchen"); // now in the player's room
    s.persist();
    const first = word(holder);
    expect(card(holder).lastSeenMood).toBe(first);
    s.presence.set(holder, "backyard"); // they part
    setMood(holder, 0.1); // their mood crashes out of sight
    s.persist();
    expect(word(holder), "the live word really changed").not.toBe(first);
    expect(card(holder).lastSeenMood, "the card keeps what the player last saw").toBe(first);
    s.presence.set(holder, "kitchen"); // together again
    s.persist();
    expect(card(holder).lastSeenMood).toBe(word(holder));
    expect(card(holder).lastSeenMood).not.toBe(first);
  });

  it("a houseguest the player has not shared a room with has no cue, even after others do", () => {
    const { s, holder, other, card } = game();
    s.presence.set(holder, "kitchen");
    s.persist();
    expect(card(holder).lastSeenMood).toBeDefined();
    expect(card(other).lastSeenMood).toBeUndefined();
  });

  it("an evicted houseguest has no cue, even if one was captured", () => {
    const { s, holder, card } = game();
    s.presence.set(holder, "kitchen");
    s.persist();
    expect(card(holder).lastSeenMood).toBeDefined();
    s.live.evictionOrder.push(holder);
    expect(card(holder).lastSeenMood).toBeUndefined();
  });

  it("flag off: the card is byte-identical to a game where nobody was ever seen, and nothing is captured", () => {
    const a = game(), b = game();
    for (const g of [a, b]) g.s.presence.set(g.holder, "kitchen");
    a.s.setMoodCueEnabled(false);
    a.s.persist(); b.s.persist();
    expect(a.s.seenMoods).toBeNull();
    expect("lastSeenMood" in a.card(a.holder)).toBe(false);
    expect("lastSeenMood" in b.card(b.holder)).toBe(true);
  });

  it("Vault wall: the card carries only the word, never a number, the soul, a cause or a trend (player channel)", async () => {
    const { rt, user, s, holder, setMood } = game();
    setMood(holder, 0.33);
    s.presence.set(holder, "kitchen");
    s.persist();
    const state = (await rt.registry.resolver()("player", user).callTool("getGameState", {})) as { house: Array<Record<string, unknown>> };
    const c = state.house.find((h) => h.id === holder)!;
    expect(typeof c.lastSeenMood).toBe("string");
    expect(c.lastSeenMood as string).not.toMatch(/\d/);
    const blob = JSON.stringify(state.house);
    for (const k of ["emotionalState", "volatility", "emotionalHistory", "moodCause", "soul"]) expect(blob, `a card carries ${k}`).not.toContain(`"${k}"`);
  });
});
