import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_FLAGS, bootFlagsFromEnv } from "../../src/featureFlags";

/**
 * B45 - the ORWELL_* FLAG INVENTORY: one generated table (`docs/FLAG-INVENTORY.md`) and the drift gate behind it. Built from the code, never typed by hand:
 *   - the /health registry (`src/featureFlags.ts`): env var, /health key, parser, and the code default (the parser run on an UNSET env);
 *   - the deploy defaults (`deploy/orwell-env-defaults.sh`): the value the deploy writes;
 *   - the pins (`tests/unit/flagDefaultParity.test.ts` NEVER_FLIPPED, `tests/unit/healthFlags.test.ts` NOT_FLIPPED) - which flags are deliberately opt-in;
 *   - every other ORWELL_* name `src/` reads (raw `process.env` reads of flags that are not on /health yet, and the operational config vars).
 * `undeclaredReads()` is the gate: an ORWELL_* name read in src that none of those declare (and that is not an allow-listed operational var) is drift.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/** Operational/config env vars (not behaviour flags): reading them in src needs no flag declaration. One reason each. */
export const OPERATIONAL_ENV: Readonly<Record<string, string>> = {
  ORWELL_DATA_DIR: "per-user save directory",
  ORWELL_STORE: "save-store backend selector (file | sqlite)",
  ORWELL_ENGINE_PORT: "HTTP edge port",
  ORWELL_ENGINE_HOST: "HTTP edge bind host",
  ORWELL_ENGINE_TOKEN: "shared secret on every tool route",
  ORWELL_ENGINE_ADMIN_TOKEN: "separate secret for /admin/*",
  ORWELL_ENGINE_MCP_URL: "where the front-end reaches the engine",
  ORWELL_ENGINE_TIMEOUT: "engine call timeout",
  ORWELL_ENGINE_RESPONSE_BUDGET_MS: "engine response budget",
  ORWELL_ENGINE_MULTIUSER: "reject a missing x-orwell-user",
  ORWELL_PORT: "legacy port fallback",
  ORWELL_EMBEDDINGS: "embedding provider selector",
  ORWELL_EMBED_CACHE: "embedding model cache dir",
  ORWELL_EMBED_THREADS: "embedding worker threads",
  ORWELL_EMBED_WARMUP_MS: "embedding warm-up budget",
  ORWELL_MAX_RESIDENT_SANDBOXES: "resident sandbox cap",
  ORWELL_FLAGS_OFF: "diagnostic: restore every default-flipped flag to OFF",
};

/** Raw `process.env` BEHAVIOUR reads that are not on /health (found by the gate): the doc lists them under their own heading, with kind, default and reason - they are NOT operational config. */
export const RAW_BEHAVIOUR: Readonly<Record<string, { kind: "toggle" | "seam" | "knob"; default: string; reason: string }>> = {
  ORWELL_COMP_THEMES: { kind: "toggle", default: "ON", reason: "themed competition variety; =0 turns it off" },
  ORWELL_GEN_COMPETITIONS: { kind: "toggle", default: "off", reason: "generative competitions (#1400); the God-Mode dial also sets it per sandbox" },
  ORWELL_MEMORY_CALLBACKS: { kind: "toggle", default: "see memoryCallbackConstants", reason: "memory callbacks (narrator lines), read through MEMORY_CALLBACKS_ENV" },
  ORWELL_DISABLE_DIVERSITY: { kind: "seam", default: "off", reason: "TEST SEAM (#338 RNG-isolation golden test): =1 skips the diversity pass" },
  ORWELL_HANGOUT_P_SCALE: { kind: "knob", default: "1", reason: "live-verification knob (A15): scales the hang-out stop chances; the deploy never sets it" },
  ORWELL_WANT_MOVEMENT_K: { kind: "knob", default: "1", reason: "calibration-measurement override of the want-movement strength; the deploy never sets it" },
};

const walk = (dir: string, out: string[] = []): string[] => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
};

/** Drop `/* ... *\/` and `// ...` comments so a name only MENTIONED in prose (a design flag, a spec reference) is not counted as a read. Strings are kept (a read is `process.env.X` / `"ORWELL_X"`). */
export function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

/** Every distinct ORWELL_<NAME> token in src/ code (comments stripped) (a bare `ORWELL_` prefix in a template is not a name). */
export function envNamesReadInSrc(): string[] {
  const names = new Set<string>();
  for (const f of walk(join(ROOT, "src"))) for (const m of stripComments(readFileSync(f, "utf8")).matchAll(/ORWELL_[A-Z0-9]+(?:_[A-Z0-9]+)*/g)) names.add(m[0]);
  return [...names].sort();
}

const quoted = (text: string): Set<string> => new Set([...text.matchAll(/"(ORWELL_[A-Z0-9_]+)"/g)].map((m) => m[1]!));
const deployDefaults = (): Map<string, string> => {
  const m = new Map<string, string>();
  for (const line of read("deploy/orwell-env-defaults.sh").split("\n")) {
    const x = /^(ORWELL_[A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (x) m.set(x[1]!, x[2]!);
  }
  return m;
};
const neverFlipped = (): Set<string> => {
  const t = read("tests/unit/flagDefaultParity.test.ts");
  const a = t.indexOf("const NEVER_FLIPPED = [");
  return quoted(t.slice(a, t.indexOf("];", a)));
};

/** The names the codebase DECLARES somewhere (registry, deploy defaults, the never-flipped pin, the operational allow-list). */
export function declaredNames(): Set<string> {
  return new Set([...FEATURE_FLAGS.map((f) => f.envKey), ...deployDefaults().keys(), ...neverFlipped(), ...Object.keys(OPERATIONAL_ENV), ...Object.keys(RAW_BEHAVIOUR)]);
}
export function undeclaredReads(): string[] {
  const declared = declaredNames();
  return envNamesReadInSrc().filter((n) => !declared.has(n));
}

export function renderInventory(): string {
  const dep = deployDefaults();
  const pinned = neverFlipped();
  const saved: Record<string, string | undefined> = {};
  for (const k of [...FEATURE_FLAGS.map((f) => f.envKey), "ORWELL_FLAGS_OFF"]) { saved[k] = process.env[k]; delete process.env[k]; }
  const defaults = Object.fromEntries(FEATURE_FLAGS.map((f) => [f.envKey, undefined as boolean | undefined]));
  try {
    // run each parser on an UNSET env through the registry's own function
    const boot = bootFlagsFromEnv();
    for (const f of FEATURE_FLAGS) defaults[f.envKey] = boot[f.key];
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
  const rows: string[] = [
    "# ORWELL_* flag inventory",
    "",
    "GENERATED by `npx tsx scripts/gen-flag-inventory.ts` from `src/featureFlags.ts`, `deploy/orwell-env-defaults.sh` and the pins in `tests/unit/flagDefaultParity.test.ts`; `tests/unit/flagInventory.test.ts` fails when this file is stale or when `src/` reads an `ORWELL_*` name that nothing declares. Do not edit by hand.",
    "",
    "## Behaviour flags on `/health` (the registry)",
    "",
    "| Env var | /health key | Parser | Registry default | Deploy writes | Pinned opt-in (never flipped) |",
    "|---|---|---|---|---|---|",
  ];
  for (const f of FEATURE_FLAGS) {
    rows.push(`| \`${f.envKey}\` | \`${f.key}\` | ${f.parser} | ${defaults[f.envKey] ? "ON" : "off"} | ${dep.has(f.envKey) ? `\`${dep.get(f.envKey)}\`` : "-"} | ${pinned.has(f.envKey) ? "yes" : "-"} |`);
  }
  const registry = new Set(FEATURE_FLAGS.map((f) => f.envKey));
  const rawFlags = envNamesReadInSrc().filter((n) => !registry.has(n) && !(n in OPERATIONAL_ENV));
  rows.push("", "## Behaviour flags read raw by the engine (not on `/health`)", "", "| Env var | Kind | Default | Deploy writes | Pinned opt-in (never flipped) | Note |", "|---|---|---|---|---|---|");
  for (const n of rawFlags) { const r = RAW_BEHAVIOUR[n]; rows.push(`| \`${n}\` | ${r?.kind ?? "flag"} | ${r?.default ?? (pinned.has(n) ? "off" : "-")} | ${dep.has(n) ? `\`${dep.get(n)}\`` : "-"} | ${pinned.has(n) ? "yes" : "-"} | ${r?.reason ?? ""} |`); }
  rows.push("", "## Operational config (not behaviour flags)", "", "| Env var | Purpose |", "|---|---|");
  for (const [n, why] of Object.entries(OPERATIONAL_ENV)) rows.push(`| \`${n}\` | ${why} |`);
  return rows.join("\n") + "\n";
}
