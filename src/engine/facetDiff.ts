/**
 * T0-6 — the ONE generic closed-facet-diff validator at the `recordCastProfile` boundary.
 *
 * Replaces the per-facet regex guard that used to live inline in `GameSessionAdapter.recordCastProfile`
 * (the 2026-07-21 #1768 INK-BUDGET backstop): that guard was hand-written for exactly one closed facet
 * (visible ink) and only ever scanned `physicalCharacteristics` fields, never the biography prose — so a
 * tattoo mention smuggled into the authored BIOGRAPHY bypassed it entirely. This module is table-driven —
 * a future closed facet (region, vocation family, …) is one registry row, not a new hand-rolled guard —
 * and it checks BOTH the structured facet fields and the free-text biography.
 *
 * ADR 0005's spirit: this validates CLOSED facets only (a dealt, immutable per-houseguest budget) — it
 * never touches open-set prose meaning, only whether the authored material CONTRADICTS a fixed fact the
 * casting office already committed. A skeleton that granted a dimension (e.g. an inked slot) leaves the
 * author free to sharpen it however they like; only a skeleton that did NOT grant it is guarded.
 *
 * T9 (owner resiliency ruling, 2026-07-21): the demoted per-facet regex (`INK_RE`) is preserved here —
 * never deleted — as an ALARMED MONITOR: `monitorLegacyInkGuard` re-runs it after this generic validator
 * has already corrected the record, and it is a canary, not a corrector. If it ever still finds ink on a
 * no-ink skeleton post-guard, that is a real gap in the generic validator, and it alarms loudly
 * (`console.warn`) rather than silently re-fixing it — demote → observe → delete-never.
 */

/** Facet fields the ink dimension is checked (and, on conflict, reverted) across — mirrors every field
 * that actually reaches the portrait prompt / narrator context via `physicalFacetToAppearance` (the
 * Greptile P1 gap on #1768: a mark-only guard missed `style`, which renders in the portrait's
 * "Presentation style:" line). */
export const RENDERED_FACET_FIELDS = [
  "heightBuild", "skinTone", "hair", "facialFeatures", "distinguishingMark", "ageLook", "style",
  // ORW-360 / ORW-380: the three look fields (wardrobe, onCamera, photoHair). `wardrobe` is a string[] (joined for matching, reverted whole).
  // They feed the portrait prompt via ORW-361, so a tattoo written into either must be caught here.
  "wardrobe", "onCamera", "photoHair",
] as const;

/** Word-bounded ink lexicon — kept IDENTICAL to `tests/unit/diversity.test.ts`'s `INK_LEXICON` (one
 * lexicon, pinned sites) and to the FE mirror in `frontend/src/orwell_cast_authoring.py`'s `_INK_RE`. */
export const INK_RE =
  /\btattoo|\bink(?:ed)?\b|\bblackwork\b|\bbody art\b|\b(?:full|half)[- ]sleeves?(?!\s+(?:tee|t-?shirt|shirt|top|blouse|sweater|kurta)s?\b)/i;

export interface ClosedFacetDimension {
  /** Vault-free canonical name (surfaced in `conflicts` — never the authored value). */
  readonly name: string;
  readonly pattern: RegExp;
  /** `physicalCharacteristics` keys this dimension's pattern is checked (and reverted) across. */
  readonly fields: readonly string[];
}

/** The CLOSED facet dimensions this validator enforces. Table-driven so a future closed facet is one
 * row here, never a new bespoke guard. Only "visible-ink" is enforced today (mirrors the FE's
 * `_CLOSED_FACET_DIMENSIONS`); the shape scales to region/vocation-family/etc. without new call sites. */
export const CLOSED_FACET_DIMENSIONS: readonly ClosedFacetDimension[] = [
  { name: "visible-ink", pattern: INK_RE, fields: RENDERED_FACET_FIELDS },
];

/** Any facet-block shape whose values this validator can pattern-match — deliberately loose (not pinned
 * to the domain `PhysicalCharacteristics` type) so it never creates an import from `src/engine` back
 * onto `src/domain`; callers pass their own concrete facet-record type via the generic parameter. */
type FacetRecordLike = Record<string, string | readonly string[] | undefined>;

/** A facet field's text for matching: a string[] (wardrobe) is joined, an absent field is "". */
function fieldText(rec: FacetRecordLike, f: string): string {
  const v = rec[f];
  return Array.isArray(v) ? v.join(" ") : typeof v === "string" ? v : "";
}

/** Does the COMMITTED skeleton already grant this dimension anywhere in its rendered fields? A granted
 * dimension is the author's to sharpen freely — the guard only holds the line for a dimension the
 * skeleton explicitly did NOT deal. No prior skeleton (pre-game, nothing committed yet) ⇒ nothing to
 * contradict, so every dimension reads as granted (no-op guard). */
function dimensionGranted<T extends object>(prior: T | undefined, dim: ClosedFacetDimension): boolean {
  if (prior === undefined) return true;
  return dim.fields.some((f) => dim.pattern.test(fieldText(prior as FacetRecordLike, f)));
}

export interface FacetGuardResult<T extends object> {
  /** The authored `physicalCharacteristics`, with any field that introduced an un-granted dimension
   * reverted to the committed prior value for that field (per-field, never wholesale — a clean authored
   * facet in another field always stands). `undefined` in ⇒ `undefined` out (nothing to guard). */
  physicalCharacteristics: T | undefined;
  /** True when the authored BIOGRAPHY (a single free-text field — there is no "field" within it to
   * revert) introduces a dimension the skeleton did not grant. The caller must drop the WHOLE biography
   * to the seeded/prior floor in that case (the same "drop the field, seeded floor stands" pattern
   * `identity_contradictions`/`coherence_conflicts` already use FE-side) — never graft a contradicting
   * paragraph beside a corrected facet block. */
  dropBiography: boolean;
  /** Every closed-facet dimension the authored material tried to introduce. Vault-free: dimension NAMES
   * only, never the authored text (mirrors the hidden-field-drop discipline elsewhere in this boundary). */
  conflicts: readonly string[];
}

/**
 * The generic closed-facet-diff validator: for each registered dimension NOT already granted by the
 * committed `prior` skeleton, revert any authored `physicalCharacteristics` field that introduces it, and
 * flag the authored `biography` for a whole-field drop if IT introduces the dimension. Transactional
 * adopt-or-regenerate in spirit — the corrected result either ADOPTS the skeleton's facet (via the
 * per-field revert / biography drop) or leaves fully-coherent authored material untouched; it never lets
 * a contradicting fragment commit beside a clean one (never graft).
 */
export function applyClosedFacetGuard<T extends object>(
  prior: T | undefined,
  authoredPhysical: T | undefined,
  authoredBiography: string | undefined,
): FacetGuardResult<T> {
  const conflicts: string[] = [];
  let dropBiography = false;
  const corrected: T | undefined = authoredPhysical ? { ...authoredPhysical } : authoredPhysical;
  for (const dim of CLOSED_FACET_DIMENSIONS) {
    if (dimensionGranted(prior, dim)) continue; // the skeleton GRANTED this dimension — sharpen freely
    let introduced = false;
    if (corrected !== undefined) {
      for (const f of dim.fields) {
        if (dim.pattern.test(fieldText(corrected as FacetRecordLike, f))) {
          introduced = true;
          if (prior !== undefined) {
            // Revert to the committed value; the optional ORW-360 fields may be absent on the prior
            // (a pre-change save), in which case the field is removed rather than set to undefined.
            const pv = (prior as FacetRecordLike)[f];
            if (pv === undefined) delete (corrected as FacetRecordLike)[f];
            else (corrected as FacetRecordLike)[f] = pv;
          }
        }
      }
    }
    if (authoredBiography !== undefined && dim.pattern.test(authoredBiography)) {
      introduced = true;
      dropBiography = true;
    }
    if (introduced) conflicts.push(dim.name);
  }
  return { physicalCharacteristics: corrected, dropBiography, conflicts };
}

/**
 * T9 — the demoted per-facet regex guard, kept ALIVE as an alarmed monitor (demote → observe →
 * delete-never). Re-runs the legacy literal ink check against the POST-guard state; it never corrects
 * anything itself (`applyClosedFacetGuard` above is the sole corrector) — it only alarms, loudly, if it
 * ever still finds ink on a skeleton that granted none, which would mean the generic validator has a real
 * gap, not a false positive. A silent no-op canary firing never happens in the healthy path.
 */
export function monitorLegacyInkGuard<T extends object>(
  houseguestId: string,
  prior: T | undefined,
  postGuardPhysical: T | undefined,
  postGuardBiography: string | undefined,
): void {
  const priorHasInk = prior !== undefined
    && RENDERED_FACET_FIELDS.some((f) => INK_RE.test(fieldText(prior as FacetRecordLike, f)));
  if (priorHasInk) return; // the skeleton granted ink — nothing for the canary to watch
  const stillInk =
    (postGuardPhysical !== undefined
      && RENDERED_FACET_FIELDS.some((f) => INK_RE.test(fieldText(postGuardPhysical as FacetRecordLike, f))))
    || (postGuardBiography !== undefined && INK_RE.test(postGuardBiography));
  if (stillInk) {
    // eslint-disable-next-line no-console
    console.warn(
      `[facetDiff] ALARM — ${houseguestId}'s no-ink skeleton still carries visible-ink text after the ` +
      "generic closed-facet guard ran (T9 canary: the generic validator has a gap the legacy regex " +
      "caught here — investigate the generic guard before trusting it alone).",
    );
  }
}
