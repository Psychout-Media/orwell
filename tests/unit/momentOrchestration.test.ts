import type { GameStateView } from "../../src/ports/GameSession";
import { describe, it, expect } from "vitest";
import {
  momentForPhase, momentFragment, buildSystemPrompt, renderGameContext, physicalLook,
  BASE_GAME_MASTER_PROMPT, MOMENT_PROMPTS,
} from "../../src/engine/momentPrompts";
import { physicalFacetToAppearance } from "../../src/engine/portraitPrompts";
import { GameSessionAdapter } from "../../src/adapters/engine/GameSessionAdapter";
import type { EntityId } from "../../src/domain/ids";

describe("0018 — narrative & moment orchestration", () => {
  it("maps phases to moments deterministically", () => {
    expect(momentForPhase("nominations")).toBe("nominations");
    expect(momentForPhase("HOH Competition")).toBe("hoh-competition");
    expect(momentForPhase("veto ceremony")).toBe("veto-ceremony");
    expect(momentForPhase("anything-else")).toBe("default");
    expect(momentForPhase("nominations")).toBe(momentForPhase("nominations"));
  });

  it("the base persona frames host/voice-of-house and forbids the generic-assistant break", () => {
    const p = BASE_GAME_MASTER_PROMPT;
    expect(p).toMatch(/host/i);
    expect(p).toMatch(/voice of every houseguest/i);
    expect(p).toMatch(/not a generic ai assistant/i);
  });

  it("L25 — the base prompt pins the casting interview OOC: no NPC knows a casting answer until revealed in-scene", () => {
    const p = BASE_GAME_MASTER_PROMPT;
    // The casting interview is producer-only, with no pathway into the house (mirrors the Diary Room).
    expect(p).toMatch(/casting interview is sealed from the house/i);
    expect(p).toMatch(/no houseguest ever learns/i);
    // The exact L25 leak shape — an NPC quoting the player's profession back as a "read" — is named.
    expect(p).toMatch(/never quote, paraphrase, or even allude to a casting answer/i);
    expect(p).toMatch(/witnessed/i); // NPCs form their read from witnessed behavior only
  });

  it("L28 — the base prompt pins DISTINCT registers: the house is NOT a room of identical warm pros", () => {
    const p = BASE_GAME_MASTER_PROMPT;
    // each houseguest is voiced in their OWN register, grounded in demeanor/archetype/background…
    expect(p).toMatch(/DISTINCT REGISTERS/);
    expect(p).toMatch(/own register/i);
    expect(p).toMatch(/demeanor/i);
    // …and the homogeneity it must break is named explicitly (a blunt one is blunt, a quiet one quiet)
    expect(p).toMatch(/not a room of identical/i);
    expect(p).toMatch(/a blunt houseguest is blunt/i);
    expect(p).toMatch(/a quiet one stays quiet/i);
  });

  it("L30 — the base prompt pins wander pacing: survey, then ONE cluster, then WAIT", () => {
    const p = BASE_GAME_MASTER_PROMPT;
    // one grouping at a time for real connection — the survey orients, the scene happens
    expect(p).toMatch(/ONE GROUPING AT A TIME/i);
    expect(p).toMatch(/brief orienting SURVEY/i);
    expect(p).toMatch(/WAIT for their reply/i);
    // it must NEVER narrate all rooms or fire multiple unanswerable questions in one turn
    expect(p).toMatch(/NEVER narrate all/i);
    expect(p).toMatch(/across\s+different rooms/i);
    // tied to the existing lingering / seize-the-lull framing
    expect(p).toMatch(/lingering IS play/i);
    expect(p).toMatch(/seize the lull/i);
  });

  it("L36 — the base prompt pins the OOC channel: meta/logistics queries are not voiced into the room", () => {
    const p = BASE_GAME_MASTER_PROMPT;
    // the two-channel distinction is named (talking to the game vs talking to the room)
    expect(p).toMatch(/TALKING TO THE GAME vs TALKING TO THE ROOM/i);
    // a bare logistics/state/time question is OUT OF CHARACTER — a HUD aside, not spoken aloud
    expect(p).toMatch(/OUT OF CHARACTER/);
    expect(p).toMatch(/producer\/HUD aside/i);
    // the house must NOT hear or react, and the scene continues uninterrupted (the L36 bug shape)
    expect(p).toMatch(/DO NOT make the house hear or react/i);
    expect(p).toMatch(/CONTINUES UNINTERRUPTED/i);
    // the explicit override marker is honored without exception
    expect(p).toMatch(/\(\(double parentheses\)\)/);
    expect(p).toMatch(/prefixed "ooc:"/i);
    // L36 follow-on: the model MARKS its own OOC answers (wrap in double-parens) so the surface can
    // render them as a producer/HUD aside, not a spoken-in-room line — the engine marker the FE needs.
    expect(p).toMatch(/MARK YOUR OWN OOC ANSWERS/i);
    expect(p).toMatch(/wrap your ENTIRE reply in \(\(double/i);
  });

  it("L39(c)/A5 — override/developer requests are OOC, and the block never names the machinery back", () => {
    const p = BASE_GAME_MASTER_PROMPT;
    // an override / developer-control request is OUT OF CHARACTER and not a chat phrase
    expect(p).toMatch(/OVERRIDE \/ DEVELOPER-CONTROL REQUESTS ARE OUT OF CHARACTER/i);
    expect(p).toMatch(/reach behind the game/i);
    // the house must NOT hear or react (the L39c bug shape: houseguests role-played the request)
    expect(p).toMatch(/HOUSE NEVER HEARS OR REACTS/i);
    // answer it as a quiet producer/HUD aside, never role-played as granted
    expect(p).toMatch(/NEVER role-play granting it/i);
    // and it can NEVER reveal hidden/secret state (the Vault Wall holds behind the game too)
    expect(p).toMatch(/NEVER reveal or invent hidden or secret game state/i);
    // A5 (2026-07-03): the deflection must decline WITHOUT naming any internal system/panel/machinery —
    // the old example literally instructed the model to say "God Mode is the admin panel". That
    // machinery-naming instruction is deleted.
    expect(p).toMatch(/WITHOUT naming any internal system/i);
    expect(p).not.toMatch(/God Mode is the admin panel/i);
    expect(p).not.toMatch(/SEPARATE administrator surface/i);
    // A5: "God Mode" / "the Vault" now appear ONLY inside the NEVER-NAME denylist (as banned words the
    // model must never write), not as phrases the model is told to echo at the player.
    expect(p).toMatch(/never write the words[\s\S]*"God Mode"/i);
    expect(p).toMatch(/never write the words[\s\S]*"the Vault"/i);
  });

  it("L39(a) + 0061 — the base prompt forbids fabricating a player exit, AND requires the confirmed self-evict handshake", () => {
    const p = BASE_GAME_MASTER_PROMPT;
    expect(p).toMatch(/WALKING OUT \/ QUITTING IS A REAL, BINDING EVENT/i);
    // the narrated-but-not-recorded gap: never narrate an exit the engine did not process
    expect(p).toMatch(/NEVER narrate one the game did not process/i);
    // 0061: a self-eviction IS a real lever now — but it takes an explicit two-step CONFIRMATION
    // (the L36/L39a refusal stays for the bare/unconfirmed/ambiguous line, which the house never hears).
    expect(p).toMatch(/deliberate, IRREVERSIBLE choice/i);
    expect(p).toMatch(/two-step CONFIRMATION/i);
    expect(p).toMatch(/HOUSE NEVER HEARS OR REACTS to it/i);
    expect(p).toMatch(/Only once they[\s\S]*explicitly confirm/i);
    expect(p).toMatch(/ambiguous or unconfirmed/i);
    // the player remains a houseguest until the engine reports them evicted (or self-evicted) / season over
    expect(p).toMatch(/player is still ACTIVE in the house/i);
    expect(p).toMatch(/evicted \(or self-evicted\)/i);
    expect(p).toMatch(/NEVER fabricate the exit\s+yourself/i);
  });

  it("L40 — the base prompt restrains showmance over-labeling (no soap-opera saturation)", () => {
    const p = BASE_GAME_MASTER_PROMPT;
    expect(p).toMatch(/SHOWMANCES ARE RARE/i);
    // ordinary closeness is friendship/strategy, not romance
    expect(p).toMatch(/do NOT read romance into ordinary closeness/i);
    // romance is voiced ONLY for a pair the engine has SURFACED into the GAME CONTEXT (0059/L40)
    expect(p).toMatch(/engine SEEDS the season's showmances/i);
    expect(p).toMatch(/Public showmance/i);
  });

  it("R3-01 — the eviction & finale moments pin the REVEAL: vote already cast, narrate beat-by-beat, never re-ask", () => {
    // Live-playtest finding (deepseek-v4-pro): during the staged eviction-vote reveal the model
    // re-prompted the player to vote again ("who do you vote to evict?") for a ballot already cast,
    // and at the finale looped on "we haven't reached the vote yet". The reveal is NARRATION of an
    // already-recorded result the engine walks one beat per turn — not a decision to re-collect.
    const ev = MOMENT_PROMPTS["eviction"]!;
    // the player's vote is already in — this is the reveal, not the ballot
    expect(ev).toMatch(/THE VOTE IS ALREADY IN/i);
    expect(ev).toMatch(/already been cast and recorded/i);
    // the job is to NARRATE the reveal beat by beat
    expect(ev).toMatch(/job here is to NARRATE that\s+reveal/i);
    // never re-ask for the vote / reopen the Diary Room
    expect(ev).toMatch(/Do NOT re-ask the player who they vote to evict/i);
    expect(ev).toMatch(/do NOT reopen the Diary Room for a vote/i);
    // never claim the result hasn't happened — the engine is walking the reveal
    expect(ev).toMatch(/do NOT say the vote hasn't happened/i);

    const fin = MOMENT_PROMPTS["jury-finale"]!;
    // the jury-vote reveal is narration, not a new decision
    expect(fin).toMatch(/THE JURY-VOTE REVEAL IS NARRATION, NOT A NEW DECISION/i);
    expect(fin).toMatch(/ALREADY CAST and recorded/i);
    // narrate one vote at a time; never re-ask a finale choice already made
    expect(fin).toMatch(/NARRATE the reveal one vote at a time/i);
    expect(fin).toMatch(/Do NOT\s+re-ask the player to vote/i);
    // never claim the vote hasn't been reached yet (the live-playtest loop shape)
    expect(fin).toMatch(/do NOT say the vote hasn't happened or that you haven't reached it yet/i);

    // No Vault/secret state introduced: the reveal text references only anonymized ballots, the public
    // tally, and the public winner — never a voter attribution or any hidden/secret vocabulary.
    for (const banned of ["soul", "volatility", "hiddenElement", "secret-motive", "who cast it"]) {
      expect(ev.includes(banned), `eviction reveal must not mention ${banned}`).toBe(false);
      expect(fin.includes(banned), `finale reveal must not mention ${banned}`).toBe(false);
    }
  });

  it("the woven context is Vault-free (player card + phase + roster names; no stats/souls)", () => {
    const game = new GameSessionAdapter();
    game.createCharacter({ playerName: "Player One", seed: 4 });
    const ctx = renderGameContext(game.getGameState());
    expect(ctx).toContain("Player One");
    // The woven context is PROSE, not the stat block: bare "physical"/"mental"/"social" are public
    // words (a "physical therapist" vocation, a "social" strategy style — L28), so they are NOT
    // banned. The hidden layer is banned precisely (soul vocabulary), and no numeric aptitude (a
    // float) may ever ride along — that is what a real stat leak would look like in the context.
    for (const banned of ['"soul"', "volatility", "emotionalState", "hiddenElement", "secret-motive"]) {
      expect(ctx.includes(banned)).toBe(false);
    }
    expect(ctx).not.toMatch(/\d\.\d/);
  });

  it("surfaces the exact walkable rooms to the model so it never guesses a moveTo room (the bug fix)", () => {
    const game = new GameSessionAdapter();
    game.createCharacter({ playerName: "Player One", seed: 4 });
    const ctx = renderGameContext(game.getGameState());
    // The model is handed the menu of rooms it may walk the player to (so it never guesses "bedroom"
    // and loops on "isn't mapping"). Every walkable room's natural name appears, the diary room does not.
    expect(ctx).toContain("ROOMS YOU CAN WALK THE PLAYER TO");
    for (const name of ["kitchen", "living room", "backyard", "bedroom A", "bedroom B", "HOH room", "bathroom", "storage room"]) {
      expect(ctx, `lists ${name}`).toContain(name);
    }
    // The diary room is a beat, not a walkable hangout — it is NOT on the menu.
    expect(ctx).not.toContain("diary room.");
    // The lever manifest also points at the menu + advertises forgiving phrasing.
    expect(BASE_GAME_MASTER_PROMPT).toContain("ROOMS YOU CAN WALK THE PLAYER TO");
  });

  it("editing a moment fragment changes only that moment", () => {
    const original = MOMENT_PROMPTS["social"]!;
    try {
      MOMENT_PROMPTS["social"] = "MOMENT — EDITED";
      expect(momentFragment("social")).toContain("EDITED");
      expect(momentFragment("nominations")).not.toContain("EDITED");
      expect(BASE_GAME_MASTER_PROMPT).toMatch(/host/i);
    } finally {
      MOMENT_PROMPTS["social"] = original;
    }
    expect(momentFragment("social")).toBe(original);
  });

  it("buildSystemPrompt is base + fragment + context (a pure read; mutates nothing)", () => {
    const game = new GameSessionAdapter();
    game.createCharacter({ playerName: "P", seed: 1 });
    // ORW-249: the ceremony script rides once the engine has committed the nominees (commit before voice) - give the pure prompt builder a committed board
    const view = { ...game.getGameState(), ceremony: { hoh: null, nominees: [{ id: "npc:1", name: "A" }, { id: "npc:2", name: "B" }], veto: { holder: null, used: false, players: [] } } } as GameStateView;
    const before = view.phase;
    const prompt = buildSystemPrompt("nominations", view);
    expect(prompt).toContain(MOMENT_PROMPTS["nominations"]!.slice(0, 20));
    expect(view.phase).toBe(before); // narration/prompt-building does not advance the game
  });
});

/**
 * L29/L23 consistency gate: the narrated body and the cast portrait MUST derive from ONE source —
 * the structured `physicalCharacteristics` facet. The live-playtest bug was a houseguest narrated
 * "stocky with honey-blond waves" while her portrait showed an entirely different person, because
 * the narrator-facing context fed only the prose `appearance` blurb while the portrait used the
 * structured facet. This proves both consumers consume the SAME facet for the same character.
 */
describe("L29 — narration and portrait share ONE appearance source", () => {
  it("the narrator context voices the SAME structured physical facet the portrait prompt was drawn from", () => {
    const game = new GameSessionAdapter();
    game.createCharacter({ playerName: "The Player", seed: 31 });
    const view = game.getGameState();
    // A live houseguest carrying the seeded structured facet (the 0058 floor seeds every active NPC).
    const npc = view.house.find((h) => h.status === "active" && h.physicalCharacteristics)!;
    expect(npc).toBeTruthy();

    // The SAME builder both consumers use, applied to this card's facet — the single source of truth.
    const sharedLook = physicalFacetToAppearance(npc.physicalCharacteristics!);
    expect(sharedLook).toContain(npc.physicalCharacteristics!.hair);
    expect(sharedLook).toContain(npc.physicalCharacteristics!.heightBuild);

    // Consumer #1 — the narrator-facing context: voices the shared look (hair + build), not an
    // improvised description. The structured facet AUTHORS the look here.
    const ctx = renderGameContext(view);
    expect(ctx).toContain(npc.physicalCharacteristics!.hair);
    expect(ctx).toContain(npc.physicalCharacteristics!.heightBuild);

    // Consumer #2 — the portrait prompt: built from the SAME facet (the live cast portrait path).
    const pp = game.getPortraitPrompt(npc.id as EntityId)!;
    expect(pp.prompt).toContain(npc.physicalCharacteristics!.hair);
    expect(pp.prompt).toContain(npc.physicalCharacteristics!.heightBuild);

    // The hinge: the EXACT physical clause the portrait builds is present verbatim in the narrator
    // context — there is one description, voiced once and pictured once, never two that can diverge.
    expect(pp.prompt).toContain(sharedLook);
    expect(ctx).toContain(sharedLook);
  });

  it("physicalLook prefers the structured facet and falls back to the prose appearance (pre-0058 saves)", () => {
    const facet = {
      heightBuild: "tall and broad-shouldered", skinTone: "warm brown skin", hair: "tight natural curls, jet black",
      facialFeatures: "a square jaw", distinguishingMark: "none notable",
      ageLook: "settled, thirties presence", style: "streetwear and bold sneakers",
    };
    // With a facet present, the facet authors the look (NOT the prose blurb) — same as the portrait.
    expect(physicalLook({ appearance: "ignored prose blurb", physicalCharacteristics: facet }))
      .toBe(physicalFacetToAppearance(facet));
    expect(physicalLook({ appearance: "ignored prose blurb", physicalCharacteristics: facet }))
      .not.toContain("ignored prose blurb");
    // No facet (a pre-0058 save): fall back to the prose appearance so older saves still describe a body.
    expect(physicalLook({ appearance: "athletic, close-cropped hair" })).toBe("athletic, close-cropped hair");
    expect(physicalLook({})).toBeUndefined();
  });

  it("the shared physical facet carries NO hidden/Vault content into the narrator context", () => {
    // Poison every hidden surface of one NPC with a unique sentinel, restore, then assert the
    // narrator context (which now voices the structured facet) surfaces NONE of it. The facet is a
    // PUBLIC §3 baseline — proving the consistency fix did not open a leak path.
    const game = new GameSessionAdapter();
    game.createCharacter({ playerName: "The Player", seed: 9 });
    const snap = game.snapshot();
    const SENTINEL = "SENTINEL-L29-NARRATION-LEAK-DO-NOT-SURFACE";
    const poison = (hg: { character: { stats: { physical: number; mental: number; social: number };
      hiddenElements: { kind: "secret-motive"; detail: string }[] }; soul: { memory: string[] } }) => {
      hg.character.hiddenElements.push({ kind: "secret-motive", detail: `${SENTINEL}-motive` });
      hg.soul.memory.push(`${SENTINEL}-memory`);
      hg.character.stats.physical = 99999;
    };
    poison(snap.house!.npcs[0]! as unknown as Parameters<typeof poison>[0]);
    poison(snap.house!.player as unknown as Parameters<typeof poison>[0]);
    const restored = new GameSessionAdapter();
    restored.restore(snap);

    const ctx = renderGameContext(restored.getGameState());
    expect(ctx).not.toContain(SENTINEL);
    expect(ctx).not.toContain("99999");
  });
});

describe("#534 — the in-game time of day is injected into the narrator context", () => {
  it("voices THIS hour when timeOfDay is present, and instructs not to narrate a different one", () => {
    const game = new GameSessionAdapter();
    game.createCharacter({ playerName: "The Player", seed: 17 });
    const base = game.getGameState();
    const view = { ...base, timeOfDay: "evening" } as typeof base;
    const ctx = renderGameContext(view);
    expect(ctx).toContain("Time of day: evening");
    // It must tell the model to set the scene at THIS hour and never drift to another time of day.
    expect(ctx.toLowerCase()).toContain("never narrate a different time of day");
  });

  it("emits NO time-of-day line when timeOfDay is absent (byte-identical, clock-off default)", () => {
    const game = new GameSessionAdapter();
    game.createCharacter({ playerName: "The Player", seed: 17 });
    const view = game.getGameState();
    // Clock-off is the default: getGameState() carries no timeOfDay, so the context is unchanged.
    expect(view.timeOfDay).toBeUndefined();
    const ctx = renderGameContext(view);
    expect(ctx).not.toContain("Time of day:");
    // And explicitly: injecting the field and removing it round-trips to the same string.
    const without = renderGameContext({ ...view, timeOfDay: undefined } as typeof view);
    expect(without).toBe(ctx);
  });
});
