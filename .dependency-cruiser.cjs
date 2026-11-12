/**
 * dependency-cruiser configuration — the STRUCTURAL proof of the Vault Wall.
 *
 * The crux of feature 0001: no outward-facing module (player surface, admin /
 * God-Mode port, the visible-state services they consume, or the outward
 * composition root) may depend on the engine-only `VaultStore` / `VectorIndex`
 * ports, their adapters, or the engine composition root that wires them.
 *
 * `tsPreCompilationDeps: true` makes the check catch even type-only imports, so
 * an outward module cannot so much as *name* the Vault types.
 */
// B59/audit E7: OUTWARD covers every leak-sensitive outward consumer — the narrative adapters
// (the LLM seam itself) and the process entrypoint included, not just surfaces/services/mcp.
const OUTWARD =
  "^src/(surfaces|services)/|^src/composition/outwardRoot\\.ts$|^src/adapters/(mcp|narrative)/|^src/main\\.ts$";
// B59/audit E7: VAULT also names the engine modules that HOLD hidden logic/state (the relationship
// ledger, confessionals, off-screen life, gossip, the live loop) — a surface could otherwise import
// confessionalFor()/relationship internals without tripping the gate. Type-only imports count.
const VAULT =
  "^src/ports/(VaultStore|VectorIndex|SoulProvider|EmbeddingProvider|UserSaveStore)\\.ts$" +
  "|^src/adapters/inmemory/(InMemoryVaultStore|InMemoryVectorIndex)\\.ts$" +
  "|^src/adapters/engine/(SoulStore|FileSaveStore)\\.ts$" +
  // E63: the relational adapters persist souls + the hidden relationship layer (the snapshot) and the
  // Vault-side soul vectors — engine-only, exactly like FileSaveStore / InMemoryVectorIndex above.
  "|^src/adapters/sqlite/(SqliteSaveStore|SqliteVectorIndex)\\.ts$" +
  "|^src/adapters/embedding/DeterministicEmbedding\\.ts$" +
  "|^src/engine/(sessionSnapshot|relationships|confessionals|offscreen|gossip|liveSeason|campaigns|agenda|agendaConstants|agendaDecisions|houseLife|houseLifeConstants)\\.ts$" +
  "|^src/composition/engineRoot\\.ts$";

// Audit E18: the VAULT denylist above enumerates KNOWN hidden modules — every new engine
// module (characterFactory's hiddenElements, emotionalArc, deals, decisions, jury, blocs,
// presence, competitionLibrary, …) had to be remembered into it. ENGINE_LAYER closes that
// hole by construction: outward code may not reach into the engine layer AT ALL. The only
// sanctioned edge is the process entrypoint composing the runtime (src/main.ts →
// src/composition/runtime.ts); everything else outward consumes ports and outward-safe
// services. The denylist rule stays as a second, independent tripwire (strengthen, never
// weaken).
const ENGINE_LAYER =
  "^src/engine/" +
  "|^src/adapters/(inmemory|engine|embedding|sqlite)/" +
  "|^src/composition/";

module.exports = {
  forbidden: [
    {
      name: "no-vault-in-producer-read",
      severity: "error",
      comment:
        "#1792 — producerRead.ts is structurally Vault-free by design, with no VaultStore, " +
        "SoulProvider, RelationshipModel, or hidden engine module handle. This rule enforces " +
        "that it stays that way: no hidden-state imports may reach src/engine/producerRead.ts, " +
        "even as type-only deps (tsPreCompilationDeps catches type-only imports).",
      from: { path: "^src/engine/producerRead\\.ts$" },
      to: { path: VAULT },
    },
    {
      name: "no-vault-in-receipts",
      severity: "error",
      comment:
        "#1800 — receipts.ts is structurally Vault-free by design, with no VaultStore, " +
        "SoulProvider, RelationshipModel, or hidden engine module handle. This rule enforces " +
        "that it stays that way: no hidden-state imports may reach src/engine/receipts.ts, " +
        "even as type-only deps (tsPreCompilationDeps catches type-only imports).",
      from: { path: "^src/engine/receipts\\.ts$" },
      to: { path: VAULT },
    },
    {
      name: "no-vault-in-canon-ledger",
      severity: "error",
      comment:
        "Showrunner memory Part B (K4 §2.8.3) — the canon ledger (src/engine/canonLedger.ts + its types in " +
        "src/domain/canon.ts) is structurally Vault-free: the Vault sweep is an injected `leaksVault` closure, " +
        "wired at composition, so the ledger never holds a VaultStore, SoulProvider, VectorIndex or hidden " +
        "engine module handle (type-only imports included). Recorded canon can never encode a Vault string.",
      from: { path: "^src/(engine/canonLedger|domain/canon)\\.ts$" },
      to: { path: VAULT },
    },
    {
      name: "no-vault-on-outward",
      severity: "error",
      comment:
        "Outward-facing code must be structurally incapable of reading the Vault. " +
        "The narrator cannot leak what it never receives. (The process entrypoint is the " +
        "ONE sanctioned exception — see no-vault-on-entrypoint below — so it is excluded here.)",
      from: { path: OUTWARD, pathNot: "^src/main\\.ts$" },
      to: { path: VAULT },
    },
    {
      name: "no-vault-on-entrypoint",
      severity: "error",
      comment:
        "The process entrypoint (src/main.ts) may compose the engine root (engineRoot.ts wires the " +
        "Vault internally — the E86a fastembed warm-up calls setRuntimeEmbedding through it) but it " +
        "may NEVER reach the actual Vault ports/adapters or the hidden engine modules directly. So " +
        "engineRoot is the ONLY VAULT-listed module the entrypoint may touch; everything deeper stays " +
        "forbidden — the wall holds even for the trusted entrypoint.",
      from: { path: "^src/main\\.ts$" },
      to: { path: VAULT, pathNot: "^src/composition/engineRoot\\.ts$" },
    },
    {
      name: "no-engine-layer-on-outward",
      severity: "error",
      comment:
        "Default-deny (audit E18): outward code may not import ANY engine-layer module — " +
        "src/engine/**, the engine/inmemory/embedding adapters, or the composition wiring. " +
        "New hidden-state modules are covered the day they are created, without being " +
        "enumerated. The sole exception is below (entrypoint → runtime).",
      from: { path: OUTWARD, pathNot: "^src/main\\.ts$" },
      to: { path: ENGINE_LAYER, pathNot: "^src/composition/outwardRoot\\.ts$" },
    },
    {
      name: "entrypoint-composes-runtime-only",
      severity: "error",
      comment:
        "The process entrypoint may compose the runtime (which wires the Vault internally), the " +
        "outward root, the engine root (E86a: setRuntimeEmbedding), the fastembed embedding " +
        "adapter it warms up at boot, and the dependency-free /health embeddings-status tracker " +
        "(PERSIST-5) — but nothing else in the engine layer (audit E18).",
      from: { path: "^src/main\\.ts$" },
      to: {
        path: ENGINE_LAYER,
        pathNot:
          "^src/composition/(runtime|outwardRoot|engineRoot)\\.ts$" +
          "|^src/adapters/embedding/(FastembedEmbedding|embeddingsStatus)\\.ts$",
      },
    },
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies muddy the port boundaries; keep the graph acyclic.",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { extensions: [".ts", ".js"] },
    doNotFollow: { path: "node_modules" },
    exclude: { path: "node_modules" },
  },
};
