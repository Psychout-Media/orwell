import { describe, it, expect } from "vitest";
import { buildPortraitPrompt, buildCastPortraitPrompts } from "../../src/engine/portraitPrompts";
import { IMAGE_BUDGET, STYLE_ANCHOR_VARIANTS, LEGACY_STYLE_ANCHOR_VARIANTS, WORN_TEXTURE_VARIANTS, BACKDROP_VARIANTS } from "../../src/engine/imageConstants";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { buildEngineCore } from "../../src/composition/engineRoot";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";

/**
 * Feature 0051 — in-character images. The portrait prompt builder is the Vault-Wall gate: it draws
 * ONLY public appearance facets + the per-season style anchor, so no stat / soul / hidden element
 * can ever ride out to an image provider. HARD rule: roles only — no names, generated fixtures only.
 */
describe("0051 — portrait prompts (Vault-free builder)", () => {
  const styleAnchor = STYLE_ANCHOR_VARIANTS[0]!;

  it("buildPortraitPrompt assembles a prompt from the style anchor + public facets", () => {
    const result = buildPortraitPrompt("hg:1", "A Houseguest", {
      appearance: "athletic, close-cropped hair, a warm smile",
      age: 28,
      presentation: "confident and easygoing",
    }, styleAnchor);
    expect(result.houseguestId).toBe("hg:1");
    expect(result.prompt).toContain(styleAnchor);
    expect(result.prompt).toContain("28");
    expect(result.prompt).toContain("athletic, close-cropped hair, a warm smile");
    expect(result.prompt).toContain("confident and easygoing");
  });

  it("buildCastPortraitPrompts builds one prompt per houseguest with complete public facets", () => {
    const cast = [
      { id: "hg:1", name: "Houseguest One", appearance: "tall", age: 25, presentation: "loud" },
      { id: "hg:2", name: "Houseguest Two", appearance: "short", age: 30, presentation: "quiet" },
      { id: "hg:3", name: "Houseguest Three" }, // missing facets — filtered out
    ];
    const prompts = buildCastPortraitPrompts(cast, styleAnchor);
    expect(prompts).toHaveLength(2);
    expect(prompts.map((p) => p.houseguestId)).toEqual(["hg:1", "hg:2"]);
    for (const p of prompts) expect(p.prompt).toContain(styleAnchor);
  });

  it("L29 — the structured physical facet AUTHORS the appearance line (distinct faces, one source of truth)", () => {
    const facetA = {
      heightBuild: "tall and broad-shouldered", skinTone: "deep brown skin", hair: "a close-cropped fade",
      facialFeatures: "a square jaw and deep-set eyes", distinguishingMark: "a half-sleeve tattoo",
      ageLook: "settled, thirties presence", style: "streetwear and bold sneakers",
    };
    const facetB = {
      heightBuild: "petite and slight", skinTone: "fair freckled skin", hair: "a platinum-blond bob",
      facialFeatures: "round soft features", distinguishingMark: "none notable",
      ageLook: "youthful, early-twenties energy", style: "preppy and buttoned-up",
    };
    const a = buildPortraitPrompt("hg:1", "One", { appearance: "ignored prose", age: 34, presentation: "warm", physicalCharacteristics: facetA }, styleAnchor);
    const b = buildPortraitPrompt("hg:2", "Two", { appearance: "ignored prose", age: 22, presentation: "shy", physicalCharacteristics: facetB }, styleAnchor);
    // The facet, not the prose, drives the physical line.
    expect(a.prompt).toContain("deep brown skin");
    expect(a.prompt).toContain("a close-cropped fade");
    expect(a.prompt).not.toContain("ignored prose");
    // The facet's style folds into the presentation line.
    expect(a.prompt).toContain("streetwear and bold sneakers");
    // A "none notable" mark is omitted (never a literal instruction to the model).
    expect(b.prompt).not.toContain("none notable");
    // Two different people read as materially different physical descriptions.
    const physOf = (p: string) => p.split("Physical appearance: ")[1]!.split(". Presentation")[0]!;
    expect(physOf(a.prompt)).not.toBe(physOf(b.prompt));
  });

  it("L29 — the live cast portrait prompts consume the seeded physical facet", () => {
    const adapter = new GameSessionAdapter();
    const view = adapter.createCharacter({ playerName: "The Player", seed: 31 });
    const npc = view.house.find((h) => h.physicalCharacteristics)!;
    expect(npc).toBeTruthy();
    const pp = adapter.getPortraitPrompt(npc.id as EntityId)!;
    // the seeded facet's skin tone (a public field on the card) appears in the prompt's physical line
    expect(pp.prompt).toContain(npc.physicalCharacteristics!.skinTone);
    expect(pp.prompt).toContain(npc.physicalCharacteristics!.hair);
  });

  it("the AUTHORED storyline facets ride the prompt: freeform identity (0116) + vocation (L28/0058)", () => {
    const result = buildPortraitPrompt("hg:1", "A Houseguest", {
      appearance: "athletic, close-cropped hair, a warm smile",
      age: 28,
      presentation: "confident and easygoing",
      identityConcept: "a chaos-agent podcaster who treats the house like a live show",
      vocation: "true-crime podcaster",
    }, styleAnchor);
    // Both authored facets appear — the shot's wardrobe/vibe can match the person's storyline.
    expect(result.prompt).toContain("a chaos-agent podcaster who treats the house like a live show");
    expect(result.prompt).toContain("Occupation: true-crime podcaster");
    // They ride BEFORE the shared season anchor (#1317: subject-specific content leads).
    expect(result.prompt.indexOf("chaos-agent podcaster")).toBeLessThan(result.prompt.indexOf(styleAnchor));
  });

  it("absent storyline facets ⇒ byte-identical prompt (the deterministic floor cast is untouched)", () => {
    const facets = {
      appearance: "athletic, close-cropped hair, a warm smile",
      age: 28,
      presentation: "confident and easygoing",
    };
    const withoutNew = buildPortraitPrompt("hg:1", "A Houseguest", facets, styleAnchor);
    // No identityConcept/vocation ⇒ no new clause of any kind sneaks in.
    expect(withoutNew.prompt).not.toContain("Character:");
    expect(withoutNew.prompt).not.toContain("Occupation:");
  });

  it("bundle-audit 2026-07-13 — the Subject line never repeats the gender phrase in a parenthetical", () => {
    // The prod bundle showed "…nonbinary presentation, …, named X (a person of androgynous,
    // nonbinary presentation)": the #1140 de-bias parenthetical duplicated the lead phrase inside
    // one Subject line. Deduped: when the phrase already opens the subject clause, the name rides
    // plain; the phrase still appears exactly once (the lead), and the #1317 build/hair clause
    // still carries gendered styling further down.
    for (const gender of ["man", "woman", "nonbinary"] as const) {
      const r = buildPortraitPrompt("hg:1", "A Houseguest", {
        appearance: "athletic, close-cropped hair, a warm smile",
        age: 28,
        presentation: "confident and easygoing",
        genderPresentation: gender,
      }, styleAnchor);
      const subject = r.prompt.split(". ")[0]!; // the Subject clause
      const phrase = gender === "man" ? "a man (masculine presentation)"
        : gender === "woman" ? "a woman (feminine presentation)"
        : "a person of androgynous, nonbinary presentation";
      // Exactly ONE occurrence of the phrase in the subject clause — the lead, not a paren echo.
      expect(subject.split(phrase).length - 1).toBe(1);
      expect(subject).toContain("named A Houseguest");
      expect(subject).not.toContain(`named A Houseguest (${phrase})`);
    }
  });

  it("bundle-audit 2026-07-13 — no gender facet ⇒ the plain `named X` tag (byte-identical legacy path)", () => {
    const r = buildPortraitPrompt("hg:1", "A Houseguest", {
      appearance: "athletic, close-cropped hair, a warm smile",
      age: 28,
      presentation: "confident and easygoing",
    }, styleAnchor);
    const subject = r.prompt.split(". ")[0]!;
    expect(subject).toContain("named A Houseguest");
    expect(subject).not.toContain("named A Houseguest (");
  });

  it("IMAGE_BUDGET bounds generation: per-turn cap < per-week cap, move-in exempt", () => {
    expect(IMAGE_BUDGET.perTurnCap).toBeGreaterThan(0);
    expect(IMAGE_BUDGET.perWeekCap).toBeGreaterThan(IMAGE_BUDGET.perTurnCap);
    expect(IMAGE_BUDGET.moveInPortraitExempt).toBe(true);
  });
});

describe("0051 — createCharacter portrait prompts (cast NPCs, Vault-free)", () => {
  it("returns one portrait prompt per NPC; the PLAYER is excluded (#529 — no name-hash face)", () => {
    const adapter = new GameSessionAdapter();
    const view = adapter.createCharacter({ playerName: "The Player", seed: 42 });
    expect(view.portraitPrompts).toBeDefined();
    // #529: the player authored no look, so they get NO improvised portrait — the cast pipeline
    // covers the 15 generated NPCs only (the player's avatar is FE-owned, never name-hash derived).
    expect(view.portraitPrompts!.length).toBe(view.house.length);
    for (const pp of view.portraitPrompts!) {
      expect(pp.houseguestId).toBeTruthy();
      expect(pp.name).toBeTruthy();
      expect(pp.prompt).toContain("photorealistic");
    }
    // The player is NOT in the cast portrait set.
    expect(view.portraitPrompts!.some((p) => p.houseguestId === PLAYER)).toBe(false);
  });

  it("same seed draws the SAME style anchor; a different seed (usually) draws a different one", () => {
    const anchorOf = (seed: number): string => {
      const a = new GameSessionAdapter();
      const v = a.createCharacter({ playerName: "The Player", seed });
      // The anchor is the shared photorealistic prefix every prompt carries; lift it from an NPC's
      // prompt (the player has no portrait — #529).
      const pp = a.getPortraitPrompt(v.house[0]!.id as EntityId)!;
      // #1317: the anchor is no longer prompt-initial (distinguishing subject/physical facets now
      // lead the composition) — find it by CONTENT rather than position.
      return (STYLE_ANCHOR_VARIANTS as readonly string[]).find((v2) => pp.prompt.includes(v2))!;
    };
    // Same seed → identical anchor, every time.
    expect(anchorOf(100)).toBe(anchorOf(100));
    // Sweep a span of seeds: at least two distinct anchors appear (not a constant).
    const seen = new Set<string>();
    for (let s = 0; s < 40; s++) seen.add(anchorOf(s));
    expect(seen.size).toBeGreaterThan(1);
    // Every drawn anchor is one of the declared variants (no invented styles).
    for (const a of seen) expect(STYLE_ANCHOR_VARIANTS as readonly string[]).toContain(a);
  });

  it("getPortraitPrompt returns a houseguest's prompt by id, and null for an unknown id", () => {
    const adapter = new GameSessionAdapter();
    const view = adapter.createCharacter({ playerName: "The Player", seed: 7 });
    const someNpc = view.house[0]!;
    const got = adapter.getPortraitPrompt(someNpc.id as EntityId);
    expect(got).not.toBeNull();
    expect(got!.houseguestId).toBe(someNpc.id);
    expect(got!.name).toBe(someNpc.name);
    expect(got!.prompt).toContain("photorealistic");

    expect(adapter.getPortraitPrompt("npc:does-not-exist" as EntityId)).toBeNull();
  });

  it("getPortraitPrompt returns null before any game has started (and before any pre-warm)", () => {
    const adapter = new GameSessionAdapter();
    expect(adapter.getPortraitPrompt(PLAYER)).toBeNull();
  });

  it("PRE-GAME, getPortraitPrompt serves the WARMED pre-seed cast (0065/ADR 0013 fresh-fetch)", () => {
    const adapter = new GameSessionAdapter();
    const warm = adapter.preSeedCast({});
    expect(warm.warmed).toBe(true);
    const npc = warm.house[0]!;
    // No live house yet — the warmed roster serves the prompt.
    const before = adapter.getPortraitPrompt(npc.id as EntityId);
    expect(before).not.toBeNull();
    expect(before!.houseguestId).toBe(npc.id);
    expect(before!.prompt).toContain("photorealistic");
    // A pre-game authoring write-back MUTATES the warm store — the served prompt must reflect the
    // store AS IT STANDS (the per-NPC authored shoot fetches at shoot time, never a stale snapshot).
    adapter.recordCastProfile({
      houseguestId: npc.id as EntityId,
      vocation: "storm-chasing meteorologist",
      physicalCharacteristics: {
        heightBuild: "tall and wiry", skinTone: "olive skin", hair: "windswept dark curls",
        facialFeatures: "sharp cheekbones", distinguishingMark: "a sunburn line", ageLook: "early thirties",
        style: "field jackets and scuffed boots",
      },
    });
    const after = adapter.getPortraitPrompt(npc.id as EntityId)!;
    expect(after.prompt).toContain("storm-chasing meteorologist");
    expect(after.prompt).toContain("windswept dark curls");
    // An unknown id still yields null pre-game.
    expect(adapter.getPortraitPrompt("npc:does-not-exist" as EntityId)).toBeNull();
  });
});

describe("0051 — sentinel sweep: hidden-layer content NEVER reaches a portrait prompt", () => {
  it("a houseguest whose HIDDEN fields carry sentinels yields a prompt containing NONE of them", () => {
    const adapter = new GameSessionAdapter();
    adapter.createCharacter({ playerName: "The Player", seed: 9 });

    // Snapshot the live house, then poison every hidden surface of one NPC + the player with a
    // unique sentinel. Portrait prompts read ONLY public facets, so a restored read must be clean.
    const snap = adapter.snapshot();
    const SENTINEL = "SENTINEL-HIDDEN-0051-DO-NOT-SURFACE";
    const poison = (hg: { character: { stats: { physical: number; mental: number; social: number };
      hiddenElements: { kind: "secret-motive"; detail: string }[] };
      soul: { memory: string[] } }) => {
      hg.character.hiddenElements.push({ kind: "secret-motive", detail: `${SENTINEL}-motive` });
      hg.soul.memory.push(`${SENTINEL}-memory`);
      // Stats are hidden too — make them recognizable strings if they ever stringified into a prompt.
      hg.character.stats.physical = 99999;
    };
    poison(snap.house!.npcs[0]! as unknown as Parameters<typeof poison>[0]);
    poison(snap.house!.player as unknown as Parameters<typeof poison>[0]);
    // The AUTHORED storyline facets are PUBLIC — they may (and should) ride the prompt, proving the
    // new fields draw from the public Character only, never dragging the poisoned hidden layer along.
    (snap.house!.npcs[0]! as unknown as { character: { identityConcept?: string; vocation?: string } })
      .character.identityConcept = "a retired rodeo clown chasing one last spotlight";
    (snap.house!.npcs[0]! as unknown as { character: { identityConcept?: string; vocation?: string } })
      .character.vocation = "rodeo clown";

    const adapter2 = new GameSessionAdapter();
    adapter2.restore(snap);

    // The NPC yields a clean prompt; the PLAYER yields NO prompt at all (#529 — no name-hash face),
    // which is the strongest no-leak guarantee for the player: nothing to draw, nothing to leak.
    const pp = adapter2.getPortraitPrompt(snap.house!.npcs[0]!.id)!;
    expect(pp).not.toBeNull();
    expect(pp.prompt).not.toContain(SENTINEL);
    expect(pp.prompt).not.toContain("99999"); // no hidden stat leaked
    expect(pp.prompt).toContain("a retired rodeo clown chasing one last spotlight"); // public facet rides
    expect(pp.prompt).toContain("Occupation: rodeo clown");
    expect(adapter2.getPortraitPrompt(PLAYER)).toBeNull();
    // The full cast response is clean too.
    const fresh = new GameSessionAdapter();
    const view = fresh.createCharacter({ playerName: "The Player", seed: 9 });
    for (const pp of view.portraitPrompts!) {
      expect(pp.prompt).not.toMatch(/\b(trust|affinity|threat|soul|confessional|secret-motive)\b/i);
    }
  });
});

describe("0051 — portraitStyleAnchor persistence (non-degradation)", () => {
  it("survives a save → load round-trip and keeps the same look", () => {
    const adapter = new GameSessionAdapter();
    const view = adapter.createCharacter({ playerName: "The Player", seed: 42 });
    // Lift the anchor from an NPC prompt by CONTENT (#1317 — no longer prompt-initial; the player has
    // no portrait — #529).
    const findAnchor = (prompt: string) => (STYLE_ANCHOR_VARIANTS as readonly string[]).find((v) => prompt.includes(v))!;
    const beforeAnchor = findAnchor(adapter.getPortraitPrompt(view.house[0]!.id as EntityId)!.prompt);

    const snap = adapter.snapshot();
    expect(snap.portraitStyleAnchor).toBeTruthy();
    expect(snap.portraitStyleAnchor).toBe(beforeAnchor);

    const restored = new GameSessionAdapter();
    restored.restore(snap);
    const afterAnchor = findAnchor(restored.getPortraitPrompt(view.house[0]!.id as EntityId)!.prompt);
    expect(afterAnchor).toBe(beforeAnchor);
  });

  it("a legacy save with no anchor (but a seed) re-seeds a stable, declared anchor", () => {
    const adapter = new GameSessionAdapter();
    const view = adapter.createCharacter({ playerName: "The Player", seed: 77 });
    const npcId = view.house[0]!.id as EntityId;
    const snap = adapter.snapshot();
    // Simulate a pre-0051 save: drop the anchor field, keep the seed.
    delete (snap as { portraitStyleAnchor?: string }).portraitStyleAnchor;

    const restored = new GameSessionAdapter();
    restored.restore(snap);
    // Lift the anchor from an NPC prompt by CONTENT (#1317 — no longer prompt-initial; the player has
    // no portrait — #529).
    const pp = restored.getPortraitPrompt(npcId)!;
    expect(pp).not.toBeNull();
    const anchor = (STYLE_ANCHOR_VARIANTS as readonly string[]).find((v) => pp.prompt.includes(v))!;
    expect(STYLE_ANCHOR_VARIANTS as readonly string[]).toContain(anchor);
  });
});

describe("0051 — recordImageBeat (recorded or it didn't happen; player-witnessed, never Vault)", () => {
  it("records a player-witnessed, non-hidden image-shown event", () => {
    const core = buildEngineCore();
    const cmd = new EngineCommandsAdapter(core.events, core.knowledge, core.relationships);

    const { eventId } = cmd.recordImageBeat({ houseguestId: "npc:1", imageRef: "img-ref-abc" });
    expect(eventId).toBeTruthy();

    const ev = core.events.queryAll().find((e) => e.id === eventId)!;
    expect(ev).toBeDefined();
    expect(ev.type).toBe("image-shown");
    // Player-witnessed by construction ⇒ never hidden ⇒ never an off-screen/Vault secret.
    expect(ev.witnessSet).toContain(PLAYER);
    expect(ev.hidden).toBe(false);
  });

  it("the image beat is NOT recorded as off-screen/secret (Vault read excludes it)", () => {
    const core = buildEngineCore();
    const cmd = new EngineCommandsAdapter(core.events, core.knowledge, core.relationships);
    const { eventId } = cmd.recordImageBeat({ houseguestId: "npc:2", imageRef: "img-ref-xyz" });

    // No hidden event carries this beat (it is the player's own knowledge, Journal-visible).
    const hiddenEvents = core.events.queryAll().filter((e) => e.hidden);
    expect(hiddenEvents.some((e) => e.id === eventId)).toBe(false);
    // The Vault's hidden-attribute store never gained a record for it either.
    const vaultRecords = core.vault.readHidden();
    expect(vaultRecords.some((r) => r.content.includes("img-ref-xyz"))).toBe(false);
  });
});

/** ORW-361 — portrait prompt v2: explicit age, written face, faint mark, wardrobe/on-camera, frame rules. */
describe("ORW-361 — portrait prompt v2", () => {
  const anchor = STYLE_ANCHOR_VARIANTS[2]!;
  const facet = {
    heightBuild: "tall and lean", skinTone: "warm brown skin", hair: "short dark curls",
    facialFeatures: "a narrow nose, wide-set eyes and a square jaw", distinguishingMark: "a thin scar through the left eyebrow",
    ageLook: "looks their age, crisp and youthful", style: "relaxed streetwear",
  };
  const base = { appearance: "legacy prose appearance", age: 27, presentation: "easygoing", ethnicity: "West African",
    genderPresentation: "man" as const, demeanor: "warm and guarded", identityConcept: "a chaos-agent podcaster", vocation: "podcaster" };
  const withNew = buildPortraitPrompt("hg:7", "Fixture One", {
    ...base, physicalCharacteristics: { ...facet, wardrobe: ["a faded grey hoodie", "dark jeans"], onCamera: "leans in, mischievous, mid-story" } as never,
  }, anchor).prompt;
  const withoutNew = buildPortraitPrompt("hg:7", "Fixture One", { ...base, physicalCharacteristics: facet }, anchor).prompt;
  const legacy = buildPortraitPrompt("hg:7", "Fixture One", base, anchor).prompt;
  const lines = (p: string) => p.split(". ");
  const MARK = "Mark (subtle: faint, small and long-healed, never a fresh wound, bruise or stain): a thin scar through the left eyebrow";
  const FRAME = "The only person in the frame. No text, logos, badges or screens, and no photos on the walls. At home in the Orwell house, not at work.";

  it("states the age explicitly in every path", () => {
    for (const p of [withNew, withoutNew, legacy]) {
      expect(p).toContain("who looks exactly 27 years old");
      expect(p.startsWith("Subject: a man")).toBe(true);
    }
  });

  it("a written face drops the random Facial structure line; legacy keeps it", () => {
    expect(withNew).not.toContain("Facial structure:");
    expect(withoutNew).not.toContain("Facial structure:");
    expect(legacy).toContain("Facial structure:");
  });

  it("the appearance line has no mark and no style; the mark is faint and said once", () => {
    const phys = withoutNew.split("Physical appearance: ")[1]!.split(". ")[0]!;
    expect(phys).toBe("tall and lean, warm brown skin, short dark curls, a narrow nose, wide-set eyes and a square jaw, looks their age, crisp and youthful");
    for (const p of [withNew, withoutNew]) {
      expect(p).toContain(MARK);
      expect(p.split("thin scar through the left eyebrow").length - 1).toBe(1);
    }
  });

  it("Wearing replaces the style line when a wardrobe is written; otherwise one style only", () => {
    expect(withNew).toContain("Wearing: a faded grey hoodie, dark jeans");
    expect(withNew).not.toContain("Presentation style:");
    expect(withNew).not.toContain("relaxed streetwear");
    expect(withoutNew).toContain("Presentation style: relaxed streetwear");
    expect(withoutNew).not.toContain("easygoing");
    expect(withoutNew).not.toContain("Wearing:");
    expect(legacy).toContain("Presentation style: easygoing");
  });

  it("On camera is the last line and replaces Character, Expression and Setting; otherwise they stay", () => {
    const l = lines(withNew);
    expect(l[l.length - 1]).toBe("On camera: leans in, mischievous, mid-story");
    for (const k of ["Character:", "Expression:", "Setting:", "Distinctive look:"]) expect(withNew).not.toContain(k);
    expect(withNew).toContain("Lighting:");
    expect(withNew).toContain("Framing:");
    for (const p of [withoutNew, legacy]) {
      expect(p).toContain("Character: a chaos-agent podcaster");
      expect(p).toContain("Expression:");
      expect(p).toContain("Setting:");
      expect(p).not.toContain("On camera:");
    }
  });

  it("closing line: written face restates the face only; legacy is unchanged", () => {
    expect(withoutNew).toMatch(/Distinctive look: a narrow nose, wide-set eyes and a square jaw$/);
    expect(legacy).toMatch(/Distinctive look: legacy prose appearance$/);
  });

  it("carries the frame rules right after the anchor and never says Big Brother", () => {
    for (const p of [withNew, withoutNew, legacy]) {
      expect(p).toContain(FRAME);
      expect(p).not.toMatch(/Big Brother/i);
      expect(p.indexOf(FRAME)).toBeGreaterThan(p.indexOf(anchor));
    }
    for (const a of STYLE_ANCHOR_VARIANTS) {
      expect(buildPortraitPrompt("hg:1", "F", base, a).prompt).not.toMatch(/Big Brother/);
    }
    const old = "photorealistic candid moment captured on a reality TV set, lived-in skin texture, Big Brother house behind";
    const p = buildPortraitPrompt("hg:1", "F", base, old).prompt;
    expect(p).not.toMatch(/Big Brother/);
    expect(p).toContain("Orwell house behind");
  });

  it("worn skin texture only when the age-look says worn; healthy skin otherwise", () => {
    expect(withNew).toContain("Skin: natural, healthy skin with real texture");
    const worn = buildPortraitPrompt("hg:7", "F", { ...base, physicalCharacteristics: { ...facet, ageLook: "weathered, sun-creased, older than their years" } }, anchor).prompt;
    expect(worn).toContain(`Skin: ${WORN_TEXTURE_VARIANTS[2]}`);
    expect(worn).not.toContain("healthy skin");
    for (const w of WORN_TEXTURE_VARIANTS) expect(withNew).not.toContain(w);
  });

  it("each pre-ORW-361 stored anchor maps to the new anchor: no Big Brother, no worn cue unless worn", () => {
    LEGACY_STYLE_ANCHOR_VARIANTS.forEach((legacyAnchor, i) => {
      const p = buildPortraitPrompt("hg:7", "F", { ...base, physicalCharacteristics: facet }, legacyAnchor).prompt;
      expect(p).toContain(STYLE_ANCHOR_VARIANTS[i]!);
      expect(p).not.toMatch(/Big Brother|unretouched|true-to-life|lived-in|honest|blemish|pores/);
      const w = buildPortraitPrompt("hg:7", "F", { ...base, physicalCharacteristics: { ...facet, ageLook: "tired, worn" } }, legacyAnchor).prompt;
      expect(w).toContain(`Skin: ${WORN_TEXTURE_VARIANTS[i]}`);
    });
  });

  it("the mark is said once even with no written face, and no empty facet part renders ', ,'", () => {
    const p = buildPortraitPrompt("hg:7", "F", { ...base, physicalCharacteristics: { ...facet, facialFeatures: "", ageLook: "" } }, anchor).prompt;
    expect(p.split("thin scar through the left eyebrow").length - 1).toBe(1);
    expect(p).toContain("Facial structure:");
    expect(p).not.toMatch(/, ,|,\s*\./);
  });

  it("frame rules come immediately after the anchor, then Skin", () => {
    const l = withNew.split(". ");
    const i = l.findIndex((x) => x.includes("Orwell house") && x.startsWith("photorealistic"));
    expect(l[i + 1]).toBe("The only person in the frame");
    expect(l.find((x) => x.startsWith("Skin:"))).toBeTruthy();
    expect(withNew.indexOf("Skin:")).toBeGreaterThan(withNew.indexOf("At home in the Orwell house"));
  });

  it("no mark line for 'none' and no memory-wall backdrop", () => {
    const p = buildPortraitPrompt("hg:7", "F", { ...base, physicalCharacteristics: { ...facet, distinguishingMark: "none notable" } }, anchor).prompt;
    expect(p).not.toContain("Mark (subtle");
    expect(p).not.toContain("none notable");
    for (const b of BACKDROP_VARIANTS) expect(b).not.toMatch(/memory wall/);
  });

  it("empty or malformed wardrobe/onCamera fall back", () => {
    const p = buildPortraitPrompt("hg:7", "F", { ...base, physicalCharacteristics: { ...facet, wardrobe: [" ", 3], onCamera: "  " } as never }, anchor).prompt;
    expect(p).toContain("Presentation style: relaxed streetwear");
    expect(p).toContain("Character:");
    expect(p).not.toContain("On camera:");
  });

  it("prints the three example prompts", () => {
    if (process.env.ORW361_PRINT) console.log(`\nWRITTEN+NEW:\n${withNew}\n\nWRITTEN:\n${withoutNew}\n\nLEGACY:\n${legacy}\n`);
  });
});
