/**
 * The observable-emotion tell vocabulary (B12/B28). A LEAF module: plain types, no imports.
 *
 * It exists so `characterFactory.ts` (which persists tells on a houseguest's soul) can name `TellKind` / `TellBand` WITHOUT importing `tells.ts`. `tells.ts` imports `composedEmotion` from `emotionalArc.ts`,
 * which imports types from `characterFactory.ts`; the inline `import("./tells")` in the factory closed `emotionalArc -> characterFactory -> tells -> emotionalArc` and `characterFactory -> tells ->
 * characterFactory` (dependency-cruiser `no-circular`, which no CI job ran before the engine job gained a `npm run test:arch` step). `tells.ts` re-exports both names, so every existing import is unchanged.
 */
export type TellKind = "withdrawn" | "tearful" | "snapping" | "brittle-calm" | "giddy" | "warm-open" | "guarded" | "restless";
export type TellBand = "faint" | "clear" | "strong";
