import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { BOND, type BondStore } from "../../src/engine/bondRecord";

/** ORW-609: the player's own recorded scenes fold into the bond record (played games only). Roles only. */
type Internals = {
  live: { active: string[]; playedGame?: boolean; bonds?: BondStore; bondsCursor?: number };
  snapshot(): unknown; restore(c: unknown): void; bondReader(): unknown;
  setBondRecordEnabled(on: boolean): void;
};
const PLAYER = "player";
const start = (seed: number, n: string, bondOn = true) => {
  const sb = new GameSessionRegistry().sandboxFor(`g609-${n}-${seed}-${bondOn}`);
  sb.session.createCharacter({ playerName: "The Player", seed });
  (sb.session as unknown as Internals).setBondRecordEnabled(bondOn);
  sb.session.noteMessage({ messageId: "m1" });
  return { sb, s: sb.session as unknown as Internals };
};
const npcs = (s: Internals): string[] => s.live.active.filter((x) => x.startsWith("npc:"));
const say = (sb: ReturnType<typeof start>["sb"], who: string[], kind: string | undefined) =>
  sb.commands.recordInteraction({ initiator: PLAYER, witnessSet: [PLAYER, ...who], content: "a quiet word", ...(kind ? { kind } : {}) } as never);

describe("a player's recorded scene moves the bond record", () => {
  it("bonding: the partner's warmth toward the player rises in full, the player's own view by the smaller share", () => {
    const { sb, s } = start(3, "a"); const [A] = npcs(s);
    expect(s.live.playedGame).toBe(true);
    say(sb, [A!], "bonding"); s.bondReader();
    const store = s.live.bonds!;
    expect(store[`${A}|${PLAYER}`]!.warmth).toBeCloseTo(BOND.warmthPerBond, 12);
    expect(store[`${PLAYER}|${A}`]!.warmth).toBeCloseTo(BOND.warmthPerBond * BOND.initiatorShare, 12);
  });
  it("a houseguest's own conflict with the player puts the resentment on the player's view of that houseguest, not the other way", () => {
    const { sb, s } = start(3, "h"); const [A] = npcs(s);
    sb.commands.recordInteraction({ initiator: A!, witnessSet: [A!, PLAYER], content: "a clash", kind: "conflict" } as never); s.bondReader();
    const store = s.live.bonds!;
    expect(store[`${PLAYER}|${A}`]!.resentment).toBeCloseTo(BOND.resentPerConflict, 12);
    expect(store[`${A}|${PLAYER}`]!.resentment).toBeCloseTo(BOND.resentPerConflict * BOND.initiatorShare, 12);
  });
  it("conflict: the partner's resentment and strain toward the player rise", () => {
    const { sb, s } = start(3, "b"); const [A] = npcs(s);
    say(sb, [A!], "conflict"); s.bondReader();
    const r = s.live.bonds![`${A}|${PLAYER}`]!;
    expect(r.resentment).toBeCloseTo(BOND.resentPerConflict, 12);
    expect(r.strain).toBeGreaterThan(0);
  });
  it("a bystander in the room moves only their own view, and the pair is untouched by them", () => {
    const { sb, s } = start(3, "c"); const [A, B] = npcs(s);
    say(sb, [A!, B!], "bonding"); s.bondReader();
    const store = s.live.bonds!;
    expect(store[`${B}|${PLAYER}`]!.warmth).toBeCloseTo(BOND.warmthPerBond * BOND.bystanderShare, 12);
    expect(store[`${A}|${B}`]).toBeUndefined();
  });
  it("kinds that are not a scene fold, and an untagged scene, fold nothing", () => {
    const { sb, s } = start(3, "d"); const [A] = npcs(s);
    say(sb, [A!], "gossip"); say(sb, [A!], "betrayal"); say(sb, [A!], undefined); s.bondReader();
    expect(Object.keys(s.live.bonds ?? {}).filter((k) => k.includes(PLAYER))).toEqual([]);
  });
  it("folds once: repeated reads and a save/restore never double it", () => {
    const { sb, s } = start(3, "e"); const [A] = npcs(s);
    say(sb, [A!], "bonding"); s.bondReader(); s.bondReader();
    const snap = JSON.parse(JSON.stringify(s.snapshot()));
    const before = JSON.stringify(s.live.bonds);
    const { s: t } = start(3, "e2"); t.restore(snap); t.bondReader(); t.bondReader();
    expect(JSON.stringify(t.live.bonds)).toBe(before);
    expect(t.live.bonds![`${A}|${PLAYER}`]!.history).toBe(1);
  });
  it("flag off: nothing kept", () => {
    const { sb, s } = start(3, "f", false); const [A] = npcs(s);
    say(sb, [A!], "bonding"); s.bondReader();
    expect(s.live.bonds).toBeUndefined();
  });
  it("the wall: the kind and the record reach no player, admin or prompt surface", async () => {
    const { sb, s } = start(3, "g"); const [A] = npcs(s);
    say(sb, [A!], "conflict"); s.bondReader();
    const dump = JSON.stringify([
      await sb.mcp.admin.callTool("inspectNonVaultState", {}),
      await sb.mcp.player.callTool("getGameState", {}),
      (s as unknown as { getMomentPrompt(a: unknown): { systemPrompt: string } }).getMomentPrompt({ moment: "social" }).systemPrompt,
    ]);
    for (const w of ["interactionKind", "peakResentment", "\"bonds\""]) expect(dump).not.toContain(w);
  });
});
