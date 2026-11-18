// A9 flip (2026-11-04): the BDD lane exercises the premiere through the pre-A9 champagne-circle scenarios (0111 etc.); the entrance scenarios opt IN via setPremiereEntrancesEnabled(true).
process.env.ORWELL_PREMIERE_ENTRANCES = "0";
process.env.ORWELL_PHILOSOPHIES = "0"; // ORW-37: lasting game philosophies re-seed who nominates whom; the seed-pinned BDD scenarios (0047 secret-ballot fixture, 0078 floor, 0119 felt-duration neutrality, 0130 anchor) were written on the archetype table. The wiring has its own tests (philosophiesWired.test.ts).
process.env.ORWELL_CALM_PRESENCE = "0"; // ORW-212: the calm re-seat (fewer, staggered moves) changes the seeded movement the 0078 intentional-movement floor scenario measures; calm has its own tests (calmPresence.test.ts)
process.env.ORWELL_BEDTIME_GATE = "0"; // the BDD lane turns in at 8am in several scenarios; the bedtime gate has its own unit test
// Cucumber.js configuration (CommonJS so it loads regardless of "type": "module").
// TypeScript step definitions are loaded through the tsx ESM loader, wired via
// NODE_OPTIONS="--import tsx" in the `test:bdd` npm script.
//
// `paths` is DISCOVERED, not hand-listed (a hand-appended array was the one line every feature PR fought over):
// every `docs/features/**/*.feature` is executed UNLESS it carries the explicit `# spec-only:` marker in its first
// three lines (a spec-only feature is a design contract that Cucumber does not execute; any verification outside
// Cucumber (Vitest, FE pytest, deployment scripts, host smoke) is recorded in that feature's status entry in the
// per-feature index, docs/features/README.md). So to wire a feature: write its steps (features/step_definitions/**)
// and do NOT put the marker on it; to shelve one: put the marker on it. tests/unit/featureShelfDrift.test.ts pins
// that every feature is one or the other. CI treats ANY edit to a .feature as an engine change (deliberately broad).
// Keep scenario edits to wired features paired with their step code.
const fs = require("node:fs");
const path = require("node:path");
function wiredFeatures() {
  const walk = (dir, prefix) => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(...walk(path.join(dir, e.name), `${prefix}/${e.name}`));
      else if (e.name.endsWith(".feature")) out.push(`${prefix}/${e.name}`);
    }
    return out;
  };
  const root = path.join(__dirname, "docs", "features");
  return walk(root, "docs/features")
    .filter((rel) => !fs.readFileSync(path.join(__dirname, rel), "utf8").split("\n").slice(0, 3).some((l) => l.startsWith("# spec-only:")))
    .sort();
}
module.exports = {
  default: {
    paths: wiredFeatures(),
    import: ["features/support/**/*.ts", "features/step_definitions/**/*.ts"],
  },
};

// ORW-413: `ci/bdd-shard.mjs` and `ci/fast-checks.sh` run a SLICE of the executable features by setting ORWELL_BDD_FEATURES (newline-separated paths). Positional paths on the
// cucumber command line are ADDED to the `paths` above (every feature would still run), so the slice has to replace the list here. Unset, the full list above runs.
if (process.env.ORWELL_BDD_FEATURES) module.exports.default.paths = process.env.ORWELL_BDD_FEATURES.split("\n").filter(Boolean);
