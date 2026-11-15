import { describe, it, expect, vi, afterEach } from "vitest";
import {
  applyClosedFacetGuard, monitorLegacyInkGuard, CLOSED_FACET_DIMENSIONS, RENDERED_FACET_FIELDS, INK_RE,
} from "../../src/engine/facetDiff";

// T0-6 — the ONE generic closed-facet-diff validator at the recordCastProfile boundary. These are
// PURE unit tests of the module itself (no game/sandbox needed); the wired-in behavior at the real
// recordCastProfile boundary is covered end-to-end in tests/unit/diversity.test.ts.

const cleanFacet = () => ({
  heightBuild: "tall and lean", skinTone: "warm tan complexion", hair: "short dark hair",
  facialFeatures: "a square jaw", distinguishingMark: "none notable",
  ageLook: "fresh-faced, late-twenties look", style: "sporty and laid-back",
});

describe("facetDiff — the generic closed-facet-diff validator", () => {
  it("is table-driven: exactly one registered dimension today (visible-ink), by name", () => {
    expect(CLOSED_FACET_DIMENSIONS.map((d) => d.name)).toEqual(["visible-ink"]);
  });

  it("no prior skeleton (pre-game) ⇒ every dimension reads as granted (no-op guard)", () => {
    const authored = { ...cleanFacet(), style: "visible forearm ink" };
    const res = applyClosedFacetGuard(undefined, authored, "a clean bio");
    expect(res.conflicts).toEqual([]);
    expect(res.physicalCharacteristics).toEqual(authored);
    expect(res.dropBiography).toBe(false);
  });

  it("a no-ink prior refuses an authored field that introduces ink, per-field, and reports the conflict", () => {
    const prior = cleanFacet();
    const authored = { ...cleanFacet(), distinguishingMark: "a full sleeve of intricate tattoos" };
    const res = applyClosedFacetGuard(prior, authored, undefined);
    expect(res.conflicts).toEqual(["visible-ink"]);
    expect(res.physicalCharacteristics!.distinguishingMark).toBe(prior.distinguishingMark);
    // Every OTHER authored field still stands (per-field revert, never a wholesale reject).
    expect(res.physicalCharacteristics!.hair).toBe(authored.hair);
    expect(res.dropBiography).toBe(false);
  });

  it("a no-ink prior flags the WHOLE biography for drop when the prose alone introduces ink", () => {
    const prior = cleanFacet();
    const res = applyClosedFacetGuard(prior, undefined, "got a full sleeve of tattoos on tour");
    expect(res.conflicts).toEqual(["visible-ink"]);
    expect(res.dropBiography).toBe(true);
  });

  it("a granted-ink prior leaves BOTH the facet fields and the biography free to sharpen", () => {
    const prior = { ...cleanFacet(), distinguishingMark: "a forearm tattoo of a compass rose" };
    const authored = { ...cleanFacet(), style: "tattooed rocker edge" };
    const res = applyClosedFacetGuard(prior, authored, "every tattoo tells a story from tour");
    expect(res.conflicts).toEqual([]);
    expect(res.physicalCharacteristics!.style).toBe(authored.style);
    expect(res.dropBiography).toBe(false);
  });

  it("a clean authored facet + a clean biography never trip the guard", () => {
    const prior = cleanFacet();
    const authored = cleanFacet();
    const res = applyClosedFacetGuard(prior, authored, "grew up cooking and skating");
    expect(res.conflicts).toEqual([]);
    expect(res.dropBiography).toBe(false);
    expect(res.physicalCharacteristics).toEqual(authored);
  });

  it("is a pure function: identical inputs ⇒ identical (deep-equal) output, no hidden state", () => {
    const prior = cleanFacet();
    const authored = { ...cleanFacet(), hair: "a full sleeve of ink on the neckline" };
    const a = applyClosedFacetGuard(prior, authored, "a plain bio");
    const b = applyClosedFacetGuard(prior, authored, "a plain bio");
    expect(a).toEqual(b);
  });

  it("RENDERED_FACET_FIELDS covers every field physicalFacetToAppearance renders (the Greptile P1 fix)", () => {
    expect(RENDERED_FACET_FIELDS).toEqual(
      // ORW-360: wardrobe + onCamera are guarded too (the portrait prompt reads them via ORW-361) even though
      // physicalFacetToAppearance (the narrator string) ignores them.
      ["heightBuild", "skinTone", "hair", "facialFeatures", "distinguishingMark", "ageLook", "style",
        "wardrobe", "onCamera", "photoHair"],
    );
  });

  it("INK_RE stays byte-identical to the pinned lexicon (tests/unit/diversity.test.ts / the FE mirror)", () => {
    const lexiconSource =
      "\\btattoo|\\bink(?:ed)?\\b|\\bblackwork\\b|\\bbody art\\b|\\b(?:full|half)[- ]sleeves?" +
      "(?!\\s+(?:tee|t-?shirt|shirt|top|blouse|sweater|kurta)s?\\b)";
    expect(INK_RE.source).toBe(lexiconSource);
  });
});

describe("facetDiff — the demoted INK_RE guard, kept alive as an alarmed monitor (T9)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays silent (no alarm) when the generic guard already cleaned the record", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const prior = cleanFacet();
    const guarded = applyClosedFacetGuard(prior, { ...cleanFacet(), style: "a full sleeve of tattoos" }, undefined);
    monitorLegacyInkGuard("npc:1", prior, guarded.physicalCharacteristics, undefined);
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent when the skeleton already granted ink (nothing to canary)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const prior = { ...cleanFacet(), distinguishingMark: "a forearm tattoo of a compass rose" };
    monitorLegacyInkGuard("npc:1", prior, { ...cleanFacet(), style: "more visible ink" }, "always more ink");
    expect(warn).not.toHaveBeenCalled();
  });

  it("ALARMS (never silently re-fixes) if ink somehow still stands post-guard on a no-ink skeleton", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const prior = cleanFacet();
    // Simulate a hypothetical generic-guard gap: the post-guard state still carries ink somewhere.
    const postGuard = { ...cleanFacet(), facialFeatures: "an inked teardrop under one eye" };
    monitorLegacyInkGuard("npc:7", prior, postGuard, undefined);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("npc:7");
    expect(String(warn.mock.calls[0][0])).toContain("ALARM");
  });

  it("ALARMS on a biography that still carries ink post-guard on a no-ink skeleton", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    monitorLegacyInkGuard("npc:9", cleanFacet(), cleanFacet(), "still mentions a full sleeve of tattoos");
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
