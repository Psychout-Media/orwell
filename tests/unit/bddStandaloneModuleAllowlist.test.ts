import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Guard for the BDD `@standalone-module` tag (PAT-5, #1982).
 *
 * `@standalone-module` marks a scenario that deliberately exercises a module with NO production caller (the live
 * game does it elsewhere). It is an escape hatch from "BDD must drive the live path", so it must never spread
 * silently: the set of tagged (feature file, scenario) pairs must EXACTLY equal the allowlist below, so adding or
 * removing a tag needs a deliberate edit HERE too. Every tagged scenario must also carry an adjacent `#` comment
 * naming a concrete, existing test file (`tests/...` or `frontend/tests/...`) that proves the live behavior or the
 * standalone module, not just "live elsewhere".
 */

const ROOT = resolve(__dirname, "..", "..");
const FEATURES = join(ROOT, "docs", "features");
const TAG = "@standalone-module";

/** The deliberate allowlist: [feature file, scenario name]. Keep sorted by file, then by order in the file. */
const ALLOWED: ReadonlyArray<readonly [string, string]> = [
  ["0023-consequence-and-memory.feature", "Wins and votes are recorded and consequential"],
  ["0024-soul-storage-and-memory-recall.feature", "Recall sharpens the relationship read (mechanics)"],
  ["0024-soul-storage-and-memory-recall.feature", "The inner diary is organised into sections (memories / leanings / feelings)"],
  ["0024-soul-storage-and-memory-recall.feature", "The soul deepens over a game; the character does not"],
  ["0027-narrative-port-llm-adapter.feature", "A narration failure leaves game state untouched"],
  ["0027-narrative-port-llm-adapter.feature", "The provider and secrets come from config, never code"],
  ["0040-npc-confessionals.feature", "Confessionals deepen the soul and ground later voice"],
  ["0071-defensive-hardening-redaction-url-guards.feature", "the URL guard fails closed on unsafe addresses"],
  ["0071-defensive-hardening-redaction-url-guards.feature", "the path join rejects traversal"],
  ["0109-deal-duration.feature", "A no-duration break is byte-identical to 0039 (no duration is the floor, not a flag)"],
];

interface Tagged { file: string; scenario: string; tagLine: number; comment: string }

const isTagLine = (l: string): boolean => l.trim().startsWith("@");
const isCommentLine = (l: string): boolean => l.trim().startsWith("#");

function scanFeature(file: string): { tagged: Tagged[]; featureLevel: boolean } {
  const lines = readFileSync(join(FEATURES, file), "utf8").split(/\r?\n/);
  const tagged: Tagged[] = [];
  let featureLevel = false;
  lines.forEach((line, i) => {
    if (!isTagLine(line) || !line.trim().split(/\s+/).includes(TAG)) return;
    // Walk down past any further tag lines to the construct the tag decorates.
    let j = i + 1;
    while (j < lines.length && (isTagLine(lines[j]!) || lines[j]!.trim() === "" || isCommentLine(lines[j]!))) j++;
    const target = (lines[j] ?? "").trim();
    if (/^Feature:/.test(target)) { featureLevel = true; return; }
    const m = /^Scenario(?: Outline)?:\s*(.+)$/.exec(target);
    if (!m) throw new Error(`${file}:${i + 1}: ${TAG} is not followed by a Scenario (found "${target}")`);
    // The comment block IMMEDIATELY above the tag (skipping other tag lines directly above it).
    let k = i - 1;
    while (k >= 0 && isTagLine(lines[k]!)) k--;
    const comment: string[] = [];
    while (k >= 0 && isCommentLine(lines[k]!)) { comment.unshift(lines[k]!.trim()); k--; }
    tagged.push({ file, scenario: m[1]!.trim(), tagLine: i + 1, comment: comment.join(" ") });
  });
  return { tagged, featureLevel };
}

const files = readdirSync(FEATURES).filter((f) => f.endsWith(".feature")).sort();
const scans = files.map((f) => ({ file: f, ...scanFeature(f) }));
const allTagged = scans.flatMap((s) => s.tagged);
const key = (file: string, scenario: string): string => `${file} :: ${scenario}`;

describe("BDD @standalone-module allowlist (PAT-5 guard)", () => {
  it("no feature carries the tag at Feature level (it would silently cover every scenario)", () => {
    expect(scans.filter((s) => s.featureLevel).map((s) => s.file)).toEqual([]);
  });

  it("the tagged (feature, scenario) set EXACTLY equals the hard-coded allowlist", () => {
    const actual = allTagged.map((t) => key(t.file, t.scenario)).sort();
    const allowed = ALLOWED.map(([f, s]) => key(f, s)).sort();
    expect(allowed.length, "allowlist has no duplicates").toBe(new Set(allowed).size);
    // Added tag => in `actual` not `allowed`; removed tag => in `allowed` not `actual`. Either needs a deliberate edit here.
    expect(actual).toEqual(allowed);
  });

  it("every allowlisted scenario exists in its feature file (no stale entry)", () => {
    for (const [f, s] of ALLOWED) {
      const text = readFileSync(join(FEATURES, f), "utf8");
      expect(text, `${f} has the scenario "${s}"`).toMatch(new RegExp(`^\\s*Scenario(?: Outline)?:\\s*${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m"));
    }
  });

  it("every tagged scenario has an adjacent # comment naming existing test file(s) that prove it", () => {
    const PATH = /\b((?:frontend\/)?tests\/[A-Za-z0-9_./-]+\.(?:test\.ts|py))\b/g;
    for (const t of allTagged) {
      const where = `${t.file}:${t.tagLine} ("${t.scenario}")`;
      expect(t.comment, `${where} needs an adjacent # comment above the tag`).not.toBe("");
      const paths = [...t.comment.matchAll(PATH)].map((m) => m[1]!);
      expect(paths.length, `${where}: the comment must name a concrete tests/... or frontend/tests/... file`).toBeGreaterThan(0);
      for (const p of paths) expect(existsSync(join(ROOT, p)), `${where}: ${p} does not exist`).toBe(true);
    }
  });
});
