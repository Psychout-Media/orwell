#!/usr/bin/env node
// ORW-758: keep the backlog whole. Ryne (2026-11-20): "if the backlog has holes, then the code that it's built off of also has holes."
// A rule alone did not hold (15 Done cards broke "Done means acceptance met"), so these run by themselves in CI (the `backlog-whole` job, every PR, docs-only included):
//
//   A1  a docs line (docs/**/*.md, but not the records in A1_EXEMPT; ORW-878) or a PR body line that says work is left ("not built", "not done", "deferred", "follow-up", "later slice", ...)
//       must name its ORW card. The lines that existed when this landed are listed in ci/backlog_baseline.json (shrink-only: a listed line that is gone must be
//       removed from the list, so the list can only get shorter; the sweep is ORW-805).
//   A2  a `# spec-only:` feature must say why it does not run: it names the ORW card it waits on (and that card is not Done in ci/board_snapshot.json), or it says
//       "superseded by <file>.feature" naming wired feature files that exist, or it is built and says "gated by <test path>" naming the test that verifies it. The cardless ones that existed when this landed are in the baseline too.
//       (Every .feature is wired or marked: tests/unit/featureShelfDrift.test.ts; cucumber.cjs discovers the wired set.)
//   A3  every spec doc (docs/features/NNNN-*.md) has a row in docs/features/README.md, and every row's link points at a file that exists.
//
// Usage: node ci/check_backlog_whole.mjs            (the repo checks)
//        BASELINE_BASE=<file> ...                    (also fails if the baseline GREW against that copy; CI passes the base commit's)
//        PR_BODY="..." node ci/check_backlog_whole.mjs   (also checks the PR body; CI passes it on pull_request events)
// Pure file reads, no dependencies: it runs before `npm ci`.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";

/** A1: the words that say work is left. */
export const LEFT_RE = /\b(not (?:yet )?built|not (?:yet )?done|deferred|follow[- ]?ups?|fast[- ]follow|later slice|next slice)\b/i;
export const CARD_RE = /\bORW-\d+\b/;
const MARKER = "# spec-only:";
const SUPERSEDED_RE = /superseded by\s+(.+)$/i;
const GATED_RE = /gated by\s+([\w./-]+)/gi;

export const norm = (line) => line.trim().replace(/\s+/g, " ");

/**
 * ORW-878: "deferred" is also a plain technical word ("the deferred fold", "a deferred-retry queue", "its deferred listener"). Only its STATUS use says work is left
 * ("is deferred", "(deferred)", "DEFERRED", "deferred to ..."), so the adjective use after an article or a possessive, and a hyphenated compound, are read past.
 */
export function statusText(line) {
  return line
    .replace(/\b(?:the|a|an|its|their|this|that|existing|any|each|one|every)\s+(?:\*+)?deferred(?:\*+)?(?=[\s-]+[a-z])/gi, " ")
    .replace(/\bdeferred-(?=[a-z])/gi, " ");
}

/** A1: the lines in `text` that say work is left and name no card. */
export function uncardedLines(text) {
  const out = [];
  let fence = false;
  text.split("\n").forEach((line, i) => {
    if (/^\s*```/.test(line)) { fence = !fence; return; }
    if (fence) return;
    if (LEFT_RE.test(statusText(line)) && !CARD_RE.test(line)) out.push({ line: i + 1, text: norm(line) });
  });
  return out;
}

/** The PR body without the review bot's generated summary and without HTML comments (blanked, not removed, so line numbers still match the body). */
export function authorText(body) {
  const blank = (m) => m.replace(/[^\n]/g, "");
  return body
    .replace(/<!--\s*This is an auto-generated description by cubic\.\s*-->[\s\S]*?<!--\s*End of auto-generated description by cubic\.\s*-->/g, blank)
    .replace(/<!--[\s\S]*?-->/g, blank);
}

function walk(dir, pred, prefix = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, pred, prefix));
    else if (pred(e.name)) out.push(p);
  }
  return out.sort();
}

const isSpecDoc = (name) => /^\d{4}[a-z]?-.+\.md$/.test(name);

/**
 * ORW-878: the docs A1 does NOT read, each with why. They are records of a moment (a line in them says what was left THEN, not what is open now), or they are judged
 * elsewhere. Everything else under docs/ is read: a design note, an ADR, a roadmap or a guide that says work is left must name its card.
 */
export const A1_EXEMPT = [
  { path: "docs/audits/", why: "dated audit records: each describes the code on its date" },
  { path: "docs/legacy/", why: "the legacy chat-prompt game, reference only" },
  { path: "docs/IMPLEMENTATION_QUEUE.md", why: "the historical work queue (every batch shipped); open work is on the board" },
  { path: "docs/decisions/PO-DECISIONS-LOG.md", why: "a dated log of rulings, appended in order" },
];

/** A1 reads every markdown file under docs/ that is not exempt; inside docs/features only the numbered spec docs (the index is A2/A3's, the review ledger is a dated record). */
function a1Docs(root) {
  const docs = join(root, "docs");
  if (!existsSync(docs)) return [];
  return walk(docs, (n) => n.endsWith(".md")).filter((f) => {
    const r = f.slice(root.length + 1);
    if (A1_EXEMPT.some((e) => (e.path.endsWith("/") ? r.startsWith(e.path) : r === e.path))) return false;
    if (r.startsWith("docs/features/")) return isSpecDoc(basename(f));
    return true;
  });
}

/** A2: what a spec-only marker says, if anything. */
export function markerReason(marker) {
  const cards = [...marker.matchAll(/\bORW-(\d+)\b/g)].map((m) => `ORW-${m[1]}`);
  const sup = marker.match(SUPERSEDED_RE);
  const supersededBy = sup ? [...sup[1].matchAll(/([\w./-]+\.feature)/g)].map((m) => m[1]) : [];
  const gatedBy = [...marker.matchAll(GATED_RE)].map((m) => m[1].replace(/[.;,]+$/, ""));
  return { cards, supersededBy, gatedBy };
}

/**
 * Run every check over a repo root. Returns { errors, warnings }. `prBody` is optional.
 * `wired` is the set of wired feature paths (repo-relative); passed in so a test can run this on a planted tree.
 */
export function checkRepo(root, { prBody, wired, baseBaseline } = {}) {
  const errors = [];
  const warnings = [];
  const baseline = JSON.parse(readFileSync(join(root, "ci", "backlog_baseline.json"), "utf8"));
  // Shrink-only: the baseline may lose entries, never gain one (`baseBaseline` is the base commit's copy; absent on the commit that adds the file).
  if (baseBaseline) {
    for (const k of ["a1", "a2"]) {
      const before = new Set(baseBaseline[k] ?? []);
      for (const e of baseline[k] ?? []) if (!before.has(e)) errors.push(`baseline ci/backlog_baseline.json: ${k} gained an entry (the list only shrinks; card the line and put the ORW number on it instead): ${String(e).slice(0, 160)}`);
    }
  }
  const snapshot = JSON.parse(readFileSync(join(root, "ci", "board_snapshot.json"), "utf8"));
  const featDir = join(root, "docs", "features");
  const rel = (p) => p.slice(root.length + 1);

  // A1, docs: every docs/**/*.md (ORW-878 widened it from the numbered feature docs), except the records listed in A1_EXEMPT.
  const a1Base = new Set(baseline.a1 ?? []);
  const a1Seen = new Set();
  for (const f of a1Docs(root)) {
    for (const u of uncardedLines(readFileSync(f, "utf8"))) {
      const key = `${rel(f)}::${u.text}`;
      if (a1Base.has(key)) { a1Seen.add(key); continue; }
      errors.push(`A1 ${rel(f)}:${u.line}: says work is left but names no ORW card (add the card number, or card it first): ${u.text.slice(0, 160)}`);
    }
  }
  for (const k of a1Base) if (!a1Seen.has(k)) errors.push(`A1 ci/backlog_baseline.json: this listed line is no longer in the docs; remove it from the list (the list only shrinks): ${k.slice(0, 160)}`);

  // A1, the PR body: the author's own words. The review bot's generated summary (between its "auto-generated description by cubic" markers) is not the
  // author's and is rewritten on every push, so it is not checked; HTML comments are not shown, so they are skipped too.
  if (prBody) for (const u of uncardedLines(authorText(prBody))) errors.push(`A1 PR body line ${u.line}: says work is left but names no ORW card (card it and put the number on the line): ${u.text.slice(0, 160)}`);

  // A2.
  const a2Base = new Set(baseline.a2 ?? []);
  const a2Seen = new Set();
  const states = snapshot.states ?? {};
  for (const f of walk(featDir, (n) => n.endsWith(".feature"))) {
    const marker = readFileSync(f, "utf8").split("\n").slice(0, 3).find((l) => l.startsWith(MARKER));
    if (!marker) continue;
    const name = basename(f);
    const { cards, supersededBy, gatedBy } = markerReason(marker);
    if (gatedBy.length) {
      // Built and verified outside Cucumber: the marker names the gate, and the gate must exist (a bare "verified elsewhere" is not enough).
      for (const g of gatedBy) if (!existsSync(join(root, g))) errors.push(`A2 ${rel(f)}: says gated by ${g}, which does not exist`);
      continue;
    }
    if (supersededBy.length) {
      for (const s of supersededBy) {
        const target = s.includes("/") ? join(root, s) : join(featDir, s);
        const r = rel(target);
        if (!existsSync(target)) errors.push(`A2 ${rel(f)}: says superseded by ${s}, which does not exist`);
        else if (wired && !wired.has(r)) errors.push(`A2 ${rel(f)}: says superseded by ${s}, which is not wired into the BDD gate`);
      }
      continue;
    }
    if (cards.length) {
      for (const c of cards) {
        const st = states[c];
        if (st === undefined) warnings.push(`A2 ${rel(f)}: waits on ${c}, which is not in ci/board_snapshot.json (the coordinator's next refresh adds it)`);
        else if (st === "Done") errors.push(`A2 ${rel(f)}: still spec-only, but ${c} is Done: wire it (drop the marker), say what it is superseded by, or name the card for what remains`);
      }
      continue;
    }
    if (a2Base.has(name)) { a2Seen.add(name); continue; }
    errors.push(`A2 ${rel(f)}: spec-only but says none of: the ORW card it waits on, "superseded by <file>.feature", or "gated by <test path>"`);
  }
  for (const k of a2Base) if (!a2Seen.has(k)) errors.push(`A2 ci/backlog_baseline.json: ${k} no longer needs listing (it now names a card, is superseded, is wired or is gone); remove it from the list`);

  // A3.
  const readme = readFileSync(join(featDir, "README.md"), "utf8");
  const rows = new Set([...readme.matchAll(/^\|\s*(\d{4}[a-z]?)\s*\|/gm)].map((m) => m[1]));
  for (const f of readdirSync(featDir).filter(isSpecDoc).sort()) {
    const num = f.match(/^(\d{4}[a-z]?)-/)[1];
    if (!rows.has(num)) errors.push(`A3 docs/features/${f}: has no row in docs/features/README.md`);
  }
  for (const m of readme.matchAll(/\]\(\.\/([^)#\s]+)(?:#[^)]*)?\)/g)) {
    if (!existsSync(join(featDir, m[1]))) errors.push(`A3 docs/features/README.md: a row links to ./${m[1]}, which does not exist`);
  }
  return { errors, warnings };
}

async function wiredSet(root) {
  const { createRequire } = await import("node:module");
  const req = createRequire(join(root, "package.json"));
  return new Set(req("./cucumber.cjs").default.paths);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  const baseBaseline = process.env.BASELINE_BASE ? JSON.parse(readFileSync(process.env.BASELINE_BASE, "utf8")) : undefined;
  const { errors, warnings } = checkRepo(root, { prBody: process.env.PR_BODY, wired: await wiredSet(root), baseBaseline });
  for (const w of warnings) console.log(`::warning::${w}`);
  for (const e of errors) console.log(`::error::${e}`);
  if (errors.length) {
    console.log(`\nbacklog-whole: ${errors.length} problem(s). Why: "if the backlog has holes, then the code that it's built off of also has holes" (Ryne, ORW-758).`);
    process.exit(1);
  }
  console.log("backlog-whole: every left-over line names its card, every spec-only feature says why, and the spec index is complete.");
}
