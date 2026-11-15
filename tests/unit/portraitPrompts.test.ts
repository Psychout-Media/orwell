import { describe, it, expect } from "vitest";
import { buildPortraitPrompt, buildCastPortraitPrompts, trimWrittenHair, signatureMarkClause } from "../../src/engine/portraitPrompts";
import { IMAGE_BUDGET, STYLE_ANCHOR_VARIANTS } from "../../src/engine/imageConstants";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import { EngineCommandsAdapter } from "../../src/adapters/engine/EngineCommandsAdapter";
import { buildEngineCore } from "../../src/composition/engineRoot";
import { PLAYER } from "../../src/domain/ids";
import type { EntityId } from "../../src/domain/ids";
import { fnv1a } from "../../src/domain/num";


/**
 * Feature 0051 — in-character images. The portrait prompt builder is the Vault-Wall gate: it draws
 * ONLY public appearance facets + the per-season style anchor, so no stat / soul / hidden element
 * can ever ride out to an image provider. HARD rule: roles only — no names, generated fixtures only.
 */

describe("0051 — portrait prompts (Vault-free builder)", () => {
  const styleAnchor = STYLE_ANCHOR_VARIANTS[0]!;

  it("buildPortraitPrompt builds one paragraph from the public facets (the anchor is not sent)", () => {
    const result = buildPortraitPrompt("hg:1", "A Houseguest", {
      appearance: "athletic, close-cropped hair, a warm smile",
      age: 28,
      presentation: "confident and easygoing",
    }, styleAnchor);
    expect(result.houseguestId).toBe("hg:1");
    expect(result.prompt).not.toContain(styleAnchor);
    expect(result.prompt).not.toContain("A Houseguest");
    expect(result.prompt).toContain("28-year-old");
    expect(result.prompt).toContain("athletic, close-cropped hair, a warm smile");
    expect(result.prompt).toContain("confident and easygoing");
    expect(result.prompt).not.toContain("\n");
  });

  it("buildCastPortraitPrompts builds one prompt per houseguest with complete public facets", () => {
    const cast = [
      { id: "hg:1", name: "Houseguest One", appearance: "tall", age: 25, presentation: "loud" },
      { id: "hg:2", name: "Houseguest Two", appearance: "short", age: 30, presentation: "quiet" },
      { id: "hg:3", name: "Houseguest Three" }, // missing facets: filtered out
    ];
    const prompts = buildCastPortraitPrompts(cast, styleAnchor);
    expect(prompts).toHaveLength(2);
    expect(prompts.map((p) => p.houseguestId)).toEqual(["hg:1", "hg:2"]);
  });

  it("L29: the live cast portrait prompts consume the seeded physical facet", () => {
    const adapter = new GameSessionAdapter();
    const view = adapter.createCharacter({ playerName: "The Player", seed: 31 });
    const npc = view.house.find((h) => h.physicalCharacteristics)!;
    expect(npc).toBeTruthy();
    const pp = adapter.getPortraitPrompt(npc.id as EntityId)!;
    expect(pp.prompt).toContain(npc.physicalCharacteristics!.skinTone);
    expect(pp.prompt).toContain(npc.physicalCharacteristics!.heightBuild);
  });

  it("IMAGE_BUDGET bounds generation: per-turn cap < per-week cap, move-in exempt", () => {
    expect(IMAGE_BUDGET.perTurnCap).toBeGreaterThan(0);
    expect(IMAGE_BUDGET.perWeekCap).toBeGreaterThan(IMAGE_BUDGET.perTurnCap);
    expect(IMAGE_BUDGET.moveInPortraitExempt).toBe(true);
  });
});


describe("0051 — createCharacter portrait prompts (cast NPCs, Vault-free)", () => {  it("returns one portrait prompt per NPC; the PLAYER is excluded (#529 — no name-hash face)", () => {
    const adapter = new GameSessionAdapter();
    const view = adapter.createCharacter({ playerName: "The Player", seed: 42 });
    expect(view.portraitPrompts).toBeDefined();
    // #529: the player authored no look, so they get NO improvised portrait — the cast pipeline
    // covers the 15 generated NPCs only (the player's avatar is FE-owned, never name-hash derived).
    expect(view.portraitPrompts!.length).toBe(view.house.length);
    for (const pp of view.portraitPrompts!) {
      expect(pp.houseguestId).toBeTruthy();
      expect(pp.name).toBeTruthy();
      expect(pp.prompt).toContain("Official cast portrait");
    }
    // The player is NOT in the cast portrait set.
    expect(view.portraitPrompts!.some((p) => p.houseguestId === PLAYER)).toBe(false);
  });

  it("the style anchor is still seeded (same seed, same anchor; a spread across seeds) but never sent", () => {
    const anchorOf = (seed: number): string => {
      const a = new GameSessionAdapter();
      const v = a.createCharacter({ playerName: "The Player", seed });
      const anchor = a.snapshot().portraitStyleAnchor!;
      for (const h of v.portraitPrompts!) expect(h.prompt).not.toContain(anchor);
      return anchor;
    };
    expect(anchorOf(100)).toBe(anchorOf(100));
    const seen = new Set<string>();
    for (let s = 0; s < 40; s++) seen.add(anchorOf(s));
    expect(seen.size).toBeGreaterThan(1);
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
    expect(got!.prompt).toContain("Official cast portrait");

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
    expect(before!.prompt).toContain("Official cast portrait");
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
    expect(after.prompt).not.toContain("storm-chasing meteorologist"); // the job is not sent (v3)
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
    expect(pp.prompt).not.toContain("rodeo clown"); // v3 sends neither the job nor the story
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
  it("survives a save, load round-trip (stored, seeded, ignored by the v3 prompt)", () => {
    const adapter = new GameSessionAdapter();
    const view = adapter.createCharacter({ playerName: "The Player", seed: 42 });
    const snap = adapter.snapshot();
    expect(snap.portraitStyleAnchor).toBeTruthy();
    const restored = new GameSessionAdapter();
    restored.restore(snap);
    expect(restored.snapshot().portraitStyleAnchor).toBe(snap.portraitStyleAnchor);
    const id = view.house[0]!.id as EntityId;
    expect(restored.getPortraitPrompt(id)!.prompt).toBe(adapter.getPortraitPrompt(id)!.prompt);
  });

  it("a legacy save with no anchor (but a seed) re-seeds a stable, declared anchor", () => {
    const adapter = new GameSessionAdapter();
    adapter.createCharacter({ playerName: "The Player", seed: 77 });
    const snap = adapter.snapshot();
    const before = snap.portraitStyleAnchor;
    delete (snap as { portraitStyleAnchor?: string }).portraitStyleAnchor;
    const restored = new GameSessionAdapter();
    restored.restore(snap);
    expect(restored.snapshot().portraitStyleAnchor).toBe(before);
    expect(STYLE_ANCHOR_VARIANTS as readonly string[]).toContain(restored.snapshot().portraitStyleAnchor);
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

/** ORW-380: photo brief v3. One paragraph in a fixed order; three fixtures (full sheet, none, legacy). */
describe("ORW-380 — portrait photo brief v3", () => {
  const anchor = STYLE_ANCHOR_VARIANTS[4]!;
  const facet = {
    heightBuild: "tall and lean", skinTone: "warm brown skin", hair: "short dark curls, usually pushed back by noon",
    facialFeatures: "a narrow nose, wide-set eyes and a square jaw",
    distinguishingMark: "a thin scar through the left eyebrow; a tattoo half-sleeve on the left forearm, plus dimples",
    ageLook: "looks their age, crisp and youthful", style: "relaxed streetwear",
  };
  const base = { appearance: "legacy prose appearance", age: 27, presentation: "easygoing", ethnicity: "West African",
    genderPresentation: "man" as const, demeanor: "warm and guarded", identityConcept: "a chaos-agent podcaster", vocation: "podcaster" };
  const ID = "hg:7";
  const idHash = fnv1a(ID);
  const full = buildPortraitPrompt(ID, "Fixture One", {
    ...base,
    physicalCharacteristics: {
      ...facet, wardrobe: ["a faded grey hoodie", "dark jeans"], photoHair: "short dark curls, shaped and neat",
      onCamera: "He leans on the kitchen island, arms folded, eyes on the camera, a small smile, someone who misses nothing.",
    },
  }, anchor).prompt;
  const none = buildPortraitPrompt(ID, "Fixture One", { ...base, physicalCharacteristics: facet }, anchor).prompt;
  const legacy = buildPortraitPrompt(ID, "Fixture One", base, anchor).prompt;
  const OPEN = "Official cast portrait of a contestant on a reality TV show, photographed by the show's photographer inside the house where the show is filmed.";
  const TAIL = "Hair and makeup done for the shoot, well groomed and camera-ready, but a real, believable person and not a model: keep the stated age and build exactly, with natural skin that is not airbrushed. Shot at eye level on a full-frame camera with an 85mm portrait lens, shallow depth of field, crisp focus on the eyes, soft flattering light, true-to-life colour. The only person in the frame; no text or logos.";
  const WHO = "Waist-up portrait of a 27-year-old West African man with warm brown skin, tall and lean, a narrow nose, wide-set eyes and a square jaw, looks their age, crisp and youthful.";
  const MARKS = "A tattoo half-sleeve on the left forearm, dimples.";
  const KITCHEN = ["bright soft window light from the side", "bright, airy morning light"][idHash % 2]!;

  it("full photo sheet: the exact sentences in the exact order", () => {
    expect(full).toBe([
      OPEN, WHO, "Hair: short dark curls, shaped and neat.", MARKS,
      "Wearing a faded grey hoodie, dark jeans.",
      "He leans on the kitchen island, arms folded, eyes on the camera, a small smile, someone who misses nothing.",
      "Setting: the house kitchen, softly out of focus behind him.", `Light: ${KITCHEN}.`, TAIL,
    ].join(" "));
  });

  it("no photo sheet: written hair trimmed and neatened, style line, fallback pose and room by demeanor and id hash", () => {
    const rooms = ["kitchen", "living room", "dining room", "backyard", "lounge", "bedroom"];
    const room = rooms[idHash % 6]!;
    const lights: Record<string, string[]> = {
      kitchen: ["bright soft window light from the side", "bright, airy morning light"],
      "dining room": ["bright soft window light from the side", "bright, airy morning light"],
      backyard: ["warm golden-hour light", "soft open shade in late afternoon"],
    };
    const lamp = ["soft window light from the side with gentle fill", "warm lamps glowing in the background, soft key light on the face"];
    const light = (lights[room] ?? lamp)[idHash % 2]!;
    expect(none).toBe([
      OPEN, WHO, "Hair: short dark curls, neatly styled.", MARKS,
      "Wearing clothes in this style: relaxed streetwear.",
      "He leans in with a big open smile, looking into the camera.",
      `Setting: the house ${room}, softly out of focus behind him.`, `Light: ${light}.`, TAIL,
    ].join(" "));
  });

  it("legacy (no facet): a person with the prose appearance, the presentation as style, no hair line", () => {
    expect(legacy).toContain("Waist-up portrait of a 27-year-old West African man with legacy prose appearance.");
    expect(legacy).toContain("Wearing clothes in this style: easygoing.");
    expect(legacy).not.toContain("Hair:");
    const noGender = buildPortraitPrompt(ID, "Fixture One", { appearance: "tall", age: 41, presentation: "quiet" }, anchor).prompt;
    expect(noGender).toContain("Waist-up portrait of a 41-year-old person with tall.");
    expect(noGender).toContain("They stand relaxed with an easy half-smile, looking into the camera.");
    expect(noGender).toContain("behind them.");
  });

  it("no name, job, character line, anchor, or the old random lines", () => {
    for (const p of [full, none, legacy]) {
      expect(p).not.toMatch(/Fixture One|podcaster|Character:|Occupation|Expression:|Framing:|Lighting:|Backdrop|Skin:|Build & hair|Facial structure/);
      expect(p).not.toContain(anchor);
    }
  });

  it("signature marks only: tattoos, piercings, glasses, freckles, dimples, beauty marks, gaps; scars, birthmarks, burns, chips are not sent", () => {
    expect(signatureMarkClause("a thin scar through the left eyebrow")).toBe("");
    expect(signatureMarkClause("a port-wine birthmark on the neck; a burn scar on the wrist; a chipped front tooth")).toBe("");
    expect(signatureMarkClause("none notable")).toBe("");
    expect(signatureMarkClause("a small nose stud, plus a scar on the chin")).toBe("A small nose stud.");
    expect(signatureMarkClause("freckles across the nose; a beauty mark by the lip")).toBe("Freckles across the nose, a beauty mark by the lip.");
    expect(signatureMarkClause("a gap between the front teeth")).toBe("A gap between the front teeth.");
    expect(signatureMarkClause("round glasses")).toBe("Round glasses.");
    expect(none).not.toContain("scar");
  });

  it("written hair is cut at the first of ', usually', ' usually', ' that ', ' by ', ' until '", () => {
    expect(trimWrittenHair("a braid that frays by afternoon")).toBe("a braid");
    expect(trimWrittenHair("dark waves, usually in a clip")).toBe("dark waves");
    expect(trimWrittenHair("grey crop usually damp")).toBe("grey crop");
    expect(trimWrittenHair("curls pinned up until noon, then loose")).toBe("curls pinned up");
    expect(trimWrittenHair("a tidy fade")).toBe("a tidy fade");
  });

  it("age-look is dropped when it says weathered, worn, tired, haggard or lived-in", () => {
    for (const w of ["weathered and sun-creased", "a worn look", "tired around the eyes", "haggard", "a lived-in face"]) {
      const p = buildPortraitPrompt(ID, "X", { ...base, physicalCharacteristics: { ...facet, ageLook: w } }, anchor).prompt;
      expect(p).not.toContain(w);
      expect(p).toContain("a square jaw.");
    }
  });

  it("light follows the spot: backyard, kitchen/dining, living room/lounge/bedroom", () => {
    const withSpot = (spot: string, id: string) => buildPortraitPrompt(id, "X", { ...base, physicalCharacteristics: {
      ...facet, onCamera: `He stands in the ${spot}, hands in pockets, eyes on the camera, an easy smile, someone at home anywhere.` } }, anchor).prompt;
    const lightOf = (p: string) => /Light: ([^.]*(?:, [^.]*)?)\./.exec(p)![1]!;
    const sets: Array<[string, string[]]> = [
      ["backyard", ["warm golden-hour light", "soft open shade in late afternoon"]],
      ["kitchen", ["bright soft window light from the side", "bright, airy morning light"]],
      ["dining room", ["bright soft window light from the side", "bright, airy morning light"]],
      ["living room", ["soft window light from the side with gentle fill", "warm lamps glowing in the background, soft key light on the face"]],
      ["lounge", ["soft window light from the side with gentle fill", "warm lamps glowing in the background, soft key light on the face"]],
      ["bedroom", ["soft window light from the side with gentle fill", "warm lamps glowing in the background, soft key light on the face"]],
    ];
    for (const [spot, opts] of sets) {
      const seen = new Set<string>();
      for (let i = 0; i < 12; i++) {
        const p = withSpot(spot, `hg:${i}`);
        expect(p).toContain(`Setting: the house ${spot},`);
        const l = lightOf(p);
        expect(opts).toContain(l);
        expect(l).toBe(opts[fnv1a(`hg:${i}`) % 2]);
        seen.add(l);
      }
      expect(seen.size).toBe(2);
    }
  });

  it("a moment with no subject gets one; the fallback pose follows the demeanor; a they-person gets plural verbs", () => {
    const mk = (onCamera: string, g: "man" | "woman" | "nonbinary" = "woman") => buildPortraitPrompt(ID, "X", {
      ...base, genderPresentation: g, physicalCharacteristics: { ...facet, onCamera } }, anchor).prompt;
    expect(mk("Leaning on the kitchen doorframe, arms folded, someone who misses nothing")).toContain(" She is leaning on the kitchen doorframe, arms folded, someone who misses nothing. Setting: the house kitchen, softly out of focus behind her.");
    expect(mk("On the backyard steps, chin on fist, a calm read", "nonbinary")).toContain("They are on the backyard steps, chin on fist, a calm read.");
    const pose = (d: string, g: "man" | "nonbinary" = "man") => buildPortraitPrompt(ID, "X", { ...base, genderPresentation: g, demeanor: d, physicalCharacteristics: facet }, anchor).prompt;
    expect(pose("bubbly and loud")).toContain("He leans in with a big open smile, looking into the camera.");
    expect(pose("quiet, watchful")).toContain("He sits back, composed, with a small closed-mouth smile, looking into the camera.");
    expect(pose("dry")).toContain("He stands relaxed with an easy half-smile, looking into the camera.");
    expect(pose("quiet", "nonbinary")).toContain("They sit back, composed");
    expect(buildPortraitPrompt(ID, "X", { ...base, genderPresentation: "nonbinary", physicalCharacteristics: facet }, anchor).prompt)
      .toContain("West African nonbinary person with a soft androgynous look");
  });

  it("every built prompt is free of the banned words and is at most 200 words", () => {
    const BANNED = /behind-the-scenes|handheld|casting-tape|imperfect framing|uneven|fluorescent|harsh|motion blur|unretouched|pores|stray hairs|flyaway|blemishes|tired|\brough\b|Big Brother/i;
    const hairy = buildPortraitPrompt(ID, "X", { ...base, physicalCharacteristics: { ...facet, ageLook: "tired and weathered" } }, anchor).prompt;
    for (const p of [full, none, legacy, hairy]) {
      expect(p).not.toMatch(BANNED);
      expect(p.split(/\s+/).length).toBeLessThanOrEqual(200);
    }
    for (const a of STYLE_ANCHOR_VARIANTS) expect(a).not.toMatch(BANNED);
  });

  it("prints the three example prompts", () => {
    if (process.env.ORW380_PRINT) console.log(`\nFULL:\n${full}\n\nNONE:\n${none}\n\nLEGACY:\n${legacy}\n`);
  });
});
