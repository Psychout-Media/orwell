import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_FLAGS, bootFlagsFromEnv } from "../../../src/featureFlags";
import { RAW_BEHAVIOUR, envNamesReadInSrc } from "../flagInventory";

/**
 * ORW-729: DISCOVERY. The features the what-fired report covers are DERIVED, never typed:
 *   - every flag in the registry (`src/featureFlags.ts` FEATURE_FLAGS) plus the raw behaviour toggles the engine reads that are not on /health (found by the flag inventory's own scan);
 *   - every feature folder entry (`docs/features/NNNN-*.md`);
 *   - the link between them is read from the comment above each registry entry (the spec number, the ticket, the Theme tag) and from the spec files that name the env var.
 * A flag added to the registry shows up in the next report with no edit here.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface FlagInfo {
  envKey: string;
  source: "registry" | "raw";
  defaultOn: boolean;
  /** the value that turns the flag the OTHER way from its default (the ablation) */
  ablateTo: "0" | "1";
  specs: string[];
  themes: string[];
  tickets: string[];
}
export interface FeatureInfo { id: string; slug: string; title: string; hasFeatureFile: boolean; status: string }

/** The comment block right above each registry entry, by env var (consecutive `//` lines immediately before the entry). */
export function commentsByFlag(src: string): Map<string, string> {
  const lines = src.split("\n");
  const out = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const m = /envKey:\s*'(ORWELL_[A-Z0-9_]+)'/.exec(lines[i]!);
    if (!m) continue;
    const block: string[] = [];
    for (let j = i - 1; j >= 0 && /^\s*\/\//.test(lines[j]!); j--) block.unshift(lines[j]!);
    out.set(m[1]!, block.join(" ") + " " + lines[i]!.replace(/^.*\}\s*,?\s*\/\//, ""));
  }
  return out;
}

const uniq = (xs: string[]): string[] => [...new Set(xs)].sort();
export function tagsOf(text: string): { specs: string[]; themes: string[]; tickets: string[] } {
  return {
    specs: uniq([...text.matchAll(/\b(0[0-2]\d{2})\b/g)].map((m) => m[1]!)),
    themes: uniq([...text.matchAll(/\bTheme\s+([0-9A-Za-z]+)\b/g)].map((m) => m[1]!)),
    tickets: uniq([...text.matchAll(/\bORW-\d+\b/g)].map((m) => m[0])),
  };
}

/** The registry default of each flag, run through the registry's own parsers on an UNSET environment. */
export function registryDefaults(): Record<string, boolean> {
  const saved: Record<string, string | undefined> = {};
  for (const k of [...FEATURE_FLAGS.map((f) => f.envKey), "ORWELL_FLAGS_OFF"]) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    const boot = bootFlagsFromEnv();
    return Object.fromEntries(FEATURE_FLAGS.map((f) => [f.envKey, boot[f.key]!]));
  } finally { for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v; }
}

export function discoverFeatures(root: string = ROOT): FeatureInfo[] {
  const dir = join(root, "docs", "features");
  const out: FeatureInfo[] = [];
  for (const f of readdirSync(dir).sort()) {
    const m = /^(\d{4})-(.+)\.md$/.exec(f);
    if (!m) continue;
    const text = readFileSync(join(dir, f), "utf8");
    const title = (/^#\s+(.+)$/m.exec(text)?.[1] ?? m[2]!).replace(/^\d{4}\s*[-:\u2014\u2013]?\s*/, "").slice(0, 110);
    const status = (/^Status:\s*(.+)$/m.exec(text)?.[1] ?? "").slice(0, 80);
    out.push({ id: m[1]!, slug: m[2]!, title, hasFeatureFile: existsSync(join(dir, f.replace(/\.md$/, ".feature"))), status });
  }
  return out;
}

export function discoverFlags(root: string = ROOT): FlagInfo[] {
  const regSrc = readFileSync(join(root, "src", "featureFlags.ts"), "utf8");
  const comments = commentsByFlag(regSrc);
  const featDir = join(root, "docs", "features");
  const specDocs = readdirSync(featDir).filter((f) => /^\d{4}-.*\.md$/.test(f)).map((f) => ({ id: f.slice(0, 4), text: readFileSync(join(featDir, f), "utf8") }));
  const defaults = registryDefaults();
  const link = (envKey: string): { specs: string[]; themes: string[]; tickets: string[] } => {
    const t = tagsOf(comments.get(envKey) ?? "");
    const named = specDocs.filter((d) => d.text.includes(envKey)).map((d) => d.id);
    return { specs: uniq([...t.specs, ...named]), themes: t.themes, tickets: t.tickets };
  };
  const out: FlagInfo[] = FEATURE_FLAGS.map((f) => ({ envKey: f.envKey, source: "registry" as const, defaultOn: defaults[f.envKey]!, ablateTo: defaults[f.envKey]! ? "0" as const : "1" as const, ...link(f.envKey) }));
  const registry = new Set(FEATURE_FLAGS.map((f) => f.envKey));
  for (const n of envNamesReadInSrc()) {
    const r = RAW_BEHAVIOUR[n];
    if (registry.has(n) || !r || r.kind !== "toggle") continue;
    const on = /^on$/i.test(r.default);
    if (!on && !/^off$/i.test(r.default)) continue; // a toggle whose default is computed elsewhere is not ablated blind
    out.push({ envKey: n, source: "raw", defaultOn: on, ablateTo: on ? "0" : "1", ...link(n) });
  }
  return out.sort((a, b) => (a.envKey < b.envKey ? -1 : 1));
}
