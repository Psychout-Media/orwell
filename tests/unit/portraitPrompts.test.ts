import { describe, it, expect } from "vitest";
import { buildPortraitPrompt, buildCastPortraitPrompts, trimWrittenHair, signatureMarkClause, stripWornWords, legacyAppearance } from "../../src/engine/portraitPrompts";
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
      expect(pp.prompt).toContain("A plain, honest portrait of a local resident by a newspaper documentary photographer");
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
    expect(got!.prompt).toContain("A plain, honest portrait of a local resident by a newspaper documentary photographer");

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
    expect(before!.prompt).toContain("A plain, honest portrait of a local resident by a newspaper documentary photographer");
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
    expect(after.prompt).toContain("storm-chasing meteorologist"); // ORW-480: the PUBLIC vocation is sent as the life the person looks like (never as a uniform or prop)
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
    expect(pp.prompt).not.toContain("chasing one last spotlight"); // the story is never sent
    expect(pp.prompt).toContain("rodeo clown");                     // ORW-480: the PUBLIC vocation is sent as the life the person looks like (an ordinary person: a N-year-old rodeo clown from ...), never as a uniform or prop
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

/** ORW-380: photo brief v3. One paragraph in a fixed order; three fixtures (full sheet, none, legacy). */
describe("ORW-380 / ORW-480 — portrait photo brief v4", () => {
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
  const full = buildPortraitPrompt(ID, "Fixture One", {
    ...base,
    physicalCharacteristics: {
      ...facet, wardrobe: ["a faded grey hoodie", "dark jeans"], photoHair: "short dark curls, shaped and neat",
      onCamera: "He leans on the kitchen island, arms folded, eyes on the camera, a small smile, someone who misses nothing.",
    },
  }, anchor).prompt;
  const none = buildPortraitPrompt(ID, "Fixture One", { ...base, physicalCharacteristics: facet }, anchor).prompt;
  const legacy = buildPortraitPrompt(ID, "Fixture One", base, anchor).prompt;

  it("full photo sheet: the sentences in order, the old studio recipe gone", () => {
    const order = ["A plain, honest portrait of a local resident by a newspaper documentary photographer, taken where they live",
      "The subject is a 27-year-old West African man with warm brown skin, tall and lean, looks his age.",
      "An ordinary person, not a model: a 27-year-old podcaster", "Face: ", "Hair: short dark curls, shaped.",
      "Wearing a faded grey hoodie, dark jeans", "Setting: ", "Light: ", "The moment: ", "Framing, the same for the whole series: a half-length portrait",
      "Taken the way a local paper would: available light, the real place in normal focus, nothing retouched", "The only person in the frame; no text or logos."];
    let at = -1;
    for (const o of order) { const i = full.indexOf(o); expect(i, o).toBeGreaterThan(at); at = i; }
    expect(full).not.toMatch(/Waist-up|softly out of focus|shallow depth|soft flattering|Official cast portrait|camera-ready/);
    expect(full).toMatch(/never a uniform, scrubs, apron, badge or work gear/);
    expect(full).not.toMatch(/laugh lines|distinguished|forties ease|crisp and youthful/);
    expect(full).toMatch(/The picture runs to all four edges: no frame, border, black edge, vignette or film-scan rim\./);   // ORW-480: no frame or border
    expect(full).toMatch(/Clothes are worn the way this person would on an ordinary day\./);
    expect(full).toMatch(/real skin and hair, worn everyday clothes/);   // documentary is the default realism wording (Kevin's pick, 2026-11-16)
    // no beautifying or quality word, no hair-and-makeup line
    expect(full).not.toMatch(/best|flatter|hair and makeup|groomed|polished|well-kept|stunning|professional portrait|high quality|sharp|airbrushed|no retouching/i);
    // the written face line is replaced by the dealt face card, the writer's on-camera line is not sent, a mark sits inside the face sentence
    expect(full).not.toContain("kitchen island");
    expect(full).not.toContain("someone who misses nothing");
    expect(full).toMatch(/Face: [^.]*, with a tattoo half-sleeve on the left forearm, dimples\./);
  });

  it("no photo sheet and legacy cards still build every part (the shot and face are dealt alone)", () => {
    expect(none).toContain("Hair: short dark curls.");
    expect(none).toContain("Wearing everyday clothes in this style: relaxed streetwear.");
    expect(legacy).toContain("The subject is a 27-year-old West African man with legacy prose appearance.");
    expect(legacy).toContain("Wearing everyday clothes in this style: easygoing.");
    expect(legacy).not.toContain("Hair:");
    const noGender = buildPortraitPrompt(ID, "Fixture One", { appearance: "tall", age: 41, presentation: "quiet" }, anchor).prompt;
    expect(noGender).toContain("The subject is a 41-year-old person with tall.");
    for (const p of [none, legacy, noGender]) { expect(p).toContain("Setting: "); expect(p).toContain("The moment: "); expect(p).toContain("Face: "); }
    expect(buildPortraitPrompt(ID, "X", { ...base, genderPresentation: "nonbinary", physicalCharacteristics: facet }, anchor).prompt)
      .toContain("West African nonbinary person with a soft androgynous look");
  });

  it("worn / rough words never reach the prompt; a legacy prose appearance is cut like hair and carries no scar words", () => {
    const p = buildPortraitPrompt(ID, "X", { ...base, physicalCharacteristics: {
      ...facet, heightBuild: "rugged and tall", facialFeatures: "a rough jaw and tired eyes", hair: "worn dark curls, usually pinned",
      wardrobe: ["a worn grey hoodie", "dark jeans"], style: "rough streetwear" } }, anchor).prompt;
    expect(p.replace("clothes that have been worn and washed, with creases", "").replace("worn everyday clothes", "").replace("Clothes are worn the way this person would on an ordinary day", "")).not.toMatch(/\b(?:weathered|worn|tired|haggard|lived-in|rough|rugged|craggy)\b/i);   // the realism tails ask for worn everyday clothes on purpose
    expect(p).toContain("with warm brown skin, tall,");
    expect(p).toContain("Hair: dark curls.");
    const legacyP = buildPortraitPrompt(ID, "X", { ...base, appearance: "athletic, a scar over the left eye, close-cropped hair usually under a cap, a birthmark on the neck, a warm smile" }, anchor).prompt;
    expect(legacyP).toContain("with athletic, close-cropped hair, a warm smile.");
    expect(legacyP).not.toMatch(/scar|birthmark|usually/i);
  });

  it("no name, job, character line, anchor, or the old random lines", () => {
    for (const p of [full, none, legacy]) {
      expect(p).not.toMatch(/Fixture One|chaos-agent|Character:|Occupation|Expression:|Framing:|Lighting:|Backdrop|Skin:|Build & hair|Facial structure/);
      expect(p).not.toContain(anchor);
    }
  });

  it("signature marks only: tattoos, piercings, glasses, freckles, dimples, beauty marks, gaps; scars, birthmarks, burns, chips are not sent", () => {
    expect(signatureMarkClause("a thin scar through the left eyebrow")).toBe("");
    expect(signatureMarkClause("a port-wine birthmark on the neck; a burn scar on the wrist; a chipped front tooth")).toBe("");
    expect(signatureMarkClause("none notable")).toBe("");
    expect(signatureMarkClause("a small nose stud, plus a scar on the chin")).toBe("A small nose stud.");
    expect(signatureMarkClause("freckles across the nose; a beauty mark by the lip")).toBe("Freckles across the nose, a beauty mark by the lip.");
    expect(signatureMarkClause("a gap between the front teeth")).toBe("");              // ORW-480: a tooth gap is never sent
    expect(signatureMarkClause("a gap-toothed grin")).toBe("");
    expect(signatureMarkClause("a gap-toothed grin; light freckles")).toBe("Light freckles.");
    expect(signatureMarkClause("a tattoo and chipped teeth")).toBe("A tattoo.");        // review of #2748: no article after "and"
    expect(signatureMarkClause("a scar on the chin and glasses")).toBe("Glasses.");
    expect(signatureMarkClause("round glasses")).toBe("Round glasses.");
    expect(none).not.toContain("scar");
  });

  it("written hair is cut at the first of ', usually', ' usually', ' that ', ' by ', ' until '", () => {
    expect(trimWrittenHair("a braid that frays by afternoon")).toBe("a braid");
    expect(legacyAppearance("a rugged haircut that grows out by spring, tall")).toBe("a haircut, tall");
    expect(legacyAppearance("tidy hairstyle usually in a clip, lean")).toBe("tidy hairstyle, lean");
    expect(stripWornWords("tall and rugged, lean")).toBe("tall, lean");
    expect(stripWornWords("lean, rugged and tall")).toBe("lean and tall");
    expect(trimWrittenHair("dark waves, usually in a clip")).toBe("dark waves");
    expect(trimWrittenHair("grey crop usually damp")).toBe("grey crop");
    expect(trimWrittenHair("curls pinned up until noon, then loose")).toBe("curls pinned up");
    expect(trimWrittenHair("a tidy fade")).toBe("a tidy fade");
  });

  it("the gloss strip leaves no dangling preposition or stray comma in the hair line", () => {
    const p = buildPortraitPrompt(ID, "X", { ...base, physicalCharacteristics: { ...facet, hair: "close black buzz with a sharp, freshly edged hairline", photoHair: "close black buzz with a sharp, freshly edged hairline" } }, anchor).prompt;
    expect(p).toContain("Hair: close black buzz, freshly edged hairline");
    expect(p).not.toMatch(/with,|with a,/);
  });

  it("age-look is dropped when it says weathered, worn, tired, haggard or lived-in", () => {
    for (const w of ["weathered and sun-creased", "a worn look", "tired around the eyes", "haggard", "a lived-in face"]) {
      const p = buildPortraitPrompt(ID, "X", { ...base, physicalCharacteristics: { ...facet, ageLook: w } }, anchor).prompt;
      expect(p).not.toContain(w);
      expect(p).toContain("tall and lean, looks his age.");   // the card's ageing text is never sent: the age is exact and the look is that age
    }
  });

  it("every built prompt is free of the banned words and is at most 360 words", () => {
    // ORW-480 on purpose: "unretouched", "pores", "flyaway" style words, "uneven" and "harsh" were banned by ORW-380 (Kevin then wanted a polished look);
    // Kevin's 2026-11-15 direction is real skin texture, so pores and loose hairs are now asked for. The rest stays banned.
    const BANNED = /behind-the-scenes|casting-tape|imperfect framing|fluorescent|motion blur|blemishes|tired|\brough\b|Big Brother/i;
    const hairy = buildPortraitPrompt(ID, "X", { ...base, physicalCharacteristics: { ...facet, ageLook: "tired and weathered" } }, anchor).prompt;
    for (const p of [full, none, legacy, hairy]) {
      expect(p).not.toMatch(BANNED);
      expect(p.split(/\s+/).length).toBeLessThanOrEqual(360);
    }
    for (const a of STYLE_ANCHOR_VARIANTS) expect(a).not.toMatch(BANNED);
  });
});

describe("ORW-437 — wardrobe, on-camera and photo hair reach the portrait prompt through the real public path", () => {
  it("recordLookExtras on the adapter, then the public card and getPortraitPrompt carry and use all three", () => {
    const adapter = new GameSessionAdapter();
    const view = adapter.createCharacter({ playerName: "The Player", seed: 31 });
    const npc = view.house.find((h) => h.physicalCharacteristics)!;
    const id = npc.id as EntityId;
    const before = adapter.getPortraitPrompt(id)!.prompt;
    const r = adapter.recordLookExtras({
      houseguestId: id, wardrobe: ["a faded grey hoodie", "dark jeans"], photoHair: "a neat low bun",
      onCamera: "Leans on the kitchen island, arms folded, eyes on the camera, a small smile, someone who misses nothing.",
    });
    expect(r.accepted).toBe(true);
    const card = adapter.getGameState().house.find((h) => h.id === id)!;   // the typed public projection, no cast
    expect(card.physicalCharacteristics?.wardrobe).toEqual(["a faded grey hoodie", "dark jeans"]);
    expect(card.physicalCharacteristics?.onCamera).toContain("kitchen island");
    const after = adapter.getPortraitPrompt(id)!.prompt;
    expect(after).not.toBe(before);
    expect(after).toContain("faded grey hoodie");
    expect(after).toContain("a low bun");
    expect(after).toContain("Setting: ");
    expect(after).not.toContain("kitchen island"); // ORW-480: the writer's on-camera line is no longer sent; the shot card sets the place and the moment
  });
});


describe("ORW-437 — portrait text cleaning", () => {
  it("removing a worn word never leaves a dangling and/or", () => {
    expect(stripWornWords("rugged and tall")).toBe("tall");
    expect(stripWornWords("tall and rugged")).toBe("tall");
    expect(stripWornWords("a rough or worn denim jacket")).toBe("a denim jacket");
    expect(stripWornWords("tall and lean")).toBe("tall and lean");
  });
  it("a compound mark keeps its signature parts when another part is not sent", () => {
    expect(signatureMarkClause("a tattoo and a chipped tooth")).toBe("A tattoo.");
    expect(signatureMarkClause("a thin scar, and a nose stud")).toBe("A nose stud.");
    expect(signatureMarkClause("a scar and a burn")).toBe("");
  });
  it("only the hair clause of a legacy appearance is cut at 'usually / that / by / until'", () => {
    expect(legacyAppearance("long hair that frays by noon, a warm smile that lights a room")).toBe("long hair, a warm smile that lights a room");
  });
});
