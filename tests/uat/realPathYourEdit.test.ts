import { quarantine } from "../support/quarantine";
import { describe, it, expect } from "vitest";
import { playSeason } from "../support/whatFired/player";
import { firstSeedWhere } from "../support/firstSeedWhere";

/**
 * ORW-755 (741c): the edit's TURNED, MEETING and SCHEME moments reached in a PLAYED season. ORW-688 / ORW-691 were closed with hand-set tests (the "turned" test sets week, playedGame and finished by hand;
 * the meeting is injected; the scheme was never asserted). Here ONE full season is played through the player channel by the scripted talking player of the nightly report (no model, seeded), to the crown,
 * and the post-season views the player is handed are read: the story of you and them (a "turned" shape), and the edit (a "scheme" moment, a "house-meeting" moment). The meeting is also in the engine's own
 * saved list of meetings the house called, so it is not injected. The off runs: the edit's extra moments switched off (ORWELL_EDIT_MOMENTS, flipped after the crown: the view is a pure read of the season) leaves
 * neither the scheme nor the meeting; the edit off (ORWELL_YOUR_EDIT) leaves no edit; and a second season played with the story off (ORWELL_YOUR_STORY: no weekly samples) has no stories.
 * HEAVY LANE (tests/uat/**, the `real-path` leg): a full season is about 2.5 minutes of play on the runner; two seasons.
 */
type Moments = Array<{ kind: string }>;
const kindsOf = (edit: { episodes: Array<{ moments: Moments }> } | undefined): Set<string> => new Set((edit?.episodes ?? []).flatMap((e) => e.moments.map((m) => m.kind)));
describe("ORW-755 REAL PATH: the edit's moments", () => {
  quarantine({ card: "ORW-1007", added: "2026-11-26" }).it("REAL PATH: turned, meeting and scheme moments are in the views of a played season, and gone when their features are off", async () => {
    // ORW-880: the first seed from 3 whose season is played to the crown with a house meeting called and a houseguest who turned, with the player's own strategy scenes read as a scheme (the precondition: the house's
    // own doing); the test then asserts what the edit and the stories make of it
    let onKinds = new Set<string>(), noMomentsKinds = new Set<string>(), editOff: unknown = "unset", shapes: string[] = [], retro: unknown;
    const { seed, sandbox, at: on } = await firstSeedWhere(async (seed, sandbox) => {
      const on = await playSeason({ user: sandbox,
      seed,
      after: ({ sess }) => {
        retro = sess.seasonRetrospective();
        onKinds = kindsOf((retro as { yourEdit?: never }).yourEdit);
        shapes = ((retro as { yourStories?: { stories: Array<{ shape: string }> } }).yourStories?.stories ?? []).map((s) => s.shape);
        sess.setEditMomentsEnabled(false); // not as shipped: read the post-season edit with the moments off, then back on
        noMomentsKinds = kindsOf(sess.seasonRetrospective().yourEdit);
        sess.setEditMomentsEnabled(true);
        sess.setYourEditEnabled(false); // not as shipped: read the post-season view with the edit off (the season is over)
        editOff = sess.seasonRetrospective().yourEdit;
      },
    });
      return on.stopped === "finished" && (on.milestones["state.houseMeetings"] ?? 0) >= 1 && shapes.includes("turned") && onKinds.has("house-meeting") && onKinds.has("scheme") ? on : undefined;
    }, { from: 1, to: 12, hint: [1, 4], sandbox: (s) => `wf-${s}`, what: "a season to the crown with a house meeting, a turned houseguest, and a house-meeting and a scheme moment in the edit" });
    expect(on.stopped, "the season was played to the crown").toBe("finished");
    // turned: the story of a houseguest who warmed then went cold, reached through the weekly sampler and the real scenes of the season
    expect(shapes).toContain("turned");
    // meeting: called by the house itself (the engine's own saved list), then read into the edit
    expect(on.milestones["state.houseMeetings"]).toBeGreaterThanOrEqual(1);
    expect(onKinds.has("house-meeting")).toBe(true);
    // scheme: the player's own strategy scenes, read as schemes
    expect(onKinds.has("scheme")).toBe(true);
    expect(on.milestones["view.yourEdit.kind:scheme"]).toBeGreaterThanOrEqual(1);
    expect(on.milestones["view.yourStories.shape:turned"]).toBeGreaterThanOrEqual(1);
    // the views are Vault-free (no number, no raw id)
    expect(JSON.stringify((retro as { yourEdit?: unknown }).yourEdit)).not.toMatch(/\d\.\d|npc:\d/);
    // off: the extra moments, and the whole edit
    expect(noMomentsKinds.has("house-meeting")).toBe(false);
    expect(noMomentsKinds.has("scheme")).toBe(false);
    expect(editOff).toBeUndefined();

    // the story off for a whole second season (it is a weekly sampler, so it has to be off while the season is played)
    let storiesOff: unknown = "unset";
    // not as shipped: the flag-off season
    const off = await playSeason({ user: sandbox, seed, setup: (sess) => sess.setYourStoryEnabled(false), after: ({ sess }) => { storiesOff = sess.seasonRetrospective().yourStories; } });
    expect(off.stopped).toBe("finished");
    expect(storiesOff).toBeUndefined();
    expect(off.milestones["view.yourStories.shape:turned"]).toBeUndefined();
  }, 900_000);
});
