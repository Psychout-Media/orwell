import { describe, it, expect } from "vitest";
import { composeRuntime } from "../../src/composition/runtime";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";

/**
 * 0129 / PO ruling 2026-11-03 — the jury house is FULLY SEQUESTERED: the player can talk to jurors only if
 * the player is a juror, and jurors mix only with other jurors. This pins the half that is built: while the
 * player is STILL ACTIVE (a non-juror),
 *   (a) no player tool reaches a seated juror (every mutating lever refuses a juror id), and
 *   (b) the event store never records a seated juror together with a non-seated houseguest after they are
 *       seated (the eviction-night departure beats — goodbyes, exit interview, "leaves the house" — are the
 *       one legitimate exception: they happen as the evictee walks out).
 * The player-as-juror surface (talking to the other jurors) is the unbuilt part of the 0129 spec.
 *
 * Roles only — no houseguest names. Seeds are SEARCHED (the balance moves which seed qualifies).
 */

interface Ref { id: string; name: string }
interface Pending { kind: string; options: Ref[] }
interface Adv { finished: boolean; pending: Pending | null }
interface Card { id: string; status: string }
interface State { week?: number; house: Card[]; player: { status: string } | null }

function answer(p: Pending): Record<string, unknown> {
  const first = p.options?.[0]?.id;
  switch (p.kind) {
    case "nominations": return { kind: "nominations", choice: [p.options[0]!.id, p.options[1]!.id] };
    case "veto-decision":
      return p.options.some((o) => o.id === PLAYER) ? { kind: "veto-decision", use: true, save: PLAYER } : { kind: "veto-decision", use: false };
    case "comp-intent": return { kind: "comp-intent", intent: "compete" };
    case "comp-round": return { kind: "comp-round", intent: "compete" };
    case "replacement": return { kind: "replacement", replacement: first };
    case "goodbye-message": return { kind: "goodbye-message", vote: "respectful" };
    default: return { kind: p.kind, vote: first };
  }
}

const DEPARTURE = /goodbye message|exit interview|leaves the house/;
const WEEKS_AFTER_FIRST_JUROR = 4;

describe("0129 — the jury house is sequestered from a non-juror player", () => {
  it("no tool reaches a juror, a pre-jury evictee goes home, and jurors mix only with jurors", async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const runtime = composeRuntime({ clock: new FakeClock(), seed: 1 });
      const user = `jury-sequester-${seed}`;
      const mcp = runtime.registry.resolver()("player", user);
      await mcp.callTool("createCharacter", { playerName: "The Player", seed });
      const events = () => runtime.registry.sandboxFor(user).engine.events.queryAll();
      const outAt = new Map<string, number>(); // anyone out of the game (evicted or seated on the jury) -> event index
      const jurors: string[] = [];
      let weeksSince = 0;
      let lastWeek = -1;
      let probed = false;
      for (let i = 0; i < 8000 && weeksSince < WEEKS_AFTER_FIRST_JUROR; i++) {
        const adv = (await mcp.callTool("advanceGame", {})) as Adv;
        if (adv.finished) break;
        if (adv.pending) {
          try { await mcp.callTool("submitDecision", answer(adv.pending)); } catch { break; }
        }
        const st = (await mcp.callTool("getGameState", {})) as State;
        if (st.player?.status !== "active") break; // the player became a juror/evictee — not this test's case
        for (const c of st.house) {
          if (c.status !== "active" && !outAt.has(c.id)) outAt.set(c.id, events().length);
          if (c.status === "jury" && !jurors.includes(c.id)) jurors.push(c.id);
        }
        if (jurors.length === 0) continue;
        if (!probed) {
          probed = true;
          const juror = jurors[0]!;
          // (a) every mutating lever refuses a juror id (null / thrown / not accepted) — never a recorded contact.
          expect(await mcp.callTool("makeDeal", { with: juror, kind: "alliance", terms: "t" })).toBeNull();
          expect(await mcp.callTool("confide", { npcId: juror })).toBeNull();
          expect(await mcp.callTool("confront", { npcId: juror, factId: "x" })).toBeNull();
          expect(await mcp.callTool("formAlliance", { name: "a", members: [juror] })).toBeNull();
          expect(await mcp.callTool("tradeSecret", { toNpcId: juror, bluff: true, subject: juror })).toMatchObject({ accepted: false });
          await expect(
            mcp.callTool("recordInteraction", { initiator: PLAYER, witnessSet: [PLAYER, juror], kind: "conversation", content: "x" }),
          ).rejects.toThrow(/non-living/);
          const w = (await mcp.callTool("whereabouts", {})) as { present?: Ref[] };
          expect((w.present ?? []).some((r) => r.id === juror), "a juror is never in the player's room").toBe(false);
          const before = events().length;
          await mcp.callTool("moveHouseguest", { id: juror, room: "kitchen" });
          expect(events().length, "moving a juror records nothing").toBe(before);
        }
        if (st.week !== undefined && st.week !== lastWeek) { lastWeek = st.week; weeksSince++; }
      }
      if (!probed) continue; // this seed never seated a juror while the player was still active — try the next

      // (b) PO ruling 2026-11-03: "the jury house is fully sequestered… other than other evicted houseguests who
      //     are on the jury." Once out, a PRE-jury evictee goes home — they appear in no further event at all —
      //     and a juror appears only with other jurors (never a houseguest still playing, the player included,
      //     and never a pre-jury evictee). The departure beats are the one exception: they happen as the
      //     evictee walks out.
      const finalState = (await mcp.callTool("getGameState", {})) as State;
      const statusOf = new Map(finalState.house.map((c) => [c.id, c.status]));
      const all = events();
      const out = (x: string, idx: number): boolean => outAt.has(x) && idx >= outAt.get(x)!;
      const isOutJuror = (x: string, idx: number): boolean => out(x, idx) && statusOf.get(x) === "jury";
      const bad = all.filter((e, idx) => {
        const parts = [...new Set([e.initiator, ...e.witnessSet])];
        if (!parts.some((x) => out(x, idx))) return false;
        if (DEPARTURE.test(String(e.content))) return false;
        if (parts.some((x) => out(x, idx) && statusOf.get(x) === "evicted")) return true; // a pre-jury evictee went home
        return parts.some((x) => !isOutJuror(x, idx)); // a juror with anyone who is not an out-of-the-game juror
      });
      expect(
        bad.map((e) => `${e.id} ${e.type}: ${String(e.content).slice(0, 60)}`),
        `seed ${seed}: the jury house was not sequestered`,
      ).toEqual([]);
      return;
    }
    throw new Error("no seed in 1..40 seated a juror while the player was still active");
  }, 600_000);
});
