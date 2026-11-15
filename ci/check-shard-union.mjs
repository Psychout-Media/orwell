#!/usr/bin/env node
// ORW-218: cross-leg proof that the duration-aware split ran EVERY test file exactly once.
//   node ci/check-shard-union.mjs <dir with shard-*.files.json> --count 4 [--exclude <glob> ...]
// Each sharded coverage leg writes {index,count,all,files} (vitest.sequencer.ts, ORWELL_SHARD_MANIFEST_DIR). Fails (exit 1) unless
//  1. all <count> manifests are present, one per leg;
//  2. every leg was handed the same full file list;
//  3. the legs' slices are pairwise disjoint and their union equals that list;
//  4. that list equals the test files that exist on disk (tests/**/*.test.ts) minus the --exclude globs ("dir/**" or an exact path),
//     i.e. the set the unit suite is supposed to run, independently of vitest's own discovery.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const args = process.argv.slice(2);
const dir = args.shift();
let count = 0;
const excludes = [];
while (args.length) {
  const a = args.shift();
  if (a === "--count") count = Number(args.shift());
  else if (a === "--exclude") excludes.push(args.shift());
  else throw new Error(`unknown argument ${a}`);
}
if (!dir || !count) throw new Error("usage: check-shard-union.mjs <dir> --count N [--exclude glob ...]");

const excluded = (f) => excludes.some((g) => (g.endsWith("/**") ? f.startsWith(g.slice(0, -2)) : f === g));
const walk = (d, out = []) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith(".test.ts")) out.push(relative(".", p).split(sep).join("/"));
  }
  return out;
};

const problems = [];
const manifests = readdirSync(dir).filter((n) => /^shard-\d+-of-\d+\.files\.json$/.test(n)).map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
const indexes = manifests.map((m) => m.index).sort((a, b) => a - b);
if (manifests.length !== count || indexes.some((v, i) => v !== i + 1) || manifests.some((m) => m.count !== count)) {
  problems.push(`expected one manifest per leg 1..${count}, found indexes [${indexes.join(",")}]`);
}
const all = manifests[0]?.all ?? [];
for (const m of manifests) if (JSON.stringify(m.all) !== JSON.stringify(all)) problems.push(`leg ${m.index} was handed a different file list than leg ${manifests[0].index}`);
const seen = new Map();
for (const m of manifests) for (const f of m.files) seen.set(f, (seen.get(f) ?? 0) + 1);
const unassigned = all.filter((f) => !seen.has(f));
const twice = [...seen].filter(([, n]) => n > 1).map(([f]) => f);
const stray = [...seen.keys()].filter((f) => !all.includes(f));
if (unassigned.length) problems.push(`UNASSIGNED (would never run): ${unassigned.join(", ")}`);
if (twice.length) problems.push(`assigned to more than one leg: ${twice.join(", ")}`);
if (stray.length) problems.push(`run by a leg but not in the full list: ${stray.join(", ")}`);
const expected = walk("tests").filter((f) => !excluded(f)).sort();
const missing = expected.filter((f) => !all.includes(f));
const extra = all.filter((f) => !expected.includes(f));
if (missing.length) problems.push(`on disk but not in the sharded set (vitest did not discover them): ${missing.join(", ")}`);
if (extra.length) problems.push(`in the sharded set but not on disk / should be excluded: ${extra.join(", ")}`);

if (problems.length) {
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(1);
}
console.log(`shard union OK: ${all.length} files = ${manifests.map((m) => m.files.length).join(" + ")} across ${count} legs; matches ${expected.length} test files on disk`);
