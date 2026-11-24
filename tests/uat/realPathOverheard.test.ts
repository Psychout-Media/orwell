import { describe, it, expect } from "vitest";
import { playSeason } from "../support/whatFired/player";
import { firstSeedWhere } from "../support/firstSeedWhere";

/**
 * ORW-756 (741d): OVERHEARD FRAGMENTS in a PLAYED season. A houseguest talking behind a wall or across a room can be half-heard (spec 0049 / 0077: `rollOverhears`, a strict, muffled fragment of the line, low confidence,
 * pathway `overheard:<event>`). Such a fragment carries NO SUBJECT today, so the secret machinery (secret breaks, leverage plays, which key on a fact's subject) never sees it.
 * THIS CARD IS A WALL CALL, NOT A TEST EDIT: a fragment is partial BY DESIGN ("a hidden scene's full content can never reach anyone verbatim through a wall"), and a subject id/name on it would tell the player (or the
 * NPC who half-heard the player) WHO the scene was about, which the words of the fragment do not necessarily support. The engine is therefore left byte-identical here and the design is reported to the Coordinator/Auditor.
 * What this test does is bring overheard fragments into the real-path coverage: in a played season one reaches the player through the engine's own roll, it is a strict fragment (it ends cut off), its pathway is the
 * overheard one, the player's own view carries it without the machine pathway slug, and (the present, deliberate state) it names no subject. If a subject is ever added, THIS assertion is the one to revisit with the wall's ruling.
 * HEAVY LANE (tests/uat/**, the `real-path` leg).
 */
interface Fact { content: string; pathway: string; subject?: string; confidence?: number }
describe("ORW-756 REAL PATH: overheard fragments", () => {
  it("REAL PATH: an overheard fragment reaches the player in a played season as a strict, subject-less fragment (the wall call is open)", async () => {
    // ORW-880: the first seed from 3 whose season gets an overheard fragment to the player (the precondition)
    const { at: { on, fragment, viewKnowledge } } = await firstSeedWhere(async (seed, sandbox) => {
      let fragment: Fact | undefined, viewKnowledge: Array<{ content: string; subject?: string }> = [];
      const on = await playSeason({ user: sandbox,
        seed, maxMessages: 1500,
        watch: ({ engine }) => { fragment = (engine.knowledge.knownTo("player") as Fact[]).find((k) => k.pathway.startsWith("overheard")); return !!fragment; },
        after: async ({ call }) => { viewKnowledge = (await call("getVisibleStateFor", { entity: "player" })).knowledge ?? []; },
      });
      return on.stopped === "watched" ? { on, fragment, viewKnowledge } : undefined;
    }, { from: 1, to: 12, hint: 3, sandbox: (s) => `wf-${s}`, what: "an overheard fragment reaching the player" });
    expect(on.milestones["pathway.overheard"]).toBeGreaterThanOrEqual(1);
    expect(fragment!.content).toMatch(/^\(overheard, muffled\) .+…$/);
    expect(fragment!.subject, "no subject today: adding one needs the wall's ruling (ORW-756)").toBeUndefined();
    // the player's own view holds the same fragment, with no subject either
    const seen = viewKnowledge.find((k) => k.content.includes("(overheard"));
    expect(seen, "the player's view carries the fragment").toBeDefined();
    expect(seen!.subject).toBeUndefined();
  }, 600_000);
});
