import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { sessionCoreSupersetViolation, type SessionSnapshot } from "../../src/engine/sessionSnapshot";

/**
 * ORW-844 - the checkpoint's agenda check has a trusted window like the events do (the first and last entries of the earlier history, the length and the owner) and the full check on the first commit and every
 * `R3_FULL_CHECK_EVERY` commits. The guard must still fire on a history that lost its past: here two REAL snapshots of one played game (through the player channel and the real registry), then "a corrupted save"
 * made by rewriting a copy of the earlier one. Truncation, a replaced first or last entry and a dropped agenda fire in both modes; a rewrite in the middle fires in the full check (and is the one the window leaves to it).
 * Roles only.
 */
type Snap = SessionSnapshot;
describe("agenda non-degradation: the trusted window and the full check", () => {
  it("fires on a corrupted earlier history exactly where the window promises, and never on a genuine later state", async () => {
    let earlier: Snap | undefined, later: Snap | undefined;
    const longest = (s: Snap): number => Math.max(0, ...Object.values(s.live?.agendas ?? {}).map((a) => a.history.length));
    // The seed is PICKED, not pinned (ORW-1159: the conversation tether pins people in the player's room, which moved which season's agendas reach three entries and grow): the first seed whose game does both.
    for (const seed of [2, 4, 5, 6, 7, 8, 1, 3]) { // ORW-995: 2, 4, 5, 6, 7, 8 grow the history on the census cast, 1 and 3 do not
      if (later) break;
      earlier = undefined;
      const reg = composeRuntime({ clock: new FakeClock(), seed }).registry;
      const user = `agenda-844-${seed}`;
      const mcp = reg.resolver()("player", user);
      await mcp.callTool("createCharacter", { playerName: "The Player", seed, archetype: "floater" });
      for (let i = 0; i < 1400 && !later; i++) {
        await mcp.callTool("noteMessage", { messageId: `m${i}` });
        if (i % 6 === 5) {
          const adv = (await mcp.callTool("advanceGame", {})) as { pending?: { kind: string; options?: Array<{ id: string }> } };
          if (adv.pending) {
            const k = adv.pending.kind, o = (j: number) => adv.pending!.options?.[j]?.id;
            try { await mcp.callTool("submitDecision", k === "nominations" ? { kind: k, choice: [o(0), o(1)] } : k === "veto-decision" ? { kind: k, use: false } : k === "comp-intent" || k === "comp-round" ? { kind: k, intent: "compete" } : k === "goodbye-message" ? { kind: k, vote: "respectful" } : { kind: k, vote: o(0) }); } catch { /* the next loop advances */ }
          }
        }
        if (i % 20 === 19) {
          const snap = JSON.parse(JSON.stringify(reg.snapshot(user))) as Snap;
          if (!earlier && longest(snap) >= 3) earlier = snap;
          else if (earlier && longest(snap) > longest(earlier)) later = snap; // the history genuinely grew
        }
      }
    }
    expect(earlier, "a played game reached an agenda history of three entries").toBeDefined();
    expect(later, "and then grew").toBeDefined();
    for (const trust of [false, true]) expect(sessionCoreSupersetViolation(later!, earlier!, { trustPrefix: trust }), `a genuine later state (trust ${trust})`).toBeNull();

    const owner = Object.entries(earlier!.live!.agendas!).sort((a, b) => b[1].history.length - a[1].history.length)[0]![0];
    const corrupt = (edit: (live: NonNullable<Snap["live"]>, id: string) => void): Snap => { const c = JSON.parse(JSON.stringify(earlier)) as Snap; edit(c.live!, owner); return c; };
    const h = (live: NonNullable<Snap["live"]>, id: string) => live.agendas![id]!.history as unknown as Array<Record<string, unknown>>;
    const cases: Array<[string, Snap, boolean]> = [
      ["the first entry rewritten", corrupt((l, id) => { h(l, id)[0] = { ...h(l, id)[0]!, why: "rewritten" }; }), true],
      ["the last entry rewritten", corrupt((l, id) => { const x = h(l, id); x[x.length - 1] = { ...x[x.length - 1]!, why: "rewritten" }; }), true],
      ["the history longer than the later one (the later lost entries)", corrupt((l, id) => { for (let i = 0; i < 400; i++) h(l, id).push({ ...h(l, id)[0]! }); }), true],
      ["the whole agenda dropped from the later state", corrupt((l, id) => { void l; void id; }), true],
      ["an entry in the MIDDLE rewritten", corrupt((l, id) => { const x = h(l, id); const m = Math.floor(x.length / 2); x[m] = { ...x[m]!, why: "rewritten" }; }), false],
    ];
    for (const [name, corrupted, caughtByWindow] of cases) {
      const laterState = name.startsWith("the whole agenda") ? (() => { const c = JSON.parse(JSON.stringify(later)) as Snap; delete c.live!.agendas![owner]; return c; })() : later!;
      expect(sessionCoreSupersetViolation(laterState, corrupted, { trustPrefix: false }), `${name}: the full check`).toBe("agendas");
      expect(sessionCoreSupersetViolation(laterState, corrupted, { trustPrefix: true }), `${name}: the trusted window`).toBe(caughtByWindow ? "agendas" : null);
    }
  }, 600_000);
});
