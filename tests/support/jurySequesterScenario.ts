import { endHeldNight } from "./heldNight";
import { expect } from "vitest";
import { FakeClock } from "../../src/adapters/time/FakeClock";
import { PLAYER } from "../../src/domain/ids";
import type { composeRuntime as ComposeRuntime } from "../../src/composition/runtime";

/**
 * 0129 / PO ruling 2026-11-03 — the jury-house sequestration scenario, shared by the flags-off test
 * (`tests/unit/jurySequester.test.ts`) and the full-deployed-profile test (`tests/unit/jurySequester.deployed.test.ts`,
 * which sets the deployed flag env BEFORE the engine modules load). Roles only — no houseguest names. Seeds are
 * SEARCHED (the balance moves which seed qualifies).
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
    case "secret-veto": return { kind: "secret-veto", use: false }; // hold it (the one-turn reveal moved the seed trajectory onto this pending)
    default: return { kind: p.kind, vote: first };
  }
}

const DEPARTURE = /goodbye message|exit interview|leaves the house/;
const WEEKS_AFTER_FIRST_JUROR = 4;

/** Search seeds for one that seats a juror while the player is still active, then assert the sequestration. */
export async function runJurySequesterScenario(composeRuntime: typeof ComposeRuntime): Promise<void> {
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
      if ((adv as { held?: unknown }).held) await endHeldNight((n, a) => mcp.callTool(n, a), `js${seed}`); // ORW-116: a held night is the player's: time passes, then they turn in
      if (adv.finished) break;
      // A refused decision here is a real failure, never an early exit.
      if (adv.pending) await mcp.callTool("submitDecision", answer(adv.pending));
      const st = (await mcp.callTool("getGameState", {})) as State;
      if (st.player?.status !== "active") break; // the player became a juror/evictee — not this scenario's case
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
      // The departure beats are the ONE exception, and only for the DEPARTING evictee's own beat: the content matches a
      // departure line AND exactly one participant is out (the evictee walking out among the still-playing house) — a
      // beat that mixes two out-of-the-game houseguests, or any other content, never escapes the check.
      if (DEPARTURE.test(String(e.content)) && parts.filter((x) => out(x, idx)).length === 1) return false;
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
}
