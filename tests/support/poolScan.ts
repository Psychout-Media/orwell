import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * ORW-508 scanner for short dealt string lists, shared by every guard that wants it (no test code here, so importing
 * it never registers a describe block in another file). A list is "dealt" when its constant is read by a pick, a
 * spread, an index by an rng draw or a hash, or a modulo of its length.
 */
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

export interface DealtList { /** The constant's name: the key of the allowlist (a move or rename of the file does not break it). */ id: string; /** Where it was found, for the failure message only. */ site: string; size: number }

export function dealtStringLists(root: string = join(__dirname, "..", "..", "src")): DealtList[] {
  const ROOT = root;
  const out: DealtList[] = [];
  const all = files(ROOT).map((f) => ({ f, src: readFileSync(f, "utf8") }));
  const joined = all.map((x) => x.src).join("\n");
  for (const { f, src } of all) {
    const decl = /(?:^|\n)[ \t]*(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]{0,120})?=\s*\[/g;
    for (let m = decl.exec(src); m; m = decl.exec(src)) {
      const items = stringArrayAt(src, m.index + m[0].length - 1);
      if (!items || items.length < 3) continue;
      if (!DEAL(m[1]!).test(joined)) continue;
      out.push({ id: m[1]!, site: `${relative(ROOT, f).replace(/\\/g, "/")}:${m[1]}`, size: items.length });
    }
  }
  return out;
}

