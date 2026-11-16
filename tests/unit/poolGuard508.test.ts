import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import allowlist from "./poolGuard508.allowlist.json";

// ORW-508 static guard: a short list of strings that the engine DEALS from (a pick, a spread, an index by
// an rng draw or a hash) must not reach a player-facing field unless it is on the allowlist with a written
// reason. New short lists fail here, so the class of defect cannot grow back unseen. The pick strategy that
// replaces such a list is in the audit for ORW-508: world tables, per-person invention, entropy and memory.

const ROOT = join(__dirname, "..", "..", "src");
/** A dealt string list shorter than this is on the allowlist or the test fails. */
export const SHORT_LIST_LIMIT = 40;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** Elements of the array literal that opens at `src[i] === "["`, or null when it is not all string literals. */
function stringArrayAt(src: string, i: number): string[] | null {
  let depth = 0, q: string | null = null, esc = false, start = i + 1;
  const items: string[] = [];
  for (let j = i; j < src.length; j++) {
    const c = src[j]!;
    if (q) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === q) q = null; continue; }
    if (c === "/" && src[j + 1] === "/") { j = src.indexOf("\n", j); if (j < 0) return null; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "[" || c === "(" || c === "{") { depth++; continue; }
    if (c === "]" || c === ")" || c === "}") {
      depth--;
      if (depth === 0) { items.push(src.slice(start, j)); break; }
      continue;
    }
    if (c === "," && depth === 1) { items.push(src.slice(start, j)); start = j + 1; }
  }
  const clean = items.map((x) => x.replace(/\/\/[^\n]*/g, "").trim()).filter((x) => x !== "");
  return clean.length > 0 && clean.every((x) => /^(["'`])[\s\S]*\1$/.test(x)) ? clean : null;
}

const DEAL = (name: string): RegExp =>
  new RegExp(`(pick\\(\\s*${name}\\b|spreadFacet\\([^)]*\\b${name}\\b|\\b${name}\\[[^\\]]*(?:int|next)\\(|%\\s*${name}\\.length|\\b${name}\\.length\\)|${name}\\)\\s*%|sample\\(\\s*${name}\\b|\\(${name}\\b[^)]*\\bpick)`);

export interface DealtList { id: string; size: number }

export function dealtStringLists(): DealtList[] {
  const out: DealtList[] = [];
  const all = files(ROOT).map((f) => ({ f, src: readFileSync(f, "utf8") }));
  const joined = all.map((x) => x.src).join("\n");
  for (const { f, src } of all) {
    const decl = /(?:^|\n)[ \t]*(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]{0,120})?=\s*\[/g;
    for (let m = decl.exec(src); m; m = decl.exec(src)) {
      const items = stringArrayAt(src, m.index + m[0].length - 1);
      if (!items || items.length < 3) continue;
      if (!DEAL(m[1]!).test(joined)) continue;
      out.push({ id: `${relative(ROOT, f).replace(/\\/g, "/")}:${m[1]}`, size: items.length });
    }
  }
  return out;
}

describe("ORW-508 static guard: short dealt string lists", () => {
  const dealt = dealtStringLists();
  const reasons = allowlist as Record<string, string>;

  it("finds the lists it is meant to find", () => {
    const ids = dealt.map((d) => d.id);
    expect(ids).toContain("engine/characterFactory.ts:DEMEANORS");
    expect(ids).toContain("engine/data/givenNames.ts:GIVEN_NAMES");
  });

  it("every dealt list shorter than the limit is on the allowlist with a written reason", () => {
    const missing = dealt.filter((d) => d.size < SHORT_LIST_LIMIT && !reasons[d.id]).map((d) => `${d.id} (${d.size})`);
    expect(missing, `new short dealt list(s): move the value to a world table, a composed deal or the writer, or add an allowlist entry with a reason`).toEqual([]);
  });

  it("the allowlist holds no stale entries and no empty reasons", () => {
    const ids = new Set(dealt.map((d) => d.id));
    const stale = Object.keys(reasons).filter((k) => !ids.has(k) || dealt.find((d) => d.id === k)!.size >= SHORT_LIST_LIMIT);
    expect(stale).toEqual([]);
    for (const [k, v] of Object.entries(reasons)) expect(v.length, k).toBeGreaterThan(12);
  });
});
