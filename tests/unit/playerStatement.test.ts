import { describe, it, expect } from "vitest";
import { GameSessionRegistry } from "../../src/composition/registry";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER } from "../../src/domain/ids";
import { buildSandbox } from "../support/sandbox";
import type { SpokenClaim } from "../../src/engine/spokenClaims";

/**
 * ORW-612 part C - the player's own word about a third person (`recordInteraction.statement`) reaches the engine over the MCP boundary and goes through the open-ledger door with the PLAYER as speaker:
 * the engine gives it its truth, the listener holds it as a belief, a false one is a lie on the record, and a contradicting second one is caught. Flag off / malformed => ignored. Roles only.
 */
type S = {
  setAdvanceGateEnabled(on: boolean): void; setPromiseTermsEnabled(on: boolean): void; setAssurancesEnabled(on: boolean): void;
  setNpcBeliefsEnabled(on: boolean): void; setLiesCaughtEnabled(on: boolean): void;
  noteMessage(m: unknown): void; movePlayer(room: string): { present: Array<{ id: string }> } | undefined;
  truthFacts(): { goalAgainst(w: string, t: string): boolean };
};
function started(flag = true) {
  const sb = new GameSessionRegistry().sandboxFor(`ps-${Math.random()}`);
  sb.session.createCharacter({ playerName: "The Player", archetype: "floater", seed: 7 });
  sb.session.advanceGame(); sb.session.advanceGame();
  const g = sb.session as unknown as S;
  (sb.session as unknown as { live: { playedGame?: boolean } }).live.playedGame = true;
  g.setAdvanceGateEnabled(false); g.setAssurancesEnabled(true); g.setNpcBeliefsEnabled(true); g.setLiesCaughtEnabled(true); g.setPromiseTermsEnabled(flag);
  g.noteMessage({ messageId: "m1" });
  const present = g.movePlayer("living-room")!.present.map((p) => p.id).filter((i) => i !== PLAYER);
  const [listener, subject, third] = present as [string, string, string];
  const b = buildSandbox(1);
  const server = new McpServer("player", { player: b.player, admin: b.admin, summary: b.summary, commands: sb.commands, session: sb.session });
  const live = () => (sb.session as unknown as { live: { claims?: { items: SpokenClaim[] }; beliefs?: Record<string, Array<{ kind: string; subject: string; refuted?: boolean; origin: string; source?: string }>> } }).live;
  const say = (statement: unknown, content = "x") => server.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, listener], content, kind: "conversation", statement });
  return { sb, g, listener, subject, third, server, live, say };
}
const playerClaims = (e: ReturnType<typeof started>) => (e.live().claims?.items ?? []).filter((c) => c.origin === "player");

describe("recordInteraction.statement", () => {
  it("a statement the engine's records back plants an inform belief in the listener, the player as the source", async () => {
    const e = started();
    // make it true from the engine's own records: the subject has an active goal against the listener
    (e.sb.session as unknown as { truthFacts(): unknown }).truthFacts = () => ({ goalAgainst: () => true, votedToEvict: () => false, votedToKeep: () => false, finalTwo: () => false, liedTo: () => false, talkedAbout: () => false });
    await e.say({ to: e.listener, about: e.subject, kind: "targets-you" });
    const c = playerClaims(e);
    const toListener = c.find((x) => x.listener === e.listener)!;
    expect(toListener).toMatchObject({ speaker: PLAYER, kind: "targets-you", subject: e.subject, isTrue: true, intent: "inform" });
    expect((e.live().beliefs?.[e.listener] ?? []).some((b) => b.kind === "targets-me" && b.subject === e.subject && !b.refuted)).toBe(true);
  });
  it("a false one is a lie on the record (the player holds no engine beliefs)", async () => {
    const e = started();
    (e.sb.session as unknown as { truthFacts(): unknown }).truthFacts = () => ({ goalAgainst: () => false, votedToEvict: () => false, votedToKeep: () => false, finalTwo: () => false, liedTo: () => false, talkedAbout: () => false });
    await e.say({ to: e.listener, about: e.subject, kind: "targets-you" });
    expect(playerClaims(e).find((x) => x.listener === e.listener)).toMatchObject({ isTrue: false, intent: "mislead" });
  });
  it("a contradicting second claim to the same listener writes lied-to-me about the player", async () => {
    const e = started();
    await e.say({ to: e.listener, about: e.subject, kind: "final-two-with", object: e.third }, "a");
    await e.say({ to: e.listener, about: e.subject, kind: "going-after", object: e.third }, "b");
    expect((e.live().beliefs?.[e.listener] ?? []).some((b) => b.kind === "lied-to-me" && b.subject === PLAYER)).toBe(true);
  });
  it("a kind outside the claim set, an unknown houseguest or a flag-off engine makes no claim and never throws; the scene still records", async () => {
    const e = started();
    for (const s of [{ to: e.listener, about: e.subject, kind: "bogus" }, { to: e.listener, about: "npc:999", kind: "targets-you" }, { to: e.listener, about: e.listener, kind: "targets-you" }]) {
      const r = (await e.say(s)) as { eventId: string };
      expect(r.eventId).toBeTruthy();
    }
    expect(playerClaims(e)).toHaveLength(0);
    const off = started(false);
    await off.say({ to: off.listener, about: off.subject, kind: "targets-you" });
    expect(playerClaims(off)).toHaveLength(0);
  });
  it("a bad shape is refused with a typed field at the boundary", async () => {
    const e = started();
    await expect(e.say("targets-you")).rejects.toThrow(/statement/);
    await expect(e.say({ to: e.listener, about: e.subject })).rejects.toThrow(/statement/);
  });
  it("only a named listener in the scene hears it", async () => {
    const e = started();
    await e.say({ to: e.third, about: e.subject, kind: "going-after", object: e.listener });
    expect(playerClaims(e).some((x) => x.listener === e.third && x.speaker === PLAYER && x.subject === e.subject)).toBe(false);
  });
});

describe("0184 part 2a: the player can spread a reputation (has-reputation statement)", () => {
  it("the player telling a houseguest someone is a snake leaves the listener holding it, the player as the source; an unknown role word becomes nothing", async () => {
    const e = started();
    await e.say({ to: e.listener, about: e.subject, kind: "has-reputation", label: "snake" });
    const c = playerClaims(e).find((x) => x.listener === e.listener && x.kind === "has-reputation");
    expect(c).toMatchObject({ speaker: PLAYER, subject: e.subject, label: "snake" });
    const held = (e.live().beliefs?.[e.listener] ?? []) as Array<{ kind: string; subject: string; nature?: string; source?: string }>;
    expect(held.some((b) => b.kind === "heard-rumor" && b.subject === e.subject && b.nature === "rep:snake" && b.source === PLAYER)).toBe(true);
    await e.say({ to: e.listener, about: e.third, kind: "has-reputation", label: "the worst" });
    expect(playerClaims(e).some((x) => x.subject === e.third && x.kind === "has-reputation")).toBe(false);
  });
});
