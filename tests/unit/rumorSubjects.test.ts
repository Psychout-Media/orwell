import { describe, it, expect } from "vitest";
import { PLAYER } from "../../src/domain/ids";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { backfillRumorSubjects, rumorFrom, rumorSubjectOf } from "../../src/engine/gossip";
import { endHeldNight } from "../support/heldNight";

/**
 * ORW-688 - a scene rumor carries who it is ABOUT, so the secret consumers (0099 barter, 0202 leverage, 0204 breaks) can match it in a PLAYED game.
 * Everything below reaches the facts through the real writers (a played season), never by seeding a fact with a subject. Roles only.
 */
async function play(seed: number, messages: number, on: boolean) {
  const prev = process.env.ORWELL_RUMOR_SUBJECTS;
  process.env.ORWELL_RUMOR_SUBJECTS = on ? "1" : "0";
  try {
    const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
    const user = `rumor-subj-${on ? "on" : "off"}-${seed}`;
    const mcp = reg.resolver()("player", user);
    await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
    for (let i = 0; i < messages; i++) {
      await mcp.callTool("noteMessage", { messageId: `${user}-${i}` });
      if (i % 6 !== 5) continue;
      const adv = (await mcp.callTool("advanceGame", {})) as { pending?: { kind: string; options?: Array<{ id: string }> }; held?: unknown };
      if (adv.held) await endHeldNight((n, a) => mcp.callTool(n, a), `rs${seed}`, undefined, { stopWhenDue: true });
      if (adv.pending) {
        const k = adv.pending.kind, o = (j: number) => adv.pending!.options?.[j]?.id;
        if (k === "ceremony-step") await mcp.callTool("advanceGame", {});
        else {
          try {
            await mcp.callTool("submitDecision", k === "nominations" ? { kind: k, choice: [o(0), o(1)] } : k === "veto-decision" ? { kind: k, use: false } : k === "comp-intent" || k === "comp-round" ? { kind: k, intent: "compete" } : k === "goodbye-message" ? { kind: k, vote: "respectful" } : { kind: k, vote: o(0) });
          } catch { await mcp.callTool("advanceGame", {}); }
        }
      }
    }
    return { reg, user, mcp, sb: reg.sandboxFor(user) };
  } finally {
    if (prev === undefined) delete process.env.ORWELL_RUMOR_SUBJECTS; else process.env.ORWELL_RUMOR_SUBJECTS = prev;
  }
}
// ORW-1043: the flag-on season of 420 messages is read by two tests (same seed, user and message count); both only read it, so it is played once.
let onSeason: ReturnType<typeof play> | undefined;
const flagOnSeason = (): ReturnType<typeof play> => (onSeason ??= play(3, 420, true));

/** Every fact an NPC holds that is ABOUT someone else (engine-only read of the knowledge layer). */
const aboutOthers = (g: Awaited<ReturnType<typeof play>>) => {
  const out: Array<{ holder: string; subject: string; factId: string; pathway: string }> = [];
  for (const h of (g.sb.session as unknown as { livingIds(): string[] }).livingIds()) {
    if (h === PLAYER) continue;
    for (const k of g.sb.engine.knowledge.knownTo(h)) if (k.subject !== undefined && k.subject !== h) out.push({ holder: h, subject: k.subject, factId: k.factId ?? k.id, pathway: k.pathway });
  }
  return out;
};

describe("rumor subjects (ORW-688)", () => {
  it("pure: the subject is the one who is not the teller; the backfill only fills a missing subject", () => {
    expect(rumorSubjectOf("a", ["a", "b"])).toBe("b");
    expect(rumorSubjectOf("c", ["a", "b"])).toBe("a");
    const snap = { seq: 1, tick: 1, suspicions: {}, knowledge: { x: [
      { id: "k1", content: rumorFrom("a", "b", "strategy"), originalContent: rumorFrom("a", "b", "strategy"), pathway: "origin", ts: 1, factId: "fact:a:12" },
      { id: "k2", content: "something else", pathway: "told-by:a", ts: 2, factId: "fact:a:13" },
      { id: "k3", content: rumorFrom("a", "b", "strategy"), pathway: "told-by:a", ts: 3, factId: "fact:a:12", subject: "kept" },
    ] } };
    const out = backfillRumorSubjects(snap).knowledge.x!;
    expect(out[0]!.subject).toBe("b");
    expect(out[1]!.subject).toBeUndefined();
    expect(out[2]!.subject).toBe("kept");
    expect(out.map((f) => f.id)).toEqual(["k1", "k2", "k3"]); // append-only: nothing lost, nothing reordered
  });

  it("a played season: what the houseguests hold about someone carries who it is about; with the flag off the same season holds less of it", async () => {
    const on = aboutOthers(await flagOnSeason());
    const off = aboutOthers(await play(3, 420, false));
    expect(on.length).toBeGreaterThan(off.length);
  }, 300_000);

  it("WALL: the subject on an NPC-held fact never reaches a player or admin surface; what the player holds with a subject came through an in-game pathway", async () => {
    const g = await flagOnSeason();
    const rows = aboutOthers(g);
    expect(rows.length).toBeGreaterThan(0); // positive control: the engine record holds the subject
    const playerFactIds = new Set(g.sb.engine.knowledge.knownTo(PLAYER).map((k) => k.factId ?? k.id));
    const hidden = rows.filter((r) => !playerFactIds.has(r.factId));
    expect(hidden.length).toBeGreaterThan(0);
    const surfaces: unknown[] = [];
    for (const tool of ["getGameState", "whereabouts", "getVisibleState", "getJournal"]) surfaces.push(await g.mcp.callTool(tool, {}).catch(() => null));
    const admin = g.reg.resolver()("admin", g.user);
    for (const tool of ["getStatus", "sandboxHealth", "getGameState"]) surfaces.push(await admin.callTool(tool, {}).catch(() => null));
    const text = JSON.stringify(surfaces);
    for (const r of hidden) expect(text).not.toContain(r.factId);
    for (const k of g.sb.engine.knowledge.knownTo(PLAYER)) if (k.subject !== undefined) expect(k.pathway).not.toBe("origin");
  }, 300_000);
});
