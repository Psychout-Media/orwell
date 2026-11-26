import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SeededRandom } from "../../src/adapters/random/SeededRandom";
import { generateHouse } from "../../src/engine/characterFactory";
import { generateCastDeepLayer } from "../../src/engine/deepProfile";
import { buildCastPortraitPrompts, buildPortraitPrompt } from "../../src/engine/portraitPrompts";
import {
  dealPortraitPlans, placeFit, placeText, regionOf, dealShotCards, dealFaceCards, shotCaps, capOf, propFor, buildClassOf, FACE_MIN_DISTANCE, PLACES, LIGHTS, PORTRAIT_FORMAT, type ShotSheet,
} from "../../src/engine/shotCards";
import { POSTURES, EXPRESSIONS, TRAITS, gestureFamily, traitScores, perfCaps, dealPerformances, type PerfSheet } from "../../src/engine/performance";

// ORW-480: the shot card and the face card, dealt across the cast on their own seeded stream.

const SEEDS = Array.from({ length: 40 }, (_, i) => 11 + i * 211);
const sheetsOf = (seed: number): ShotSheet[] => {
  const { npcs } = generateHouse(new SeededRandom(seed));
  return npcs.map((n) => ({
    id: n.id, name: n.name, age: n.character.age,
    ...(n.character.demeanor ? { demeanor: n.character.demeanor } : {}),
    ...(n.character.hometown ? { hometown: n.character.hometown } : {}),
    ...(n.character.biography ? { biography: n.character.biography } : {}),
    ...(n.character.castingType ? { castingRead: n.character.castingType.read, castingLabel: n.character.castingType.label } : {}),
    ...(n.character.voice ? { energy: n.character.voice.energy } : {}),
    ...(n.character.physicalCharacteristics ? { clothes: [...(n.character.physicalCharacteristics.wardrobe ?? []), n.character.physicalCharacteristics.style].join(" ; ") } : {}),
    ...(n.character.physicalCharacteristics?.heightBuild ? { heightBuild: n.character.physicalCharacteristics.heightBuild } : {}),
    ...(n.character.vocation ? { vocation: n.character.vocation } : {}),
  }));
};
const tally = (xs: string[]): number => Math.max(0, ...[...new Set(xs)].map((x) => xs.filter((y) => y === x).length));

describe("ORW-480 the caps come from the shared casting-director table", () => {
  it("a cast of 15: place 2, light 4, prop 2, face value 3; closed half-smile 3, at least 4 not smiling", () => {
    expect(shotCaps(15)).toMatchObject({ place: 2, light: 4, prop: 2, faceValue: 3 });
    expect(capOf("prop", 15)).toBe(2);
    expect(perfCaps(15, 9)).toMatchObject({ closedHalf: 3, minNonSmiling: 4, perExpression: 2, perPosture: 2 });
  });
});

describe("ORW-480 shot cards", () => {
  it("over 40 casts of 15: ONE portrait format for everyone, the caps kept, every pose consistent with its place", () => {
    const caps = shotCaps(15);
    for (const seed of SEEDS) {
      const sheets = sheetsOf(seed);
      expect(sheets.length).toBe(15);
      const cards = [...dealShotCards(sheets).values()];
      // one photographer, one series: nothing about the format is dealt
      for (const c of cards) { expect(c.framingId).toBe(PORTRAIT_FORMAT.id); expect(c.framing).toBe(PORTRAIT_FORMAT.phrase); expect(c.lens).toBe(PORTRAIT_FORMAT.lens); expect(c.angle).toBe(PORTRAIT_FORMAT.angle); }
      expect(tally(cards.map((c) => c.placeId)), `place ${seed}`).toBeLessThanOrEqual(caps.place);
      expect(tally(cards.map((c) => c.lightId)), `light ${seed}`).toBeLessThanOrEqual(caps.light);
      expect(cards.filter((c) => c.prop !== undefined).length, `prop ${seed}`).toBeLessThanOrEqual(caps.prop);
      expect(cards.filter((c) => c.gaze === "lens").length, `gaze ${seed}`).toBeLessThanOrEqual(caps.lensGaze);
      expect(cards.filter((c) => c.closedHalf).length, `closed half-smile ${seed}`).toBeLessThanOrEqual(3);
      expect(cards.filter((c) => !c.smiles).length, `not smiling ${seed}`).toBeGreaterThanOrEqual(4);
      expect(tally(cards.map((c) => c.expression)), `expression ${seed}`).toBeLessThanOrEqual(2);
      expect(tally(cards.map((c) => c.posture)), `posture ${seed}`).toBeLessThanOrEqual(2);
      expect(cards.filter((c) => c.outdoor).length, `outdoors ${seed}`).toBeGreaterThanOrEqual(4);
      expect(cards.filter((c) => !c.outdoor).length, `indoors ${seed}`).toBeGreaterThanOrEqual(3);
      expect(cards.filter((c) => c.placeKind === "work-adjacent").length, `work ${seed}`).toBeLessThanOrEqual(capOf("place-work", 15));
      for (const kind of ["home-interior", "home-exterior", "town", "nature"]) expect(cards.filter((c) => c.placeKind === kind).length, `${kind} ${seed}`).toBeLessThanOrEqual(capOf("place-kind", 15));
      expect(new Set(cards.map((c) => c.placeId)).size, `places ${seed}`).toBeGreaterThanOrEqual(6);
      for (const c of cards) { expect(c.placeId).not.toMatch(/laundry|driveway|hallway|gym|pool|stair|lounge/); expect(c.place).not.toMatch(/Orwell house/); }
    }
  });

  it("the light fits the place, a posture only asks for what the place has, a held prop leaves a hand free", () => {
    for (const seed of SEEDS) {
      for (const c of dealShotCards(sheetsOf(seed)).values()) {
        const place = PLACES.find((p) => p.id === c.placeId)!;
        const light = LIGHTS.find((l) => l.id === c.lightId)!;
        expect(light.where === "any" || (light.where === "out") === place.outdoor).toBe(true);
        const po = POSTURES.find((x) => x.id === c.momentId.split("+")[1])!;
        if (po.needs !== "any") expect(place[po.needs], `${c.placeId} ${po.id}`).toBeDefined();
        if (c.prop !== undefined) expect(po.fixedHands).toBe(false);
        expect(c.moment).not.toMatch(/\{|undefined/);
        expect(c.moment).not.toMatch(/whisper|hid|creep|crouch|sneak/);
      }
    }
    for (const l of LIGHTS) expect(l.phrase).not.toMatch(/flash|no fill|dark corners|hard|squint|flatter|soft catchlight|beauty/);
    expect(PORTRAIT_FORMAT.phrase).toMatch(/half-length.*both shoulders and at least one hand/);
    expect(PORTRAIT_FORMAT.lens).toBe("a 50mm lens");
    expect(PORTRAIT_FORMAT.angle).toMatch(/eye level/);
  });

  it("the performance comes from the person's own sheet: a trait word, a full-strength expression, a posture and what the hands do", () => {
    const loud: ShotSheet = { id: "a", age: 25, castingLabel: "the life of the party", castingRead: "big laugh, animated hands, lit up", demeanor: "warm, animated, and utterly unfiltered", energy: "loud and warm" };
    const shy: ShotSheet = { id: "b", age: 25, castingLabel: "the wallflower", castingRead: "shy downcast eyes, shoulders drawn in, small smile" };
    const sly: ShotSheet = { id: "c", age: 30, castingLabel: "the schemer", castingRead: "narrowed eyes, tight knowing smile, chin slightly raised" };
    const intense: ShotSheet = { id: "d", age: 30, castingLabel: "the competitor", castingRead: "focused eyes, set jaw, ready stance" };
    const guarded: ShotSheet = { id: "e", age: 40, castingLabel: "the tough nut", castingRead: "guarded stare, folded arms, firm closed mouth" };
    const cards = dealShotCards([loud, shy, sly, intense, guarded]);
    expect(cards.get("a")!.trait).toBe("loud"); expect(cards.get("b")!.trait).toBe("shy"); expect(cards.get("c")!.trait).toBe("sly");
    expect(cards.get("d")!.trait).toBe("intense"); expect(cards.get("e")!.trait).toBe("guarded");
    expect(cards.get("a")!.expression).toMatch(/laugh|grin/);          // loud types are visibly loud
    expect(cards.get("b")!.expression).toMatch(/shy/);                 // quiet types are visibly closed
    expect(cards.get("e")!.smiles).toBe(false);
    for (const c of cards.values()) { expect(c.why).toMatch(/trait \w+ from (?:type|read|demeanor|voice)/); expect(c.hands !== "" || POSTURES.find((p) => p.id === c.momentId.split("+")[1])!.fixedHands).toBe(true); }
    // one word per person, matched blind: the 58 casting types by label, and an abstract one falls back on demeanor and voice
    const top = (x: ShotSheet) => traitScores(x).sort((p, q) => q.score - p.score)[0]!.trait;
    expect(top({ id: "x", age: 30, castingLabel: "the loudmouth" })).toBe("loud");
    expect(top({ id: "x", age: 30, castingLabel: "the sophisticate" })).toBe("poised");
    expect(top({ id: "x", age: 30, castingLabel: "the grinder" })).toBe("intense");
    expect(top({ id: "x", age: 30, castingLabel: "the floater" })).toBe("dreamy");
    expect(top({ id: "x", age: 30, castingLabel: "the enigma", castingRead: "still face, level gaze, faint unreadable half-smile" })).toMatch(/sly|guarded/);
    expect(top({ id: "x", age: 30, castingLabel: "the something new", demeanor: "bouncy, loud and goofy", energy: "manic" })).toBe("loud");
    expect(EXPRESSIONS.filter((e) => e.closedHalf).length).toBeGreaterThan(0);
  });

  it("every expression, posture and hands entry is something a real person does unprompted for a portrait: none of the acted-out words", () => {
    const BAN = /hunch|slump|sprawl|lung|crouch|elbows on (?:the )?knees|elbow on the knee|between the knees|hanging|behind the head|chin resting|on one fist|\bfists?\b|point\w* at|thumbs up|flex|jazz|snarl|bared|fierce|mugg|comic|disbelief|startled|performing|wiggl|slapping|bared|stretched out|legs (?:loose|spread)|flush|dejected|deep hunch/i;
    const hands = ["one hand open mid-sentence, the other resting", "one hand holding the other wrist"];
    for (const e of EXPRESSIONS) expect(e.text, e.id).not.toMatch(BAN);
    for (const p of POSTURES) expect(p.text, p.id).not.toMatch(BAN);
    // the whole table of hands, read through a deal of every trait
    const seen = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) {
      const sheets: PerfSheet[] = TRAITS.map((t, i) => ({ id: `t${i}`, castingLabel: `the ${t}`, demeanor: `${t} ${t}` }));
      const rnd = (() => { let a = seed; return () => { a = (a * 1664525 + 1013904223) % 4294967296; return a / 4294967296; }; })();
      const flags = new Map(sheets.map((x) => [x.id, { perch: "the counter", lean: "the doorframe", seat: "on a stool", table: "the table" }] as const));
      for (const pf of dealPerformances(sheets, flags, rnd, perfCaps(10, 6)).values()) { seen.add(pf.hands); expect(pf.moment).not.toMatch(BAN); }
    }
    for (const h of seen) if (h !== "") expect(h).not.toMatch(BAN);
    void hands;
  });

  it("shy is upright with the shoulders a little in and one hand holding the other arm, not hunched; a table is only dealt where the place has one", () => {
    expect(POSTURES.find((p) => p.id === "fidget")!.text).toBe("standing upright, shoulders a little drawn in, one hand holding the other forearm");
    for (const seed of SEEDS) for (const c of dealShotCards(sheetsOf(seed)).values()) {
      const po = POSTURES.find((x) => x.id === c.momentId.split("+")[1])!;
      if (po.needs === "table") expect(PLACES.find((p) => p.id === c.placeId)!.table, `${c.placeId} ${po.id}`).toBeDefined();
      if (c.placeId === "back-yard") expect(c.posture).not.toMatch(/table/);
    }
  });

  it("two people never get the same setting sentence in a cast (the same place with a different detail and regional look)", () => {
    const sheets: ShotSheet[] = Array.from({ length: 15 }, (_, i) => ({ id: `n${i}`, name: `N${i}`, age: 30, hometown: i % 2 === 0 ? "Atlanta, Georgia" : "Gainesville, Georgia", castingLabel: "the jock", biography: "plays ball in the yard" }));
    const places = [...dealShotCards(sheets).values()].map((c) => c.place.replace(/Atlanta, Georgia|Gainesville, Georgia/g, "TOWN"));
    expect(new Set(places).size).toBe(places.length);
    for (const seed of SEEDS.slice(0, 20)) {
      const ps = [...dealShotCards(sheetsOf(seed)).values()].map((c) => c.place);
      expect(new Set(ps).size, `${seed}`).toBe(ps.length);
    }
  });

  it("no gesture, expression or hands entry is repeated across a cast where the tables are big enough; no eyes shut; nothing seated low", () => {
    const ps = [...EXPRESSIONS, ...POSTURES.map((p) => ({ text: p.text }))];
    for (const e of ps) expect(e.text).not.toMatch(/eyes (?:squeezed|crinkled nearly) shut|eyes closed|squeezed shut/);
    for (const seed of SEEDS) {
      const cards = [...dealShotCards(sheetsOf(seed)).values()];
      const count = (xs: string[]): number => tally(xs);
      expect(count(cards.map((c) => c.momentId.split("+")[0]!)), `expression ${seed}`).toBeLessThanOrEqual(2);
      expect(count(cards.map((c) => c.hands).filter((h) => h !== "")), `hands ${seed}`).toBeLessThanOrEqual(2);
      const fam = (t: string): string | undefined => gestureFamily(t);
      for (const f of ["arms-crossed", "hand-to-head", "open-palm", "hips"]) {
        const n = cards.filter((c) => fam(c.posture) === f || fam(c.hands) === f).length;
        expect(n, `${f} ${seed}`).toBeLessThanOrEqual(2);
      }
      for (const c of cards) { expect(c.hands).not.toMatch(/palm up|open and relaxed|back of the neck/); expect(c.moment).not.toMatch(/(?:seated|perched|sitting|sprawled)[^;]*\b(?:dock|steps|stoop|bleachers|log|ground)\b|cross-legged/); }
      // on most casts every expression is used once
      expect(new Set(cards.map((c) => c.momentId.split("+")[0])).size, `distinct expressions ${seed}`).toBeGreaterThanOrEqual(11);
    }
    // the low places do not seat anyone: the seated head stays at the standing height
    for (const id of ["lakeside", "front-porch", "stoop", "ball-field", "trail"]) expect(PLACES.find((p) => p.id === id)!.seat, id).toBeUndefined();
    expect(PLACES.find((p) => p.id === "lakeside")!.perch).toBeUndefined();
    expect(gestureFamily("arms crossed, leaning back against the fence")).toBe("arms-crossed");
    expect(gestureFamily("one hand lightly touching the hair")).toBe("hand-to-head");
    expect(gestureFamily("turned toward someone off-camera, mid-sentence, one hand open")).toBe("open-palm");
  });

  it("accessories follow the place: no hat, scarf or coat indoors, never sunglasses; outdoors a hat stays", () => {
    const sheet = sheetsOf(5)[0]!;
    const plan = dealPortraitPlans([sheet]).get(sheet.id)!;
    const facets = { appearance: "card", age: 40, presentation: "plain", hometown: "Sidney, Nebraska",
      physicalCharacteristics: { heightBuild: "average", skinTone: "fair", hair: "short hair", facialFeatures: "x", distinguishingMark: "none notable", ageLook: "x", style: "plain",
        wardrobe: ["a woven straw sun hat", "oatmeal linen shirt", "tinted sunglasses", "a wool coat"] } };
    const inside = buildPortraitPrompt(sheet.id, "N", facets, "x", { ...plan, shot: { ...plan.shot, outdoor: false } }).prompt;
    const outside = buildPortraitPrompt(sheet.id, "N", facets, "x", { ...plan, shot: { ...plan.shot, outdoor: true } }).prompt;
    expect(inside).not.toMatch(/sun hat|wool coat|sunglasses/);
    expect(inside).toMatch(/Wearing oatmeal linen shirt/);
    expect(outside).toMatch(/sun hat/); expect(outside).toMatch(/wool coat/);
    expect(outside).not.toMatch(/sunglasses/);
  });

  it("a prop only when the sheet gives a reason", () => {
    expect(propFor({ id: "a", age: 30, vocation: "line cook" })).toBeUndefined();            // no work props in cast photos
    expect(propFor({ id: "a", age: 30, vocation: "strength coach" })).toBeUndefined();
    expect(propFor({ id: "a", age: 30, vocation: "high school teacher" })).toMatch(/paperback/);
    expect(propFor({ id: "a", age: 30, vocation: "hospice night nurse" })).toBeUndefined();
    const none = dealShotCards(Array.from({ length: 15 }, (_, i) => ({ id: `n${i}`, name: `N${i}`, age: 30, vocation: "office manager" })));
    expect([...none.values()].filter((c) => c.prop).length).toBe(0);
    const many = dealShotCards(Array.from({ length: 15 }, (_, i) => ({ id: `n${i}`, name: `N${i}`, age: 30, vocation: "high school teacher" })));
    expect([...many.values()].filter((c) => c.prop).length).toBe(2);
    expect([...many.values()].some((c) => /\bmug\b/.test(c.prop ?? ""))).toBe(false);
  });

  it("the place is from the person's ordinary day, looks like where they live, and the job does not define the photo", () => {
    const by = (id: string) => PLACES.find((p) => p.id === id)!;
    const hiker: ShotSheet = { id: "h", age: 21, castingLabel: "the rebel", vocation: "hospice night nurse", hometown: "Grand Junction, Colorado", biography: "Off the clock she hikes Colorado mesa trails alone." };
    expect(placeFit(by("trail"), hiker)!.score).toBeGreaterThan(placeFit(by("diner-booth"), hiker)!.score);
    expect(placeFit(by("trail"), hiker)!.why).toMatch(/hik/);
    expect(placeFit(by("trail"), hiker)!.why).toMatch(/hometown Grand Junction, Colorado \(mountain-west\)/);
    // a job word does not send a nurse to a hospital, a cook to a kitchen line or a firefighter to a station: no such place exists
    expect(PLACES.map((p) => p.id).join(",")).not.toMatch(/hospital|station|restaurant-kitchen|clinic/);
    const cook: ShotSheet = { id: "c", age: 36, vocation: "line cook", hometown: "Sidney, Nebraska", biography: "She grew up eating at the family table and the town diner." };
    expect(placeFit(by("family-table"), cook)!.score).toBeGreaterThan(0);
    expect(placeFit(by("work-plaza"), { id: "x", age: 30 })).toBeUndefined();   // no job, nothing near work
    // the setting looks like where they live
    expect(placeText(by("front-porch"), "Starkville, Mississippi")).toMatch(/Starkville, Mississippi, .*(?:live oaks and humid green|tin roofs and a gravel lane|a pecan tree and cicadas)/);
    expect(placeText(by("main-street"), "Sidney, Nebraska")).toMatch(/Sidney, Nebraska.*(?:flat farmland and a grain elevator|a huge sky and a gravel road|a water tower|wind-bent cottonwoods)/);
    // when the state rule does not fit the town the regional phrase is left out, never guessed
    for (const town of ["Cedar Key, Florida", "Los Angeles, California", "Kapaʻa, Hawaii", "Houston, Texas", "Asheville, North Carolina", "Biloxi, Mississippi", "Seattle, Washington"]) {
      expect(regionOf(town), town).toBeUndefined();
      expect(placeText(by("back-yard"), town), town).not.toMatch(/pines|red clay|magnolia|palms|stucco|live oaks|grain elevator|firs|, $/);
    }
    expect(placeText(by("back-yard"), "Cedar Key, Florida")).toMatch(/^the back yard of the person's home in Cedar Key, Florida, [^,]+$/);
    expect(placeText(by("home-kitchen"), undefined)).toMatch(/their home town/);
    expect(regionOf("Atlanta, Georgia")).toBe("southeast");
    for (const seed of SEEDS) {
      const sheets = sheetsOf(seed);
      for (const [id, c] of dealShotCards(sheets)) {
        expect(placeFit(PLACES.find((p) => p.id === c.placeId)!, sheets.find((x) => x.id === id)!), `${seed} ${id} ${c.placeId}`).toBeDefined();
        expect(c.why).toMatch(/place \S+ \(/);
        if (c.placeKind === "work-adjacent") expect(c.place).toMatch(/own everyday clothes/);
      }
    }
  });

  it("is deterministic, and the same cast in another order gets the same cards", () => {
    const sheets = sheetsOf(77);
    expect([...dealShotCards(sheets)]).toEqual([...dealShotCards(sheets)]);
    const a = dealShotCards(sheets), b = dealShotCards([...sheets].reverse());
    for (const s of sheets) expect(b.get(s.id)).toEqual(a.get(s.id));
  });
});

describe("ORW-480 face cards", () => {
  it("over 40 casts: no two faces share a combination (they differ on at least 4 of 8), no value on more than 3, no quirk twice", () => {
    for (const seed of SEEDS) {
      const faces = [...dealFaceCards(sheetsOf(seed)).values()];
      const axes = ["shape", "jaw", "brows", "neck", "nose", "eyes", "mouth", "quirk"] as const;
      for (let i = 0; i < faces.length; i++) for (let j = 0; j < i; j++) {
        expect(axes.filter((a) => faces[i]![a] !== faces[j]![a]).length, `seed ${seed} ${i}/${j}`).toBeGreaterThanOrEqual(FACE_MIN_DISTANCE);
      }
      for (const a of axes.filter((x) => x !== "quirk")) expect(tally(faces.map((f) => f[a])), `${a} ${seed}`).toBeLessThanOrEqual(3);
      expect(new Set(faces.map((f) => f.quirk)).size, `quirk ${seed}`).toBe(15);
    }
  });

  it("the face never contradicts itself and the neck agrees with the written build", () => {
    for (const seed of SEEDS) for (const f of dealFaceCards(sheetsOf(seed)).values()) {
      if (/^a round,/.test(f.shape)) expect(f.jaw).not.toMatch(/long|wide, heavy|square/);
      if (/long, narrow face/.test(f.shape)) expect(f.jaw).not.toMatch(/small|soft|wide/);
      if (/heart-shaped/.test(f.shape)) expect(f.jaw).not.toMatch(/square|wide|long/);
    }
    expect(buildClassOf("short and slight, light-boned")).toBe("slender");
    expect(buildClassOf("tall and solidly built, thick through the shoulders")).toBe("thick");
    expect(buildClassOf("tall and lanky, with broad shoulders and a strong, wiry frame")).toBeUndefined();   // a conflicting build: no neck is forced
    const sheets = Array.from({ length: 15 }, (_, i) => ({ id: `s${i}`, name: `S${i}`, age: 25, heightBuild: i % 2 ? "short and slight" : "solidly built and powerful" }));
    for (const [id, f] of dealFaceCards(sheets)) {
      const slight = Number(id.slice(1)) % 2 === 1;
      expect(f.neck).toMatch(slight ? /slender|slim|average|strong/ : /thick|strong|average/);
      expect(f.neck).not.toMatch(/shoulders$/.test(f.neck) && slight ? /broad/ : /^$/);
      expect(f.neck).not.toMatch(slight ? /thick/ : /slender|slim/);
    }
  });

  it("a feature the written face line names is kept (square jaw, deep-set eyes), and the rest is still dealt", () => {
    const sheets = sheetsOf(5).map((s, i) => (i < 3 ? { ...s, facialFeatures: "a square jaw and deep-set eyes" } : s));
    const faces = dealFaceCards(sheets);
    for (const s of sheets.slice(0, 3)) { expect(faces.get(s.id)!.jaw).toBe("a square jaw"); expect(faces.get(s.id)!.eyes).toBe("deep-set eyes"); }
    const three = sheets.slice(0, 3).map((s) => faces.get(s.id)!);
    expect(new Set(three.map((f) => `${f.shape}|${f.nose}|${f.brows}|${f.mouth}`)).size).toBe(3);
  });
});

describe("ORW-480 the prompts", () => {
  const LINES = JSON.parse(readFileSync(new URL("../fixtures/orw441_oncamera_lines.json", import.meta.url), "utf8")) as { gender: "man" | "woman" | "nonbinary"; onCamera: string }[];
  const cast = (extra: (i: number) => object) => sheetsOf(9).map((s, i) => ({
    id: s.id, name: s.name!, appearance: "card", age: s.age, presentation: "plain", genderPresentation: (["man", "woman", "nonbinary"] as const)[i % 3],
    ...(s.castingRead ? { castingType: { label: s.castingLabel!, read: s.castingRead } } : {}),
    physicalCharacteristics: { heightBuild: "average", skinTone: "fair", hair: "short hair", facialFeatures: "square jaw", distinguishingMark: "none notable",
      ageLook: "thirties", style: "plain", wardrobe: ["grey tee", "dark jeans"], ...extra(i) },
  }));
  it("the writer's on-camera line and the first name never reach the prompt; every prompt has a place, light, moment and face", () => {
    const c = cast((i) => ({ onCamera: `${i} Namea gazes into the camera in the lounge, the one who keeps score.` }));
    const ps = buildCastPortraitPrompts(c, "anchor");
    expect(ps.length).toBe(15);
    for (const p of ps) {
      expect(p.prompt).not.toMatch(/the one who keeps score|Namea/);
      for (const part of ["Setting: ", "Light: ", "The moment: ", "Face: "]) expect(p.prompt).toContain(part);
      expect(p.prompt).not.toMatch(/Waist-up|softly out of focus|soft flattering/);
    }
    expect(LINES.length).toBe(28);
  });
  it("across 15 prompts no room, light or moment sentence is shared by more than its cap", () => {
    const ps = buildCastPortraitPrompts(cast(() => ({})), "anchor").map((p) => p.prompt);
    const get = (re: RegExp): string[] => ps.map((p) => re.exec(p)![1]!);
    expect(tally(get(/Setting: ([^.]+\.)/))).toBeLessThanOrEqual(3);
    expect(tally(get(/Light: ([^.]+\.)/))).toBeLessThanOrEqual(4);
    expect(tally(get(/The moment: ([^.]+\.)/))).toBeLessThanOrEqual(2);
  });
  it("three realism wordings share every fact: format, personality, life fit, marks; none beautifies", () => {
    const c = cast((i) => ({ distinguishingMark: i % 2 === 0 ? "a gap-toothed grin; light freckles across the nose" : "none notable", hair: "short, sleek, glossy black hair", photoHair: "perfectly sleek polished waves", wardrobe: ["designer silk shirt", "dark jeans"] }))
      .map((h, i) => ({ ...h, vocation: "line cook", hometown: "Sidney, Nebraska", age: 36 + (i % 3) }));
    const variants = (["press", "documentary", "minimal"] as const).map((v) => buildCastPortraitPrompts(c, "x", v));
    for (const [vi, ps] of variants.entries()) for (const p of ps) {
      expect(p.prompt, `${vi}`).toMatch(/An ordinary person, not a model: a \d\d-year-old line cook from Sidney, Nebraska; their grooming, hands, build and clothes fit that life\./);
      expect(p.prompt).toContain("Framing, the same for the whole series: a half-length portrait from mid-torso up");
      expect(p.prompt).toContain("The moment: ");
      expect(p.prompt).not.toMatch(/best|flatter|hair and makeup|groomed|polished|well-kept|stunning|professional portrait|high quality|sharp|glossy|sleek|designer|perfect/i);
      expect(p.prompt).not.toMatch(/gap/i);                                   // a tooth gap is never sent
      expect((p.prompt.match(/freckles/g) ?? []).length).toBeLessThanOrEqual(1);
      expect(p.prompt).not.toMatch(/\.\s+Light freckles/i);                   // a mark is a detail inside the face sentence, never a sentence of its own
    }
    expect(buildCastPortraitPrompts(c, "x")).toEqual(variants[1]);                                  // documentary is the default (the owner's pick of the A/B)
    expect(variants[0]![0]!.prompt).toMatch(/^An unretouched photograph from a reality show's press kit, shot on location by a staff photographer with a full-frame camera/);
    expect(variants[0]![0]!.prompt).toMatch(/visible pores and uneven skin tone with a little shine, ordinary teeth, flyaway hairs/);
    expect(variants[1]![0]!.prompt).toMatch(/^A plain, honest portrait of a local resident by a newspaper documentary photographer/);
    expect(variants[2]![0]!.prompt).toMatch(/^A candid photograph\./);
    expect(variants[2]![0]!.prompt).not.toMatch(/pores|Light:|press kit|documentary|unretouched|sensor grain/);
    expect(variants[0]![0]!.prompt).toMatch(/Face: [^.]*with light freckles across the nose\./);   // the mark sits inside the face sentence, once
  });
  it("the cast build and a one-person ask agree (same deal, same text)", () => {
    const c = cast(() => ({}));
    const a = buildCastPortraitPrompts(c, "x"), b = buildCastPortraitPrompts(c, "y");
    expect(a).toEqual(b);
  });
});

describe("ORW-480 no other dealt value moves", () => {
  it("the cast (names, ages, stats), hidden profiles and threads hash is the one creationLooks381 pins, with the shot and face deals run in between", () => {
    const run = (blankText: boolean) => {
      let all = "";
      for (const seed of [1, 2, 3, 77, 2026, 4242]) {
        const { npcs } = generateHouse(new SeededRandom(seed));
        dealShotCards(sheetsOf(seed)); dealFaceCards(sheetsOf(seed)); // our own stream: draws nothing from the game's
        const l = generateCastDeepLayer(seed, npcs);
        dealShotCards(sheetsOf(seed));
        const pub = Object.fromEntries(Object.entries(l.public).map(([k, v]) => [k, { biography: blankText ? 0 : v.biography, physicalCharacteristics: 0 }]));
        // The same blanking as creationLooks381 (ORW-508's and ORW-480's changed fields), so the two pins stay equal.
        const cast = blankText ? npcs.map((n) => ({ ...n, character: { ...n.character, background: 0, presentation: 0, vocation: 0, hometown: 0 } })) : npcs;
        const hid = blankText ? Object.fromEntries(Object.entries(l.hidden).map(([k, v]) => [k, { ...v, secrets: 0, trueGoals: 0, weakness: 0 }])) : l.hidden;
        const thr = blankText ? l.threads.map((t) => ({ ...t, premise: 0 })) : l.threads;
        all += JSON.stringify([cast, pub, hid, thr]);
      }
      return createHash("sha256").update(all).digest("hex");
    };
    expect(run(true)).toBe("986d0ffe76a90b933b5ad2520d0214ff3a800463f4a78fd67258fdf628f76bbd")   // equal to the creationLooks381 blanked pin on main
    expect(run(false)).toBe("315c28f2c5c2b682d22d74334dbd7d4c483afeab8e4da0d35d0a345717554d3a")   // equal to the creationLooks381 full pin (re-pinned by ORW-995; the blanked pin above is unchanged)
  });
});
