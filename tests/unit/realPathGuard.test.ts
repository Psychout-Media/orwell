import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * ORW-758 (A5): the REAL-PATH guard. A test a card requires "through the real path" lives in tests/realpath/ (see the README there).
 * Such a test must reach the state it checks by PLAYING (the session / MCP API: createCharacter, advanceGame, submitDecision,
 * recordInteraction, noteMessage, the player tools), never by writing hidden or engine state by hand. Fifteen cards were once marked
 * Done on tests that set the state directly; those tests proved nothing about the real game.
 *
 * This guard reads every .ts file under tests/realpath/ (and the heavy played-season real-path files tests/uat/realPath*.test.ts,
 * which stay in the heavy lane for run time) and fails on any line matching a FORBIDDEN pattern below, naming file:line.
 * Comments are blanked before matching, so prose may name the patterns. There is no escape hatch: a test that needs a hand-set
 * state does not belong in tests/realpath/.
 *
 * ALLOWED (not state writes): reading any state (`s.live.week` inside an expect), feature flags (`set...Enabled(`, `process.env.ORWELL_* =`,
 * the admin `configure` knobs), choosing a seed, the session/MCP calls a player or the front end makes (including the player tool
 * `surfaceInformationTo({...})` and `diaryRoom`), infrastructure resets (`resetSaveSyncLimiterForTests`, `setStallTimerForTests`), and
 * stubbing a front-end provider (an LLM or image fake). The guard is a line-level text check: an alias (`const L = s.live; L.week = 1`)
 * escapes it, so reviewers still read the test.
 */

const ROOT = join(__dirname, "..", "..");
const REALPATH_DIR = join(ROOT, "tests", "realpath");
const UAT_DIR = join(ROOT, "tests", "uat");

/** A balanced call argument list, one level of nesting deep: `(npc(1), PLAYER)`. */
const ARGS = String.raw`\((?:[^()]|\([^()]*\))*\)`;
/** The live season, reached as `x.live`, `x["live"]` or a `live(x)` helper. */
const LIVE = String.raw`(?:\.\s*live\b|\[\s*["'\`]live["'\`]\s*\]|(?<![\w$.])live\s*${ARGS})`;
/** A member / index chain after it: `.beliefs[npc(1)]!.trust`. */
const CHAIN = String.raw`(?:!?\s*(?:\?\.|\.)\s*[\w$]+|!?\s*\[[^\]]*\])*!?`;
/** An assignment operator (not `==`, `===`, `=>`). */
const ASSIGN = String.raw`\s*(?:\*\*|[-+*/%&|^]|<<|>>>?|\?\?|\|\||&&)?=(?![=>])`;

/** `strings: true` ⇒ matched with string contents kept (an import path); otherwise strings are blanked first. */
type Rule = { id: string; re: RegExp; reason: string; strings?: boolean };

const FORBIDDEN: Rule[] = [
  { id: "live-assign", re: new RegExp(LIVE + CHAIN + ASSIGN), reason: "assigns into the live season (hidden game state) instead of playing to it" },
  { id: "live-incdec", re: new RegExp(String.raw`${LIVE}${CHAIN}\s*(?:\+\+|--)|(?:\+\+|--)\s*[\w$.()\[\]"' ]*${LIVE}`), reason: "increments or decrements a live-season field by hand" },
  { id: "live-mutator", re: new RegExp(String.raw`${LIVE}${CHAIN}\s*\.\s*(?:push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|set|delete|add|clear)\s*\(`), reason: "mutates a live-season array, map or set in place" },
  { id: "live-delete", re: new RegExp(String.raw`\bdelete\s+[^;]*${LIVE}`), reason: "deletes a live-season field by hand" },
  { id: "object-assign-state", re: new RegExp(String.raw`Object\s*\.\s*(?:assign|defineProperty|defineProperties|setPrototypeOf)\s*\(\s*[^,]*(?:${LIVE}|\.\s*edge\s*\()`), reason: "copies hand-made values onto live state or a relationship edge" },
  { id: "edge-write", re: new RegExp(String.raw`\.\s*edge\s*${ARGS}${CHAIN}(?:${ASSIGN}|\s*(?:\+\+|--))`), reason: "sets a relationship edge (trust/affinity/threat/...) by hand instead of through a played scene" },
  { id: "relationship-writer", re: /\.\s*(?:rel|relationships|graph)\s*\.\s*(?:apply\w*|load|setDisposition|setFoldMeter|decay|driftTowardBaseline\w*)\s*\(/, reason: "moves relationship edges through the graph's own writer, skipping the scene that should move them" },
  { id: "knowledge-writer", re: /\.\s*(?:seedBelief|addSuspicion|transmitGossip|recordDiaryRoom)\s*\(|\bknowledge\s*\.\s*(?:surfaceInformationTo|load)\s*\(/, reason: "plants a belief, suspicion, gossip or diary fact straight into the knowledge store (the player tools are the real path)" },
  { id: "vault-writer", re: /\.\s*(?:writeHidden|replaceHidden)\s*\(/, reason: "writes the Vault directly; hidden content must come from the engine's own off-screen play" },
  { id: "event-writer", re: /\b(?:events|eventStore|eventLog)\s*\.\s*record\s*\(|\.\s*restoreRecord\s*\(/, reason: "appends an event to the event store by hand instead of having the game record it" },
  { id: "soul-writer", re: /\.\s*(?:recordToSoul|setSoul)\s*\(|\b(?:souls?|soulStore|vault)\s*\.\s*load\s*\(/, reason: "writes a soul or loads a hand-made store snapshot" },
  { id: "admin-override", re: /\.\s*applyOverride\s*\(/, reason: "a God-Mode override sets mechanics by hand; a played game never takes one" },
  { id: "sandbox-planter", re: /\.\s*(?:addConfessional|addOffscreenEvent|addReservedTwist|addHiddenAttribute|addNpcDeal|surfaceHiddenFactToPlayer)\s*\(/, reason: "a tests/support/sandbox.ts helper that plants hidden content" },
  { id: "planting-helper", re: /from\s+["'][^"']*\/support\/(?:liveSentinelPlanting|favorsSeam|triadsSeam|longNightDriver|vaultSentinelAnnouncementsHarness|dayTwoMorning|napWorld)["']/, reason: "imports a test-support module that writes live or hidden state (sentinel planting, the favors/triads seams, the long-night twist arming, the day-two-morning and nap-world clock setters)", strings: true },
];

/** Blank comments and string contents (keeping line breaks and a bare "live" key), so prose may mention the patterns. */
function stripComments(src: string, blankStrings = true): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  let body = "";
  while (i < src.length) {
    const c = src[i]!;
    const n = src[i + 1];
    if (quote) {
      if (c === "\\" && i + 1 < src.length) { body += n === "\n" ? "\n" : "  "; i += 2; continue; }
      if (c === quote) {
        // Keep a bare "live" (the `x["live"]` form); blank every other string so prose in a string is never read as code.
        out += (!blankStrings || body === "live" ? body : body.replace(/[^\n]/g, " ")) + c;
        quote = null;
        body = "";
      } else body += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; out += c; i++; continue; }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && n === "*") {
      out += "  ";
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i] === "\n" ? "\n" : " "; i++; }
      if (i < src.length) { out += "  "; i += 2; }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

type Violation = { file: string; line: number; rule: string; reason: string; text: string };

function scanSource(file: string, src: string): Violation[] {
  const raw = src.split("\n");
  const code = stripComments(src).split("\n");
  const withStrings = stripComments(src, false).split("\n");
  const found: Violation[] = [];
  code.forEach((l, ix) => {
    for (const r of FORBIDDEN) if (r.re.test(r.strings ? withStrings[ix]! : l)) found.push({ file, line: ix + 1, rule: r.id, reason: r.reason, text: (raw[ix] ?? "").trim() });
  });
  return found;
}

function walk(d: string, out: string[] = []): string[] {
  if (!existsSync(d)) return out;
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (n.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** The files the guard holds: everything in tests/realpath/, plus the heavy-lane real-path seasons in tests/uat/. */
function guardedFiles(): string[] {
  const heavy = existsSync(UAT_DIR) ? readdirSync(UAT_DIR).filter((n) => /^realPath.*\.test\.ts$/.test(n)).map((n) => join(UAT_DIR, n)) : [];
  return [...walk(REALPATH_DIR), ...heavy].sort();
}

const rel = (p: string): string => relative(ROOT, p).split(sep).join("/");

describe("ORW-758 A5: real-path tests never write hidden game state", () => {
  it("tests/realpath/ exists with its README and holds at least one test", () => {
    expect(existsSync(join(REALPATH_DIR, "README.md"))).toBe(true);
    expect(walk(REALPATH_DIR).filter((f) => f.endsWith(".test.ts")).length).toBeGreaterThan(0);
  });

  it("no guarded file writes live, relationship, knowledge, Vault, event or soul state directly", () => {
    const violations = guardedFiles().flatMap((f) => scanSource(rel(f), readFileSync(f, "utf8")));
    const report = violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.reason}\n    ${v.text}`).join("\n");
    expect(violations, `real-path tests must reach state by playing (tests/realpath/README.md):\n${report}`).toEqual([]);
  });
});

describe("the guard itself (planted failures)", () => {
  const PLANTED: Array<[string, string]> = [
    ["live-assign", "x.live.week = 3;"],
    ["live-assign", "live(s).beliefs = {};"],
    ["live-assign", "(s as any).live.pending = undefined;"],
    ["live-assign", "s.live.beliefs ??= {};"],
    ["live-assign", "s.live.beliefs[npc(1)] = [];"],
    ["live-assign", 'sess["live"].hoh = PLAYER;'],
    ["live-assign", "snap.live!.week += 1;"],
    ["live-assign", "seam.live = { ...seam.live, week: 2 };"],
    ["live-incdec", "core.live.week++;"],
    ["live-incdec", "--live(s).dayNumber;"],
    ["live-mutator", "s.live.evictionOrder.push(npc(3));"],
    ["live-mutator", "live(s).bonds.set(k, v);"],
    ["live-delete", "delete s.live.pending;"],
    ["object-assign-state", "Object.assign(s.live, { week: 4 });"],
    ["object-assign-state", "Object.assign(g.rel.edge(npc(1), PLAYER), { trust: 0.9 });"],
    ["edge-write", "sb.engine.rel.edge(npc(1), PLAYER).trust = 0.9;"],
    ["edge-write", "rel.edge(a, b).affinity -= 0.2;"],
    ["relationship-writer", "sb.engine.rel.applyImpactDirected(npc(1), PLAYER, { trust: -1 }, rng);"],
    ["relationship-writer", "g.relationships.load(edges);"],
    ["knowledge-writer", 'sb.engine.knowledge.seedBelief(npc(1), { content: "x", factId: "f" }, "witnessed");'],
    ["knowledge-writer", 'engine.knowledge.surfaceInformationTo(PLAYER, fact, "told");'],
    ["knowledge-writer", 'k.addSuspicion(PLAYER, { content: "x" });'],
    ["vault-writer", 'sb.engine.vault.writeHidden({ id: "v", kind: "confessional", content: "x" });'],
    ["event-writer", "sb.engine.events.record(ev);"],
    ["soul-writer", 'souls.recordToSoul(npc(1), "x");'],
    ["admin-override", "admin.applyOverride({ hoh: PLAYER });"],
    ["sandbox-planter", "sb.surfaceHiddenFactToPlayer();"],
    ["planting-helper", 'import { plant } from "../support/liveSentinelPlanting";'],
  ];

  for (const [rule, line] of PLANTED) {
    it(`flags ${rule}: ${line}`, () => {
      const v = scanSource("planted.test.ts", `import x from "y";\n${line}\n`);
      expect(v.map((x) => x.rule)).toContain(rule);
      expect(v.find((x) => x.rule === rule)!.line).toBe(2);
    });
  }

  it("passes a played test: session calls, reads, flags, comparisons, and comments naming the patterns", () => {
    const clean = [
      'import { GameSessionRegistry } from "../../src/composition/registry";',
      "// never do s.live.week = 3 or seedBelief( here",
      "/* rel.edge(a, b).trust = 1 */",
      "const reg = new GameSessionRegistry();",
      "const sb = reg.sandboxFor(user);",
      'sb.session.createCharacter({ playerName: "The Player", seed });',
      "setFavorsEnabled(true);",
      'process.env.ORWELL_FAVORS = "1";',
      "while (!(sb.session as any).live.finished) sb.session.advanceGame();",
      'sb.session.recordInteraction({ withIds: [npc(1)], kind: "chat", content: "hi" });',
      'sb.commands.surfaceInformationTo({ to: PLAYER, factId: "f", pathway: "told" });',
      "expect(live(s).week).toBe(2);",
      "expect(s.live.week >= 2 && s.live.week <= 9 && s.live.hoh !== PLAYER).toBe(true);",
      "const trust = sb.engine.rel.edge(npc(1), PLAYER).trust;",
      "const onWeek = (x: any) => x.live.week === 3;",
      'const note = "s.live.week = 3 in a string is prose, not code";',
      "const alive = s.live.evictionOrder.filter((h) => h !== PLAYER);",
      "const liveSeason = 1; liveSeason; isLive(s);",
    ].join("\n");
    expect(scanSource("clean.test.ts", clean)).toEqual([]);
  });

  it("names the file and line of a violation", () => {
    const v = scanSource("tests/realpath/x.test.ts", "a;\nb;\nx.live.week = 1;\n");
    expect(v).toEqual([expect.objectContaining({ file: "tests/realpath/x.test.ts", line: 3, rule: "live-assign" })]);
  });
});
