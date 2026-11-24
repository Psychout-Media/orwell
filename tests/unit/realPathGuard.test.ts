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

/**
 * ORW-827: the shipped switches. The setup file (tests/support/premiereTestDefault.ts) leaves tests/realpath at the deploy defaults (the premiere entrances and the bedtime gate on); a file that
 * turns a switch OFF (a `set...Enabled(false)` setter, or `process.env.ORWELL_* = "0" | "false" | "off" | "no"`) must say why, on that line or the line above: `// not as shipped: <reason>`.
 * Unsetting a variable (`delete process.env.ORWELL_*`) returns it to its shipped default and is allowed. Turning a default-OFF switch ON is not caught here (the guard does not know each default).
 */
const FLAG_OFF: Rule = { id: "flag-off-unstated", re: /\bset[A-Z]\w*Enabled\s*\(\s*false\s*\)|process\.env\.ORWELL_\w+\s*=\s*["'`](?:0|false|off|no)["'`]/, reason: "turns a shipped switch off with no stated reason (`// not as shipped: <why>` on the line or the line above)" };
const NOT_AS_SHIPPED = /\/\/.*\bnot as shipped:\s*\S/;

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

/**
 * ORW-852: the SANDBOX NAME is part of a played game's identity (with the seed it keys the player-action stream and the off-screen tick: the same seed under another
 * name is another game). So a real-path test pins it next to its seed:
 *  - every call to a played-season driver passes it (`user:` in the options of `playedGame` / `playSeason` / `playUntil` / `playMixGame`, the third argument of
 *    `bootNatural`), unless the call forwards a caller's options object (`...opts`) or the file defines a local function of that name;
 *  - every sandbox name the file writes (a `sandboxFor(...)` argument, a `user:` value, or the `const` an identifier there names) is fixed: never random, time-based
 *    or a counter that moves with test order;
 *  - ORW-880: a seed chosen by `firstSeedWhere` / `firstSeedWhereSync` counts as pinned when the call names each seed's sandbox (`sandbox: (seed) => ...`), itself fixed.
 */
const DRIVERS = ["playedGame", "playedSeason", "playSeason", "playUntil", "playMixGame", "bootNatural"];
const UNFIXED_NAME = /Math\s*\.\s*random|\bDate\b|performance\s*\.\s*now|randomUUID|hrtime|\+\+|--/;

/** The text between the parenthesis at `open` and its match (strings and comments already handled by the caller's stripping). */
function argsAt(src: string, open: number): string {
  let d = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") { d--; if (d === 0) return src.slice(open + 1, j); }
  }
  return src.slice(open + 1);
}
/** The top-level arguments of an argument list. */
function topArgs(a: string): string[] {
  const out: string[] = []; let d = 0, cur = "";
  for (const c of a) {
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") d--;
    if (c === "," && d === 0) { out.push(cur); cur = ""; } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
const lineOf = (src: string, at: number): number => src.slice(0, at).split("\n").length;

function scanSandboxNames(file: string, src: string): Violation[] {
  const raw = src.split("\n");
  const code = stripComments(src, false); // strings kept: a name is a string
  const found: Violation[] = [];
  const push = (at: number, rule: string, reason: string): void => { const line = lineOf(code, at); found.push({ file, line, rule, reason, text: (raw[line - 1] ?? "").trim() }); };
  const local = new Set([...code.matchAll(/function\s+([\w$]+)\s*\(/g)].map((m) => m[1]!));
  for (const name of DRIVERS) {
    if (local.has(name)) continue;
    for (const m of code.matchAll(new RegExp(String.raw`(?<![\w$.])${name}\s*\(`, "g"))) {
      const before = code.slice(Math.max(0, m.index! - 40), m.index!);
      if (/function\s*$|import\s*\{[^}]*$|\bas\s*$/.test(before)) continue;
      const open = m.index! + m[0].length - 1;
      const args = argsAt(code, open);
      const pinned = name === "bootNatural" ? topArgs(args).length >= 3 : /\buser\s*:/.test(args) || /\.\.\.\s*opts\b/.test(args);
      if (!pinned) push(m.index!, "sandbox-unpinned", `${name}(...) plays a seeded season without naming its sandbox; the name is part of the game (pass user: next to the seed)`);
    }
  }
  // ORW-880: a seed picked by the scan (tests/support/firstSeedWhere.ts) is pinned when the scan names its sandbox for each seed (`sandbox: (s) => \`wf-${s}\``).
  if (!local.has("firstSeedWhere")) for (const m of code.matchAll(/(?<![\w$.])firstSeedWhere(?:Sync)?\s*\(/g)) {
    const before = code.slice(Math.max(0, m.index! - 40), m.index!);
    if (/function\s*$|import\s*\{[^}]*$|\bas\s*$/.test(before)) continue;
    if (!/\bsandbox\s*:/.test(argsAt(code, m.index! + m[0].length - 1))) push(m.index!, "sandbox-unpinned", "firstSeedWhere(...) picks a seed without naming each seed's sandbox; pass sandbox: (seed) => a fixed name");
  }
  const exprs: Array<{ at: number; expr: string }> = [];
  for (const m of code.matchAll(/(?<![\w$])sandbox\s*:\s*/g)) { const rest = code.slice(m.index! + m[0].length); exprs.push({ at: m.index!, expr: topArgs(rest.split(/\n/)[0] ?? "")[0] ?? "" }); }
  for (const m of code.matchAll(/(?<![\w$])sandboxFor\s*\(/g)) exprs.push({ at: m.index!, expr: argsAt(code, m.index! + m[0].length - 1) });
  for (const m of code.matchAll(/(?<![\w$])user\s*:\s*/g)) { const rest = code.slice(m.index! + m[0].length); exprs.push({ at: m.index!, expr: topArgs(rest.split(/[}\n]/)[0] ?? "")[0] ?? "" }); }
  for (const { at, expr } of exprs) {
    const e = expr.trim();
    const id = /^[\w$]+$/.test(e) ? e : undefined;
    const decl = id ? new RegExp(String.raw`(?:const|let|var)\s+${id}\s*=\s*([^;\n]+)`).exec(code)?.[1] : undefined;
    if (UNFIXED_NAME.test(e) || (decl !== undefined && UNFIXED_NAME.test(decl))) push(at, "sandbox-unfixed", "a sandbox name that is random, time-based or a counter: the same seed then plays a different game from run to run or with test order");
  }
  return found;
}



function scanSource(file: string, src: string): Violation[] {
  const raw = src.split("\n");
  const code = stripComments(src).split("\n");
  const withStrings = stripComments(src, false).split("\n");
  const found: Violation[] = [];
  code.forEach((l, ix) => {
    for (const r of FORBIDDEN) if (r.re.test(r.strings ? withStrings[ix]! : l)) found.push({ file, line: ix + 1, rule: r.id, reason: r.reason, text: (raw[ix] ?? "").trim() });
    // ORW-827: a switch turned OFF is not the game as shipped. Allowed only with a stated reason on the line or the line above (`// not as shipped: <why>`), e.g. the flag-off arm of an on/off comparison.
    const reasoned = (j: number): boolean => j >= 0 && NOT_AS_SHIPPED.test(raw[j] ?? "");
    if (FLAG_OFF.re.test(withStrings[ix]!) && !reasoned(ix) && !reasoned(ix - 1)) found.push({ file, line: ix + 1, rule: FLAG_OFF.id, reason: FLAG_OFF.reason, text: (raw[ix] ?? "").trim() });
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

  it("ORW-852: every guarded file that plays a seeded season names its sandbox, with a fixed name", () => {
    const violations = guardedFiles().flatMap((f) => scanSandboxNames(rel(f), readFileSync(f, "utf8")));
    const report = violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.reason}\n    ${v.text}`).join("\n");
    expect(violations, `pin the sandbox name with the seed (tests/realpath/README.md):\n${report}`).toEqual([]);
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

  it("flags a shipped switch turned off with no stated reason (ORW-827), and passes one with a reason", () => {
    for (const line of ["s.setCopresenceEnabled(false);", 'process.env.ORWELL_TIME_OF_DAY = "0";', "setup: (sess) => sess.setLeveragePlaysEnabled( false ),"]) {
      expect(scanSource("p.test.ts", `a;\n${line}\n`).map((v) => v.rule), line).toEqual(["flag-off-unstated"]);
    }
    expect(scanSource("p.test.ts", "a;\ns.setCopresenceEnabled(false); // not as shipped: the off arm of the on/off comparison\n")).toEqual([]);
    expect(scanSource("p.test.ts", "// not as shipped: the dormancy check\nprocess.env.ORWELL_TIME_OF_DAY = \"0\";\n")).toEqual([]);
    expect(scanSource("p.test.ts", "// not as shipped:\ns.setCopresenceEnabled(false);\n").map((v) => v.rule), "an empty reason is no reason").toEqual(["flag-off-unstated"]);
    expect(scanSource("p.test.ts", "delete process.env.ORWELL_TIME_OF_DAY;\ns.setCopresenceEnabled(true);\nGameSessionAdapter.setTimeOfDayEnabled(null);\n")).toEqual([]);
  });

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

  it("ORW-852: flags a played-season driver called without a sandbox name, and a random, time-based or counter name", () => {
    const rules = (src: string): string[] => scanSandboxNames("p.test.ts", src).map((v) => v.rule);
    expect(rules('a;\nconst g = playedGame({ seed: 21 });\n')).toEqual(["sandbox-unpinned"]);
    expect(rules('a;\nconst at = await playUntil(SEED, (s) => s.msg > 3);\n')).toEqual(["sandbox-unpinned"]);
    expect(rules('a;\nconst at = await playUntil(SEED, (s) => s.msg > 3, { maxMessages: 900 });\n')).toEqual(["sandbox-unpinned"]);
    expect(rules('a;\nconst r = await playSeason({\n  seed: 4,\n  maxMessages: 1400,\n});\n')).toEqual(["sandbox-unpinned"]);
    expect(rules("a;\nconst s = bootNatural(seed, true);\n")).toEqual(["sandbox-unpinned"]);
    expect(rules("a;\nconst s = new GameSessionRegistry().sandboxFor(`mh-${Math.random()}`).session;\n")).toEqual(["sandbox-unfixed"]);
    expect(rules('a;\nconst g = playedGame({ seed: 21, user: `p-${Date.now()}` });\n')).toEqual(["sandbox-unfixed"]);
    expect(rules("a;\nconst user = `cpm-${n++}`;\nconst sb = reg.sandboxFor(user);\n")).toEqual(["sandbox-unfixed"]);
    expect(rules("a;\nconst f = await firstSeedWhere((seed) => playUntil(seed, done, { user: `wf-${seed}` }), { from: 1, to: 9 });\n")).toEqual(["sandbox-unpinned"]);
    expect(rules("a;\nconst f = firstSeedWhereSync((seed, sandbox) => go(seed, sandbox), { from: 1, to: 9, sandbox: (s) => `x-${Date.now()}-${s}` });\n")).toEqual(["sandbox-unfixed"]);
    const v = scanSandboxNames("p.test.ts", 'a;\nb;\nconst g = playedGame({ seed: 21 });\n');
    expect(v[0]).toMatchObject({ line: 3, rule: "sandbox-unpinned" });
  });

  it("ORW-852: passes pinned names, forwarded options, a local helper and the drivers' own definitions", () => {
    const clean = [
      'import { playUntil } from "./playedSeason";',
      'import { playMixGame } from "../support/houseMixDriver";',
      'const g = playedGame({ seed: 21, user: "ps21" });',
      'const at = await playUntil(SEED, (s) => s.msg > 3, { user: `wf-${SEED}` });',
      'const q = await playUntil(SEED, done, { ...QUIET, user: "wf-3" });',
      "const r = await playSeason({ user: `wf-${seed}`, seed, maxMessages: 1400 });",
      'await playMixGame(13, 1400, { user: "mixdrv-13" });',
      "const s = bootNatural(seed, true, `ln-natural-${seed}-on`);",
      "const rec = await playSeason({ ...opts, seed, maxMessages: 1500 });",
      'const NAME = "bj-real-load";',
      "const loaded = new GameSessionRegistry().sandboxFor(NAME).session;",
      "const sb = reg.sandboxFor(`hours-${playing}`);",
      "const f = await firstSeedWhere((seed, sandbox) => playUntil(seed, done, { user: sandbox }), { from: 1, to: 12, hint: 3, sandbox: (s) => `wf-${s}` });",
      "const g = firstSeedWhereSync((seed, sandbox) => reach(seed, sandbox), {",
      "  from: 1, to: 12,",
      "  sandbox: (s) => `pj-${s}`,",
      "});",
      "function playUntilQuiet(seed: number) { return 1; }",
      "export async function playSeason(opts: PlayOpts): Promise<SeasonRecord> { return run(opts); }",
    ].join("\n");
    expect(scanSandboxNames("clean.test.ts", clean)).toEqual([]);
    const local = "function playSeason(seed: number) { const s = reg.sandboxFor(\"orw747\").session; s.createCharacter({ seed }); }\nplaySeason(SEED);\n";
    expect(scanSandboxNames("local.test.ts", local), "a file's own helper of that name is checked by the name it builds instead").toEqual([]);
  });

  it("names the file and line of a violation", () => {
    const v = scanSource("tests/realpath/x.test.ts", "a;\nb;\nx.live.week = 1;\n");
    expect(v).toEqual([expect.objectContaining({ file: "tests/realpath/x.test.ts", line: 3, rule: "live-assign" })]);
  });
});
