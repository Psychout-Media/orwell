import { describe, it, expect } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { McpServer } from "../../src/adapters/mcp/McpServer";
import { PLAYER_TOOLS } from "../../src/surfaces/tools/registry";
import { buildSandbox } from "../support/sandbox";
import type { CompetitionStagingView, RecordCompetitionFictionResult } from "../../src/ports/GameSession";

/**
 * Feature #1400 — the generative-competition write-back BOUNDARY test (the mandatory step-4 gate; the
 * `worldSnapshotBoundary`/`castPrewarm` template). The engine has a COMPLETE adapter impl
 * (`competitionStagingView` / `recordCompetitionFiction`), but the four-place wiring is DEAD at runtime
 * unless the tool is BOTH on the channel allowlist AND dispatched in `McpServer.callTool` — and neither
 * the arch gate nor the manifest test catches a missing dispatch case. This proves the seam is open end
 * to end: the FE can reach the staging READ and the fiction WRITE-BACK over the MCP boundary. It also
 * pins the core SAFETY property: a matched fiction is accepted, a REORDERED one is rejected (the 0042
 * floor stands). Roles only — no names from any corpus.
 */

function playerServer(genEnabled = true): { server: McpServer; session: GameSessionAdapter } {
  const sb = buildSandbox(1);
  const session = new GameSessionAdapter();
  session.setGenCompetitionsEnabled(genEnabled);
  const commands = new EngineCommandsAdapter(sb.engine.events, sb.engine.knowledge);
  const server = new McpServer("player", { player: sb.player, admin: sb.admin, summary: sb.summary, commands, session });
  return { server, session };
}

/** Drive a fresh season to a RESOLVED staged HOH competition (winner + drop order fixed). */
function driveToResolvedComp(session: GameSessionAdapter): void {
  session.createCharacter({ playerName: "The Player", seed: 4 });
  session.advanceGame(); // 0111: close the premiere champagne circle
  let adv = session.advanceGame(); // the first HOH stages
  while (adv.event?.beat === "day-break") adv = session.advanceGame(); // P4b: clock-live premiere exit = the first-morning day-break; the HOH stages on the next advance
  if (adv.pending?.kind === "comp-round" || adv.pending?.kind === "comp-intent") {
    session.submitDecision({ kind: "comp-round", intent: "compete" }); // resolves + begins staging
  }
}

describe("#1400 — the competition staging READ + fiction WRITE-BACK reach the engine over the MCP boundary", () => {
  it("both tools are on the player channel (the boundary bug)", () => {
    const names = PLAYER_TOOLS.map((t) => t.name);
    expect(names).toContain("competitionStagingView");
    expect(names).toContain("recordCompetitionFiction");
  });

  it("dispatches competitionStagingView — it is not rejected as 'not available' or 'unhandled tool'", async () => {
    const { server } = playerServer();
    // Pre-game / no comp staging: a clean null dispatch (never a throw).
    const view = await server.callTool("competitionStagingView", {});
    expect(view).toBeNull();
  });

  it("dispatches recordCompetitionFiction — a no-op reason when nothing is staging (still a clean dispatch)", async () => {
    const { server } = playerServer();
    const res = (await server.callTool("recordCompetitionFiction", {
      comp: "hoh-competition", week: 1, theme: "t", premise: "p", eliminations: [],
    })) as RecordCompetitionFictionResult;
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe("no-game");
  });

  it("end to end: the staging view surfaces the fixed order, a MATCHED fiction is accepted over the boundary", async () => {
    const { server, session } = playerServer();
    driveToResolvedComp(session);
    const view = (await server.callTool("competitionStagingView", {})) as CompetitionStagingView | null;
    expect(view, "a staged comp should be surfaced once its roll committed").not.toBeNull();
    expect(view!.comp).toBe("hoh-competition");
    expect(view!.dropOrder.length).toBeGreaterThan(1);
    expect(view!.winner.id).toBeTruthy();
    // The library scaffold the model riffs ON is handed over too (the 0042 floor).
    expect(view!.library.premise.length).toBeGreaterThan(0);

    // Before authoring: the staging view reports NO fiction stored yet (the FE's exactly-once guard).
    expect(view!.alreadyAuthored).toBe(false);

    // Author fiction that names the SAME houseguests in the SAME order → accepted.
    const res = (await server.callTool("recordCompetitionFiction", {
      comp: view!.comp, week: view!.week, theme: "The Gauntlet of Whispers",
      premise: "Six houseguests balance on a tilting deck of secrets.",
      eliminations: view!.dropOrder.map((r, i) => ({ id: r.id, fiction: `${r.name} loses their grip, beat ${i + 1}.` })),
    })) as RecordCompetitionFictionResult;
    expect(res.accepted).toBe(true);
    expect(res.reason).toBeUndefined();

    // AFTER authoring: the staging view now reports fiction is stored — the persistent "author exactly
    // once per comp" signal the FE reads to no-op every subsequent round's kickoff (the idempotence fix).
    const after = (await server.callTool("competitionStagingView", {})) as CompetitionStagingView | null;
    expect(after).not.toBeNull();
    expect(after!.alreadyAuthored).toBe(true);
  });

  it("end to end: a REORDERED fiction is REJECTED over the boundary (the 0042 floor stands)", async () => {
    const { server, session } = playerServer();
    driveToResolvedComp(session);
    const view = (await server.callTool("competitionStagingView", {})) as CompetitionStagingView | null;
    expect(view).not.toBeNull();
    const reversed = [...view!.dropOrder].reverse();
    const res = (await server.callTool("recordCompetitionFiction", {
      comp: view!.comp, week: view!.week, theme: "t", premise: "p",
      eliminations: reversed.map((r) => ({ id: r.id, fiction: `${r.name} out.` })),
    })) as RecordCompetitionFictionResult;
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe("drop-order-mismatch");
  });

  it("flag OFF: the staging view is null and the write-back is refused (byte-identical 0042 floor)", async () => {
    const { server, session } = playerServer(false); // generation disabled
    driveToResolvedComp(session);
    expect(await server.callTool("competitionStagingView", {})).toBeNull();
    const res = (await server.callTool("recordCompetitionFiction", {
      comp: "hoh-competition", week: 1, theme: "t", premise: "p", eliminations: [],
    })) as RecordCompetitionFictionResult;
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe("disabled");
  });

  it("refuses a malformed eliminations (a non-array) with a typed field name (E31 arg-guard)", async () => {
    const { server } = playerServer();
    await expect(
      server.callTool("recordCompetitionFiction", { comp: "hoh-competition", week: 1, theme: "t", premise: "p", eliminations: "nope" }),
    ).rejects.toThrow(/eliminations/);
  });

  it("end to end: recorded fiction reaches the comp-elimination beat through advanceGame (presentation wired)", async () => {
    const { server, session } = playerServer();
    driveToResolvedComp(session);
    const view = (await server.callTool("competitionStagingView", {})) as CompetitionStagingView | null;
    expect(view).not.toBeNull();
    await server.callTool("recordCompetitionFiction", {
      comp: view!.comp, week: view!.week, theme: "The Long Silence",
      premise: "A staging of the model's own invention.",
      eliminations: view!.dropOrder.map((r) => ({ id: r.id, fiction: `MODEL-FICTION: ${r.name} steps off the wall.` })),
    });
    // Advance through the remaining reveals; a comp-elimination beat should now read the model's prose.
    let sawFiction = false;
    for (let g = 0; g < 40 && !session.gameStatus().hoh; g++) {
      const adv = session.advanceGame();
      if (adv.event?.beat === "comp-elimination" && adv.event.content.includes("MODEL-FICTION")) sawFiction = true;
    }
    expect(sawFiction, "a staged drop should be told as the model's authored fiction").toBe(true);
  });

  it("engine-side exactly-once: a SECOND valid recordCompetitionFiction is rejected and the stored fiction is unchanged", async () => {
    const { server, session } = playerServer();
    driveToResolvedComp(session);
    const view = (await server.callTool("competitionStagingView", {})) as CompetitionStagingView | null;
    expect(view).not.toBeNull();

    // First write (FIRST-FICTION) is accepted and stored.
    const first = (await server.callTool("recordCompetitionFiction", {
      comp: view!.comp, week: view!.week, theme: "First Theme", premise: "First premise.",
      eliminations: view!.dropOrder.map((r) => ({ id: r.id, fiction: `FIRST-FICTION: ${r.name} is out.` })),
    })) as RecordCompetitionFictionResult;
    expect(first.accepted).toBe(true);

    // A SECOND perfectly VALID write (same fixed order, different prose) is REFUSED — never overwrites.
    const second = (await server.callTool("recordCompetitionFiction", {
      comp: view!.comp, week: view!.week, theme: "Second Theme", premise: "Second premise.",
      eliminations: view!.dropOrder.map((r) => ({ id: r.id, fiction: `SECOND-FICTION: ${r.name} is out.` })),
    })) as RecordCompetitionFictionResult;
    expect(second.accepted).toBe(false);
    expect(second.reason).toBe("already-authored");

    // The STORED fiction is unchanged: the reveals render the FIRST prose, never the rejected second.
    let sawFirst = false;
    let sawSecond = false;
    for (let g = 0; g < 40 && !session.gameStatus().hoh; g++) {
      const adv = session.advanceGame();
      if (adv.event?.beat === "comp-elimination") {
        if (adv.event.content.includes("FIRST-FICTION")) sawFirst = true;
        if (adv.event.content.includes("SECOND-FICTION")) sawSecond = true;
      }
    }
    expect(sawFirst, "the FIRST authored fiction is preserved").toBe(true);
    expect(sawSecond, "the rejected SECOND fiction never reached the reveals").toBe(false);
  });
});
