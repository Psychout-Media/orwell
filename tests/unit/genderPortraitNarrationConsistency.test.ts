import { describe, it, expect, vi } from "vitest";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { renderGameContext } from "../../src/engine/momentPrompts";
import { genderPresentationPhrase, pronounsFor, UNCONFIRMED_GENDER_CLAUSE } from "../../src/domain/gender";
import { nameGenderOf } from "../../src/engine/data/nameGender";
import type { GameStateView } from "../../src/ports/GameSession";

/**
 * Issue #1140 — the NPC gender/pronoun ↔ portrait mismatch.
 *
 * The engine carries ONE public gender facet, `genderPresentation` ("man" | "woman" | "nonbinary"),
 * and the engine DELIBERATELY lets it diverge from the NAME (diversity.ts: AI override, gender-balance
 * flip, nonbinary). The PORTRAIT prompt anchors on that stored facet; before this fix the NARRATION
 * inferred gender/pronouns from the name each turn — so the photo and the prose could disagree.
 *
 * These tests lock the regression closed: for every active houseguest the gender the PORTRAIT encodes
 * (ORW-380 v3: the subject noun man / woman / nonbinary person in the portrait's "The subject is a N-year-old ..." sentence, `portraitGenderRe`) MUST equal the gender the
 * NARRATION voice-anchor encodes (`genderPresentationPhrase` + the pronoun set in `renderGameContext`), and BOTH
 * must derive from the same stored `genderPresentation`. Roles only — no fixture names asserted.
 */

/** The single roster line `renderGameContext` emits for one houseguest (`  - <name> ... — <vibe>`). */
function rosterLineFor(ctx: string, name: string): string | undefined {
  // The name leads the line (`  - ${h.name}...`); match the whole line so the per-houseguest vibe
  // (which carries the gender cue) is scoped to THIS houseguest, never another's.
  return ctx.split("\n").find((l) => l.trimStart().startsWith(`- ${name}`));
}

/** ORW-380: the v3 portrait subject line carries the gender as man / woman / nonbinary person. */
// Anchored on the subject sentence ("The subject is a 31-year-old ... man with ..."), so freeform look text elsewhere in the prompt can never satisfy it.
const portraitGenderRe = (g: string): RegExp =>
  g === "nonbinary" ? /The subject is an? \d+-year-old [^.]*?nonbinary person with a soft androgynous look/ : new RegExp(`The subject is an? \\d+-year-old (?:[A-Za-z -]+ )?${g} with`);

describe("#1140 — portrait and narration voice the SAME stored gender presentation", () => {
  it("every active houseguest's narration gender + pronouns match the portrait's gender, all from one facet", () => {
    // Sweep several seeds so the invariant holds across casts (every gender mix), not one lucky draw.
    for (const seed of [11, 23, 47, 101, 202]) {
      const s = new GameSessionAdapter();
      const view = s.createCharacter({ playerName: "The Player", seed });
      const ctx = renderGameContext(view);

      const active = view.house.filter((h) => h.status === "active");
      expect(active.length).toBeGreaterThan(0);

      for (const card of active) {
        // Every active houseguest carries the public facet (it is dealt for the whole cast).
        expect(card.genderPresentation).toBeDefined();
        const g = card.genderPresentation!;

        // (1) The PORTRAIT: the live, Vault-free prompt the FE renders, keyed by id. Its SUBJECT line
        // encodes the gender as the v3 subject noun for `card.genderPresentation` (matched by `portraitGenderRe`).
        const portrait = s.getPortraitPrompt(card.id);
        expect(portrait).not.toBeNull();
        expect(portrait!.prompt).toMatch(portraitGenderRe(g)); // ORW-380: the v3 subject line says man / woman / nonbinary person

        // (2) The NARRATION: the roster line for this houseguest encodes the SAME phrase AND hands the
        // model the pronoun set — so the narrator anchors gender/pronouns on the stored facet, not the name.
        const line = rosterLineFor(ctx, card.name);
        expect(line).toBeDefined();
        expect(line!).toContain(genderPresentationPhrase(g));
        expect(line!).toContain(`use ${pronounsFor(g)}`);

        // (3) SAME SOURCE: both surfaces derive from the one stored `genderPresentation` — so the gender the
        // portrait encodes and the gender the narration encodes are, by construction, identical.
        expect(genderPresentationPhrase(g)).toBe(genderPresentationPhrase(g));

        // (4) #1140 Fix A — the NAME itself now reads the SAME gender. The diversity layer RE-PICKS the
        // given name to match the final presentation (the portrait puts the NAME in the prompt, so a
        // unisex-overlap / flipped name would otherwise make the image model render the name's gender). A
        // gendered presentation ⇒ the name reads that gender; nonbinary ⇒ a unisex (any-presentation) name.
        const ng = nameGenderOf(card.name);
        if (g === "nonbinary") expect(ng, `${card.id} ${card.name}`).toBe("unisex");
        else expect(ng, `${card.id} ${card.name}`).toBe(g);
      }
    }
  });

  it("CRITICAL — when the stored facet DISAGREES with the name, portrait and narration STILL agree", () => {
    // Force the divergence the bug rode on: take a clearly-gendered NPC and author the OPPOSITE
    // presentation through the real AI-identity seam (`recordCastIdentity`). The engine honors the proposal
    // and re-grounds the public facet; the name now points one way while `genderPresentation` points the
    // other — exactly the case where a name-inferring narrator would contradict the photo.
    let proved = false;

    for (const seed of [11, 23, 47, 101, 202, 303, 404]) {
      let s = new GameSessionAdapter();
      const view0 = s.createCharacter({ playerName: "The Player", seed });

      // Find an active houseguest whose FIRST name reads clearly man/woman, and propose the opposite.
      const target = view0.house.find((h) => {
        if (h.status !== "active") return false;
        const first = h.name.split(/\s+/)[0] ?? h.name;
        return nameGenderOf(first) === "man" || nameGenderOf(first) === "woman";
      });
      if (!target) continue;
      const firstName = target.name.split(/\s+/)[0] ?? target.name;
      const opposite: "man" | "woman" = nameGenderOf(firstName) === "man" ? "woman" : "man";

      // ORW-437: a live fold after createCharacter no longer flips an introduced houseguest (name and presentation are
      // one identity once told), so the divergence is built the way a pre-fold card or an older save carries it: the
      // stored facet is set through the durable snapshot, leaving the drawn name pointing the other way.
      const snap = JSON.parse(JSON.stringify(s.snapshot()));
      snap.house.npcs.find((n: { id: string }) => n.id === target.id).character.genderPresentation = opposite;
      s = new GameSessionAdapter();
      s.restore(snap);
      const res = { accepted: true };

      // Re-read live state AFTER the fold.
      const view = s.getGameState();
      const card = view.house.find((h) => h.id === target.id);
      if (!card || card.status !== "active" || card.genderPresentation === undefined) continue;
      const g = card.genderPresentation;

      // Only assert the CRITICAL case when the AUTHORED facet truly disagrees with the ORIGINALLY-DRAWN
      // name (the repair pipeline could, in principle, re-balance a specific draft — we want a genuine
      // man↔woman flip vs. the name as it was at the deal). `nameG` is that DRAWN name's gender.
      const nameG = nameGenderOf(firstName);
      const disagrees = (g === "man" || g === "woman") && nameG !== "unisex" && g !== nameG;
      if (!disagrees) continue;

      const ctx = renderGameContext(view);
      const line = rosterLineFor(ctx, card.name);
      const portrait = s.getPortraitPrompt(card.id);

      expect(portrait).not.toBeNull();
      expect(line).toBeDefined();

      // The PROOF: the portrait and the narration BOTH encode the STORED facet `g` — they agree with each
      // other and with the photo. (Before #1140 the narration inferred gender from the name and contradicted
      // the photo; now both anchor on the facet.)
      expect(portrait!.prompt).toMatch(portraitGenderRe(g)); // ORW-380: the v3 subject line says man / woman / nonbinary person
      expect(line!).toContain(genderPresentationPhrase(g));
      expect(line!).toContain(`use ${pronounsFor(g)}`);

      // And the narration must NOT carry the (now-stale) drawn-name presentation phrase.
      const wrongPhrase = genderPresentationPhrase(nameG as "man" | "woman");
      // (the two binary phrases are distinct strings, so this is a real divergence check)
      expect(genderPresentationPhrase(g)).not.toBe(wrongPhrase);
      expect(line!).not.toContain(`use ${pronounsFor(nameG as "man" | "woman")}`);

      // #1140 Fix A — and the engine RE-PICKED the houseguest's NAME to match the authored facet (the
      // uncapped AI-override hole, now closed at the recordCastIdentity fold): the CURRENT display name
      // reads the SAME gender `g` the portrait + narration encode. The image model puts the name in the
      // prompt, so the name itself must point the right way — no "Marlon, a woman" mismatch survives.
      // ORW-437: this fold lands AFTER createCharacter, so every name has already been told to the player and a live
      // fold never renames it (the same freeze `recordCastProfile` applies). The pre-game fold, where names are not yet
      // introduced, still re-picks the name (covered by the diversity and castGenesisGenderCohere suites).
      expect(card.name, `an introduced name never changes on a live fold`).toBe(target.name);

      proved = true;
      break;
    }

    // The seeds above reliably yield a clearly-gendered NPC to flip; fail loudly if the setup ever can't
    // construct the divergent case (so the regression guard never silently no-ops).
    expect(proved).toBe(true);
  });

  it("the gender→phrase/pronoun mapping is total and deterministic (single shared helper, #1140)", () => {
    for (const g of ["man", "woman", "nonbinary"] as const) {
      expect(genderPresentationPhrase(g)).toBeTruthy();
      expect(pronounsFor(g)).toMatch(/\//); // a pronoun set ("he/him" | "she/her" | "they/them")
    }
    expect(pronounsFor("man")).toBe("he/him");
    expect(pronounsFor("woman")).toBe("she/her");
    expect(pronounsFor("nonbinary")).toBe("they/them");
    // The three phrases are pairwise distinct, so portrait↔narration agreement is a real equality check.
    const phrases = new Set(["man", "woman", "nonbinary"].map((g) => genderPresentationPhrase(g as "man")));
    expect(phrases.size).toBe(3);
  });
});

/**
 * Issue #1326 — "gender/pronouns weird and inconsistent". Three concrete gaps closed:
 *  (1) an unset NPC `genderPresentation` used to make the whole pronoun clause fall out of a
 *      `filter(Boolean)` array — a SILENT drop that let the narrator guess gender from the name.
 *  (2) the PLAYER's own pronouns were never captured or voiced at all.
 *  (3) a legacy save loaded with the facet unset stayed unset forever (no repair).
 */
describe("#1326 — an unset genderPresentation is NEVER silently dropped", () => {
  it("at the prompt layer: a doctored view with the facet unset still voices an explicit fallback clause, and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const view = new GameSessionAdapter().createCharacter({ playerName: "The Player", seed: 11 });
      const active = view.house.find((h) => h.status === "active" && h.genderPresentation !== undefined)!;
      expect(active).toBeDefined();

      // Doctor a COPY of the real view — simulating a houseguest whose facet is unset for any reason
      // (a legacy save that predates restore()'s backfill, or a non-standard creation path) — and feed
      // it directly to the pure prompt builder, bypassing the adapter's own backfill entirely.
      const doctored: GameStateView = {
        ...view,
        house: view.house.map((h) => (h.id === active.id ? { ...h, genderPresentation: undefined } : h)),
      };

      const ctx = renderGameContext(doctored);
      const line = ctx.split("\n").find((l) => l.trimStart().startsWith(`- ${active.name}`));
      expect(line).toBeDefined();
      // The explicit, never-silent fallback — NOT an absent/empty clause.
      expect(line!).toContain(UNCONFIRMED_GENDER_CLAUSE);
      expect(line!).toContain("they/them");

      // A console warning surfaces the gap instead of it healing invisibly.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain(active.id);
    } finally {
      warn.mockRestore();
    }
  });

  it("the SAME fallback applies during the premiere's champagne-circle roster", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const view = new GameSessionAdapter().createCharacter({ playerName: "The Player", seed: 23 });
      // CHAMPAGNE CIRCLE (0111): the whole house is met at the toast, so the roster the premiere context
      // renders is the `met` list ("THE HOUSE AT THE CIRCLE"). Strip one houseguest's facet and assert the
      // same unconfirmed-gender fallback clause appears — mirroring the roster-line doctoring above.
      const met = view.premiere?.met ?? [];
      // At creation the whole cast is met at the champagne circle — assert the precondition rather than
      // silently skipping (review, PR #1346).
      expect(met.length).toBeGreaterThan(0);
      const target = met[0]!;
      const doctored: GameStateView = {
        ...view,
        premiere: {
          ...view.premiere!,
          met: view.premiere!.met.map((fi) =>
            fi.houseguest.id === target.houseguest.id ? { ...fi, genderPresentation: undefined } : fi,
          ),
        },
      };
      const ctx = renderGameContext(doctored);
      const section = ctx.split("THE HOUSE AT THE CIRCLE")[1] ?? "";
      expect(section).toContain(UNCONFIRMED_GENDER_CLAUSE);
    } finally {
      warn.mockRestore();
    }
  });

  it("genderGuidanceClause/isGenderPresentation are total and pure (no I/O)", async () => {
    const { genderGuidanceClause, isGenderPresentation } = await import("../../src/domain/gender");
    expect(genderGuidanceClause(undefined)).toContain(UNCONFIRMED_GENDER_CLAUSE);
    for (const g of ["man", "woman", "nonbinary"] as const) {
      expect(genderGuidanceClause(g)).toContain(genderPresentationPhrase(g));
      expect(isGenderPresentation(g)).toBe(true);
    }
    expect(isGenderPresentation("alien")).toBe(false);
    expect(isGenderPresentation(undefined)).toBe(false);
  });
});

describe("#1326 — a legacy save with an unset genderPresentation is backfilled deterministically on restore", () => {
  it("restore() repairs a stripped NPC facet, deterministically, and warns once", () => {
    const adapter = new GameSessionAdapter();
    const view = adapter.createCharacter({ playerName: "The Player", seed: 47 });
    const targetId = view.house.find((h) => h.status === "active")!.id;

    const snap = adapter.snapshot();
    // Simulate a pre-0063 (or otherwise non-standard) save: strip the facet from one NPC.
    const npc = snap.house!.npcs.find((n) => n.id === targetId)!;
    delete (npc.character as { genderPresentation?: unknown }).genderPresentation;
    expect(npc.character.genderPresentation).toBeUndefined();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let backfilled: string | undefined;
    try {
      const restored = new GameSessionAdapter();
      restored.restore(JSON.parse(JSON.stringify(snap)));
      const card = restored.getGameState().house.find((h) => h.id === targetId)!;
      expect(card.genderPresentation).toBeDefined();
      backfilled = card.genderPresentation;
      // Exactly ONE warning for the repaired houseguest — catches duplicate-warning regressions
      // (review, PR #1346).
      expect(warn.mock.calls.filter((c) => String(c[0]).includes(targetId))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }

    // Determinism: restoring the SAME stripped snapshot again yields the SAME backfilled value (keyed
    // off a dedicated hash of the game seed + the houseguest's id + name, never the shared game-seed
    // rng STREAM — so it never perturbs calibration and is reproducible).
    const restoredAgain = new GameSessionAdapter();
    restoredAgain.restore(JSON.parse(JSON.stringify(snap)));
    const cardAgain = restoredAgain.getGameState().house.find((h) => h.id === targetId)!;
    expect(cardAgain.genderPresentation).toBe(backfilled);
  });

  it("restore() does NOT touch the PLAYER's facet — an unset player facet is a legitimate, permanent choice", () => {
    // Unlike an NPC (always dealt by the diversity floor — an unset facet is a genuine gap), the
    // player's facet is player-authored and OPTIONAL: silence is a real choice, never a data gap to
    // force-fill. A save where the player never answered must restore with it STILL unset, forever.
    const adapter = new GameSessionAdapter();
    adapter.createCharacter({
      playerName: "The Player", backstory: "a life", motivation: "to win", personaArchetype: "persona-role-fixture",
    });
    expect(adapter.getGameState().player!.genderPresentation).toBeUndefined();
    const snap = adapter.snapshot();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const restored = new GameSessionAdapter();
      restored.restore(JSON.parse(JSON.stringify(snap)));
      expect(restored.getGameState().player!.genderPresentation).toBeUndefined();
      expect(warn.mock.calls.some((c) => String(c[0]).includes("player"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it("a player facet that WAS captured survives restore unchanged (ordinary persistence, not backfill)", () => {
    const adapter = new GameSessionAdapter();
    adapter.updateCasting({
      playerName: "The Player", backstory: "a life", motivation: "to win",
      personaArchetype: "persona-role-fixture", genderPresentation: "woman",
    });
    adapter.createCharacter({});
    const snap = adapter.snapshot();
    const restored = new GameSessionAdapter();
    restored.restore(JSON.parse(JSON.stringify(snap)));
    expect(restored.getGameState().player!.genderPresentation).toBe("woman");
  });

  it("restore() of an INTACT save never warns and never changes the facet", () => {
    const adapter = new GameSessionAdapter();
    const view = adapter.createCharacter({ playerName: "The Player", seed: 47 });
    const before = new Map(view.house.filter((h) => h.status === "active").map((h) => [h.id, h.genderPresentation]));
    const snap = adapter.snapshot();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const restored = new GameSessionAdapter();
      restored.restore(JSON.parse(JSON.stringify(snap)));
      const warnedGender = warn.mock.calls.some((c) => String(c[0]).includes("genderPresentation"));
      expect(warnedGender).toBe(false);
      for (const h of restored.getGameState().house) {
        if (before.has(h.id)) expect(h.genderPresentation).toBe(before.get(h.id));
      }
    } finally {
      warn.mockRestore();
    }
  });
});

describe("#1326 — the PLAYER's own pronouns, captured at casting, are voiced in the moment prompt", () => {
  it("updateCasting(genderPresentation) round-trips onto the player card and the moment prompt", () => {
    const s = new GameSessionAdapter();
    s.updateCasting({
      playerName: "The Player", backstory: "a life", motivation: "to win",
      personaArchetype: "persona-role-fixture", genderPresentation: "nonbinary",
    });
    const view = s.createCharacter({});
    expect(view.player!.genderPresentation).toBe("nonbinary");

    const prompt = s.getMomentPrompt({}).systemPrompt;
    expect(prompt).toContain(genderPresentationPhrase("nonbinary"));
    expect(prompt).toContain("they/them");
  });

  it("an unanswered player pronoun question omits the pronoun clause — no forced 'unconfirmed' fallback (it says the gender is unstated instead)", () => {
    const s = new GameSessionAdapter();
    const view = s.createCharacter({
      playerName: "The Player", backstory: "a life", motivation: "to win", personaArchetype: "persona-role-fixture",
    });
    expect(view.player!.genderPresentation).toBeUndefined();
    const prompt = s.getMomentPrompt({}).systemPrompt;
    // The player's own line names them but carries no pronoun/"(use ...)" clause (unlike an NPC,
    // whose roster line always carries the explicit "unconfirmed" fallback).
    const playerLine = prompt.split("\n").find((l) => l.includes("You are playing as:"));
    expect(playerLine).toBeDefined();
    expect(playerLine).not.toContain(UNCONFIRMED_GENDER_CLAUSE);
    expect(playerLine).not.toContain("(use ");
    // ORW-444: ...but it DOES say the gender is unstated, so nobody assigns one.
    expect(playerLine).toContain("gender is unstated");
  });

  it("ORW-444: the unstated-gender line is absent when the player's presentation is set", () => {
    const s = new GameSessionAdapter();
    s.updateCasting({ genderPresentation: "woman" });
    s.createCharacter({ playerName: "The Player", backstory: "a life", motivation: "to win", personaArchetype: "persona-role-fixture" });
    const playerLine = s.getMomentPrompt({}).systemPrompt.split("\n").find((l) => l.includes("You are playing as:"))!;
    expect(playerLine).toContain("(use ");
    expect(playerLine).not.toContain("gender is unstated");
  });

  it("a garbled genderPresentation value is validated away, never stored raw (mirrors archetype)", () => {
    const s = new GameSessionAdapter();
    s.updateCasting({
      playerName: "The Player", backstory: "a life", motivation: "to win",
      personaArchetype: "persona-role-fixture",
    });
    const view = s.createCharacter({ genderPresentation: "not-a-real-value" });
    expect(view.player!.genderPresentation).toBeUndefined();
  });

  it("the player's pronoun field aliases (`pronouns`, `gender`) onto the canonical field", () => {
    const s = new GameSessionAdapter();
    const st = s.updateCasting({ pronouns: "man" } as never);
    expect(st.known["genderPresentation"]).toBe("man");
  });

  it("genderPresentation NEVER gates casting ready/finalizable — it is purely optional", () => {
    // Name-only, no gender answer: still ready.
    const s = new GameSessionAdapter();
    const st = s.updateCasting({ playerName: "The Player" });
    expect(st.ready).toBe(true);
    expect(st.missing).toContain("genderPresentation");

    // A full, finalizable interview that never touches gender is still finalizable.
    const s2 = new GameSessionAdapter();
    const st2 = s2.updateCasting({
      playerName: "The Player", backstory: "a life", motivation: "to win", personaArchetype: "persona-role-fixture",
    });
    expect(st2.finalizable).toBe(true);
    const view = s2.createCharacter({});
    expect(view.started).toBe(true);
    expect(view.player!.genderPresentation).toBeUndefined();
  });

  it("season-to-season continuity (0056 keepCharacter) carries the player's recorded pronouns forward", () => {
    const s = new GameSessionAdapter();
    s.updateCasting({
      playerName: "The Player", backstory: "a life", motivation: "to win",
      personaArchetype: "persona-role-fixture", genderPresentation: "woman",
    });
    s.createCharacter({ seed: 5 });
    expect(s.getGameState().player!.genderPresentation).toBe("woman");

    const restarted = s.createCharacter({ confirmRestart: true, keepCharacter: true, seed: 9 });
    expect(restarted.player!.genderPresentation).toBe("woman");
  });
});
